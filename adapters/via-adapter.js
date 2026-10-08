// adapters/via-adapter.js - Via 浏览器桥接逻辑
// 负责：读写 bookmarks.html（Netscape Bookmark 格式）、HTML↔扁平列表互转

// Via HTML 无持久化 ID，用 title + parentId 生成确定性 ID，避免每次解析 ID 不同导致去重失效
// 模块级函数，parseHtmlToBookmarks 和 parseFavoritesTxt 共用
function hashId(title, parentId) {
  const str = String(title || '') + '\x00' + String(parentId || '');
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    hash = ((hash << 5) - hash + c) | 0;
  }
  return 'via_' + Math.abs(hash).toString(36).slice(0, 10);
}

// HTML 实体解码（命名实体 + 数字实体）
// 不同写端转义风格不同：本扩展写 &amp;，floccus 之类的写端写 &#38;（数字实体），
// 只认命名实体会让标题对不上、URL 被破坏。两种都要认。
//
// ⚠️ 调用位置有硬约束：只能在「已经取出属性值/文本之后」解码，绝不能在整段 HTML 预处理阶段解码
//    —— 那时 &lt;b&gt; 会先变成真标签 <b>，再被去标签规则 /<[^>]*>/g 当成标签删掉
//    （实测 "A&lt;B&gt;C" 会被吃成 "AC"）。正确顺序：先取属性/先去标签，再解码。
function decodeHtmlEntities(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// ========== HTML → 扁平列表 ==========
// 将 Netscape Bookmark HTML 解析为与 Berry JSON 相同格式的扁平列表
function parseHtmlToBookmarks(html) {
  if (!html || typeof html !== 'string') return [];

  const bookmarks = [];

  // 解析 ADD_DATE 属性（秒 → 毫秒）
  function parseAddDate(str) {
    if (!str) return Date.now();
    const num = parseInt(str, 10);
    if (isNaN(num)) return Date.now();
    // Via 的 ADD_DATE 是秒级时间戳（10位数字）
    return num > 9999999999 ? num : num * 1000;
  }

  // 从 pos 开始找到与当前 <DL><p> 配对的 </DL><p>，返回内部内容和结束位置
  function extractDLBlock(text, startAfterDLp) {
    let depth = 1;
    let i = startAfterDLp;
    const openTag = '<DL><p>';
    const closeTag = '</DL><p>';
    while (i < text.length && depth > 0) {
      const nextOpen = text.indexOf(openTag, i);
      const nextClose = text.indexOf(closeTag, i);
      if (nextClose === -1) break; // 格式异常，跳出
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        i = nextOpen + openTag.length;
      } else {
        depth--;
        if (depth === 0) {
          return { content: text.slice(startAfterDLp, nextClose), end: nextClose + closeTag.length };
        }
        i = nextClose + closeTag.length;
      }
    }
    // 兜底：返回剩余全部
    return { content: text.slice(startAfterDLp), end: text.length };
  }

  function parseDL(block, parentId, source) {
    // 逐项扫描：匹配 <DT> 开头的文件夹或书签
    const dtRegex = /<DT>\s*<H3[^>]*?(?:ADD_DATE="(\d*)")?[^>]*>([\s\S]*?)<\/H3>\s*<DL><p>|<DT>\s*<A\s+HREF="([^"]*)"[^>]*?(?:ADD_DATE="(\d*)")?[^>]*>([\s\S]*?)<\/A>/gi;
    let match;
    while ((match = dtRegex.exec(block)) !== null) {
      if (match[2] !== undefined) {
        // 文件夹：用栈计数方式提取完整的子 DL 内容
        const title = decodeHtmlEntities(match[2].replace(/<[^>]*>/g, '').trim());
        const addDate = parseAddDate(match[1]);
        const folderId = hashId(title, parentId);

        // 从 match 结束位置提取配对的 DL 块
        const dlResult = extractDLBlock(block, match.index + match[0].length);
        // 将正则游标跳到该 DL 块之后，避免重复匹配子内容
        dtRegex.lastIndex = dlResult.end;

        const childBlock = dlResult.content;

        // 检查是否为顶层特殊文件夹（Chrome/Edge/Via 导出格式）
        if (parentId === ROOT_ID) {
          const lowerTitle = title.toLowerCase();
          if (FOLDER_TITLES.bookmarkBar.some(ft => lowerTitle.includes(ft.toLowerCase()))) {
            parseDL(childBlock, ROOT_ID, 'bar');
            continue;
          } else if (FOLDER_TITLES.otherBookmarks.some(ft => lowerTitle.includes(ft.toLowerCase()))) {
            bookmarks.push({
              id: folderId,
              title: title,
              url: '',
              isFolder: true,
              parentId: ROOT_ID,
              addedAt: addDate,
              source: 'other',
              color: '', favicon: '', customIcon: ''
            });
            parseDL(childBlock, folderId, null);
            continue;
          } else if (FOLDER_TITLES.mobileBookmarks.some(ft => lowerTitle.includes(ft.toLowerCase()))) {
            bookmarks.push({
              id: folderId,
              title: title,
              url: '',
              isFolder: true,
              parentId: ROOT_ID,
              addedAt: addDate,
              source: 'mobile',
              color: '', favicon: '', customIcon: ''
            });
            parseDL(childBlock, folderId, null);
            continue;
          } else if (FOLDER_TITLES.berryHome.some(ft => lowerTitle.includes(ft.toLowerCase()))) {
            continue;
          }
        }

        // 兼容旧格式：嵌套的同名特殊文件夹
        const lowerTitle2 = title.toLowerCase();
        if (FOLDER_TITLES.otherBookmarks.some(ft => lowerTitle2.includes(ft.toLowerCase())) ||
            FOLDER_TITLES.mobileBookmarks.some(ft => lowerTitle2.includes(ft.toLowerCase())) ||
            FOLDER_TITLES.bookmarkBar.some(ft => lowerTitle2.includes(ft.toLowerCase()))) {
          parseDL(childBlock, parentId, source);
          continue;
        }

        bookmarks.push({
          id: folderId,
          title: title,
          url: '',
          isFolder: true,
          parentId: parentId,
          addedAt: addDate,
          source: parentId === ROOT_ID ? source : '',
          color: '',
          favicon: '',
          customIcon: ''
        });
        parseDL(childBlock, folderId, null);
      } else if (match[3] !== undefined) {
        // 书签
        // ★ 实体解码必须发生在 normalizeUrl 之前：写端把 & 写成 &#38; 时，
        //   其中的 '#' 会被 new URL() 当成 fragment 起点，查询串被整段丢弃
        //   （实测 ?q=a&b=c → ?q=a&，等于篡改书签地址）。
        const url = decodeHtmlEntities(match[3]);
        // 标题：必须先去标签再解码（顺序反了会把 &lt;b&gt; 变成真标签后误删）
        const title = decodeHtmlEntities((match[5] || '').replace(/<[^>]*>/g, '').trim());
        const addDate = parseAddDate(match[4]);
        const fixedUrl = normalizeUrl(url);
        if (!fixedUrl) continue;
        const bookmarkId = hashId(fixedUrl + '\x01' + title, parentId);
        bookmarks.push({
          id: bookmarkId,
          title: title,
          url: fixedUrl,
          isFolder: false,
          parentId: parentId,
          addedAt: addDate,
          source: parentId === ROOT_ID ? source : '',
          color: '',
          favicon: '',
          customIcon: ''
        });
      }
    }
  }

  // 解析根 DL 内容，parseDL 会自动识别顶层特殊文件夹
  const topDLMatch = html.match(/<H1>.*?<\/H1>\s*<DL><p>([\s\S]*)<\/DL><p>\s*$/i);
  const content = topDLMatch ? topDLMatch[1] : html;
  parseDL(content, ROOT_ID, 'bar');
  return bookmarks;
}

// ========== 扁平列表 → HTML ==========
// 将扁平列表序列化为标准 Netscape Bookmark HTML
// Via 不区分书签栏/其他书签，只输出 source='bar' 的内容统一平铺
function serializeToHtml(bookmarkList) {
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file.',
    '     It will be read and overwritten.',
    '     DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>'
  ];

  // 构建 parentId → children 索引
  const childrenOf = new Map();
  for (const n of bookmarkList) {
    if (!childrenOf.has(n.parentId)) childrenOf.set(n.parentId, []);
    childrenOf.get(n.parentId).push(n);
  }

  function addDateAttr(addedAt) {
    if (!addedAt) return '';
    // 毫秒 → 秒
    const sec = Math.floor(addedAt / 1000);
    return ` ADD_DATE="${sec}"`;
  }

  function escapeHtml(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function writeNode(node, indent) {
    const prefix = '  '.repeat(indent);
    if (node.isFolder) {
      lines.push(`${prefix}<DT><H3${addDateAttr(node.addedAt)}>${escapeHtml(node.title)}</H3>`);
      lines.push(`${prefix}<DL><p>`);
      const children = childrenOf.get(node.id) || [];
      for (const child of children) {
        writeNode(child, indent + 1);
      }
      lines.push(`${prefix}</DL><p>`);
    } else {
      lines.push(`${prefix}<DT><A HREF="${escapeHtml(node.url || '')}"${addDateAttr(node.addedAt)}>${escapeHtml(node.title)}</A>`);
    }
  }

  // 按 source 分组输出根级节点
  // source='bar' → 直接平铺；source='other' → 包一层"其他收藏夹"；source='mobile' → 包一层"移动收藏夹"；source='home' → 由 favorites.txt 处理，跳过
  const rootNodes = bookmarkList.filter(n => n.parentId === ROOT_ID);

  // 收集各 source 的根级节点
  const barNodes = [];
  let otherNode = null;
  let mobileNode = null;

  for (const node of rootNodes) {
    // 跳过虚拟容器节点
    if (node.id === HOME_FOLDER_ID || node.id === MOBILE_FOLDER_ID) continue;
    // source='home' 由 favorites.txt 处理，不写进 HTML
    if (node.source === 'home') continue;
    if (node.source === 'other') {
      if (node.isFolder && !otherNode) otherNode = node;
      continue;
    }
    if (node.source === 'mobile') {
      if (node.isFolder && !mobileNode) mobileNode = node;
      continue;
    }
    // source='bar' 或 source 为空 → 平铺
    barNodes.push(node);
  }

  // 输出书签栏内容（平铺）
  for (const node of barNodes) {
    writeNode(node, 1);
  }

  // 输出其他收藏夹（包一层文件夹）
  if (otherNode) {
    lines.push(`  <DT><H3${addDateAttr(otherNode.addedAt)}>${escapeHtml(otherNode.title)}</H3>`);
    lines.push(`  <DL><p>`);
    const otherNodeChildren = childrenOf.get(otherNode.id) || [];
    for (const child of otherNodeChildren) {
      writeNode(child, 2);
    }
    lines.push(`  </DL><p>`);
  }

  // 输出移动收藏夹（包一层文件夹）
  if (mobileNode) {
    lines.push(`  <DT><H3${addDateAttr(mobileNode.addedAt)}>${escapeHtml(mobileNode.title)}</H3>`);
    lines.push(`  <DL><p>`);
    const mobileNodeChildren = childrenOf.get(mobileNode.id) || [];
    for (const child of mobileNodeChildren) {
      writeNode(child, 2);
    }
    lines.push(`  </DL><p>`);
  }

  lines.push('</DL><p>');
  return lines.join('\n');
}

// ========== WebDAV 操作 ==========

// 下载 Via 的 bookmarks.html
async function downloadViaBookmarks() {
  const config = await getWebDAVConfig();
  if (!config.url || !config.user || !config.password) throw new Error('Via WebDAV 未配置');
  const viaPath = await getViaPath();
  if (!viaPath) throw new Error('Via 路径未配置');
  const fullUrl = joinWebDAVUrl(config.url, viaPath + '/' + VIA_FILE);
  try {
    const response = await fetch(fullUrl, {
      method: 'GET',
      cache: 'no-store',
      headers: {
        'Authorization': getAuthHeader(config.user, config.password),
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`读取 Via 文件失败: ${response.status}`);
    return await response.text();
  } catch (e) {
    console.warn('[sync] 读取 Via 文件异常:', e.message);
    throw e;
  }
}

// 上传 HTML 到 WebDAV
async function uploadViaHtml(html) {
  const config = await getWebDAVConfig();
  if (!config.url || !config.user || !config.password) throw new Error('Via WebDAV 未配置');
  const viaPath = await getViaPath();
  if (!viaPath) throw new Error('Via 路径未配置');
  await ensureWebDAVDir(config.url, viaPath, config.user, config.password);
  const fullUrl = joinWebDAVUrl(config.url, viaPath + '/' + VIA_FILE);
  const response = await fetch(fullUrl, {
    method: 'PUT',
    headers: {
      'Authorization': getAuthHeader(config.user, config.password),
      'Content-Type': 'text/html; charset=utf-8'
    },
    body: html
  });
  if (!response.ok) throw new Error(`写入 Via 文件失败: ${response.status}`);
}

// ========== 桥接逻辑 ==========

// 将合并结果写回 Via（HTML + favorites.txt）
async function patchViaFile(mergedList) {
  const results = {};
  for (const [name, upload, serialize] of [
    ['html', uploadViaHtml, serializeToHtml],
    ['favorites', uploadViaFavorites, serializeToFavoritesTxt]
  ]) {
    try {
      await upload(serialize(mergedList));
      results[name] = { status: 'success' };
    } catch (e) {
      results[name] = { status: 'failed', error: e.message };
      console.warn(`[sync] Via ${name} 写回失败:`, e.message);
    }
  }
  return results;
}

// 从 Via 读取变更并合并到当前列表（HTML + favorites.txt）
async function mergeViaData(currentList, tombstoneKeys = null) {
  const result = await mergeViaDataWithChanges(currentList, tombstoneKeys);
  if (result.complete && result.snapshotUpdates) await chrome.storage.local.set(result.snapshotUpdates);
  return result.list;
}

async function mergeViaDataWithChanges(currentList, tombstoneKeys = null) {
  const changes = { list: currentList, deletedIds: [], deletedPathKeys: [], complete: true, errors: [] };
  // 计数：供末尾「处理完成」日志展示差异构成（声明在函数级，块内赋值）
  let viaNewCount = 0, homeNewCount = 0;
  // ★ 收集所有"来自 Via 文件"的 pathKey（HTML + favorites），
  //   用于删除检测时正确圈定 Via 负责的节点（含嵌套子书签，其 source 为空）。
  const viaAllPKSet = new Set();
  let viaList = []; // 提前声明，避免 html 下载失败时后面删除检测引用报错
  // ===== 1. 合并 bookmarks.html（source='bar'/'other'/'mobile'）=====
  let html;
  try {
    html = await downloadViaBookmarks();
    if (html === null) throw new Error('Via bookmarks.html 不存在');
    if (typeof html !== 'string' || !/<DL\b[^>]*>/i.test(html) || !/<\/DL\s*>/i.test(html)) {
      throw new Error('Via bookmarks.html 格式无效');
    }
  } catch (e) {
    changes.complete = false;
    changes.errors.push(e.message);
  }

  if (changes.complete && html) {
    viaList = parseHtmlToBookmarks(html);
    if (viaList.length > 0) {
      const currentPKs = computePathKeys(currentList);
      const viaPKs = computePathKeys(viaList);
      for (const pk of viaPKs.values()) viaAllPKSet.add(pk);
      const currentPKSet = new Set(currentPKs.values());

      const viaIdToPK = new Map();
      for (const n of viaList) {
        const pk = viaPKs.get(n.id);
        if (pk) viaIdToPK.set(n.id, pk);
      }

      const currentPKToId = new Map();
      for (const n of currentList) {
        const pk = currentPKs.get(n.id);
        if (pk) currentPKToId.set(pk, n.id);
      }

      // 构建去重索引：目录层级 + 标题 + URL
      function getParentPath(pk) {
        if (!pk) return '';
        const lastSlash = pk.lastIndexOf('/');
        return lastSlash > 0 ? pk.substring(0, lastSlash) : pk;
      }
      const currentDupIndex = new Map();
      for (const n of currentList) {
        const pk = currentPKs.get(n.id);
        const parentPath = getParentPath(pk);
        const key = n.isFolder
          ? `${parentPath}/F:${n.title}`
          : `${parentPath}/L:${n.title}:${(n.url || '').replace(/&amp;/g, '&')}`;
        if (!currentDupIndex.has(key)) currentDupIndex.set(key, n.id);
      }
      // ★ URL 精确匹配集：用于 fallback 去重（覆盖 parentPath 不一致但实际是同一书签的场景）
      const localUrlSet = new Set(
        currentList.filter(n => !n.isFolder && n.url).map(n => n.url.replace(/&amp;/g, '&').replace(/\/$/, ''))
      );

      let dedupByPath = 0, dedupByUrl = 0, dedupFolderByName = 0;
      // ★ 文件夹标题集：用于 fallback 匹配（覆盖 parentPath 不一致但实际是同一文件夹的场景）
      const localFolderTitles = new Set(
        currentList.filter(n => n.isFolder).map(n => n.title)
      );
      const viaNew = viaList.filter(n => {
        const pk = viaPKs.get(n.id);
        if (!pk || currentPKSet.has(pk)) return false;
        // 被 tombstone 标记删除的不当作新增
        if (tombstoneKeys && tombstoneKeys.has(pk)) return false;
        // 补充去重：目录 + 标题 + URL 相同则视为重复
        const parentPath = getParentPath(pk);
        const dupKey = n.isFolder
          ? `${parentPath}/F:${n.title}`
          : `${parentPath}/L:${n.title}:${(n.url || '').replace(/&amp;/g, '&')}`;
        if (currentDupIndex.has(dupKey)) { dedupByPath++; return false; }
        // URL 精确匹配 fallback（覆盖路径不一致但实际是同一书签的场景）
        if (!n.isFolder && n.url) {
          const normalizedUrl = n.url.replace(/&amp;/g, '&').replace(/\/$/, '');
          if (localUrlSet && localUrlSet.has(normalizedUrl)) { dedupByUrl++; return false; }
        }
        // ★ 文件夹标题 fallback：若本地已有同名文件夹，视为重复
        //   场景：Via 文件里文件夹 parentPath=ROOT:other/F:X，本地同一文件夹
        //   parentPath=ROOT:home/F:X（Berry主页 映射导致路径分歧），
        //   上述两种去重都失效，但标题相同就是同一个文件夹。
        if (n.isFolder && n.title && localFolderTitles.has(n.title)) {
          dedupFolderByName++;
          return false;
        }
        return true;
      });
      if (viaNew.length > 0) {
        viaNewCount = viaNew.length;
        viaNew.sort((a, b) => {
          if (a.id === b.parentId) return -1;
          if (b.id === a.parentId) return 1;
          if (a.parentId === ROOT_ID && b.parentId !== ROOT_ID) return -1;
          if (b.parentId === ROOT_ID && a.parentId !== ROOT_ID) return 1;
          return 0;
        });

        const mappedNew = viaNew.map(n => {
          const copy = { ...n };
          if (copy.parentId && copy.parentId !== ROOT_ID) {
            const parentPK = viaIdToPK.get(copy.parentId);
            if (parentPK && currentPKToId.has(parentPK)) {
              copy.parentId = currentPKToId.get(parentPK);
            }
          }
          if (copy.isFolder) {
            const pk = viaPKs.get(n.id);
            if (pk) currentPKToId.set(pk, copy.id);
          }
          return copy;
        });

        currentList = [...currentList, ...mappedNew];
      }
    }
  }

  // ===== 2. 合并 favorites.txt（source='home'）=====
  let txt;
  try {
    txt = await downloadViaFavorites();
    if (txt === null) throw new Error('Via favorites.txt 不存在');
    if (typeof txt !== 'string') throw new Error('Via favorites.txt 格式无效');
    for (const line of txt.split('\n').filter(value => value.trim())) {
      const row = JSON.parse(line);
      if (!row || typeof row !== 'object' || typeof row.url !== 'string' || !row.url.trim() ||
          (row.title !== undefined && typeof row.title !== 'string') || !normalizeUrl(row.url)) {
        throw new Error('Via favorites.txt 书签节点格式无效');
      }
    }
  } catch (e) {
    changes.complete = false;
    changes.errors.push(e.message);
  }
  if (changes.complete && txt) {
    const homeList = parseFavoritesTxt(txt);
    if (homeList.length > 0) {
      // 确保 HOME_FOLDER_ID 容器节点存在（否则 pathKey 算不出来）
      if (!currentList.some(n => n.id === HOME_FOLDER_ID)) {
        currentList = [...currentList, {
          id: HOME_FOLDER_ID,
          title: '主页文件夹',
          url: '',
          isFolder: true,
          parentId: ROOT_ID,
          addedAt: Date.now(),
          color: '',
          favicon: '',
          customIcon: ''
        }];
      }

      const currentPKs2 = computePathKeys(currentList);
      const homePKs = computePathKeys(homeList);
      for (const pk of homePKs.values()) viaAllPKSet.add(pk);
      const currentPKSet2 = new Set(currentPKs2.values());

      // 构建去重索引：目录层级 + 标题 + URL
      function getParentPath2(pk) {
        if (!pk) return '';
        const lastSlash = pk.lastIndexOf('/');
        return lastSlash > 0 ? pk.substring(0, lastSlash) : pk;
      }
      const currentDupIndex2 = new Map();
      for (const n of currentList) {
        const pk = currentPKs2.get(n.id);
        const parentPath = getParentPath2(pk);
        const key = n.isFolder
          ? `${parentPath}/F:${n.title}`
          : `${parentPath}/L:${n.title}:${(n.url || '').replace(/&amp;/g, '&')}`;
        if (!currentDupIndex2.has(key)) currentDupIndex2.set(key, n.id);
      }
      // URL 匹配集（fallback）：归一化比较，http/https、www.、尾斜杠差异视为同一书签
      const localUrlSet2 = new Set(
        currentList.filter(n => !n.isFolder && n.url).map(n => normalizeUrlForDedup(n.url.replace(/&amp;/g, '&')))
      );

      const localFolderTitles2 = new Set(
        currentList.filter(n => n.isFolder).map(n => n.title)
      );
      const homeNew = homeList.filter(n => {
        const pk = homePKs.get(n.id);
        if (!pk || currentPKSet2.has(pk)) return false;
        if (tombstoneKeys && tombstoneKeys.has(pk)) return false;
        // 补充去重：目录 + 标题 + URL 相同则视为重复
        const parentPath = getParentPath2(pk);
        const dupKey = n.isFolder
          ? `${parentPath}/F:${n.title}`
          : `${parentPath}/L:${n.title}:${(n.url || '').replace(/&amp;/g, '&')}`;
        if (currentDupIndex2.has(dupKey)) return false;
        // URL 匹配 fallback（归一化）
        if (!n.isFolder && n.url) {
          const normalizedUrl = normalizeUrlForDedup(n.url.replace(/&amp;/g, '&'));
          if (localUrlSet2.has(normalizedUrl)) return false;
        }
        // 文件夹标题 fallback
        if (n.isFolder && n.title && localFolderTitles2.has(n.title)) return false;
        return true;
      });

      if (homeNew.length > 0) {
        homeNewCount = homeNew.length;
        currentList = [...currentList, ...homeNew];
      }
    }
  }

  // ===== 3. Via 删除检测（与 Berry 对称）=====
  // 上次 Via 有但现在没有 → Via 端删除 → 从 currentList 移除
  const allViaPKs = computePathKeys(currentList);
  // 当前 Via 负责的节点 = 本次从 Via 文件解析出的全部 pk（含嵌套子书签，其 source 为空），
  // 不再用 source 白名单圈定（空 source 子书签会被漏掉，导致 Via 端删除无法传播）。
  const viaPKSet = viaAllPKSet;
  // 对方节点的 URL / 文件夹标题集合：识别「父改名/移动导致 pathKey 变了，但并非真删」
  const viaUrlSet = new Set(
    viaList.filter(n => !n.isFolder && n.url).map(n => n.url.replace(/&amp;/g, '&').replace(/\/$/, ''))
  );
  const viaFolderTitles = new Set(
    viaList.filter(n => n.isFolder).map(n => n.title)
  );
  const viaSnapshotData = (await chrome.storage.local.get(['via_pathkey_snapshot']))['via_pathkey_snapshot'] || [];
  const viaSnapshotSet = new Set(viaSnapshotData);
  let viaDeletedCount = 0;
  if (changes.complete && viaSnapshotSet.size > 0) {
    const filteredCurrent = currentList.filter(n => {
      const pk = allViaPKs.get(n.id);
      if (!pk) return true;
      if (viaSnapshotSet.has(pk) && !viaPKSet.has(pk)) {
        // 改名/移动兜底：URL（书签）或标题（文件夹）仍存在于对方 → 只是路径变了，不是真删
        if (!n.isFolder && n.url) {
          const u = n.url.replace(/&amp;/g, '&').replace(/\/$/, '');
          if (viaUrlSet.has(u)) return true;
        }
        if (n.isFolder && n.title && viaFolderTitles.has(n.title)) return true;
        viaDeletedCount++;
        changes.deletedIds.push(n.id);
        changes.deletedPathKeys.push(pk);
        return false;
      }
      return true;
    });
    if (viaDeletedCount > 0) {
      currentList = filteredCurrent;
    }
  }

  // 保存 Via pathKey 快照（用于下次检测 Via 删除）
  if (changes.complete) changes.snapshotUpdates = { via_pathkey_snapshot: [...viaPKSet] };

  // Via 新增节点（来自 html/favorites 解析）无 _index → 补到同父已有节点之后
  MiniSync.utils.fillMissingSiblingIndex(currentList);
  console.log(`[sync] 📱 Via 处理完成: ${zoneSummary(currentList)}`);
  changes.list = currentList;
  return changes;
}

// ========== favorites.txt 读写（Berry 主页）==========
// 解析 favorites.txt（JSONL）→ 扁平列表，source='home'
function parseFavoritesTxt(txt) {
  if (!txt || typeof txt !== 'string') return [];
  const bookmarks = [];
  const lines = txt.split('\n').filter(l => l.trim());
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (!obj.url) continue;
      const fixedUrl = normalizeUrl(obj.url);
      if (!fixedUrl) continue;
      const title = (obj.title || '').trim();
      // 用与 hashId 相同的逻辑，但前缀改为 via_home_
      const str = String(fixedUrl + '\x01' + title) + '\x00' + String(ROOT_ID);
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        hash = ((hash << 5) - hash + c) | 0;
      }
      const id = 'via_home_' + Math.abs(hash).toString(36).slice(0, 10);
      bookmarks.push({
        id,
        title: title || fixedUrl,
        url: fixedUrl,
        isFolder: false,
        parentId: HOME_FOLDER_ID,
        addedAt: Date.now(),
        source: 'home',
        color: '',
        favicon: '',
        customIcon: '',
        _otherIndex: typeof obj.order === 'number' ? obj.order : 0
      });
    } catch (e) {
      // 跳过非法行
    }
  }
  return bookmarks;
}

// 将扁平列表序列化为 favorites.txt（JSONL）
function serializeToFavoritesTxt(bookmarkList) {
  const lines = [];
  let order = 0;
  for (const n of bookmarkList) {
    // 匹配 Berry 主页节点：source='home' 或 parentId=HOME_FOLDER_ID
    if (n.source !== 'home' && n.parentId !== HOME_FOLDER_ID) continue;
    // 跳过容器节点本身和文件夹
    if (n.id === HOME_FOLDER_ID) continue;
    if (n.isFolder) continue;
    lines.push(JSON.stringify({
      title: n.title || '',
      url: n.url,
      order: order++
    }));
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

// 下载 favorites.txt
async function downloadViaFavorites() {
  const config = await getWebDAVConfig();
  if (!config.url || !config.user || !config.password) throw new Error('Via WebDAV 未配置');
  const viaPath = await getViaPath();
  if (!viaPath) throw new Error('Via 路径未配置');
  const fullUrl = joinWebDAVUrl(config.url, viaPath + '/' + VIA_FAVORITES_FILE);
  try {
    const response = await fetch(fullUrl, {
      method: 'GET',
      cache: 'no-store',
      headers: {
        'Authorization': getAuthHeader(config.user, config.password),
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`读取 Via favorites.txt 失败: ${response.status}`);
    return await response.text();
  } catch (e) {
    console.warn('[sync] 读取 Via favorites.txt 异常:', e.message);
    throw e;
  }
}

// 上传 favorites.txt 到 WebDAV
async function uploadViaFavorites(txt) {
  const config = await getWebDAVConfig();
  if (!config.url || !config.user || !config.password) throw new Error('Via WebDAV 未配置');
  const viaPath = await getViaPath();
  if (!viaPath) throw new Error('Via 路径未配置');
  await ensureWebDAVDir(config.url, viaPath, config.user, config.password);
  const fullUrl = joinWebDAVUrl(config.url, viaPath + '/' + VIA_FAVORITES_FILE);
  const response = await fetch(fullUrl, {
    method: 'PUT',
    headers: {
      'Authorization': getAuthHeader(config.user, config.password),
      'Content-Type': 'text/plain; charset=utf-8'
    },
    body: txt
  });
  if (!response.ok) throw new Error(`写入 Via favorites.txt 失败: ${response.status}`);
}

// 挂载到 MiniSync，供 sync-orchestrator 在合并阶段调用
MiniSync.via = {
  mergeViaData,
  mergeViaDataWithChanges,
  patchViaFile
};
