// adapters/aira-adapter.js - Aira 浏览器桥接逻辑
// 数据文件：WebDAV 子目录下的 snapshot.json（如 aira/g3/bookmarks/snapshot.json）
// 顶层结构：
//   { version, history, commitId, parentCommitId, deviceId, createdAt,
//     snapshot: { meta:{version,deviceId,generatedAt}, bookmarkFolders, bookmarkItems, bookmarkOrders, tombstones } }
// 三表分离（均在 snapshot 内）：
//   bookmarkFolders : [{id, type:'bookmark-folder', parentId:null, title, createdAt, updatedAt, updatedBy, revision}]
//   bookmarkItems   : [{id, type:'bookmark-item', parentId, title, url, createdAt, updatedAt, updatedBy, revision}]
//   bookmarkOrders  : [{type:'bookmark-order', parentId:null, ids:[...], updatedAt, updatedBy, revision}]
//   tombstones      : [...]
//   appPrivateBookmarks : 隐私书签空间（完整子树，原样保留，不同步）
// 负责：读写 snapshot.json、继承图标/颜色、顺序同步（bookmarkOrders）、id 映射、删除检测

// ====== Aira 数据读写（WebDAV 子目录）======
// 随机 base36 串，固定 6 位（用于 commitId 随机后缀，对齐手机端真值长度）
function rand36() {
  return Math.random().toString(36).replace(/^0\./, '').slice(0, 6).padStart(6, '0');
}

// 稳定 6 位 base36 后缀（用于 bkf_/bkm_bookmark_ 的 id 后缀，对齐真值 a3z4yt 风格）
// 提升为模块级：airaListToSnapshot 与 patchAiraFile 共用，避免作用域不可用。
function stableSuffix(s) {
  let h = 5381 >>> 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(0, 6).padStart(6, '0');
}

async function getAiraPath() {
  const data = await new Promise(resolve => chrome.storage.local.get(['aira_folder_path'], resolve));
  return data.aira_folder_path || 'aira/g3/bookmarks';
}

async function downloadAiraBookmarks() {
  const config = await getWebDAVConfig();
  if (!config.url) throw new Error('未配置 WebDAV');
  const filePath = (await getAiraPath()).replace(/\/+$/, '') + '/snapshot.json';
  const content = await MiniSync.webdav.getFile(config.url, config.username, config.password, filePath);
  if (!content) return null;
  return JSON.parse(content);
}

async function uploadAiraBookmarks(snapshot) {
  const config = await getWebDAVConfig();
  if (!config.url) throw new Error('未配置 WebDAV');
  const dirPath = (await getAiraPath()).replace(/\/+$/, '');
  const filePath = dirPath + '/snapshot.json';
  // 先确保远程子目录存在（与 Berry/Via 一致），否则对不存在的父目录 PUT 会被服务器拒绝(403/409)
  await MiniSync.webdav.ensureWebDAVDir(config.url, dirPath, config.username, config.password);
  // 带缩进(2 空格)写出，便于 Sublime/编辑器高亮与人工核对，也贴合手机端真值格式
  await MiniSync.webdav.putFile(config.url, config.username, config.password, filePath, JSON.stringify(snapshot), 'application/json; charset=utf-8');
}

// 取 Aira personalization（g2）路径：将 g3/bookmarks 的父级 aira/ 换成 aira/g2/personalization
async function getAiraPersonalizationPath() {
  const base = (await getAiraPath()).replace(/\/+$/, '');
  // base 形如 "aira/g3/bookmarks" → 取其第一段 "aira" → "aira/g2/personalization"
  const segs = base.split('/');
  const root = segs[0] || 'aira';
  return root + '/g2/personalization';
}

async function downloadAiraPersonalization() {
  const config = await getWebDAVConfig();
  if (!config.url) throw new Error('未配置 WebDAV');
  const filePath = (await getAiraPersonalizationPath()).replace(/\/+$/, '') + '/snapshot.json';
  const content = await MiniSync.webdav.getFile(config.url, config.username, config.password, filePath);
  if (!content) return null;
  return JSON.parse(content);
}

async function uploadAiraPersonalization(snapshot) {
  const config = await getWebDAVConfig();
  if (!config.url) throw new Error('未配置 WebDAV');
  const dirPath = (await getAiraPersonalizationPath()).replace(/\/+$/, '');
  const filePath = dirPath + '/snapshot.json';
  await MiniSync.webdav.ensureWebDAVDir(config.url, dirPath, config.username, config.password);
  await MiniSync.webdav.putFile(config.url, config.username, config.password, filePath, JSON.stringify(snapshot), 'application/json; charset=utf-8');
}

// 重算 personalization 的 checksum（= 四 section 无缩进 JSON 字符串）
function computePersonalizationChecksum(sections) {
  const pick = s => ({ enabled: s.enabled, updatedAt: s.updatedAt, payload: s.payload });
  return JSON.stringify({
    home_shortcuts: pick(sections.home_shortcuts),
    core_preferences: pick(sections.core_preferences),
    activity_heatmap: pick(sections.activity_heatmap),
    search: pick(sections.search)
  });
}

// ====== Berry主页 → Aira personalization（home_shortcuts）写回 ======
// opts.align=true（上传覆盖语义）：以桌面 home 为准对齐——personalization 中
//   桌面没有的 shortcuts 一律移除（含历史残留），仅保留桌面有的并补齐缺失。
// 默认（合并语义）：只追加桌面有而此处没有的，不移除任何端上条目。
async function patchAiraPersonalization(mergedList, opts = {}) {
  const align = !!(opts && opts.align);
  let prev;
  try {
    prev = await downloadAiraPersonalization();
  } catch (e) {
    prev = null;
  }

  // personalization 缺失时的种子创建：若 g3 snapshot.json 存在（内含移动端 deviceId），
  // 桌面可携带该 deviceId 创建 personalization 骨架并按桌面 home 填充——
  // 移动端的 deviceId 一致性校验可过，不会形成死锁。g3 也不存在 → 仍不创建（保持保护）。
  if (!prev) {
    let seedDeviceId = '';
    try {
      const g3 = await downloadAiraBookmarks();
      seedDeviceId = (g3 && (g3.deviceId || (g3.meta && g3.meta.deviceId))) || '';
    } catch (e) { /* ignore */ }
    if (!align || !seedDeviceId) {
      // 合并语义（非 align）不创建；连移动端 deviceId 都拿不到 → 不创建（保持原保护）
      return;
    }
    const now = Date.now();
    prev = {
      meta: { version: 2, deviceId: seedDeviceId, generatedAt: new Date(now).toISOString() },
      sections: {
        home_shortcuts: { enabled: true, updatedAt: now, payload: { scenarios: [], shortcuts: [], orders: [] } },
        core_preferences: { enabled: false, updatedAt: 0, payload: {} },
        activity_heatmap: { enabled: false, updatedAt: 0, payload: { contributions: [] } },
        search: { enabled: false, updatedAt: 0, payload: {} }
      }
    };
    console.log(`[sync] 🤖 Aira 主页文件缺失：以移动端 deviceId 种子创建并按桌面 home 填充`);
  }
  if (!prev.sections || !prev.sections.home_shortcuts) return;

  const homeItems = mergedList.filter(n => n.source === 'home' && !n.isFolder && n.url);
  // ★ 归一化去重：http/https、www.、尾斜杠差异视为同一书签。
  //   此前精确匹配导致同一批主页书签被反复追加（Berry 主页出现成对重复）。
  //   顺带清理历史重复：归一化 URL 相同的 shortcuts 只保留最早创建的一条。
  //   align 模式下进一步以桌面 home 为准：桌面没有的 shortcuts 一律移除。
  const deskUrls = align ? new Set(homeItems.map(n => normalizeUrlForDedup(n.url))) : null;
  const allShortcuts = prev.sections.home_shortcuts.payload.shortcuts || [];
  const seenNormUrls = new Set();
  const keptShortcutIds = new Set();
  const dedupedShortcuts = [];
  for (const sc of allShortcuts) {
    const norm = normalizeUrlForDedup(sc.url);
    if (align && !deskUrls.has(norm)) continue; // 对齐：桌面没有的端上条目移除
    if (norm && seenNormUrls.has(norm)) continue; // 重复条目：丢弃（保留最早的一条）
    if (norm) seenNormUrls.add(norm);
    keptShortcutIds.add(sc.id);
    dedupedShortcuts.push(sc);
  }
  if (dedupedShortcuts.length !== allShortcuts.length || align) {
    prev.sections.home_shortcuts.payload.shortcuts = dedupedShortcuts;
    for (const o of (prev.sections.home_shortcuts.payload.orders || [])) {
      o.shortcutIds = (o.shortcutIds || []).filter(id => keptShortcutIds.has(id));
    }
  }
  const existingUrls = new Set(dedupedShortcuts.map(s => normalizeUrlForDedup(s.url)));
  const existingScenarioIds = new Set((prev.sections.home_shortcuts.payload.scenarios || []).map(s => s.id));

  const DEFAULT_SCENARIO = 'aira_default_scenario';
  if (!existingScenarioIds.has(DEFAULT_SCENARIO)) {
    prev.sections.home_shortcuts.payload.scenarios = prev.sections.home_shortcuts.payload.scenarios || [];
    prev.sections.home_shortcuts.payload.scenarios.push({
      id: DEFAULT_SCENARIO, name: 'Berry主页', color: '#3f7d5f', icon: 'sparkles',
      position: 0, archived: false, createdAt: Date.now(), updatedAt: Date.now(),
      sync: { state: 'pending_push', source: 'local', lastModifiedAt: Date.now(), lastModifiedBy: prev.meta ? prev.meta.deviceId : '', deviceId: prev.meta ? prev.meta.deviceId : '' }
    });
  }

  const newShortcuts = [];
  const order = prev.sections.home_shortcuts.payload.orders && prev.sections.home_shortcuts.payload.orders.find(o => o.scenarioId === DEFAULT_SCENARIO)
    ? prev.sections.home_shortcuts.payload.orders.find(o => o.scenarioId === DEFAULT_SCENARIO)
    : { scenarioId: DEFAULT_SCENARIO, shortcutIds: [], updatedAt: Date.now() };
  if (!prev.sections.home_shortcuts.payload.orders) prev.sections.home_shortcuts.payload.orders = [];
  const orderRef = prev.sections.home_shortcuts.payload.orders.find(o => o.scenarioId === DEFAULT_SCENARIO) || (prev.sections.home_shortcuts.payload.orders.push(order), order);

  let pos = (prev.sections.home_shortcuts.payload.shortcuts || []).length;
  const now = Date.now();
  const deviceId = prev.meta ? prev.meta.deviceId : '';
  for (const n of homeItems) {
    const key = normalizeUrlForDedup(n.url);
    if (existingUrls.has(key)) continue; // 已存在则跳过（归一化比较）
    existingUrls.add(key);
    const id = 'shortcut-' + stableSuffix(n.id + n.url + now + Math.random());
    const sc = {
      id, scenarioId: DEFAULT_SCENARIO, title: n.title || '', url: n.url || '',
      folderName: '首页', position: pos++, description: '首页',
      useOfficialIcon: true, autoUseOfficialIcon: true, officialIconAvailableAtSave: false,
      officialIconColorOverride: false, iconRendering: 'official', iconColor: '',
      createdAt: now, updatedAt: now,
      sync: { state: 'pending_push', source: 'local', lastModifiedAt: now, lastModifiedBy: deviceId, deviceId }
    };
    prev.sections.home_shortcuts.payload.shortcuts.push(sc);
    newShortcuts.push(sc);
    orderRef.shortcutIds.push(id);
  }

  // ★ 顺序以桌面为权威：shortcuts 数组、position 与 orderRef.shortcutIds 按桌面
  //   home 区顺序重排（端上独有条目排末尾），使桌面拖拽重排可传播到手机主页。
  const shortcutsArr = prev.sections.home_shortcuts.payload.shortcuts || [];
  const deskRank = new Map(homeItems.map((n, i) => [normalizeUrlForDedup(n.url), i]));
  const rankOf = (sc) => { const r = deskRank.get(normalizeUrlForDedup(sc.url)); return r === undefined ? Number.MAX_SAFE_INTEGER : r; };
  const sortedShortcuts = shortcutsArr.slice().sort((a, b) => rankOf(a) - rankOf(b));
  const idRank = new Map(sortedShortcuts.map((sc, i) => [sc.id, i]));
  const rank = (id) => (idRank.has(id) ? idRank.get(id) : Number.MAX_SAFE_INTEGER);
  const sortedIds = (orderRef.shortcutIds || []).slice().sort((a, b) => rank(a) - rank(b));
  const homeOrderChanged = shortcutsArr.some((sc, i) => sc !== sortedShortcuts[i]) ||
    (orderRef.shortcutIds || []).some((id, i) => id !== sortedIds[i]);
  if (homeOrderChanged) {
    sortedShortcuts.forEach((sc, i) => { sc.position = i; });
    prev.sections.home_shortcuts.payload.shortcuts = sortedShortcuts;
    orderRef.shortcutIds = sortedIds;
  }

  orderRef.updatedAt = now;
  prev.sections.home_shortcuts.updatedAt = now;

  // 重算 checksum
  prev.checksum = computePersonalizationChecksum(prev.sections);

  // ★ 上传条件：内容有实际变更才推送（新增条目，或 align/去重导致条目增减）。
  //   align 模式的删除会让数量变化从而触发推送；已对齐时不再重复推送。
  const needUpload = newShortcuts.length > 0 || dedupedShortcuts.length !== allShortcuts.length || homeOrderChanged;
  // 主页回写摘要：数量=对齐去重后端上的最终 shortcuts（与回写日志 home 口径一致）；
  // 推送与否由下方「主页文件已推送」日志体现。
  console.log(`[sync] 🤖 Aira 主页回写: [home:${dedupedShortcuts.length}]`);
  if (needUpload) {
    try {
      await uploadAiraPersonalization(prev);
      console.log('[sync] 🤖 Aira 主页文件已推送');
    } catch (e) {
      console.warn('[sync] 🤖 Aira 主页推送失败:', e.message);
    }
  }
}

// 取 snapshot 容器（兼容顶层直接是三表对象的旧形态）
function airaGetSnapshotContainer(raw) {
  if (!raw) return null;
  if (raw.snapshot && raw.snapshot.bookmarkFolders) return raw.snapshot;
  if (raw.bookmarkFolders) return raw; // 兼容：老格式直接是容器
  return null;
}

// ====== Aira snapshot → 扁平列表 ======
// 把 snapshot 的三表结构转成与 Chrome 扁平列表同构的数组（parentId/source/id/title/url/isFolder）
function airaSnapshotToList(raw) {
  const snap = airaGetSnapshotContainer(raw);
  if (!snap || !Array.isArray(snap.bookmarkFolders)) return [];
  const list = [];

  // Aira 的根容器 id → source 映射（computePathKeys 据此把子节点归到正确的根区）
  const AIRA_ROOT_MAP = {
    browser_root_toolbar: 'bar',
    browser_root_other: 'other',
    browser_root_mobile: 'mobile'
  };
  // Aira 根容器标题需标准化为 Chrome 系统根容器标题，才能让 computePathKeys 正确截断生成 ROOT:bar/other/mobile
  const AIRA_ROOT_STANDARD_TITLES = {
    browser_root_toolbar: '书签栏',
    browser_root_other: '其他收藏夹',
    browser_root_mobile: '移动收藏夹'
  };
  // 先建 id → 节点 索引，便于向上回溯 source
  const byId = new Map();
  const folders = snap.bookmarkFolders.filter(f => !f.type || f.type === 'bookmark-folder');
  const items = (Array.isArray(snap.bookmarkItems) ? snap.bookmarkItems : []).filter(it => !it.type || it.type === 'bookmark-item');
  for (const f of folders) byId.set(f.id, f);
  for (const it of items) byId.set(it.id, it);

  // 向上回溯，确定某个节点所属根区的 source（bar/other/mobile）
  function resolveSource(node) {
    const rootSrc = AIRA_ROOT_MAP[node.id];
    if (rootSrc) return rootSrc; // 根容器本身
    if (node.parentId && AIRA_ROOT_MAP[node.parentId]) return AIRA_ROOT_MAP[node.parentId]; // 直接挂在根容器下
    // 挂在普通文件夹下 → 向上回溯父链
    let p = node.parentId ? byId.get(node.parentId) : null;
    while (p) {
      const ps = AIRA_ROOT_MAP[p.id];
      if (ps) return ps;
      p = p.parentId ? byId.get(p.parentId) : null;
    }
    return 'bar'; // 兜底（理论上 Aira 所有节点都可回溯到根容器）
  }

  // 记录根容器原始 id → 规范根 key 的映射，用于把子节点 parentId 也统一成规范 key
  const originalRootIdMap = new Map();
  // 1. 文件夹（type: 'bookmark-folder'）
  for (const f of folders) {
    const isAiraRoot = !!AIRA_ROOT_MAP[f.id] || !!AIRA_ROOT_MAP[f.title];
    // Aira 根容器 id 必须和子节点 parentId 引用一致。
    // 实测 Aira 根容器节点 id 可能是 '100277'，title='browser_root_toolbar'，而子节点 parentId='browser_root_toolbar'。
    // 因此把根容器 id 统一为 title（browser_root_toolbar/other/mobile），使子节点 parentId 能匹配。
    const rootKey = AIRA_ROOT_MAP[f.id] ? f.id : (AIRA_ROOT_MAP[f.title] ? f.title : null);
    if (rootKey && f.id !== rootKey) originalRootIdMap.set(f.id, rootKey);
    list.push({
      id: rootKey || f.id,
      // Aira 根容器 parentId 统一挂到虚拟根，title 标准化，使 computePathKeys 生成 ROOT:bar/other/mobile
      parentId: isAiraRoot ? ROOT_ID : (f.parentId || null),
      title: rootKey ? AIRA_ROOT_STANDARD_TITLES[rootKey] : (f.title || ''),
      isFolder: true,
      source: resolveSource(f), // 按 Aira 根容器归属正确设置，而非统一 'bar'
      createdAt: f.createdAt || undefined,
      updatedAt: f.updatedAt || undefined
    });
  }
  // 2. 书签项（type: 'bookmark-item'）
  for (const it of items) {
    let pid = it.parentId || null;
    // 如果 parentId 指向根容器原始 id，统一为规范根 key
    if (pid && originalRootIdMap.has(pid)) pid = originalRootIdMap.get(pid);
    list.push({
      id: it.id,
      parentId: pid,
      title: it.title || '',
      url: it.url || '',
      isFolder: false,
      source: resolveSource({ ...it, parentId: pid }),
      favicon: it.favicon || it.icon || undefined,
      color: it.color || undefined,
      createdAt: it.createdAt || undefined,
      updatedAt: it.updatedAt || undefined
    });
  }
  return list;
}

// ====== 扁平列表 → Aira snapshot（回写）======
// 将合并后的扁平列表重建为 Aira 三表结构（真实层级：顶层元数据 + snapshot 容器）
function airaListToSnapshot(list, prevRaw) {
  const prevSnap = airaGetSnapshotContainer(prevRaw) || {};

  // 兄弟顺序：优先沿用 prev 中 bookmarkOrders 的真实交错顺序（文件夹与书签项交错，
  // 如 [知乎, 我的最爱, bilibili]），避免 list 的「先全部文件夹、后全部书签项」导致顺序错位。
  // 再补入 list 中存在但 prev 未记录的节点（新增节点追加在末尾）。
  const prevOrders = (prevSnap.bookmarkOrders && Array.isArray(prevSnap.bookmarkOrders)) ? prevSnap.bookmarkOrders : [];
  const orderMap = new Map(); // parentId(归一) → [ids]
  // 将 Chrome 数字根 id 归一为 Aira 规范根容器（与 toAiraParentId 保持一致）：
  //   '0'/'1' → browser_root_toolbar ; '2' → browser_root_other ; null/undefined/ROOT_ID → null（真正的根顺序组）
  // 注意：不能把 '1' 当成 null 根，否则 (8) 真值里 parentId:"1" 的顺序组会丢失对齐。
  const normPid = (p) => {
    if (p === null || p === undefined || p === ROOT_ID) return null;
    if (p === '0' || p === '1') return 'browser_root_toolbar';
    if (p === '2') return 'browser_root_other';
    return p;
  };
  for (const o of prevOrders) {
    const pid = normPid(o.parentId);
    orderMap.set(pid, Array.isArray(o.ids) ? o.ids.slice() : []);
  }
  const seen = new Set();
  for (const ids of orderMap.values()) ids.forEach(id => seen.add(id));
  for (const n of list) {
    const pid = normPid(n.parentId);
    if (!orderMap.has(pid)) orderMap.set(pid, []);
    if (!seen.has(n.id)) { orderMap.get(pid).push(n.id); seen.add(n.id); }
  }

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const prevMeta = prevSnap.meta || prevRaw || {};
  const deviceId = prevMeta.deviceId || (typeof getDeviceId === 'function' ? getDeviceId() : 'aira');
  // updatedBy / revision 判定（与移动端真值规范一致）：
  //   根容器（browser_root_toolbar/other）与根顺序组（parentId=null）→ browser-shell-seed / 2
  //   其余所有节点与顺序组（桌面端维护的内容）                          → aira-bookmark-manager / 1
  const isRootContainer = (id) => id === 'browser_root_toolbar' || id === 'browser_root_other';
  // 节点（文件夹/书签项）判定：根容器本身 → browser-shell-seed/2；其余 → aira-bookmark-manager/1
  const byFor = (id) => isRootContainer(id) ? 'browser-shell-seed' : 'aira-bookmark-manager';
  const revFor = (id) => isRootContainer(id) ? 2 : 1;
  // 顺序组判定：仅根顺序组（parentId=null）→ browser-shell-seed/2；其余顺序组 → aira-bookmark-manager/1
  const byForOrder = (pid) => (pid === null || pid === undefined) ? 'browser-shell-seed' : 'aira-bookmark-manager';
  const revForOrder = (pid) => (pid === null || pid === undefined) ? 2 : 1;
  // 根级 parentId 统一映射为 Aira 规范根容器字符串（而非 null / Chrome 数字 id）
  //   书签栏 → browser_root_toolbar ; 其他书签 → browser_root_other
  const toAiraParentId = (n) => {
    const id = n.id;
    // 根容器自身：parentId 必须为 null（(5) 真值规范，如 书签栏/其他书签 的 parentId=null）
    if (id === 'browser_root_toolbar' || id === 'browser_root_other') return null;
    const p = n.parentId;
    if (p === null || p === undefined || p === ROOT_ID || p === '0' || p === '1') {
      return (n.source === 'other') ? 'browser_root_other' : 'browser_root_toolbar';
    }
    if (p === '2') return 'browser_root_other';
    return p;
  };

  // 全量 id 规范化：除两个根容器外，所有节点统一重命名为移动端规范格式
  //   文件夹 → bkf_bookmark_<6位随机后缀> ; 书签项 → bkm_bookmark_<6位随机后缀>
  // 后缀风格对齐真值（如 bkf_bookmark_a3z4yt 的 6 位随机串），且基于「原 id + 类型」做稳定哈希，
  // 保证同一份输入每次生成得到相同新 id（避免移动端反复重建）。
  // 已是规范 bkf_/bkm_bookmark_ 前缀的节点（移动端原有固定 id）原样保留，不做重命名。
  const rootIds = new Set(['browser_root_toolbar', 'browser_root_other']);
  // 规范 id：bkf_/bkm_bookmark_ 前缀 + 恰好 6 位 base36 后缀（对齐真值 a3z4yt 风格）。
  // 仅前缀匹配但后缀非 6 位（如旧版生成的 14 位变长 id）视为不规范，需重命名。
  const isNormId = (id) => /^bk[fm]_bookmark_[0-9a-z]{6}$/.test(id);
  const idMap = new Map();
  for (const n of list) {
    if (rootIds.has(n.id) || isNormId(n.id)) { idMap.set(n.id, n.id); continue; }
    const isFolder = n.isFolder || n.type === 'bookmark-folder';
    idMap.set(n.id, (isFolder ? 'bkf_bookmark_' : 'bkm_bookmark_') + stableSuffix(n.id + (isFolder ? 'F' : 'I')));
  }

  const bookmarkFolders = [];
  const bookmarkItems = [];
  for (const n of list) {
    const newId = idMap.get(n.id);
    // 父 id 同样走映射表（根容器 browser_root_* 在 idMap 中映射到自身；
    // 若未命中再回退到 toAiraParentId 做 Chrome 数字根归一化）。
    const newPid = idMap.get(n.parentId) || toAiraParentId(n);
    const isFolder = n.isFolder || n.type === 'bookmark-folder';
    if (isFolder) {
      bookmarkFolders.push({
        id: newId,
        type: 'bookmark-folder',
        parentId: newPid,
        title: n.title || '',
        createdAt: n.createdAt || nowIso,
        updatedAt: nowIso,
        updatedBy: byFor(newId),
        revision: revFor(newId)
      });
    } else {
      const item = {
        id: newId,
        type: 'bookmark-item',
        parentId: newPid,
        title: n.title || '',
        url: n.url || '',
        createdAt: n.createdAt || nowIso,
        updatedAt: nowIso,
        updatedBy: byFor(n.id),
        revision: revFor(n.id)
      };
      if (n.favicon) item.favicon = n.favicon;
      if (n.icon) item.icon = n.icon;
      if (n.color) item.color = n.color;
      bookmarkItems.push(item);
    }
  }

  // 确保 Aira 规范根容器「书签栏 / 其他书签」作为显式根文件夹记录存在
  // （移动端真值 snapshot(5) 中这是两条 parentId=null 的根记录，且排在最前；缺失会导致手机端无法识别根层级）
  const hasToolbar = bookmarkFolders.some(f => f.id === 'browser_root_toolbar');
  const hasOther = bookmarkFolders.some(f => f.id === 'browser_root_other');
  const rootToolbar = {
    id: 'browser_root_toolbar', type: 'bookmark-folder', parentId: null,
    title: '书签栏', createdAt: '2024-03-09T17:00:00.000Z', updatedAt: '2024-03-09T17:00:00.000Z',
    updatedBy: 'browser-shell-seed', revision: 2
  };
  const rootOther = {
    id: 'browser_root_other', type: 'bookmark-folder', parentId: null,
    title: '其他书签', createdAt: '2024-03-09T18:00:00.000Z', updatedAt: '2024-03-09T18:00:00.000Z',
    updatedBy: 'browser-shell-seed', revision: 2
  };
  if (!hasToolbar) bookmarkFolders.unshift(rootToolbar);
  if (!hasOther) bookmarkFolders.unshift(rootOther);
  // 根容器始终置顶（无论是否原本就在 list 中、位于何处），与 (5) 真值开头顺序一致
  bookmarkFolders.sort((a, b) => {
    const ra = a.id === 'browser_root_toolbar' ? 0 : a.id === 'browser_root_other' ? 1 : 2;
    const rb = b.id === 'browser_root_toolbar' ? 0 : b.id === 'browser_root_other' ? 1 : 2;
    return ra - rb;
  });

  const bookmarkOrders = [];
  // ★ 过滤悬空引用：orderMap 以 prev 的旧顺序组初始化（276-290 行），rebuild 全量重建时
  //   旧 ids 大多指向已不存在的节点（历史镜像/残留），手机端校验 orders 引用完整性，
  //   悬空 id 会导致「格式无效」。只保留本次 snapshot 中真实存在的节点 id；
  //   父 id 悬空的顺序组整组丢弃（browser_root_* 为移动端规范根，视为有效）。
  const validNodeIds = new Set([...bookmarkFolders, ...bookmarkItems].map(n => n.id));
  const isKnownContainer = (id) => id === null || id === 'browser_root_toolbar' ||
    id === 'browser_root_other' || id === 'browser_root_mobile';
  for (const [pid, ids] of orderMap.entries()) {
    const mapPid = (pid === null || pid === undefined) ? null : (idMap.get(pid) || pid);
    if (mapPid !== null && !isKnownContainer(mapPid) && !validNodeIds.has(mapPid)) continue; // 组父悬空 → 丢弃
    const validIds = (ids || [])
      .map(id => idMap.get(id) || id)
      .filter(id => validNodeIds.has(id));
    bookmarkOrders.push({
      type: 'bookmark-order',
      parentId: mapPid, // null 表示根顺序
      ids: validIds,
      updatedAt: nowIso,
      updatedBy: byForOrder(mapPid),
      revision: revForOrder(mapPid)
    });
  }

  // 顶层元信息 + snapshot 容器
  const container = prevRaw || {};
  // commitId 格式复刻移动端真值：<now36 8位>--<ts36 8位>-<设备指纹6位>-<随机6位>
  //   第3段取自身 deviceId 的稳定 6 位后缀（对齐真值 aira-sync-source-xxxx-ow0gdj 的最后一段）
  //   第4段为随机 base36（固定 6 位，对齐真值 1o85ux9/cafgxy 长度）
  const devSuffix = stableSuffix(deviceId).slice(0, 6);
  const out = {
    version: container.version || 2,
    history: container.history || { version: 1, epochId: 'bookmark-history-v1-origin', retainedFrom: '1970-01-01T00:00:00.000Z' },
    commitId: now.toString(36) + '--' + Date.now().toString(36) + '-' + devSuffix + '-' + rand36(),
    parentCommitId: null,
    deviceId: deviceId,
    createdAt: container.createdAt || new Date(now).toISOString(),
    snapshot: {
      meta: {
        version: (prevSnap.meta && prevSnap.meta.version) || 2,
        deviceId: deviceId,
        generatedAt: new Date(now).toISOString()
      },
      bookmarkFolders,
      bookmarkItems,
      bookmarkOrders,
      tombstones: Array.isArray(prevSnap.tombstones) ? prevSnap.tombstones : [],
      // 隐私书签空间：原样保留，不与普通书签混合（移动端强依赖此字段，缺失会被判读取失败）
      appPrivateBookmarks: prevSnap.appPrivateBookmarks || { bookmarkFolders: [], bookmarkItems: [], bookmarkOrders: [], tombstones: [] }
    }
  };
  // appPrivateBookmarks（隐私书签空间）原样保留，不同步
  if (prevSnap.appPrivateBookmarks) {
    out.snapshot.appPrivateBookmarks = prevSnap.appPrivateBookmarks;
  } else if (container.appPrivateBookmarks) {
    out.snapshot.appPrivateBookmarks = container.appPrivateBookmarks;
  }
  return out;
}

// 对 Aira 快照做去重/清理，避免残留重复节点堵塞上传判重。
// 规则：同一 pathKey（含父路径的 title/url）只保留第一份，其余并存的节点 id 全部映射到保留 id；
//       bookmarkOrders.ids 中指向被合并 id 的，替换为保留 id 并去重，过滤掉悬空引用。
function dedupeAiraSnapshot(folders, items, orders) {
  const all = [...folders, ...items];
  const byId = new Map();
  all.forEach(n => byId.set(n.id, n));

  // 计算 pathKey（复用 computePathKeys 的同一算法）
  function pkOf(node) {
    if (node.id === 'root') return 'ROOT';
    const ROOTMAP = { browser_root_toolbar: 'bar', browser_root_other: 'other', browser_root_mobile: 'mobile' };
    if (ROOTMAP[node.id]) return 'ROOT:' + ROOTMAP[node.id];
    const isFolder = node.type === 'bookmark-folder' || node.isFolder;
    const seg = isFolder ? 'F:' + node.title : 'L:' + (node.url || '');
    const p = byId.get(node.parentId);
    if (!p) return 'ROOT:unknown/' + seg;
    let pp = (p.id === 'root' && node.source && node.source !== 'home') ? 'ROOT:' + node.source : pkOf(p);
    return pp + '/' + seg;
  }

  // 按 pathKey 去重，保留第一份
  const keepIdByPK = new Map();   // pathKey -> 保留 id
  const alias = new Map();        // 被合并 id -> 保留 id
  const keptFolders = [];
  const keptItems = [];
  for (const n of folders) {
    const pk = pkOf(n);
    if (keepIdByPK.has(pk)) { alias.set(n.id, keepIdByPK.get(pk)); continue; }
    keepIdByPK.set(pk, n.id);
    keptFolders.push(n);
  }
  for (const n of items) {
    const pk = pkOf(n);
    if (keepIdByPK.has(pk)) { alias.set(n.id, keepIdByPK.get(pk)); continue; }
    keepIdByPK.set(pk, n.id);
    keptItems.push(n);
  }

  // 重建 orders：
  //   - parentId 若指向被合并的文件夹，则替换为其保留 id（避免悬空父）
  //   - ids 中指向被合并 id 的替换为保留 id，并去重、过滤悬空
  //   - 同 (parentId) 的多条 order 合并为一条（ids 拼接去重）
  const orderMap = new Map(); // 保留 parentId -> ids[]
  for (const o of orders) {
    const parentResolved = alias.get(o.parentId) || o.parentId;
    const seen = new Set(orderMap.get(parentResolved) || []);
    const ids = orderMap.get(parentResolved) || [];
    for (const id of (o.ids || [])) {
      const resolved = alias.get(id) || id;
      if (!byId.has(resolved) && !keptFolders.some(f => f.id === resolved) && !keptItems.some(i => i.id === resolved)) continue;
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      ids.push(resolved);
    }
    orderMap.set(parentResolved, ids);
  }
  const keptOrders = [];
  for (const [parentId, ids] of orderMap.entries()) {
    keptOrders.push({ type: 'bookmark-order', parentId, ids, updatedAt: new Date().toISOString(), updatedBy: 'aira-bookmark-manager', revision: 1 });
  }

  return { folders: keptFolders, items: keptItems, orders: keptOrders };
}

// ====== 桥接：将变更 patch 进 snapshot.json ======
// 增量原则（与 Aira 同步语义一致）：
//   - WebDAV 上已有的 snapshot.json 是「对方权威源」，原样保留其所有节点与字段（含 aira_ 前缀、扩展属性等）
//   - 桌面端 mergedList 中、按 pathKey 判重后「对方没有」的节点，才追加进 snapshot
//   - 绝不重建/覆盖对方节点，也不删除对方任何节点
async function patchAiraFile(mergedList, opts = {}) {
  // rebuild 模式：忽略手机端已有节点，以桌面 mergedList 全量重建 snapshot。
  // 用于清理历史镜像/残留（Aira 文件曾因"只增不减"策略积累到 300+ 节点）。
  // ⚠️ 手机端独有、桌面没有的书签会在此模式下丢失，仅在我方确认无保留价值后使用。
  const rebuild = !!(opts && opts.rebuild);
  let prev;
  try {
    prev = await downloadAiraBookmarks();
  } catch (e) {
    return;
  }
  if (!prev) {
    // WebDAV 上尚无 Aira 文件 → 不创建。
    // 原因：Aira 的 deviceId 必须以移动端为准（移动端强校验，不一致则拒绝合并）。
    // 若此处用桌面端自己的 deviceId 自创文件，移动端将永远合并不了、且形成死锁。
    // 正确顺序：由移动端先上传一份（带移动端 deviceId），桌面端再同步时沿用它。
    return;
  }

  const snap = airaGetSnapshotContainer(prev);
  if (!snap) return;

  // ===== 重建（对齐）模式：以桌面列表为准清理手机端 snapshot =====
  // 实现要点：保留 Aira 原生节点对象（字段齐全 → 手机端格式校验通过；从零重建的新节点
  // 缺失 Aira 原生专有字段，曾导致手机端「格式无效」），按桌面 pathKey 集合删除桌面
  // 没有的节点（历史镜像/残留），桌面独有节点随后由统一增量追加逻辑补齐。
  let folders, items, orders;
  let prevList;
  // 实际写入 snapshot 的节点（扁平表示）：供回写日志的四区统计使用
  let writtenFlatList = [];
  // 保留节点的 id 集（函数级：out 构建时用于墓碑冲突过滤，两个分支都会赋值）
  let keptIds;
  if (rebuild) {
    const snapList = airaSnapshotToList({ snapshot: { bookmarkFolders: snap.bookmarkFolders || [], bookmarkItems: snap.bookmarkItems || [], bookmarkOrders: snap.bookmarkOrders || [] } });
    const snapPKs = computePathKeys(snapList);
    const deskPKSet = new Set(computePathKeys(mergedList).values());

    // 原生节点 id → snapList id（根容器在 snapList 中被归一为 browser_root_*）
    const rawToSnapId = new Map();
    for (const f of (snap.bookmarkFolders || [])) {
      const t = String(f.title || '');
      rawToSnapId.set(String(f.id), t.startsWith('browser_root_') ? t : String(f.id));
    }
    for (const it of (snap.bookmarkItems || [])) rawToSnapId.set(String(it.id), String(it.id));
    const pkOfRaw = (raw) => {
      const sn = rawToSnapId.get(String(raw.id));
      const pk = sn ? snapPKs.get(sn) : null;
      return pk || null;
    };
    const isAiraRootId = (id) => String(id).startsWith('browser_root_');

    // 桌面 pathKey 集合中没有的 Aira 节点（历史镜像/残留）一律删除；规范根容器必留
    folders = (snap.bookmarkFolders || []).filter(f => {
      if (isAiraRootId(f.id)) return true;
      const pk = pkOfRaw(f);
      return !!pk && deskPKSet.has(pk);
    });
    items = (snap.bookmarkItems || []).filter(it => {
      const pk = pkOfRaw(it);
      return !!pk && deskPKSet.has(pk);
    });

    keptIds = new Set([...folders, ...items].map(n => String(n.id)));
    orders = (snap.bookmarkOrders || [])
      .map(o => ({ ...o, ids: (o.ids || []).filter(id => keptIds.has(String(id))) }))
      .filter(o => (o.ids || []).length > 0 || isAiraRootId(String(o.parentId)));

    // 对齐后的手机端节点列表：供后续增量追加判重（prevByPK）使用
    prevList = snapList.filter(n => {
      const pk = snapPKs.get(String(n.id));
      return !!pk && deskPKSet.has(pk);
    });
    writtenFlatList = prevList;
  } else {
    // 0) 对方快照去重/清理：
    //    手机删除书签后，snapshot 可能残留重复/失效节点，
    //    同一 pathKey 多份会占住判重坑，导致本地真实书签被误判"已存在"而无法上传。
    //    这里按 pathKey 去重，并同步修正 bookmarkOrders 的 ids 指向，避免"删后传不进去"。
    const deduped = dedupeAiraSnapshot(
      snap.bookmarkFolders || [], snap.bookmarkItems || [], snap.bookmarkOrders || []
    );
    folders = deduped.folders;
    items = deduped.items;
    orders = deduped.orders;
    keptIds = new Set([...folders, ...items].map(n => String(n.id)));
    // 1) 以对方节点为基准建 pathKey 索引（原样保留，不重建）
    // 注意：原始 Aira snapshot 节点用 type='bookmark-folder' 而非 isFolder，
    // 直接用 raw nodes 会导致 computePathKeys 把文件夹误判为叶子，pathKey 全错，
    // 结果每次写回都重复创建已存在的文件夹，Aira 文件越点越多。
    prevList = airaSnapshotToList({ snapshot: { bookmarkFolders: folders, bookmarkItems: items, bookmarkOrders: orders } });
    writtenFlatList = prevList;
  }
  const prevByPK = buildPathKeyMap(prevList);
  const mergedPKs = computePathKeys(mergedList);

  // URL 兜底去重集：Aira 已存在相同 URL 的书签（可能路径不同）→ 写回时不再重复写入，
  // 否则桌面端 Chrome 树会被整棵镜像进 Aira 文件、越攒越大（用户侧表现为 Aira 数量暴涨到 700+）。
  const normUrl = (u) => (u || '').replace(/&amp;/g, '&').replace(/\/$/, '');
  const prevUrlSet = new Set(items.filter(n => n.url).map(n => normUrl(n.url)));
  const prevItemsByUrl = new Map(items.filter(n => n.url).map(n => [normUrl(n.url), n]));

  // 系统根容器（书签栏/其他书签/移动收藏夹）在桌面端树里也是节点，
  // 需映射到 Aira 根容器 id，作为新建节点的父。
  const ROOT_AIRA = {
    bar: 'browser_root_toolbar',
    other: 'browser_root_other',
    mobile: 'browser_root_mobile'
  };
  const rootContainerMap = new Map(); // 桌面端根容器节点 id → Aira 根容器 id
  for (const n of mergedList) {
    const t = (n.title || '').toLowerCase();
    if (['书签栏', '书签工具栏', 'bookmarks bar', '其他书签', '其他 bookmark', '移动收藏夹', '移动设备书签'].includes(t)) {
      const src = n.source === 'other' ? 'other' : n.source === 'mobile' ? 'mobile' : 'bar';
      rootContainerMap.set(n.id, ROOT_AIRA[src]);
    }
  }

  // 2) 遍历桌面端节点，按 pathKey 判重，仅追加对方没有的
  const mergedIdToAiraId = new Map();
  const now = new Date().toISOString();
  const newFolderIds = [];
  const newItemIds = [];

  function mapParent(pid) {
    if (!pid) return null;
    if (mergedIdToAiraId.has(pid)) return mergedIdToAiraId.get(pid);
    if (rootContainerMap.has(pid)) return rootContainerMap.get(pid);
    // 兜底：按 source 挂到对应根容器
    return null;
  }

  for (const n of mergedList) {
    // Berry主页（source==='home'）不进 Aira 书签，改走 g2/personalization 的 home_shortcuts；
    // HOME 容器（id=HOME_FOLDER_ID，source='other'）同样跳过，避免「Berry主页」空文件夹
    // 被反复创建进 Aira 文件
    if (n.source === 'home' || n.id === HOME_FOLDER_ID) continue;
    const pk = mergedPKs.get(n.id);
    if (!pk) continue;
    if (prevByPK.has(pk)) {
      // 对方已有 → 不动，仅记录 id 映射（供子节点挂接）
      const exist = prevByPK.get(pk);
      mergedIdToAiraId.set(n.id, exist.id);
      continue;
    }
    // 对方没有 → 新增（仅当不是系统根容器本身）
    if (rootContainerMap.has(n.id)) continue;

    const isFolder = n.isFolder || n.type === 'bookmark-folder';

    // URL 兜底去重：Aira 已存在相同 URL 的书签（可能路径不同）→ 不重复写入，
    // 避免桌面端 Chrome 树被整棵镜像进 Aira 文件、越攒越大。
    if (!isFolder && n.url) {
      const u = normUrl(n.url);
      if (prevUrlSet.has(u)) {
        const exist = prevItemsByUrl.get(u);
        mergedIdToAiraId.set(n.id, exist ? exist.id : null);
        continue;
      }
      prevUrlSet.add(u);
    }

    const newId = (isFolder ? 'bkf_bookmark_' : 'bkm_bookmark_') +
      stableSuffix(n.id + (isFolder ? 'F' : 'I') + Date.now() + Math.random());
    mergedIdToAiraId.set(n.id, newId);

    let parentId = mapParent(n.parentId);
    if (!parentId) {
      // 兜底挂到 source 对应根容器（默认 bar）
      const src = n.source === 'other' ? 'other' : n.source === 'mobile' ? 'mobile' : 'bar';
      parentId = ROOT_AIRA[src];
    }

    const base = {
      id: newId,
      type: isFolder ? 'bookmark-folder' : 'bookmark-item',
      parentId: parentId,
      title: n.title || '',
      createdAt: n.createdAt || now,
      updatedAt: now,
      updatedBy: 'aira-bookmark-manager',
      revision: 1
    };
    if (isFolder) {
      folders.push(base);
      newFolderIds.push(newId);
    } else {
      base.url = n.url || '';
      items.push(base);
      newItemIds.push(newId);
    }
  }

  // 3) 更新 bookmarkOrders：把新增节点挂到对应父的顺序组末尾
  function ensureOrder(parentId, id) {
    let ord = orders.find(o => o.parentId === parentId);
    if (!ord) {
      ord = { type: 'bookmark-order', parentId: parentId, ids: [], updatedAt: now, updatedBy: 'aira-bookmark-manager', revision: 1 };
      orders.push(ord);
    }
    if (!ord.ids.includes(id)) ord.ids.push(id);
  }
  // 遍历新建节点，按映射后的 parentId 追加到顺序组
  for (const n of mergedList) {
    if (n.source === 'home') continue;
    if (!mergedIdToAiraId.has(n.id)) continue;
    const pk = mergedPKs.get(n.id);
    if (!pk || prevByPK.has(pk)) continue; // 只处理新增
    if (rootContainerMap.has(n.id)) continue;
    const isFolder = n.isFolder || n.type === 'bookmark-folder';
    const newId = mergedIdToAiraId.get(n.id);
    let parentId = mapParent(n.parentId);
    if (!parentId) {
      const src = n.source === 'other' ? 'other' : n.source === 'mobile' ? 'mobile' : 'bar';
      parentId = ROOT_AIRA[src];
    }
    ensureOrder(parentId, newId);
  }

  // 3.5) ★ 顺序以桌面为权威：按 mergedList 同父出现顺序（Chrome 树 DFS，文件夹与
  //   书签项的交错顺序与桌面显示一致）重排每个顺序组；端上独有节点（桌面暂无）
  //   追加组末尾，避免丢引用被手机端判悬空。此前沿用端上旧顺序，桌面拖拽重排
  //   无法传播到 Aira，表现为「各端顺序不一致」。
  const deskOrderGroups = new Map(); // aira parentId → [aira ids]（桌面顺序）
  for (const n of mergedList) {
    if (n.source === 'home' || n.id === HOME_FOLDER_ID) continue;
    if (rootContainerMap.has(n.id)) continue; // 系统根容器不进顺序组
    const aid = mergedIdToAiraId.get(n.id);
    if (!aid) continue;
    let airaPid = mapParent(n.parentId);
    if (!airaPid) {
      const src = n.source === 'other' ? 'other' : n.source === 'mobile' ? 'mobile' : 'bar';
      airaPid = ROOT_AIRA[src];
    }
    if (!deskOrderGroups.has(airaPid)) deskOrderGroups.set(airaPid, []);
    deskOrderGroups.get(airaPid).push(aid);
  }
  for (const ord of orders) {
    const deskIds = deskOrderGroups.get(ord.parentId);
    if (!deskIds || !deskIds.length) continue; // 桌面该组无节点（如根顺序组）→ 保持端上原序
    const deskSet = new Set(deskIds);
    const rest = (ord.ids || []).filter(id => !deskSet.has(id)); // 端上独有，排末尾
    ord.ids = [...deskIds, ...rest];
  }

  // 4) 写回：version/history/deviceId/createdAt 原样沿用，仅重算 commitId、parentCommitId 固定 null
  const devSuffix = stableSuffix(prev.deviceId).slice(0, 6);
  const prevSnap = prev.snapshot || {};
  const out = {
    version: prev.version,
    history: prev.history,
    commitId: Date.now().toString(36) + '--' + Date.now().toString(36) + '-' + devSuffix + '-' + rand36(),
    parentCommitId: null,
    deviceId: prev.deviceId,
    createdAt: prev.createdAt || new Date().toISOString(),
    snapshot: {
      // ★ generatedAt 必须随每次写回更新（沿用旧值会被移动端视为过期的提交）
      meta: { ...(prevSnap.meta || { version: 2, deviceId: prev.deviceId }), generatedAt: new Date().toISOString() },
      bookmarkFolders: folders,
      bookmarkItems: items,
      bookmarkOrders: orders,
      // ★ 墓碑一致性：同一 id 不得同时存在于 items 与 tombstones（移动端状态一致性
      //   校验会判「格式无效」——实测真值 tombstones 达 1165 条且随提交维护）。
      //   处理：与保留节点 id 冲突的墓碑移除（桌面已恢复的书签不再视为已删），
      //   其余「真删除」墓碑原样保留，供移动端正常消费删除状态。
      tombstones: (prevSnap.tombstones || []).filter(t => !keptIds.has(String(t.id))),
      appPrivateBookmarks: prevSnap.appPrivateBookmarks || { bookmarkFolders: [], bookmarkItems: [], bookmarkOrders: [], tombstones: [] }
    }
  };

  try {
    await uploadAiraBookmarks(out);
    console.log(`[sync] 🤖 Aira 回写完成: ${zoneSummary(writtenFlatList, { includeHome: false })}`);
  } catch (e) {
    // 上传失败静默忽略，避免阻塞主上传流程
    console.warn('[sync] 🤖 Aira 桥接：上传失败', e.message);
  }
}

// ====== 从 Aira 文件读取变更并合并 ======
async function mergeAiraData(currentList, preferLocalOrder = false, tombstoneKeys = null) {
  let airaData;
  try {
    airaData = await downloadAiraBookmarks();
  } catch (e) {
    return currentList;
  }
  const airaList = airaSnapshotToList(airaData);
  if (!airaList || airaList.length === 0) return currentList;

  // 0. 从 Aira personalization（g2）读 home_shortcuts，合并回 Berry主页（source==='home'）
  try {
    const pers = await downloadAiraPersonalization();
    if (pers && pers.sections && pers.sections.home_shortcuts) {
      const scs = pers.sections.home_shortcuts.payload.shortcuts || [];
      // ★ 归一化匹配：http/https、www.、尾斜杠差异视为同一主页书签。
      //   此前精确 toLowerCase 匹配导致 personalization 的历史条目（协议/斜杠略异）
      //   每次都被误判为「主页新增」注入，home 区数量逐轮膨胀（曾在手机端出现成对重复）。
      const localUrls = new Set(currentList.filter(n => n.source === 'home' && n.url).map(n => normalizeUrlForDedup(n.url)));
      const homeNodes = [];
      for (const sc of scs) {
        if (!sc.url || localUrls.has(normalizeUrlForDedup(sc.url))) continue;
        localUrls.add(normalizeUrlForDedup(sc.url));
        homeNodes.push({
          id: sc.id || ('shortcut-' + stableSuffix(sc.url)),
          title: sc.title || '',
          url: sc.url || '',
          isFolder: false,
          parentId: HOME_FOLDER_ID,
          source: 'home'
        });
      }
      if (homeNodes.length > 0) {
        // ★ 禁止原地修改传入数组：currentList 可能与调用方的列表同引用
        //   （如 mergeViaData 无新增时原样返回 flatList），原地 push 会把 Aira 的
        //   home 节点污染进其他桥接的回写列表（曾导致 Via 回写凭空多出 11 条）。
        const needHomeContainer = !currentList.some(n => n.id === HOME_FOLDER_ID);
        currentList = needHomeContainer
          ? [...currentList, { id: HOME_FOLDER_ID, title: 'Berry主页', isFolder: true, parentId: 'root', source: 'other' }, ...homeNodes]
          : [...currentList, ...homeNodes];
      }
    }
  } catch (e) { /* personalization 不存在则忽略 */ }

  // 建立 source → 本地 Chrome 根容器 id 的映射
  // 优先用 Chrome 标准根 id（'1'/'2'/'3'）识别，若用户浏览器根 id 被改写，
  // 再用系统根标题兜底，避免被 parentId='root' 的污染节点覆盖。
  const CHROME_ROOT_IDS = new Set(['1', '2', '3']);
  const isRealRootContainer = (n) => {
    if (!n.isFolder) return false;
    // ★ home 虚拟容器（移动端主页）：id 稳定不依赖标题，等同系统容器不可删/不可过滤
    if (String(n.id) === String(HOME_FOLDER_ID)) return true;
    if (CHROME_ROOT_IDS.has(String(n.id))) return true;
    const isParentRoot = n.parentId === ROOT_ID || n.parentId === null || n.parentId === '0';
    const srcByTitle = detectFolderSourceByTitle(n.title);
    return isParentRoot && !!srcByTitle && srcByTitle !== 'home';
  };
  const sourceToRootId = new Map();
  for (const n of currentList) {
    if (!isRealRootContainer(n)) continue;
    const src = n.source || detectFolderSourceByTitle(n.title);
    if (!src || src === 'home') continue;
    // 同一 source 只取第一个，避免污染节点覆盖
    if (!sourceToRootId.has(src)) sourceToRootId.set(src, n.id);
  }
  // 兜底：若按标题/父级未识别到根容器（比如 Berry/Via 合并后改写了根标题），
  // 直接以 Chrome 标准根 id '1'/'2'/'3' 建立映射，避免后续 rootIdMap 为空导致
  // Aira 整棵树的 pathKey 偏移，所有节点被误判为新增。
  if (sourceToRootId.size === 0) {
    // Chrome/Edge 根容器 id 固定为 '1'/'2'/'3'，直接用做兜底映射，
    // 避免 currentList 缺少根容器时 rootIdMap 为空、Aira 整树变孤儿。
    sourceToRootId.set('bar', '1');
    sourceToRootId.set('other', '2');
    sourceToRootId.set('mobile', '3');
  }
  function detectFolderSourceByTitle(title) {
    const t = (title || '').toLowerCase();
    const titles = typeof FOLDER_TITLES !== 'undefined' ? FOLDER_TITLES : null;
    if (!titles) return null;
    if (titles.bookmarkBar.some(x => x.toLowerCase() === t)) return 'bar';
    if (titles.otherBookmarks.some(x => x.toLowerCase() === t)) return 'other';
    if (titles.mobileBookmarks.some(x => x.toLowerCase() === t)) return 'mobile';
    return null;
  }

  // Aira 根容器 id → source，用于把 Aira 整棵树的根容器 id 替换为本地 Chrome 根容器 id
  const AIRA_ROOT_IDS = new Map([
    ['browser_root_toolbar', 'bar'],
    ['browser_root_other', 'other'],
    ['browser_root_mobile', 'mobile']
  ]);
  const STANDARD_ROOT_TITLES = { bar: '书签栏', other: '其他收藏夹', mobile: '移动收藏夹' };

  // 规范化 Aira 列表：把 Aira 根容器 id 和直接挂在根下的 parentId 替换为本地根容器 id，
  // 使 Aira 子节点的 pathKey 与本地 Chrome 完全一致（ROOT:bar/...），避免父文件夹重复注入和子节点变孤儿
  const rootIdMap = new Map();
  for (const [airaId, source] of AIRA_ROOT_IDS) {
    const localId = sourceToRootId.get(source);
    if (localId) rootIdMap.set(airaId, localId);
  }
  const normalizedAiraList = airaList.map(n => {
    const copy = { ...n };
    const selfSource = AIRA_ROOT_IDS.get(copy.id);
    if (selfSource) {
      const localId = rootIdMap.get(copy.id);
      if (localId) {
        copy.id = localId;
        copy.parentId = ROOT_ID;
        copy.title = STANDARD_ROOT_TITLES[selfSource] || copy.title;
      }
    }
    if (rootIdMap.has(copy.parentId)) {
      copy.parentId = rootIdMap.get(copy.parentId);
    }
    return copy;
  });

  const airaPKs = computePathKeys(normalizedAiraList);
  const currentPKs = computePathKeys(currentList);
  const airaByPK = buildPathKeyMap(normalizedAiraList);
  const currentPKSet = new Set(currentPKs.values());

  // 1. 继承图标/颜色
  let enriched = currentList.map(n => {
    const pk = currentPKs.get(n.id);
    if (!pk) return n;
    const a = airaByPK.get(pk);
    if (a) {
      const copy = { ...n };
      if (a.favicon && !copy.favicon) copy.favicon = a.favicon;
      if (a.color && !copy.color) copy.color = a.color;
      return copy;
    }
    return n;
  });

  // 2. Aira 新增节点（pathKey 不在本地）
  // 必须用 normalizedAiraList，否则 parentId 还是 Aira 原始根 id（browser_root_toolbar），
  // 而 airaPKs 的 key 已经是本地根 id（'1'/'195'），会映射失败 fallback 到 'root'。
  function getParentPath(pk) {
    if (!pk) return '';
    const i = pk.lastIndexOf('/');
    return i > 0 ? pk.substring(0, i) : pk;
  }
  // URL 兜底去重集：Air 里大量节点其实是 Chrome 的镜像（URL 相同但路径不同），
  // pathKey 按完整路径严格匹配会失败，若不兜底就会反复注入，撑大数量。
  const curUrlSet = new Set(currentList.filter(n => !n.isFolder && n.url).map(n => (n.url || '').replace(/&amp;/g, '&').replace(/\/$/, '')));
  const airaNew = normalizedAiraList.filter(n => {
    const pk = airaPKs.get(n.id);
    if (!pk || currentPKSet.has(pk)) return false;
    if (tombstoneKeys && tombstoneKeys.has(pk)) return false;
    // 兜底：Chrome 已存在相同 URL 的书签 → 视为重复，避免 Aira 里的镜像重复回灌
    if (!n.isFolder && n.url) {
      const u = (n.url || '').replace(/&amp;/g, '&').replace(/\/$/, '');
      if (curUrlSet.has(u)) return false;
    }
    return true;
  });

  // 3. Aira 删除检测（pathKey 快照）
  const airaPKSet = new Set(airaPKs.values());
  // 对方节点的 URL / 文件夹标题集合：识别「父改名/移动导致 pathKey 变了，但并非真删」
  const airaUrlSet = new Set(
    airaList.filter(n => !n.isFolder && n.url).map(n => n.url.replace(/&amp;/g, '&').replace(/\/$/, ''))
  );
  const airaFolderTitles = new Set(
    airaList.filter(n => n.isFolder).map(n => n.title)
  );
  const snapshotData = (await chrome.storage.local.get(['aira_pathkey_snapshot']))['aira_pathkey_snapshot'] || [];
  const airaSnapshotSet = new Set(snapshotData);
  let airaDeletedCount = 0;
  if (airaSnapshotSet.size > 0) {
    enriched = enriched.filter(n => {
      // 本地 Chrome 根容器是系统容器，Aira 不能删除，必须保留（id='1'/'2'/'3' 或系统根标题）
      if (isRealRootContainer(n)) return true;
      const pk = currentPKs.get(n.id);
      if (!pk) return true;
      // 上次快照有、本次没有 → 疑似 Aira 删了
      if (airaSnapshotSet.has(pk) && !airaPKSet.has(pk)) {
        // 改名/移动兜底：URL（书签）或标题（文件夹）仍存在于对方 → 只是路径变了，不是真删
        if (!n.isFolder && n.url) {
          const u = n.url.replace(/&amp;/g, '&').replace(/\/$/, '');
          if (airaUrlSet.has(u)) return true;
        }
        if (n.isFolder && n.title && airaFolderTitles.has(n.title)) return true;
        airaDeletedCount++;
        return false; // Aira 真删了
      }
      return true;
    });
  }
  await chrome.storage.local.set({ 'aira_pathkey_snapshot': [...airaPKSet] });

  // ===== 4. 组装结果（保持输入数组顺序，仅追加 Aira 新增） =====
  const combined = [...enriched];
  // 按 pathKey 深度升序排序，确保父文件夹先于子节点注入（避免子节点找不到父而变孤儿）
  const airaNewSorted = [...airaNew].sort((x, y) => {
    const px = (airaPKs.get(x.id) || '').split('/').length;
    const py = (airaPKs.get(y.id) || '').split('/').length;
    return px - py;
  });
  for (const a of airaNewSorted) {
    // 映射 parentId 到当前列表中的节点 id
    let mappedParent = a.parentId;

    // 0. 直接挂在虚拟根（'root'）下的节点，按 source 归到对应本地真实根容器
    if (mappedParent === ROOT_ID) {
      const srcRootId = sourceToRootId.get(a.source);
      if (srcRootId) mappedParent = srcRootId;
    }

    const parentPK = airaPKs.get(mappedParent);

    // 1. Aira 内部层级：父文件夹也是本次新增的，已先加入 combined，直接按 id 保留
    if (combined.some(n => String(n.id) === String(mappedParent))) {
      // mappedParent 已是 combined 中有效 id，保持不变
    } else if (parentPK) {
      // 2. 映射到本地已存在的节点
      const cur = currentList.find(n => currentPKs.get(n.id) === parentPK);
      if (cur) mappedParent = cur.id;
    }
    // 兜底：如果 still 找不到父，按 source 归到对应本地真实根，绝不 fallback 到虚拟 'root'
    const isOrphan = mappedParent &&
      !combined.some(n => String(n.id) === String(mappedParent)) &&
      !currentList.some(n => String(n.id) === String(mappedParent));
    if (isOrphan) {
      const fallbackRoot = sourceToRootId.get(a.source);
      if (fallbackRoot) mappedParent = fallbackRoot;
    }
    combined.push({ ...a, parentId: mappedParent });
  }

  // ★ 顺序以合并链数组为权威（桌面顺序）：不再按 Aira bookmarkOrders 重排——
  //    回写时 patchAiraFile 已把端上 orders 重排为桌面顺序，这里若再按端上旧 orders
  //    重排数组，会把 Berry/Via 刚传播来的新顺序打回旧序（表现为「一端调整顺序后
  //    另一端合并顺序不变」）。仅保留原有的系统容器兜底与 pk 过滤，顺序保持输入。
  const result = [];
  for (const n of combined) {
    const srcByTitle = detectFolderSourceByTitle(n.title);
    // ★ home 虚拟容器用 id 判定保留（旧硬编码 n.title === 'Berry主页' 在改名
    //   「移动端主页」后失配，导致容器被本过滤丢弃 → home 子节点变孤儿 → 落到书签栏）
    const isSystemContainer = isRealRootContainer(n) || (n.isFolder && n.parentId === ROOT_ID && srcByTitle && srcByTitle !== 'home') || n.title === 'Berry主页' || String(n.id) === String(HOME_FOLDER_ID);
    if (!isSystemContainer) {
      const pk = currentPKs.get(n.id);
      const aPk = airaPKs.get(n.id);
      if (!(aPk || pk)) continue; // 与原逻辑一致：无 pathKey 的节点不进入结果
    }
    result.push(n);
  }

  // Aira 新增节点（来自 snapshot 解析）无 _index → 补到同父已有节点之后
  MiniSync.utils.fillMissingSiblingIndex(result);
  console.log(`[sync] 🤖 Aira 处理完成: ${zoneSummary(result)}`);
  return result;
}

// 构建 pathKey → 节点 映射
function buildPathKeyMap(list) {
  const pks = computePathKeys(list);
  const m = new Map();
  for (const n of list) {
    const pk = pks.get(n.id);
    if (pk) m.set(pk, n);
  }
  return m;
}

// 挂载到 MiniSync
MiniSync.aira = {
  mergeAiraData,
  patchAiraFile,
  patchAiraPersonalization,
  downloadAiraBookmarks,
  uploadAiraBookmarks,
  downloadAiraPersonalization,
  uploadAiraPersonalization
};
