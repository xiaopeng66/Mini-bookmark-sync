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
    .replace(/&#(\d+);/g, (_, d) => {
      const code = Number(d);
      // ★ 非 BMP 码点必须用 fromCodePoint：旧实现 fromCharCode(128512) 会截断成 \uF600，
      //   emoji 标题在往返后变成乱码（审计 2026-10-11 复现）。
      return Number.isFinite(code) && code >= 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : _;
    })
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : _;
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// 存储用的 URL 规范化：去首尾空白 + 剥路径尾部斜杠（沿用既有存储口径），
// 但**保留 fragment**。
// ★ 不能在这里剥 fragment：`https://app.invalid/#/inbox` 是完整地址，旧实现的
//   `obj.hash = ''` 把用户书签改写成 `https://app.invalid`（审计复现 via-fragment-url...）。
//   带 fragment 时不做尾斜杠裁剪，避免把 `.../#/` 这类地址截成另一种写法。
//   去重/身份比较另有 normalizeUrlForDedup，两者不要混用。
function normalizeStoredUrl(url) {
  if (!url) return '';
  const trimmed = String(url).trim();
  if (!trimmed || /#/.test(trimmed)) return trimmed;
  return trimmed.replace(/\/+$/, '');
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

  // 从一个标签串里取属性值（双引号/单引号/无引号都认，属性顺序无关）。
  // ★ 旧实现在大正则里写死 `<A\s+HREF="..."`：属性顺序一变（合法 HTML）或写成单引号，
  //   整条书签读不到，而文件仍被判为「读取完整」→ 上一轮快照里的书签被当成手机端删除，
  //   本地与主 XBEL 一起被删（审计 2026-10-11 复现）。这里对合法书写形式一视同仁。
  function parseAttrs(tagText) {
    const attrs = new Map();
    let rest = tagText;
    while (rest.trim()) {
      // Consume the whole attribute list. An unmatched quote must never fall
      // through to the unquoted alternative or match a suffix such as DATA-HREF.
      const attr = /^\s+([^\s"'<>/=`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`=]+)))?/.exec(rest);
      if (!attr) throw new Error('Via bookmarks.html 属性格式无效');
      const key = attr[1].toUpperCase();
      if (attrs.has(key)) throw new Error('Via bookmarks.html 属性重复');
      attrs.set(key, attr[2] ?? attr[3] ?? attr[4] ?? '');
      rest = rest.slice(attr[0].length);
    }
    return attrs;
  }

  function attrValue(tagText, name) {
    return parseAttrs(tagText).get(name.toUpperCase()) || '';
  }

  // Check every item, not just successfully parsed ones: a partial export must
  // not authorize deletions. Quoted '>' is data, not the end of a tag.
  const attributeText = `(?:[^<>"']|"[^"]*"|'[^']*')*`;
  // Consume whole quoted tags before looking for comments, so <!--...--> in
  // an HREF remains data. The final alternative catches a truncated <DT that
  // would otherwise leave a valid-looking anchor invisible to parseDL.
  const markup = /<!--[\s\S]*?-->|<(?:[^<>"']|"[^"]*"|'[^']*')*>|<DT\b/gi;
  html = html.replace(markup, tag => {
    if (tag.startsWith('<!--')) return '';
    if (/^<DT\b/i.test(tag) && !/^<DT>$/i.test(tag)) {
      throw new Error('Via bookmarks.html DT 标签格式无效');
    }
    return tag;
  });
  const itemStart = /<(A|H3)\b/gi;
  const itemHead = new RegExp('<(A|H3)\\b(' + attributeText + ')>', 'iy');
  let item;
  while ((item = itemStart.exec(html))) {
    itemHead.lastIndex = item.index;
    const head = itemHead.exec(html);
    if (!head) throw new Error('Via bookmarks.html 标签格式无效');
    const attrs = parseAttrs(head[2]);
    if (head[1].toUpperCase() === 'A' && !decodeHtmlEntities(attrs.get('HREF')).trim()) {
      throw new Error('Via bookmarks.html 书签地址缺失');
    }
    const close = new RegExp('</' + head[1] + '\\s*>', 'gi');
    close.lastIndex = itemHead.lastIndex;
    const end = close.exec(html);
    if (!end || /<(?:A|H3|DT|DL)\b/i.test(html.slice(itemHead.lastIndex, end.index))) {
      throw new Error('Via bookmarks.html 书签标签不完整');
    }
    itemStart.lastIndex = close.lastIndex;
  }

  function parseDL(block, parentId, source) {
    // 逐项扫描：按 <DT> 切分后再判断这一项是文件夹还是书签。
    // 属性解析交给 attrValue —— 不再依赖固定书写顺序与引号风格（两者都是合规 HTML）。
    const dtRegex = new RegExp('<DT>\\s*(?:<H3\\b(' + attributeText + ')>([\\s\\S]*?)<\\/H3\\s*>\\s*<DL\\b[^>]*>|<A\\b(' + attributeText + ')>([\\s\\S]*?)<\\/A\\s*>)', 'gi');
    let match;
    while ((match = dtRegex.exec(block)) !== null) {
      if (match[2] !== undefined) {
        // 文件夹：用栈计数方式提取完整的子 DL 内容
        const title = decodeHtmlEntities(match[2].replace(/<[^>]*>/g, '').trim());
        const addDate = parseAddDate(attrValue(match[1], 'ADD_DATE'));
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
        const url = decodeHtmlEntities(attrValue(match[3], 'HREF'));
        // 标题：必须先去标签再解码（顺序反了会把 &lt;b&gt; 变成真标签后误删）
        const title = decodeHtmlEntities((match[4] || '').replace(/<[^>]*>/g, '').trim());
        const addDate = parseAddDate(attrValue(match[3], 'ADD_DATE'));
        const fixedUrl = normalizeStoredUrl(url);
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
  return MiniSync.webdav.getFile(config.url, config.user, config.password, viaPath + '/' + VIA_FILE);
}

// 上传 HTML 到 WebDAV
async function uploadViaHtml(html) {
  const config = await getWebDAVConfig();
  if (!config.url || !config.user || !config.password) throw new Error('Via WebDAV 未配置');
  const viaPath = await getViaPath();
  if (!viaPath) throw new Error('Via 路径未配置');
  await ensureWebDAVDir(config.url, viaPath, config.user, config.password);
  return MiniSync.webdav.putFile(config.url, config.user, config.password,
    viaPath + '/' + VIA_FILE, html, 'text/html; charset=utf-8');
}

// ========== 桥接逻辑 ==========

// 将合并结果写回 Via（HTML + favorites.txt）
async function patchViaFile(mergedList) {
  const results = {};
  const written = {};
  for (const [name, upload, serialize] of [
    ['html', uploadViaHtml, serializeToHtml],
    ['favorites', uploadViaFavorites, serializeToFavoritesTxt]
  ]) {
    try {
      written[name] = serialize(mergedList);
      await upload(written[name]);
      results[name] = { status: 'success' };
    } catch (e) {
      results[name] = { status: 'failed', error: e.message };
      console.warn(`[sync] Via ${name} 写回失败:`, e.message);
    }
  }
  if (results.html.status === 'success' && results.favorites.status === 'success') {
    results.snapshotUpdates = await MiniSync.berry.bridgeIdentity.snapshotUpdates('via_pathkey_snapshot',
      await MiniSync.utils.bridgeResourceUrl('via'),
      [...parseHtmlToBookmarks(written.html), ...parseFavoritesTxt(written.favorites)]);
  }
  return results;
}

// 从 Via 读取变更并合并到当前列表（HTML + favorites.txt）
async function mergeViaData(currentList, tombstoneKeys = null) {
  const result = await mergeViaDataWithChanges(currentList, tombstoneKeys);
  if (result.complete && result.snapshotUpdates) await chrome.storage.local.set(result.snapshotUpdates);
  return result.list;
}

async function mergeViaDataWithChanges(currentList, tombstoneKeys = null, bridgeContext = null) {
  try {
    const html = await downloadViaBookmarks();
    if (html === null) throw new Error('Via bookmarks.html 不存在');
    if (typeof html !== 'string' || !/<DL\b[^>]*>/i.test(html) || !/<\/DL\s*>/i.test(html)) {
      throw new Error('Via bookmarks.html 格式无效');
    }
    const viaList = parseHtmlToBookmarks(html);
    if (viaList.length === 0 && /<(?:A|H3)\b/i.test(html)) {
      throw new Error('Via bookmarks.html 内容无法解析（格式不兼容）');
    }
    const downloadedFavorites = await downloadViaFavorites();
    const txt = downloadedFavorites === null ? '' : downloadedFavorites;
    if (typeof txt !== 'string') throw new Error('Via favorites.txt 格式无效');
    for (const line of txt.split('\n').filter(value => value.trim())) {
      const row = JSON.parse(line);
      if (!row || typeof row !== 'object' || typeof row.url !== 'string' || !row.url.trim() ||
          (row.title !== undefined && typeof row.title !== 'string') || !normalizeStoredUrl(row.url)) {
        throw new Error('Via favorites.txt 书签节点格式无效');
      }
    }
    const phoneList = [...viaList, ...parseFavoritesTxt(txt)];
    let input = currentList;
    if (phoneList.some(n => n.source === 'home') && !input.some(n => n.id === HOME_FOLDER_ID)) {
      input = [...input, { id: HOME_FOLDER_ID, title: '主页文件夹', isFolder: true, parentId: ROOT_ID }];
    }
    const changes = await MiniSync.berry.bridgeIdentity.merge({ kind: 'via', storageKey: 'via_pathkey_snapshot',
      owner: await MiniSync.utils.bridgeResourceUrl('via'), currentList: input, phoneList,
      tombstoneKeys, context: bridgeContext, stableIds: false });
    console.log(`[sync] Via 处理完成: ${zoneSummary(changes.list)}`);
    return changes;
  } catch (e) {
    return { list: currentList, deletedIds: [], deletedPathKeys: [], complete: false, errors: [e.message] };
  }
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
      const fixedUrl = normalizeStoredUrl(obj.url);
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
  return MiniSync.webdav.getFile(config.url, config.user, config.password, viaPath + '/' + VIA_FAVORITES_FILE);
}

// 上传 favorites.txt 到 WebDAV
async function uploadViaFavorites(txt) {
  const config = await getWebDAVConfig();
  if (!config.url || !config.user || !config.password) throw new Error('Via WebDAV 未配置');
  const viaPath = await getViaPath();
  if (!viaPath) throw new Error('Via 路径未配置');
  await ensureWebDAVDir(config.url, viaPath, config.user, config.password);
  return MiniSync.webdav.putFile(config.url, config.user, config.password,
    viaPath + '/' + VIA_FAVORITES_FILE, txt, 'text/plain; charset=utf-8');
}

// 挂载到 MiniSync，供 sync-orchestrator 在合并阶段调用
MiniSync.via = {
  mergeViaData,
  mergeViaDataWithChanges,
  patchViaFile
};
