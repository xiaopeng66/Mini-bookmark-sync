// xbel.js — XBEL 数据层核心
// Service Worker 中无 DOM API，全部使用纯字符串构建和正则解析
// 数据流向：
//   A-P1 上传：Chrome书签树 → chromeToXbel() → XML字符串 → WebDAV PUT
//   B-P2 下载：WebDAV GET → xbelToJson() → JSON中间态 → importBookmarksFromData()

MiniSync.xbel = (function() {

// ====== 内部常量（与 constants.js 保持同步）======
const ROOT_ID = 'root';
const HOME_FOLDER_ID = '__home_folder__';
const MOBILE_FOLDER_ID = '__mobile_folder__';

// 三区文件夹名称（XBEL 固定使用中文）
const XBEL_FOLDER_NAMES = {
  bar: '书签栏',
  other: '其他收藏夹',
  mobile: '移动收藏夹',
  // home 区标准名（由「Berry主页」更名而来）：chromeToXbel 落盘时统一写此名；
  // 识别端经 FOLDER_TITLES.berryHome 别名表兼容旧名，老用户云端数据无感迁移。
  berryHome: '移动端主页'
};

// ========== XBEL 模板常量 ==========
const XBEL_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE xbel PUBLIC "+//IDN python.org//DTD XBEL 1.0//EN" "http://www.python.org/topics/dtd/xbel-1.0.dtd">\n';
const XBEL_VERSION = '1.0';
const METADATA_OWNER = 'mini-sync';

// ========== XML 转义工具 ==========

function escapeXml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeAttr(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 构建 metadata 子元素字符串 */
function buildMetadataXml(props) {
  if (!props || Object.keys(props).length === 0) return '';
  const parts = [];
  for (const [key, val] of Object.entries(props)) {
    if (val == null) continue;
    parts.push(`<prop key="${escapeAttr(key)}">${escapeXml(String(val))}</prop>`);
  }
  if (parts.length === 0) return '';
  return `<info><metadata owner="${METADATA_OWNER}">${parts.join('')}</metadata></info>`;
}


function sanitizeEndpoints(value) {
  if (Array.isArray(value)) return value.map(sanitizeEndpoints);
  if (!value || typeof value !== 'object') return value;
  const clean = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/password|passwd|secret|token|credential|authorization|api.?key|username|user(name)?|^auth$/i.test(key)) continue;
    if (/url|uri|endpoint|server|host/i.test(key) && typeof entry === 'string') {
      try {
        const url = new URL(entry);
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        clean[key] = url.toString();
      } catch (_) { /* Unknown endpoint formats may contain credentials; omit them. */ }
    } else {
      clean[key] = sanitizeEndpoints(entry);
    }
  }
  return clean;
}

/** Validate XML structure before the tolerant XBEL tree scanner runs. */
function validateXbel(xml) {
  if (typeof xml !== 'string' || !xml.trim()) throw new Error('Invalid XBEL document');
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/?[A-Za-z][\w:.-]*(?:\s+(?:[^<>"']|"[^"]*"|'[^']*')*)?\s*\/?>/g;
  const invalidEntity = /&(?!(?:#(?:[0-9]+|x[0-9A-Fa-f]+)|[A-Za-z_:][\w:.-]*);)/;
  let pos = 0;
  let rootCount = 0;
  const stack = [];
  let token;
  while ((token = tokens.exec(xml))) {
    const between = xml.slice(pos, token.index);
    if (between.includes('<') || invalidEntity.test(between) || (!stack.length && between.trim())) throw new Error('Malformed XBEL XML');
    pos = tokens.lastIndex;
    const tag = token[0];
    if (tag.startsWith('<!--') || tag.startsWith('<?') || tag.startsWith('<!DOCTYPE')) {
      if (stack.length) throw new Error('Malformed XBEL XML');
      continue;
    }
    if (tag.startsWith('<![CDATA[')) {
      if (!stack.length) throw new Error('Malformed XBEL XML');
      continue;
    }
    const name = /^<\/?([A-Za-z][\w:.-]*)/.exec(tag)[1];
    if (tag.startsWith('</')) {
      if (!/^<\/[A-Za-z][\w:.-]*\s*>$/.test(tag) || stack.pop() !== name) throw new Error('Malformed XBEL XML');
    } else {
      let attributes = tag.slice(name.length + 1, tag.length - (tag.endsWith('/>') ? 2 : 1));
      while (attributes.trim()) {
        const attribute = /^\s+[A-Za-z_:][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*')/.exec(attributes);
        if (!attribute || invalidEntity.test(attribute[0])) throw new Error('Malformed XBEL XML');
        attributes = attributes.slice(attribute[0].length);
      }
      if (!stack.length) {
        if (name !== 'xbel' || rootCount++) throw new Error('Invalid XBEL root');
      }
      if (!tag.endsWith('/>')) stack.push(name);
    }
  }
  if (xml.slice(pos).trim() || stack.length || rootCount !== 1) throw new Error('Malformed XBEL XML');
  return xml.replace(/<xbel\b([^<>]*?)\s*\/>/, '<xbel$1></xbel>');
}

// 核心：扁平 JSON → XBEL XML 字符串

/** 将插件数据对象转换为 XBEL XML 字符串 */
function jsonToXbel(pluginData) {
  const bookmarks = (pluginData && pluginData.bookmarks) || [];

  // 按 parentId 分组构建树结构
  const childrenMap = new Map(); // parentId → [nodes]
  for (const bm of bookmarks) {
    const pid = bm.parentId || ROOT_ID;
    if (!childrenMap.has(pid)) childrenMap.set(pid, []);
    childrenMap.get(pid).push(bm);
  }

  // 递归渲染 folder 及其子节点
  function renderFolderContents(parentId, indent) {
    const children = childrenMap.get(parentId) || [];
    if (children.length === 0) return '';

    const lines = [];
    for (const node of children) {
      if (node.isFolder) {
        // Virtual containers are rendered in their dedicated sections below.
        if (node.id === HOME_FOLDER_ID || node.id === MOBILE_FOLDER_ID) continue;

        const metaProps = {};
        if (node.addedAt != null) metaProps.addedAt = node.addedAt;
        if (node.color != null) metaProps.color = node.color;
        if (node.id != null) metaProps.id = node.id;
        if (node.source) metaProps.source = node.source;
        if (node._otherIndex != null) metaProps._otherIndex = node._otherIndex;

        const metaXml = buildMetadataXml(metaProps);
        const subIndent = indent + '  ';
        const subContent = renderFolderContents(node.id, subIndent);

        lines.push(`${indent}<folder>`);
        lines.push(`${indent}  <title>${escapeXml(node.title || '')}</title>`);
        if (metaXml) lines.push(indent + '  ' + metaXml);
        if (subContent) lines.push(subContent);
        lines.push(`${indent}</folder>`);

      } else {
        // bookmark 叶节点
        const metaProps = {};
        if (node.addedAt != null) metaProps.addedAt = node.addedAt;
        if (node.color != null) metaProps.color = node.color;
        if (node.favicon != null) metaProps.favicon = node.favicon;
        if (node.customIcon != null) metaProps.customIcon = node.customIcon;
        if (node.id != null) metaProps.id = node.id;
        if (node.source) metaProps.source = node.source;

        const metaXml = buildMetadataXml(metaProps);

        lines.push(`${indent}<bookmark href="${escapeAttr(node.url || '')}">`);
        lines.push(`${indent}  <title>${escapeXml(node.title || '')}</title>`);
        if (metaXml) lines.push(indent + '  ' + metaXml);
        lines.push(`${indent}</bookmark>`);
      }
    }

    return lines.join('\n');
  }

  // 构建三区根文件夹内容
  const barContent = renderFolderContents(ROOT_ID, '    ');
  // Each ROOT_ID child belongs to the single sync bucket. Home and mobile use their own virtual roots.
  // Berry 主页（HOME_FOLDER_ID）下的内容归入 other 区
  const berryContent = renderFolderContents(HOME_FOLDER_ID, '      ');
  let otherBody = '';
  // Berry 主页作为其他收藏夹下的第一个子文件夹
  let otherFolderBody = '';
  if (berryContent) {
    otherFolderBody += `      <folder>\n        <title>${escapeXml(XBEL_FOLDER_NAMES.berryHome)}</title>\n${berryContent}\n      </folder>\n`;
  }
  otherFolderBody += otherBody;

  const mobileContent = renderFolderContents(MOBILE_FOLDER_ID, '    ');

  // 全局 metadata
  const globalMeta = {};
  if (pluginData.lastModified) globalMeta.lastModified = pluginData.lastModified;
  if (pluginData.deviceId) globalMeta.deviceId = pluginData.deviceId;
  if (pluginData.version) globalMeta.version = pluginData.version;
  if (pluginData.tombstones && Array.isArray(pluginData.tombstones)) {
    globalMeta.tombstones = JSON.stringify(pluginData.tombstones);
  }
  if (pluginData.endpoints) {
    globalMeta.endpoints = JSON.stringify(sanitizeEndpoints(pluginData.endpoints));
  }
  if (pluginData.snapshots) {
    globalMeta.snapshots = JSON.stringify(pluginData.snapshots);
  }
  const rootMetaXml = buildMetadataXml(globalMeta);

  // 拼装完整文档
  let xml = XBEL_HEADER + `<xbel version="${XBEL_VERSION}">`;
  if (rootMetaXml) xml += '\n' + rootMetaXml;

  xml += `\n  <folder>\n    <title>${escapeXml(XBEL_FOLDER_NAMES.bar)}</title>\n`;
  if (barContent) xml += barContent + '\n';
  xml += `  </folder>`;

  xml += `\n  <folder>\n    <title>${escapeXml(XBEL_FOLDER_NAMES.other)}</title>\n`;
  if (otherFolderBody) xml += otherFolderBody + '\n';
  xml += `  </folder>`;

  xml += `\n  <folder>\n    <title>${escapeXml(XBEL_FOLDER_NAMES.mobile)}</title>\n`;
  if (mobileContent) xml += mobileContent + '\n';
  xml += `  </folder>`;

  xml += '\n</xbel>\n';

  return xml;
}


// ================================================================
//  核心：XBEL XML 字符串 → 扁平 JSON
// ================================================================

function parseAttributes(attrStr) {
  const attrs = new Map();
  const attrRegex = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = attrRegex.exec(attrStr)) !== null) {
    attrs.set(match[1], match[2] == null ? match[3] : match[2]);
  }
  return attrs;
}

/**
 * 从 XML 文本中提取所有指定标签（正确处理嵌套同名标签）
 * 使用深度计数器手动扫描，确保每个开标签匹配到正确的闭标签
 */
function extractXmlTags(xmlText, tagName) {
  const results = [];
  if (!xmlText || !tagName) return results;

  const openPrefix = '<' + tagName;
  const closeTag = '</' + tagName + '>';
  let pos = 0;
  const len = xmlText.length;

  while (pos < len) {
    let startIdx = xmlText.indexOf(openPrefix, pos);
    if (startIdx === -1) break;

    const afterPrefix = startIdx + openPrefix.length;
    if (afterPrefix < len) {
      const nextCh = xmlText[afterPrefix];
      if (nextCh !== '>' && nextCh !== ' ' && nextCh !== '\t' && nextCh !== '\n' && nextCh !== '/') {
        pos = startIdx + 1;
        continue;
      }
    }

    let gtIdx = xmlText.indexOf('>', startIdx);
    if (gtIdx === -1) break;

    let depth = 1;
    let searchPos = gtIdx + 1;
    let foundClose = -1;

    while (depth > 0 && searchPos < len) {
      const nextOpen = xmlText.indexOf(openPrefix, searchPos);
      const nextClose = xmlText.indexOf(closeTag, searchPos);

      if (nextClose === -1) break;

      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        searchPos = nextOpen + openPrefix.length;
      } else {
        depth--;
        if (depth === 0) foundClose = nextClose;
        searchPos = nextClose + closeTag.length;
      }
    }

    if (foundClose === -1) { pos = gtIdx + 1; continue; }

    const fullText = xmlText.substring(startIdx, foundClose + closeTag.length);
    const innerStart = gtIdx + 1;
    const innerXml = xmlText.substring(innerStart, foundClose);

    const attrStr = xmlText.substring(afterPrefix, gtIdx);
    const attrs = parseAttributes(attrStr);

    results.push({ tagName: tagName, attrs: attrs, innerXml: innerXml, fullText: fullText });
    pos = foundClose + closeTag.length;
  }

  return results;
}

/** 提取单个子标签的文本内容（如 <title>xxx</title>） */
function extractChildText(parentInnerXml, childTag) {
  const regex = new RegExp('<' + childTag + '>([\\s\\S]*?)<\\/' + childTag + '>', 'i');
  const m = regex.exec(parentInnerXml);
  if (!m) return '';
  return unescapeXml(m[1]);
}

/** 反转义 XML 实体 */
function unescapeXml(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** 提取 metadata 中的 prop 键值对 */
function extractMetadata(innerXml) {
  const result = {};
  const metadata = extractXmlTags(innerXml, 'metadata')[0];
  if (!metadata) return result;

  for (const prop of extractXmlTags(metadata.innerXml, 'prop')) {
    const key = prop.attrs.get('key');
    if (key == null) continue;
    const val = unescapeXml(prop.innerXml.trim());
    // 关键修复：保留原始字符串，不要对纯数字 id 做 parseInt。
    // Chrome/Edge 的书签 id 本质是字符串（如 "123"），若将 <prop key="id">123</prop>
    // 解析成 number 123，会在 XBEL 多端往返后破坏「字符串 id === 字符串 id」的严格匹配，
    // 导致 merge/import 阶段误判节点为「新增」而重复创建。
    // 仅对明确语义的布尔值做类型规整，其余一律保留字符串。
    if (val === 'true') result[key] = true;
    else if (val === 'false') result[key] = false;
    else result[key] = val;
  }
  return result;
}

/** 将 XBEL XML 字符串转换为插件数据格式（扁平 JSON） */
function xbelToJson(xmlString) {
  const validatedXml = validateXbel(xmlString);
  const xbelMatches = extractXmlTags(validatedXml, 'xbel');
  const xbelInner = xbelMatches[0].innerXml;
  const result = {
    version: 1,
    bookmarks: [],
    lastModified: 0,
    deviceId: '',
    tombstones: [],
    endpoints: {},
    snapshots: {}
  };

  // 读取全局 metadata
  const globalMeta = extractMetadata(xbelInner);
  if (globalMeta.lastModified) result.lastModified = parseInt(globalMeta.lastModified, 10) || 0;
  if (globalMeta.deviceId) result.deviceId = globalMeta.deviceId;
  if (globalMeta.version) result.version = parseInt(globalMeta.version, 10) || 1;
  if (globalMeta.tombstones) { try { result.tombstones = JSON.parse(globalMeta.tombstones); } catch (_) { result.tombstones = []; } }
  if (globalMeta.endpoints) { try { result.endpoints = JSON.parse(globalMeta.endpoints); } catch (_) { result.endpoints = {}; } }
  if (globalMeta.snapshots) { try { result.snapshots = JSON.parse(globalMeta.snapshots); } catch (_) { result.snapshots = {}; } }
  // 写入端的「扁平根容器名」（雨见/可拓这类宿主：根下唯一的文件夹是宿主的书签容器）。
  // 云端若残留同名包装文件夹（根目录/根目录/…），这里当场拆掉，使远端 pathKey 与
  // 各端的摊平形态一致；非扁平根宿主（桌面 Edge）也用它来识别自己本地那个
  // 「其他收藏夹/根目录」镜像包装 —— 桌面端不靠结构（它的根是标准三区），只能靠
  // 云端这个声明，所以必须同时写进模块级声明供 chromeTreeToList / chromeToXbel 读。
  // ★ 声明若是系统分区名（书签栏/其他书签/移动收藏夹），一律当没声明处理：
  //   桶恰是系统分区时写入端绝不写这个声明，所以它只可能是历史脏数据（早期构建写过）。
  //   当真了会把分区顶层的用户同名文件夹整层折平 —— 宁可退回「按本机形态」。
  const declaredBase = String(globalMeta.flatRootContainer || '');
  const declaredIsZoneName = !!declaredBase && FOLDER_TITLES.bookmarkBar
    .concat(FOLDER_TITLES.otherBookmarks, FOLDER_TITLES.mobileBookmarks)
    .some(t => String(t).toLowerCase() === declaredBase.toLowerCase());
  const declaredWrapped = declaredIsZoneName ? '' : declaredBase;
  if (declaredWrapped) {
    result.flatRootContainer = declaredWrapped;
    if (typeof MiniSync !== 'undefined' && MiniSync.utils && MiniSync.utils.setDeclaredFlatRootContainer) {
      MiniSync.utils.setDeclaredFlatRootContainer(declaredWrapped);
    }
  } else if (typeof MiniSync !== 'undefined' && MiniSync.utils && MiniSync.utils.getDeclaredFlatRootContainer) {
    // 云端没有（或没有可用的）元数据：用调用方声明的名字（扁平根宿主＝本机容器名）
    // 兜底，这样旧云端里那层「其他收藏夹/根目录」包装也能当场拆平，而不是等到落盘层。
    const primed = MiniSync.utils.getDeclaredFlatRootContainer();
    if (primed) result.flatRootContainer = primed;
  }

  // 提取三区根 folder
  const rootFolders = extractXmlTags(xbelInner, 'folder');
  if (rootFolders.length < 3) console.warn('[xbel] XBEL 文档根 folder 数量不足:', rootFolders.length);

  // ★ 关键修复：不再盲信 rootFolders 的固定顺序（[0]=bar/[1]=other/[2]=mobile），
  // 而是按每个根 folder 的 <title> 文本反推其 source。
  // 原因：chromeToXbel 写入时若某端根 title 未命中 FOLDER_TITLES，会把内容错位写进别的区，
  // 若解码端仍按固定顺序读取，错位会被固化（书签栏内容被当成"其他"），导致合并时 pathKey 不匹配。
  // 按 title 反推可纠正写入端的偶尔错位，使 source 始终正确。
  function matchRootSourceByTitle(folder) {
    if (!folder) return null;
    const title = (extractChildText(folder.innerXml, 'title') || '').trim().toLowerCase();
    if (FOLDER_TITLES.bookmarkBar.some(t => t.toLowerCase() === title)) return 'bar';
    if (FOLDER_TITLES.otherBookmarks.some(t => t.toLowerCase() === title)) return 'other';
    if (FOLDER_TITLES.mobileBookmarks.some(t => t.toLowerCase() === title)) return 'mobile';
    // 兜底：用 XBEL 固定中文名比对
    if (title === XBEL_FOLDER_NAMES.bar) return 'bar';
    if (title === XBEL_FOLDER_NAMES.other) return 'other';
    if (title === XBEL_FOLDER_NAMES.mobile) return 'mobile';
    return null;
  }

  let barFolder = null, otherFolder = null, mobileFolder = null;
  const assigned = new Set();
  const assignedFolders = new Set();
  // 第一遍：按 title 精确匹配分配
  for (const f of rootFolders) {
    const src = matchRootSourceByTitle(f);
    if (src === 'bar' && !assigned.has('bar')) { barFolder = f; assigned.add('bar'); assignedFolders.add(f); }
    else if (src === 'other' && !assigned.has('other')) { otherFolder = f; assigned.add('other'); assignedFolders.add(f); }
    else if (src === 'mobile' && !assigned.has('mobile')) { mobileFolder = f; assigned.add('mobile'); assignedFolders.add(f); }
  }
  // 第二遍：未匹配的 folder 用剩余空位按出现顺序兜底（兼容旧版/异常 XBEL）
  const orderedSources = ['bar', 'other', 'mobile'];
  let orderIdx = 0;
  for (const f of rootFolders) {
    if (assignedFolders.has(f)) continue;
    while (orderIdx < orderedSources.length && assigned.has(orderedSources[orderIdx])) orderIdx++;
    if (orderIdx >= orderedSources.length) break;
    const src = orderedSources[orderIdx++];
    assigned.add(src);
    if (src === 'bar') barFolder = f;
    else if (src === 'other') otherFolder = f;
    else if (src === 'mobile') mobileFolder = f;
  }

  let idCounter = 1000;
  let wrapperSplicedRemote = 0; // 云端被拆掉的同名包装层数（诊断用）

  // 云端包装文件夹判定：标题＝写入端声明的容器名（flatRootContainer），且位置**够格**
  // 当包装 —— 即它是某个分区的顶层，或是另一层包装的直接子节点（wrapperEligible）。
  // ★ 判据不跨普通文件夹：用户自己在深层建的同名文件夹不受影响。这条规则必须与本地端
  //   （chromeTreeToList.walkBucket / chromeToXbel 的折平）逐条对称，否则「云端带包装 /
  //   本机摊平」两种形态来回写永远收敛不了（表现为每合并一轮多一层嵌套）。
  function isFolderStillFlatWrapper(title, wrapperEligible) {
    if (!result.flatRootContainer) return false;
    if (!wrapperEligible) return false;
    return String(title) === String(result.flatRootContainer);
  }

  /**
   * ★ 关键修复：按 XML 顺序逐个扫描子节点，正确处理嵌套
   * 
   * 旧 bug：extractXmlTags(xml, 'bookmark') 会提取**所有层级**的书签，
   *       包括嵌套在子文件夹内的，导致本应在文件夹内的书签
   *       全部被标记为 parentId=ROOT_ID（书签栏根级别）。
   * 
   * 新逻辑：手动扫描 XML 字符串，遇到 <folder> 就跳过整个文件夹内容
   *       （由递归调用处理），遇到 <bookmark> 才当作当前层的直接子书签。
   */
  // wrapperEligible：当前这一层「够格当包装层」—— 分区顶层、或某层包装的直接子层。
  // 进入一个普通文件夹就失去资格（false），于是用户自己在深处建的同名文件夹不会被拆。
  function walkFolder(folderInnerXml, parentId, source, wrapperEligible) {
    // 按原始 XML 出现顺序逐个扫描
    let pos = 0;
    const len = folderInnerXml.length;
    let siblingIndex = 0;
    
    while (pos < len) {
      // 查找下一个 <folder 或 <bookmark
      const nextFolderStart = folderInnerXml.indexOf('<folder', pos);
      const nextBookmarkStart = folderInnerXml.indexOf('<bookmark ', pos);
      
      // 确定哪个先出现
      let nextStart = -1;
      let isFolder = false;
      
      if (nextFolderStart !== -1 && nextBookmarkStart !== -1) {
        if (nextFolderStart < nextBookmarkStart) {
          nextStart = nextFolderStart;
          isFolder = true;
        } else {
          nextStart = nextBookmarkStart;
          isFolder = false;
        }
      } else if (nextFolderStart !== -1) {
        nextStart = nextFolderStart;
        isFolder = true;
      } else if (nextBookmarkStart !== -1) {
        nextStart = nextBookmarkStart;
        isFolder = false;
      } else {
        break; // 没有更多子节点
      }
      
      if (isFolder) {
        // ★ 文件夹：提取完整的 <folder>...</folder> 块（含嵌套内容）
        let gtIdx = folderInnerXml.indexOf('>', nextStart);
        if (gtIdx === -1) { pos = nextStart + 1; continue; }
        
        let depth = 1;
        let searchPos = gtIdx + 1;
        let foundClose = -1;
        const closeTag = '</folder>';
        
        while (depth > 0 && searchPos < len) {
          const nextOpen = folderInnerXml.indexOf('<folder', searchPos);
          const nextClose = folderInnerXml.indexOf(closeTag, searchPos);
          
          if (nextClose === -1) break;
          
          if (nextOpen !== -1 && nextOpen < nextClose) {
            depth++;
            searchPos = nextOpen + 7; // '<folder'.length
          } else {
            depth--;
            if (depth === 0) foundClose = nextClose;
            searchPos = nextClose + closeTag.length;
          }
        }
        
        if (foundClose === -1) { pos = gtIdx + 1; continue; }
        
        const folderFullText = folderInnerXml.substring(nextStart, foundClose + closeTag.length);
        const folderInnerStart = gtIdx + 1;
        const folderInnerXml_content = folderInnerXml.substring(folderInnerStart, foundClose);
        
        // 解析文件夹
        const title = extractChildText(folderInnerXml_content, 'title');
        const meta = extractMetadata(folderInnerXml_content);
        let folderSource = source;
        let folderId = meta.id || ('folder_' + (idCounter++));
        
        // Berry 主页识别：仅「其他收藏夹」分区（source='other'）下的命中文件夹才视为
        // home 容器（chromeToXbel 只把 home 容器写入 other 分区）。书签栏/移动区的
        // 同名文件夹（用户自建或历史脏数据）按普通文件夹处理，不再被强制改挂到
        // 其他收藏夹，避免与 home 体系分化、重复。
        const lowerTitle = title.toLowerCase();

        // ★ 扁平根包装折平：写入端是扁平根宿主（metadata.flatRootContainer）时，它在
        //   「其他收藏夹」区顶层可能留下一个与容器同名的文件夹（历史版本每合并一次
        //   就套一层：根目录/根目录/…）。这里**完全不产生该节点**，直接把它的子节点
        //   当作当前层的内容继续处理 ⇒ 远端 pathKey 与各端的摊平形态一致，
        //   合并才认得出「同一批书签」而不是来回搬。
        const flatWrapperTitle = result.flatRootContainer || '';
        const isFlatWrapper = !!flatWrapperTitle && isFolderStillFlatWrapper(title, wrapperEligible);
        if (isFlatWrapper) {
          wrapperSplicedRemote++;
          walkFolder(folderInnerXml_content, parentId, source, true);
          pos = foundClose + closeTag.length;
          siblingIndex++;
          continue;
        }

        const isHomeTitle = (FOLDER_TITLES.berryHome || []).some(t => t.toLowerCase() === lowerTitle)
          || title === XBEL_FOLDER_NAMES.berryHome;
        if (isHomeTitle && source === 'other') {
          folderId = HOME_FOLDER_ID;
          // ★ source 保持 'other'：Berry主页 在本地 Chrome/Edge 里位于「其他收藏夹」下，
          //   落盘分区（import.js 的 folderMap）靠 source 决定挂到哪个默认文件夹，必须是 'other'。
          //   pathKey 前缀 ROOT:home 由 id=HOME_FOLDER_ID 虚拟根（xbel-path.js 第 39 行）保证，
          //   不依赖 source，故 source 不会被误用为 'home' 而破坏落盘分区。
          folderSource = 'other';
        }
        
        result.bookmarks.push({
          id: folderId, title: title, url: '', isFolder: true, parentId: parentId,
          source: folderSource, addedAt: meta.addedAt || Date.now(), color: meta.color || null,
          favicon: meta.favicon || null, customIcon: meta.customIcon || null,
          _index: siblingIndex, _otherIndex: meta._otherIndex != null ? meta._otherIndex : -1
        });
        
        // ★ 递归处理文件夹内部（传入文件夹的 innerXml）
        // Berry主页 容器本身 source='other'（落盘分区→其他收藏夹），但其下子节点传 'home'，
        // 使 buildPath 走 segment 拼接（pk=ROOT:home/F:层1/...），与本地 chromeTreeToList
        // （子节点 source='home'）保持一致；否则子节点继承 'other' 会被误判成 other 区根、
        // pk 丢层级，与本地不一致导致深层删除/排序失败。
        // 第 4 参 false：进入普通文件夹后，这一层的子节点不再够格当包装层。
        walkFolder(folderInnerXml_content, folderId, folderId === HOME_FOLDER_ID ? 'home' : folderSource, false);
        
        pos = foundClose + closeTag.length;
        
      } else {
        // ★ 书签：提取完整的 <bookmark ...>...</bookmark> 块
        let gtIdx = folderInnerXml.indexOf('>', nextStart);
        if (gtIdx === -1) { pos = nextStart + 1; continue; }
        
        const closeTag = '</bookmark>';
        const bookmarkCloseIdx = folderInnerXml.indexOf(closeTag, gtIdx);
        if (bookmarkCloseIdx === -1) { pos = gtIdx + 1; continue; }
        
        const bookmarkFullText = folderInnerXml.substring(nextStart, bookmarkCloseIdx + closeTag.length);
        const bookmarkInnerStart = gtIdx + 1;
        const bookmarkInner = folderInnerXml.substring(bookmarkInnerStart, bookmarkCloseIdx);
        
        // 提取属性和内容
        const attrStr = folderInnerXml.substring(nextStart + 10, gtIdx); // '<bookmark '.length = 10
        const attrs = parseAttributes(attrStr);

        const href = attrs.get('href') || '';
        const title = extractChildText(bookmarkInner, 'title') || href;
        const meta = extractMetadata(bookmarkInner);
        
        result.bookmarks.push({
          id: meta.id || ('bm_' + (idCounter++)), title: title, url: href, isFolder: false,
          parentId: parentId, source: source, addedAt: meta.addedAt || Date.now(), color: meta.color || null,
          favicon: meta.favicon || null, customIcon: meta.customIcon || null,
          _index: siblingIndex, _otherIndex: -1
        });
        
        pos = bookmarkCloseIdx + closeTag.length;
      }
      
      siblingIndex++;
    }
  }

  if (barFolder) walkFolder(barFolder.innerXml, ROOT_ID, 'bar', true);
  if (otherFolder) walkFolder(otherFolder.innerXml, ROOT_ID, 'other', true);
  if (mobileFolder) walkFolder(mobileFolder.innerXml, ROOT_ID, 'mobile', true);
  result.wrapperSplicedRemote = wrapperSplicedRemote;

  // ===== 单同步桶：三区**并集**读入 =====
  // 桶内容在云端的唯一区是「书签栏」；但旧版云端把桶内容写在「其他收藏夹」（桌面镜像时代）
  // 或「移动收藏夹」里。并集读入保证升级时一条都不丢（无损迁移），写回后云端即归一为
  // 一个区。Berry 主页（HOME_FOLDER_ID）不是桶内容，保持 source='other' 不动。
  // 用户私有的「其他收藏夹」内容若在旧云端里，会被一并读入一次 —— 之后可用合并删除
  // 让它按墓碑双向传播；这是并集读入的已知代价（宁可多带一次，不可漏）。
  for (const n of result.bookmarks) {
    if (String(n.id) === String(HOME_FOLDER_ID)) continue;
    if (String(n.parentId) !== ROOT_ID) continue;
    if (n.source === 'other' || n.source === 'mobile') n.source = 'bar';
  }

  // [ROOT-CAUSE CHECK] 检查"孤儿节点"：parentId 找不到对应父节点的节点
  // 如果存在，说明 XBEL 数据本身就有问题（id/parentId 不一致）
  const idMap = new Map();
  for (const n of result.bookmarks) idMap.set(String(n.id), n);
  const orphans = result.bookmarks.filter(n => {
    if (n.parentId === ROOT_ID) return false;
    return !idMap.has(String(n.parentId));
  });
  if (orphans.length > 0) {
    console.warn(`[xbel-root-cause] ⚠️ 发现 ${orphans.length} 个孤儿节点（parentId 找不到父节点）:`);
    for (const o of orphans) {
      // 尝试找相似 id 的父节点（排查 id 偏移）
      const similar = [...idMap.values()].find(p => {
        const diff = Math.abs(Number(p.id) - Number(o.parentId));
        return diff > 0 && diff < 200; // 差异在 200 以内视为"疑似"
      });
      console.warn(`  孤儿: id=${o.id} title="${o.title}" parentId=${o.parentId} ${similar ? `→ 疑似父节点: id=${similar.id} title="${similar.title}" (差值=${Math.abs(Number(similar.id) - Number(o.parentId))})` : '→ 无相似父节点'}`);
    }
  }

  return result;
}


// ================================================================
//  A-P1: Chrome 书签树 → XBEL 字符串（跳过扁平 JSON 中间态）
// ================================================================

/**
 * 将 Chrome 书签树直接转换为 XBEL XML 字符串（A-P1 上传路径）
 */
function chromeToXbel(tree, meta) {
  const root = tree && tree[0];
  if (!root) return XBEL_HEADER + '<xbel version="1.0"></xbel>\n';

  const rootChildren = (root.children) || [];

  function renderNode(node, indent) {
    const isFolder = !node.url;
    const lines = [];

    if (isFolder) {
      // 注意：不再跳过空文件夹。用户会主动创建空文件夹作占位/待分类用途，
      // 必须能跨端（Edge/Chrome）合并同步。空文件夹渲染为 <folder><title>...</title></folder>。
      const nodeMeta = {};
      if (node.id != null) nodeMeta.id = node.id;
      if (node.dateAdded != null) nodeMeta.addedAt = node.dateAdded;
      const metaXml = buildMetadataXml(nodeMeta);
      const subIndent = indent + '  ';

      lines.push(`${indent}<folder>`);
      lines.push(`${indent}  <title>${escapeXml(node.title || '')}</title>`);
      if (metaXml) lines.push(indent + '  ' + metaXml);

      if (node.children && node.children.length > 0) {
        for (const child of node.children) { lines.push(renderNode(child, subIndent)); }
      }
      lines.push(`${indent}</folder>`);
    } else {
      const bmMeta = {};
      if (node.id != null) bmMeta.id = node.id;
      if (node.dateAdded != null) bmMeta.addedAt = node.dateAdded;
      const metaXml = buildMetadataXml(bmMeta);
      lines.push(`<bookmark href="${escapeAttr(node.url || '')}">`);
      lines.push(`${indent}  <title>${escapeXml(node.title || '')}</title>`);
      if (metaXml) lines.push(indent + '  ' + metaXml);
      lines.push(`</bookmark>`);
    }
    return lines.join('\n');
  }

  function findFolder(nodes, id) {
    for (const n of (nodes || [])) {
      if (!n || n.url) continue;
      if (String(n.id) === String(id)) return n;
      const hit = findFolder(n.children, id);
      if (hit) return hit;
    }
    return null;
  }
  const isBerryHomeTitle = (title) => FOLDER_TITLES.berryHome
    .some(t => t.toLowerCase() === String(title || '').toLowerCase());

  // ===== 单同步桶：只有桶的子节点会被写出去 =====
  // 桶以外的一切（其他收藏夹里的其它文件夹、移动收藏夹、根下其它文件夹）都不写云端 ——
  // 这就是用户要求的「其他收藏夹不要备份」：不是靠过滤某些名字，而是同步范围本身只有一个
  // 文件夹。桶自身也不写（它是承载容器，不是用户数据），否则下载端会把同名节点建回来。
  // 桶的解析见 utils.resolveSyncBucket（显式设置 → 扁平容器 → 书签栏 → 云端声明过的镜像）。
  const bucket = (MiniSync.utils && MiniSync.utils.resolveSyncBucket)
    ? MiniSync.utils.resolveSyncBucket(rootChildren, {
        bucketId: (meta && meta.syncBucketId) || (MiniSync.utils.getSyncBucketId ? MiniSync.utils.getSyncBucketId() : ''),
        declaredWrapper: (meta && meta.flatRootContainer)
          || (MiniSync.utils.getDeclaredFlatRootContainer ? MiniSync.utils.getDeclaredFlatRootContainer() : '')
      })
    : null;

  let barContent = '';
  let otherBody = '';

  const bucketNode = bucket ? findFolder(rootChildren, bucket.id) : null;
  if (bucketNode) {
    const bucketTitle = String(bucketNode.title || '');
    // legacy 嵌套包装折平（旧版每合并一轮就套一层 根目录/根目录）：
    // 只吃**直接子层**的同名文件夹，链式继续；不跨普通文件夹 —— 用户自己在「学习」
    // 下建的同名文件夹必须原样保留（与 xbelToJson / chromeTreeToList 同一条规则，
    // 三处对称否则云端与本机形态来回写，永远收敛不了）。
    let kids = bucketNode.children || [];
    if (bucketTitle) {
      for (let pass = 0; pass < 20; pass++) {
        let changed = false;
        const next = [];
        for (const k of kids) {
          if (k && !k.url && String(k.title || '') === bucketTitle) {
            for (const gc of (k.children || [])) next.push(gc);
            changed = true;
          } else {
            next.push(k);
          }
        }
        kids = next;
        if (!changed) break;
      }
    }
    for (const child of kids) barContent += renderNode(child, '    ') + '\n';
  }

  // Berry 主页：独立功能（自家 home 区），不是同步桶的内容，照旧写进「其他收藏夹」区。
  // 它可能挂在根下，也可能是「其他收藏夹」的直接子文件夹（Chrome/Edge 的常见位置）。
  let berryHomeNode = null;
  for (const top of rootChildren) {
    if (!top || top.url) continue;
    if (isBerryHomeTitle(top.title) && (!bucketNode || String(top.id) !== String(bucketNode.id))) {
      berryHomeNode = top;
      break;
    }
    const hit = (top.children || []).find(c => c && !c.url && isBerryHomeTitle(c.title)
      && (!bucketNode || String(c.id) !== String(bucketNode.id)));
    if (hit) { berryHomeNode = hit; break; }
  }
  if (berryHomeNode) {
    otherBody += `      <folder>\n        <title>${escapeXml(XBEL_FOLDER_NAMES.berryHome)}</title>\n`;
    for (const gc of (berryHomeNode.children || [])) otherBody += renderNode(gc, '        ') + '\n';
    otherBody += `      </folder>\n`;
  }

  // 全局 metadata
  const globalMeta = {};
  if (meta) {
    if (meta.lastModified) globalMeta.lastModified = meta.lastModified;
    if (meta.deviceId) globalMeta.deviceId = meta.deviceId;
    if (meta.version) globalMeta.version = meta.version;
    if (meta.tombstones && Array.isArray(meta.tombstones)) globalMeta.tombstones = JSON.stringify(meta.tombstones);
    if (meta.endpoints) globalMeta.endpoints = JSON.stringify(sanitizeEndpoints(meta.endpoints));
    if (meta.snapshots) globalMeta.snapshots = JSON.stringify(meta.snapshots);
  }
  // 容器名声明：桶是「容器型」（手机根下那个文件夹、桌面的 其他收藏夹/根目录 镜像）时
  // 写自己的名字，各端靠它识别同名包装；桶恰是系统分区（书签栏/其他收藏夹/移动收藏夹）
  // 时绝不写 —— 把分区名当包装名声明出去，别端会把分区顶层的同名文件夹折平，破坏用户
  // 数据。桶是系统分区时保留云端已有的声明，legacy 包装才能继续被识别掉。
  const bucketTitleForMeta = (bucket && bucket.kind !== 'zone'
    && !FOLDER_TITLES.bookmarkBar.concat(FOLDER_TITLES.otherBookmarks, FOLDER_TITLES.mobileBookmarks)
      .some(t => String(t).toLowerCase() === String(bucket.title || '').toLowerCase()))
    ? String(bucket.title || '') : '';
  if (bucketTitleForMeta) globalMeta.flatRootContainer = bucketTitleForMeta;
  else if (meta && meta.flatRootContainer) globalMeta.flatRootContainer = meta.flatRootContainer;
  const rootMetaXml = buildMetadataXml(globalMeta);

  let xml = XBEL_HEADER + `<xbel version="${XBEL_VERSION}">`;
  if (rootMetaXml) xml += '\n' + rootMetaXml;
  xml += `\n  <folder>\n    <title>${escapeXml(XBEL_FOLDER_NAMES.bar)}</title>\n`;
  if (barContent) xml += barContent;
  xml += `  </folder>`;
  xml += `\n  <folder>\n    <title>${escapeXml(XBEL_FOLDER_NAMES.other)}</title>\n`;
  if (otherBody) xml += otherBody;
  xml += `  </folder>`;
  xml += `\n  <folder>\n    <title>${escapeXml(XBEL_FOLDER_NAMES.mobile)}</title>\n`;
  xml += `  </folder>`;
  xml += '\n</xbel>\n';

  return xml;
}

// ================================================================
//  序列化/反序列化辅助（I/O 层使用）
// ================================================================

/** 将数据序列化为 XBEL XML 字符串（用于 WebDAV 上传） */
function serializeXbelToString(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  if (data.startsWith && data.startsWith('<?xml')) return String(data);
  if (data.bookmarks) return jsonToXbel(data);
  return String(data);
}

/** 解析 XBEL XML 字符串为 pluginData 对象（用于 WebDAV 下载） */
function parseXbelFromString(xmlString) {
  if (!xmlString || typeof xmlString !== 'string') return null;
  try { return xbelToJson(xmlString); } catch (e) { console.error('[xbel] 解析失败:', e.message); return null; }
}

/** URL 规范化（用于匹配 key 生成） */
function normalizeUrl(url) {
  if (!url) return '';
  try {
    let u = url.trim().replace(/\/+$/, '');
    if (/^https?:\/\//i.test(u)) {
      const obj = new URL(u);
      obj.hash = '';
      return obj.toString().replace(/\/$/, '');
    }
    return u;
  } catch (_) { return url.trim(); }
}

// ====== 导出公共 API ======
return {
  xbelToJson: xbelToJson,           // XBEL XML → JSON 中间态（下载路径）
  jsonToXbel: jsonToXbel,           // JSON 中间态 → XBEL XML（上传/桥接）
  chromeToXbel: chromeToXbel,       // Chrome 树 → XBEL XML（A-P1 上传）
  serializeXbelToString: serializeXbelToString,  // 序列化辅助
  parseXbelFromString: parseXbelFromString,      // 反序列化辅助
  normalizeUrl: normalizeUrl        // URL 规范化
};

})();
