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

// 取 Aira personalization（g2）路径，保留自定义 g3 路径的完整前缀。
async function getAiraPersonalizationPath() {
  const base = (await getAiraPath()).replace(/\/+$/, '');
  const segs = base.split('/').filter(Boolean);
  const root = segs.length >= 3 && segs[segs.length - 2] === 'g3' && segs[segs.length - 1] === 'bookmarks'
    ? segs.slice(0, -2).join('/') || 'aira'
    : segs[0] || 'aira';
  return (base.startsWith('/') ? '/' : '') + root + '/g2/personalization';
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
// 默认（合并语义）：保留端上独有条目，仅按明确墓碑传播删除。
async function patchAiraPersonalization(mergedList, opts = {}) {
  const align = !!(opts && opts.align);
  let prev;
  prev = await downloadAiraPersonalization();

  // personalization 缺失时的种子创建：若 g3 snapshot.json 存在（内含移动端 deviceId），
  // 桌面可携带该 deviceId 创建 personalization 骨架并按桌面 home 填充——
  // 移动端的 deviceId 一致性校验可过，不会形成死锁。g3 也不存在 → 仍不创建（保持保护）。
  if (!prev) {
    const g3 = await downloadAiraBookmarks();
    const seedDeviceId = (g3 && (g3.deviceId || (g3.meta && g3.meta.deviceId) || (g3.snapshot && g3.snapshot.meta && g3.snapshot.meta.deviceId))) || '';
    if (!align || !seedDeviceId) {
      // 合并语义（非 align）不创建；连移动端 deviceId 都拿不到 → 不创建（保持原保护）
      return { status: 'skipped', reason: 'Aira 主页缺失且无设备 ID' };
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
  if (!prev.sections || !prev.sections.home_shortcuts) throw new Error('Aira 主页文件格式无效');

  const homeItems = mergedList.filter(n => n.source === 'home' && !n.isFolder && n.url);
  // ★ 归一化去重：http/https、www.、尾斜杠差异视为同一书签。
  //   此前精确匹配导致同一批主页书签被反复追加（Berry 主页出现成对重复）。
  //   顺带清理历史重复：归一化 URL 相同的 shortcuts 只保留最早创建的一条。
  //   align 模式下进一步以桌面 home 为准：桌面没有的 shortcuts 一律移除。
  const deskUrls = align ? new Set(homeItems.map(n => normalizeUrlForDedup(n.url))) : null;
  const deletionState = await MiniSync.utils.readLocalKeys(['sync_tombstones']);
  const deletionKeys = new Set((deletionState.sync_tombstones || []).map(t => typeof t === 'string' ? t : t && t.key));
  const liveKeys = new Set(computePathKeys(mergedList).values());
  const allShortcuts = prev.sections.home_shortcuts.payload.shortcuts || [];
  const homeNodes = allShortcuts.map(sc => ({ id: sc.id, title: sc.title || '', url: sc.url,
    parentId: HOME_FOLDER_ID, source: 'home', isFolder: false, createdAt: sc.createdAt, updatedAt: sc.updatedAt }));
  const homeKeys = computePathKeys(homeNodes);
  const seenNormUrls = new Set();
  const keptShortcutIds = new Set();
  const dedupedShortcuts = [];
  for (const sc of allShortcuts) {
    const norm = normalizeUrlForDedup(sc.url);
    const key = homeKeys.get(sc.id);
    if (deletionKeys.has(key) && !liveKeys.has(key)) continue;
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
      throw e;
    }
  }
  if (!needUpload) return { status: 'skipped' };
  const written = prev.sections.home_shortcuts.payload.shortcuts.map(sc => ({ id: sc.id,
    title: sc.title || '', url: sc.url, parentId: HOME_FOLDER_ID, source: 'home', isFolder: false,
    createdAt: sc.createdAt, updatedAt: sc.updatedAt }));
  const snapshotUpdates = await MiniSync.berry.bridgeIdentity.snapshotUpdates('aira_home_pathkey_snapshot',
    (await MiniSync.utils.airaResourceUrls()).g2, written);
  return { status: 'success', snapshotUpdates };
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
  // ★ bookmarkItems 必须是数组：结构损坏（对象/字符串）不能被静默当成「空 items」——
  //   那会让删除检测读到「手机端把书签都删了」，本机与云端书签被整批删除
  //   （审计 2026-10-11 复现 aira-malformed-item-table-with-valid-roots...）。
  //   抛错 = 读取不完整，调用方停掉删除检测与写回。
  if (snap.bookmarkItems !== undefined && !Array.isArray(snap.bookmarkItems)) {
    throw new Error('Aira 快照 bookmarkItems 格式无效');
  }
  const items = (Array.isArray(snap.bookmarkItems) ? snap.bookmarkItems : []).filter(it => !it.type || it.type === 'bookmark-item');
  const nativeRoots = new Map();
  for (const f of folders) {
    const rootKey = AIRA_ROOT_MAP[f.id] ? f.id : AIRA_ROOT_MAP[f.title] ? f.title : null;
    if (rootKey) nativeRoots.set(rootKey, f);
  }
  for (const node of [...folders, ...items]) {
    if (!node || typeof node.id !== 'string' || !node.id || byId.has(node.id)) {
      throw new Error('Aira 快照节点 ID 无效或重复');
    }
    byId.set(node.id, node);
  }
  const parentOf = node => byId.get(node.parentId) || nativeRoots.get(node.parentId);
  for (const node of [...folders, ...items]) {
    if (node.parentId != null && (!parentOf(node) || !folders.includes(parentOf(node)))) {
      throw new Error('Aira 快照存在悬空父节点');
    }
    const seen = new Set();
    let parent = node;
    while (parent) {
      if (seen.has(parent.id)) throw new Error('Aira 快照包含环形父链');
      seen.add(parent.id);
      parent = parent.parentId != null ? parentOf(parent) : null;
    }
  }

  // 向上回溯，确定某个节点所属根区的 source（bar/other/mobile）
  function resolveSource(node) {
    const rootSrc = AIRA_ROOT_MAP[node.id] || AIRA_ROOT_MAP[node.title];
    if (rootSrc) return rootSrc; // 根容器本身
    if (node.parentId && AIRA_ROOT_MAP[node.parentId]) return AIRA_ROOT_MAP[node.parentId]; // 直接挂在根容器下
    // 挂在普通文件夹下 → 向上回溯父链
    let p = node.parentId ? parentOf(node) : null;
    while (p) {
      const ps = AIRA_ROOT_MAP[p.id] || AIRA_ROOT_MAP[p.title];
      if (ps) return ps;
      p = p.parentId ? parentOf(p) : null;
    }
    return 'bar'; // 兜底（理论上 Aira 所有节点都可回溯到根容器）
  }

  // 记录根容器原始 id → 规范根 key 的映射，用于把子节点 parentId 也统一成规范 key
  const originalRootIdMap = new Map([...nativeRoots].map(([key, node]) => [node.id, key]));
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
      parentId: isAiraRoot ? ROOT_ID : (originalRootIdMap.get(f.parentId) || f.parentId || null),
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
  const rootSources = { browser_root_toolbar: 'bar', browser_root_other: 'other', browser_root_mobile: 'mobile' };
  const rootKey = n => rootSources[n.id] ? n.id : rootSources[n.title] ? n.title : null;
  const list = airaSnapshotToList({ snapshot: { bookmarkFolders: folders, bookmarkItems: items } });
  const keys = computePathKeys(list);
  const nativeRoots = new Map();
  for (const n of folders) if (rootKey(n) && !nativeRoots.has(rootKey(n))) nativeRoots.set(rootKey(n), n.id);
  const keepIdByPK = new Map();
  const alias = new Map();
  const keep = nodes => nodes.flatMap(n => {
    const root = rootKey(n);
    const pk = root ? 'ROOT:' + rootSources[root] : keys.get(n.id) || 'ID:' + n.id;
    if (keepIdByPK.has(pk)) { alias.set(n.id, keepIdByPK.get(pk)); return []; }
    keepIdByPK.set(pk, n.id);
    return [{ ...n }];
  });
  const keptFolders = keep(folders);
  const keptItems = keep(items);
  function resolve(id) {
    id = nativeRoots.get(id) || id;
    while (alias.has(id)) id = alias.get(id);
    return id == null ? null : id;
  }
  const kept = new Map([...keptFolders, ...keptItems].map(n => [n.id, n]));
  const folderIds = new Set(keptFolders.map(n => n.id));
  for (const n of kept.values()) {
    n.parentId = resolve(n.parentId);
    if (n.parentId !== null && !folderIds.has(n.parentId)) throw new Error('Aira 快照存在悬空父节点');
  }
  const orderMap = new Map();
  for (const o of orders) {
    const parentId = resolve(o.parentId);
    if (parentId !== null && !folderIds.has(parentId)) continue;
    if (!orderMap.has(parentId)) orderMap.set(parentId, { ...o, parentId, ids: [] });
    const order = orderMap.get(parentId);
    const seen = new Set(order.ids);
    for (const id of o.ids || []) {
      const resolved = resolve(id);
      const node = kept.get(resolved);
      if (!node || node.parentId !== parentId || seen.has(resolved)) continue;
      seen.add(resolved);
      order.ids.push(resolved);
    }
  }
  return { folders: keptFolders, items: keptItems, orders: [...orderMap.values()] };
}

// ====== 桥接：将变更 patch 进 snapshot.json ======
// 增量原则（与 Aira 同步语义一致）：
//   - WebDAV 上已有的 snapshot.json 是「对方权威源」，原样保留其所有节点与字段（含 aira_ 前缀、扩展属性等）
//   - 桌面端 mergedList 中、按 pathKey 判重后「对方没有」的节点，才追加进 snapshot
//   - 保留端上独有节点与原生字段；只传播已有墓碑明确证明的删除
async function patchAiraFile(mergedList, opts = {}) {
  // rebuild 模式：忽略手机端已有节点，以桌面 mergedList 全量重建 snapshot。
  // 用于清理历史镜像/残留（Aira 文件曾因"只增不减"策略积累到 300+ 节点）。
  // ⚠️ 手机端独有、桌面没有的书签会在此模式下丢失，仅在我方确认无保留价值后使用。
  const rebuild = !!(opts && opts.rebuild);
  let prev;
  try {
    prev = await downloadAiraBookmarks();
  } catch (e) {
    throw new Error(`Aira 读取失败: ${e.message}`);
  }
  if (!prev) {
    // Aira deviceId 只能由移动端创建；明确标记跳过。
    return { status: 'skipped', reason: 'Aira 文件不存在' };
  }

  const snap = airaGetSnapshotContainer(prev);
  if (!snap || !Array.isArray(snap.bookmarkFolders)) throw new Error('Aira 快照格式无效');

  // ===== 重建（对齐）模式：以桌面列表为准清理手机端 snapshot =====
  // 实现要点：保留 Aira 原生节点对象（字段齐全 → 手机端格式校验通过；从零重建的新节点
  // 缺失 Aira 原生专有字段，曾导致手机端「格式无效」），按桌面 pathKey 集合删除桌面
  // 没有的节点（历史镜像/残留），桌面独有节点随后由统一增量追加逻辑补齐。
  // Validate before deduplication and before any remote write.
  airaSnapshotToList(prev);
  let { folders, items, orders } = dedupeAiraSnapshot(
    snap.bookmarkFolders || [], snap.bookmarkItems || [], snap.bookmarkOrders || []);
  const phoneList = airaSnapshotToList({ snapshot: { bookmarkFolders: folders, bookmarkItems: items } });
  const phoneKeys = computePathKeys(phoneList);
  const mergedPKs = computePathKeys(mergedList);
  const deskKeys = new Set(mergedPKs.values());
  const state = await MiniSync.utils.readLocalKeys(['sync_tombstones']);
  const deletionKeys = new Set((state.sync_tombstones || []).map(t => typeof t === 'string' ? t : t && t.key));
  const rootNames = new Set(['browser_root_toolbar', 'browser_root_other', 'browser_root_mobile']);
  const rawById = new Map([...folders, ...items].map(n => [n.id, n]));
  const removed = new Set();
  for (const node of rawById.values()) {
    if (rootNames.has(node.id) || rootNames.has(node.title)) continue;
    const pk = phoneKeys.get(node.id);
    if (pk && !deskKeys.has(pk) && (rebuild || deletionKeys.has(pk))) removed.add(node.id);
  }
  // An unobserved phone child is not covered by an old parent deletion.
  for (const node of rawById.values()) {
    if (removed.has(node.id)) continue;
    let parent = rawById.get(node.parentId);
    while (parent) { removed.delete(parent.id); parent = rawById.get(parent.parentId); }
  }
  folders = folders.filter(n => !removed.has(n.id));
  items = items.filter(n => !removed.has(n.id));
  orders = orders.filter(o => !removed.has(o.parentId))
    .map(o => ({ ...o, ids: (o.ids || []).filter(id => !removed.has(id)) }));
  const prevList = airaSnapshotToList({ snapshot: { bookmarkFolders: folders, bookmarkItems: items } });
  const prevByPK = buildPathKeyMap(prevList);

  // 系统根容器（书签栏/其他书签/移动收藏夹）在桌面端树里也是节点，
  // 需映射到 Aira 根容器 id，作为新建节点的父。
  const ROOT_AIRA = {
    bar: 'browser_root_toolbar',
    other: 'browser_root_other',
    mobile: 'browser_root_mobile'
  };
  for (const [source, canonicalId] of Object.entries(ROOT_AIRA)) {
    const native = folders.find(n => n.id === canonicalId || n.title === canonicalId);
    if (native) ROOT_AIRA[source] = native.id;
  }
  const rootContainerMap = new Map();
  for (const n of mergedList) {
    if (n.isFolder && !mergedPKs.has(n.id) && n.id !== HOME_FOLDER_ID) {
      rootContainerMap.set(n.id, ROOT_AIRA[n.source] || ROOT_AIRA.bar);
    }
  }

  const mergedIdToAiraId = new Map();
  const now = new Date().toISOString();
  const allocatedIds = new Set([...folders, ...items].map(n => n.id));
  const additions = [];
  const idByPath = new Map([...prevByPK].map(([pk, n]) => [pk, n.id]));
  for (const n of mergedList) {
    if (n.source === 'home' || n.id === HOME_FOLDER_ID) continue;
    const pk = mergedPKs.get(n.id);
    if (!pk) continue;
    let id = idByPath.get(pk);
    if (!id) {
      let salt = 0;
      do {
        id = (n.isFolder ? 'bkf_bookmark_' : 'bkm_bookmark_') +
          stableSuffix(n.id + now + (++salt) + Math.random());
      } while (allocatedIds.has(id));
      allocatedIds.add(id);
      idByPath.set(pk, id);
      additions.push(n);
    }
    mergedIdToAiraId.set(n.id, id);
  }
  function mapParent(pid) {
    return mergedIdToAiraId.get(pid) || rootContainerMap.get(pid) || null;
  }
  function rootFor(n) {
    const source = (mergedPKs.get(n.id) || 'ROOT:bar').split('/')[0].slice(5);
    const id = ROOT_AIRA[source] || ROOT_AIRA.bar;
    if (!folders.some(f => f.id === id)) {
      folders.push({ id, type: 'bookmark-folder', parentId: null,
        title: { bar: '书签栏', other: '其他书签', mobile: '移动收藏夹' }[source] || '书签栏',
        createdAt: now, updatedAt: now, updatedBy: 'aira-bookmark-manager', revision: 1 });
    }
    return id;
  }
  // Allocate every ID before wiring parents; input order need not be parent-first.
  for (const n of additions) {
    const base = {
      id: mergedIdToAiraId.get(n.id),
      type: n.isFolder ? 'bookmark-folder' : 'bookmark-item',
      parentId: mapParent(n.parentId) || rootFor(n),
      title: n.title || '', createdAt: n.createdAt || now, updatedAt: now,
      updatedBy: 'aira-bookmark-manager', revision: 1
    };
    if (n.isFolder) folders.push(base);
    else items.push({ ...base, url: n.url || '' });
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
  const writtenById = new Map([...folders, ...items].map(n => [n.id, n]));
  for (const n of additions) {
    const written = writtenById.get(mergedIdToAiraId.get(n.id));
    ensureOrder(written.parentId, written.id);
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
    const airaPid = writtenById.get(aid).parentId;
    if (!deskOrderGroups.has(airaPid)) deskOrderGroups.set(airaPid, []);
    if (!deskOrderGroups.get(airaPid).includes(aid)) deskOrderGroups.get(airaPid).push(aid);
  }
  for (const ord of orders) {
    const deskIds = deskOrderGroups.get(ord.parentId);
    if (!deskIds || !deskIds.length) continue; // 桌面该组无节点（如根顺序组）→ 保持端上原序
    const deskSet = new Set(deskIds);
    const rest = (ord.ids || []).filter(id => !deskSet.has(id)); // 端上独有，排末尾
    ord.ids = [...deskIds, ...rest];
  }

  // 4) 写回：version/history/deviceId/createdAt 原样沿用，仅重算 commitId、parentCommitId 固定 null
  const devSuffix = stableSuffix(prev.deviceId || '').slice(0, 6);
  const prevSnap = snap;
  const keptIds = new Set(writtenById.keys());
  const out = {
    ...prev,
    version: prev.version,
    history: prev.history,
    commitId: Date.now().toString(36) + '--' + Date.now().toString(36) + '-' + devSuffix + '-' + rand36(),
    parentCommitId: null,
    deviceId: prev.deviceId,
    createdAt: prev.createdAt || new Date().toISOString(),
    snapshot: {
      ...prevSnap,
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

  const writtenFlatList = airaSnapshotToList(out);
  for (const order of orders) {
    if (order.parentId != null && !folders.some(n => n.id === order.parentId)) throw new Error('Aira 顺序表父节点不存在');
    if (new Set(order.ids).size !== order.ids.length || order.ids.some(id =>
      !writtenById.has(id) || writtenById.get(id).parentId !== order.parentId)) {
      throw new Error('Aira 顺序表包含无效子节点引用');
    }
  }
  await uploadAiraBookmarks(out);
  const snapshotUpdates = await MiniSync.berry.bridgeIdentity.snapshotUpdates('aira_pathkey_snapshot',
    (await MiniSync.utils.airaResourceUrls()).g3, writtenFlatList);
  console.log(`[sync] 🤖 Aira 回写完成: ${zoneSummary(writtenFlatList, { includeHome: false })}`);
  return { status: 'success', snapshotUpdates };
}

// ====== 从 Aira 文件读取变更并合并 ======
async function mergeAiraData(currentList, preferLocalOrder = false, tombstoneKeys = null) {
  const result = await mergeAiraDataWithChanges(currentList, preferLocalOrder, tombstoneKeys);
  if (result.complete && result.snapshotUpdates) await chrome.storage.local.set(result.snapshotUpdates);
  return result.list;
}

async function mergeAiraDataWithChanges(currentList, preferLocalOrder = false, tombstoneKeys = null, bridgeContext = null) {
  try {
    const airaData = await downloadAiraBookmarks();
    if (!airaData) throw new Error('Aira 文件不存在');
    const snap = airaGetSnapshotContainer(airaData);
    if (!snap || !Array.isArray(snap.bookmarkFolders)) throw new Error('Aira 快照格式无效');
    const phoneList = airaSnapshotToList(airaData);
    if (!phoneList.length) throw new Error('Aira 根容器缺失');
    const owner = await MiniSync.utils.airaResourceUrls();
    // Validate both resources before exposing ANY deletion/identity plan.
    const pers = await downloadAiraPersonalization();
    let homeNodes = null;
    if (pers !== null) {
      const shortcuts = pers && pers.sections && pers.sections.home_shortcuts && pers.sections.home_shortcuts.payload && pers.sections.home_shortcuts.payload.shortcuts;
      if (!Array.isArray(shortcuts)) throw new Error('Aira 主页快照格式无效');
      homeNodes = shortcuts.map(sc => {
        if (!sc || typeof sc.url !== 'string' || !sc.url) throw new Error('Aira 主页书签格式无效');
        return { id: sc.id || ('shortcut-' + stableSuffix(sc.url)), title: sc.title || '', url: sc.url,
          isFolder: false, parentId: HOME_FOLDER_ID, source: 'home', createdAt: sc.createdAt, updatedAt: sc.updatedAt };
      });
    }
    const identity = MiniSync.berry.bridgeIdentity;
    const changes = await identity.merge({ kind: 'aira', storageKey: 'aira_pathkey_snapshot', owner: owner.g3,
      currentList, phoneList, tombstoneKeys, context: bridgeContext });
    if (homeNodes !== null) {
      let input = changes.list;
      if (homeNodes.length && !input.some(n => n.id === HOME_FOLDER_ID)) {
        input = [...input, { id: HOME_FOLDER_ID, title: 'Berry主页', isFolder: true, parentId: ROOT_ID, source: 'other' }];
      }
      const data = bridgeContext || await MiniSync.utils.readLocalKeys(['sync_tombstones', 'sync_tombstone_acked']);
      const revoked = new Set(changes.revokedTombstones.map(identity.versionKey));
      const remaining = (data.tombstones || data.sync_tombstones || []).filter(t => !revoked.has(identity.versionKey(t)));
      const homeKeys = tombstoneKeys ? new Set([...tombstoneKeys].filter(key => !changes.revokedPathKeys.includes(key))) : null;
      const home = await identity.merge({ kind: 'aira_home', storageKey: 'aira_home_pathkey_snapshot', owner: owner.g2,
        currentList: input, phoneList: homeNodes, tombstoneKeys: homeKeys,
        context: { tombstones: remaining, ackedPathKeys: data.ackedPathKeys || data.sync_tombstone_acked || [] } });
      for (const key of ['deletedIds', 'deletedPathKeys', 'revokedPathKeys', 'revokedTombstones', 'pathRemaps']) changes[key].push(...home[key]);
      changes.changed = changes.changed || home.changed;
      changes.list = home.list;
      Object.assign(changes.snapshotUpdates, home.snapshotUpdates);
    }
    console.log(`[sync] Aira 处理完成: ${zoneSummary(changes.list)}`);
    return changes;
  } catch (e) {
    return { list: currentList, deletedIds: [], deletedPathKeys: [], complete: false, errors: [e.message] };
  }
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
  mergeAiraDataWithChanges,
  patchAiraFile,
  patchAiraPersonalization,
  downloadAiraBookmarks,
  uploadAiraBookmarks,
  downloadAiraPersonalization,
  uploadAiraPersonalization
};
