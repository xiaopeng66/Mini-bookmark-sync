// core/sync-input.js — 同步输入/IO 辅助层
// 从 sync-orchestrator.js 抽离：树获取、浏览器检测、备份/恢复、快照、状态记录。
// 这些辅助函数被上传/下载/合并三条路径共用，依赖 lib/constants.js 的全局常量。

MiniSync.syncInput = (function() {

// 从 Chrome 书签树读取完整书签数据
async function getChromeTree() {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.getTree((tree) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(tree);
      }
    });
  });
}

// 检测当前浏览器类型（chrome/firefox/edge）
// 返回 'firefox' | 'edge' | 'chrome'
function _getBrowserType() {
  try {
    const ua = (navigator.userAgent || '').toLowerCase();
    if (ua.indexOf('firefox') !== -1) return 'firefox';
    if (ua.indexOf('edg/') !== -1 || ua.indexOf('edge') !== -1) return 'edge';
    return 'chrome';
  } catch (e) {
    return 'chrome';
  }
}

// 从 chrome 树构建 XBEL 用的本地树快照（归一化 parentId 为真实嵌套，避免 Berry 主页拍平导致 pathKey 塌缩）
async function getLocalTreeForXbel() {
  const tree = await getChromeTree();
  // 直接返回 chrome 原始树，由 model/xbel.js 的 chromeToXbel 处理 pathKey 归一化。
  return tree;
}

// 清空所有书签（用于「完全从云端恢复」模式：removeTree 所有顶层节点）。
// 同时清理本地墓碑，避免旧删除墓碑在下次合并时污染新导入数据。
async function clearAllBookmarks() {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.getTree(async (tree) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      try {
        const root = tree[0];
        const ids = (root.children || []).map(c => c.id);
        for (const id of ids) {
          await new Promise((res, rej) => {
            chrome.bookmarks.removeTree(id, () => {
              if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
              else res();
            });
          });
        }
        // 清空本地墓碑，避免「完全恢复」后旧删除墓碑重新删掉刚导入的内容
        try { await new Promise(res => chrome.storage.local.set({ sync_tombstones: [] }, res)); } catch (e) {}
        resolve({ cleared: ids.length });
      } catch (e) {
        reject(e);
      }
    });
  });
}

// 备份本地树到 chrome.storage.local（key: 'local_bookmark_backup'）
// ★ 参数可缺省：orchestrator/sync-merge 的调用点均未传参，此前把 undefined
//   存进备份键，导致 restoreLocalBackup 永远返回 no_backup——回滚从未生效过。
async function backupLocalTree(tree) {
  try {
    if (!tree) tree = await getChromeTree();
    await MiniSync.storage.setLocal({ local_bookmark_backup: tree });
    const saved = await getLocalBackup();
    if (!Array.isArray(saved) || JSON.stringify(saved) !== JSON.stringify(tree)) throw new Error('备份校验失败');
    return true;
  } catch (e) {
    console.warn('[orchestrator] 备份本地书签失败:', e.message);
    return false;
  }
}

// 读取本地备份（chrome.storage.local: 'local_bookmark_backup'）
async function getLocalBackup() {
  const data = await MiniSync.storage.getLocal(['local_bookmark_backup']);
  return Array.isArray(data.local_bookmark_backup) ? data.local_bookmark_backup : null;
}

// 回滚：在同步桶内先重建备份，成功后才删除原内容；创建失败时保留原内容。
// 缺省为叠加导入（现有书签保留），供用户主动恢复按钮使用。
// 同步失败回滚用替换式，避免在半成品状态上叠加大量重复书签。
async function restoreLocalBackup(options) {
  options = options || {};
  const backup = await getLocalBackup();
  if (!backup) return { ok: false, restored: 0, conflicts: [], reason: 'no_backup' };
  const root = backup[0];
  const current = (await getChromeTree())[0];
  const bucketId = String(options.targetParentId || (MiniSync.utils.getSyncBucketId && MiniSync.utils.getSyncBucketId()) || '');
  function find(node, id) {
    if (String(node.id) === id) return node;
    for (const child of node.children || []) { const match = find(child, id); if (match) return match; }
    return null;
  }
  const savedBucket = root && find(root, bucketId);
  const currentBucket = current && find(current, bucketId);
  if (!savedBucket || !currentBucket || currentBucket.url) {
    return { ok: false, restored: 0, conflicts: [], reason: 'bucket_not_found' };
  }
  const targets = [{ saved: savedBucket, current: currentBucket }];
  if (options.includeHome) {
    const homeTitles = FOLDER_TITLES.berryHome.map(title => String(title).toLowerCase());
    function findHome(node) {
      if (!node || node.url) return null;
      if (homeTitles.includes(String(node.title || '').toLowerCase())) return node;
      for (const child of node.children || []) { const home = findHome(child); if (home) return home; }
      return null;
    }
    const savedHome = findHome(root);
    const currentHome = savedHome && find(current, String(savedHome.id));
    function contains(node, id) { return !!find(node, String(id)); }
    if (savedHome && currentHome && !contains(savedBucket, savedHome.id) && !contains(currentBucket, currentHome.id)) {
      targets.push({ saved: savedHome, current: currentHome });
    }
  }
  let restored = 0;
  const conflicts = [];
  const call = (method, ...args) => new Promise((resolve, reject) => {
    chrome.bookmarks[method](...args, value => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(value);
    });
  });
  async function recreate(node, parentId, index) {
    const info = { parentId, index, title: node.title || '' };
    if (node.url) info.url = node.url;
    const created = await call('create', info);
    restored++;
    for (const [i, child] of (node.children || []).entries()) await recreate(child, String(created.id), i);
  }
  if (options.replaceCurrent) {
    // Reuse surviving backup IDs. Staging a second copy then removing the original
    // duplicates nodes whenever the original is subject to a persistent remove failure.
    const surviving = new Map();
    function indexNodes(node, map) {
      map.set(String(node.id), node);
      for (const child of node.children || []) indexNodes(child, map);
    }
    for (const target of targets) indexNodes(target.current, surviving);
    const planned = [];
    const stagedRoots = [];
    const stagedIds = new Set();
    const desiredIds = new Set(targets.map(target => String(target.current.id)));
    async function stage(node, parentId, index) {
      let live = surviving.get(String(node.id));
      if (!live || !!live.url !== !!node.url) {
        const info = { parentId, title: node.title || '' };
        if (node.url) info.url = node.url;
        live = await call('create', info);
        if (!stagedIds.has(parentId)) stagedRoots.push({ id: String(live.id), url: !!node.url });
        stagedIds.add(String(live.id));
      }
      const id = String(live.id);
      desiredIds.add(id);
      planned.push({ node, id, parentId, index });
      restored++;
      for (const [i, child] of (node.children || []).entries()) await stage(child, id, i);
    }
    try {
      // No original is changed or removed until every required create succeeds.
      for (const target of targets) {
        for (const [i, child] of (target.saved.children || []).entries()) {
          await stage(child, String(target.current.id), i);
        }
      }
    } catch (e) {
      conflicts.push({ error: e.message });
      for (const staged of stagedRoots.reverse()) {
        try { await call(staged.url ? 'remove' : 'removeTree', staged.id); }
        catch (cleanupError) { conflicts.push({ id: staged.id, error: cleanupError.message }); }
      }
      return { ok: false, restored, conflicts, reason: e.message };
    }
    try {
      const liveNodes = new Map();
      indexNodes((await getChromeTree())[0], liveNodes);
      for (const entry of planned) {
        const live = liveNodes.get(entry.id);
        const changes = {};
        if ((live.title || '') !== (entry.node.title || '')) changes.title = entry.node.title || '';
        if (entry.node.url && live.url !== entry.node.url) changes.url = entry.node.url;
        if (Object.keys(changes).length) {
          await call('update', entry.id, changes);
          Object.assign(live, changes);
        }
        const parent = liveNodes.get(entry.parentId);
        if (String(live.parentId) !== entry.parentId || String((parent.children || [])[entry.index]?.id) !== entry.id) {
          await call('move', entry.id, { parentId: entry.parentId, index: entry.index });
          const oldParent = liveNodes.get(String(live.parentId));
          if (oldParent) oldParent.children = (oldParent.children || []).filter(child => String(child.id) !== entry.id);
          parent.children = parent.children || [];
          parent.children.splice(entry.index, 0, live);
          live.parentId = entry.parentId;
        }
      }
      async function removeExtras(parent) {
        for (const child of parent.children || []) {
          if (desiredIds.has(String(child.id))) await removeExtras(child);
          else await call(child.url ? 'remove' : 'removeTree', String(child.id));
        }
      }
      for (const target of targets) await removeExtras(liveNodes.get(String(target.current.id)));
      return { ok: true, restored, conflicts, result: { importedCount: restored, conflicts } };
    } catch (e) {
      conflicts.push({ error: e.message });
      return { ok: false, restored, conflicts, reason: e.message };
    }
  }
  for (const [i, child] of (savedBucket.children || []).entries()) {
    const existing = (currentBucket.children || []).find(n => n.title === child.title && n.url === child.url);
    if (existing) continue;
    try { await recreate(child, bucketId, i); }
    catch (e) { conflicts.push({ title: child.title, error: e.message }); }
  }
  return { ok: conflicts.length === 0, restored, conflicts, result: { importedCount: restored, conflicts } };
}

// 清空三个系统根容器的内容。
// ⚠️ 不能 removeTree 根容器本身（'书签栏'/'其他书签'/'移动设备书签' 是浏览器
// 永久节点，Chrome/Edge 会拒绝删除）；只能清空它们的 children。
// 遍历用通用 id，不依赖 '1'/'2'/'3' 硬编码（兼容 Edge 等非标准根 id）。
async function _clearAllBookmarkContents() {
  const tree = await getChromeTree();
  const root = tree && tree[0];
  if (!root || !root.children) return { cleared: 0 };
  let cleared = 0;
  for (const top of root.children) {
    for (const child of (top.children || [])) {
      try {
        await new Promise((res, rej) => {
          chrome.bookmarks.removeTree(String(child.id), () => {
            if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
            else res();
          });
        });
        cleared++;
      } catch (e) {
        // 单个节点删除失败（如已被移除）继续清其余节点
        console.warn(`[sync] 清空书签失败 "${child.title || child.id}": ${e.message}`);
      }
    }
  }
  return { cleared };
}

// 把 chrome 树拍平成 import 引擎需要的扁平列表（仅本地备份回滚用）
function _treeToFlatList(tree) {
  const list = [];
  function walk(node, parentId) {
    if (!node) return;
    const isFolder = !node.url;
    list.push({
      id: String(node.id),
      title: node.title || '',
      url: node.url || '',
      isFolder: isFolder,
      parentId: String(parentId),
      source: 'other',
      addedAt: node.dateAdded || Date.now(),
      color: null, favicon: null, customIcon: null,
      _index: 0
    });
    if (isFolder && node.children) {
      for (const child of node.children) walk(child, node.id);
    }
  }
  const root = tree && tree[0];
  if (root && root.children) {
    for (const top of root.children) walk(top, ROOT_ID);
  }
  return list;
}

// Identity is origin/account/file/local bucket; legacy unbound state is never inherited.
async function ensureSyncRelationship(config, bucketId) {
  const url = new URL(config.url);
  const file = MiniSync.utils.joinWebDAVUrl(config.url, config.filename || DEFAULT_FILENAME);
  const key = JSON.stringify([url.origin.toLowerCase(), String(config.username || ''), file, String(bucketId || '')]);
  const data = await MiniSync.storage.getLocal(['sync_relationship_key', 'sync_relationship_states', STORAGE_KEYS.TOMBSTONES, STORAGE_KEYS.SNAPSHOTS, STORAGE_KEYS.CLOUD_LAST_MODIFIED]);
  if (data.sync_relationship_key === key) return { changed: false, key };
  const states = data.sync_relationship_states || {};
  if (data.sync_relationship_key) {
    states[data.sync_relationship_key] = {
      tombstones: data[STORAGE_KEYS.TOMBSTONES] || [],
      snapshots: data[STORAGE_KEYS.SNAPSHOTS] || {},
      cloudLastModified: data[STORAGE_KEYS.CLOUD_LAST_MODIFIED] || 0
    };
  }
  const next = states[key] || { tombstones: [], snapshots: {}, cloudLastModified: 0 };
  await MiniSync.storage.setLocal({
    sync_relationship_key: key, sync_relationship_states: states,
    [STORAGE_KEYS.TOMBSTONES]: next.tombstones,
    [STORAGE_KEYS.SNAPSHOTS]: next.snapshots,
    [STORAGE_KEYS.CLOUD_LAST_MODIFIED]: next.cloudLastModified,
    berry_pathkey_snapshot: [], via_pathkey_snapshot: [],
    aira_pathkey_snapshot: [], aira_home_pathkey_snapshot: []
  });
  return { changed: true, key };
}

// 记录最近一次成功同步的时间戳 + 数量
// mode=含文件夹的总数（历史字段 last_sync_mode），count=纯书签数（last_sync_count，
// popup 轮询/在场两条路径统一用它展示，保证「挪走 popup 再开」与在场显示数量一致）
async function recordLastSync(mode, count) {
  try {
    const update = { last_sync_at: Date.now(), last_sync_mode: mode };
    if (count !== undefined) update.last_sync_count = count;
    await new Promise((resolve) => {
      chrome.storage.local.set(update, resolve);
    });
  } catch (e) {}
}

// ================================================================
//  「同步文件夹」设置解析（单同步桶）
// ================================================================
/**
 * 解析「同步文件夹」（设置项 bookmark_target_id，空＝自动），并把结果固化到模块级，
 * 使一次同步流程里 chromeTreeToList / chromeToXbel / import 读到同一个身份。
 *
 * 自动探测第一次跑出结果就**写回设置**：这样后续同步的行为稳定可预期（否则「书签栏
 * 空了/多了」会让自动探测换一个文件夹，用户的书签看着就像自己搬家）。用户在设置页
 * 随时可以改；改动立即生效（下一次同步读新值）。
 *
 * @returns {Promise<{saved:string, bucket:Object|null, kind:string|null, title:string, id:string|null}>}
 */
async function resolveSyncBucketSetting() {
  let saved = '';
  try {
    const t = await MiniSync.storage.getLocal(['bookmark_target_id']);
    saved = (t && t.bookmark_target_id) ? String(t.bookmark_target_id) : '';
  } catch (e) {
    console.warn('[sync] 读取同步文件夹设置失败（按自动探测处理）:', e.message);
  }
  if (MiniSync.utils && MiniSync.utils.setSyncBucketId) MiniSync.utils.setSyncBucketId(saved);
  let bucket = null;
  try {
    const tree = await getChromeTree();
    const kids = (tree && tree[0] && tree[0].children) || [];
    bucket = MiniSync.utils.resolveSyncBucket(kids, {
      bucketId: saved,
      declaredWrapper: MiniSync.utils.getDeclaredFlatRootContainer
        ? MiniSync.utils.getDeclaredFlatRootContainer() : ''
    });
  } catch (e) {
    console.warn('[sync] 解析同步文件夹失败:', e.message);
  }
  if (bucket && String(bucket.id) !== saved) {
    try {
      await MiniSync.storage.setLocal({ bookmark_target_id: String(bucket.id) });
      if (MiniSync.utils.setSyncBucketId) MiniSync.utils.setSyncBucketId(bucket.id);
    } catch (e) {
      console.warn('[sync] 固化同步文件夹设置失败（本次仍按探测结果处理）:', e.message);
    }
  }
  if (bucket) await MiniSync.storage.bindSyncStatusBucket(bucket.id);
  return {
    saved,
    bucket,
    kind: bucket ? bucket.kind : null,
    title: bucket ? String(bucket.title || '') : '',
    id: bucket ? String(bucket.id) : null
  };
}

// 保存本地快照（用于「恢复」功能）：把当前 chrome 树存为快照。
// ⚠️ 配额约束：manifest 未申请 unlimitedStorage，storage.local 默认 10MB。
// 一份完整树可能达数 MB，此前保留 20 份在大书签库下必触发 QuotaBytesExceeded，
// 整条快照链路静默失效。现保留 3 份，写入失败时逐份丢弃最旧重试。
const LOCAL_SNAPSHOT_KEEP = 3;

async function trySetSnapshots(snaps) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ local_snapshots: snaps }, () => {
        resolve(!chrome.runtime.lastError);
      });
    } catch (_) { resolve(false); }
  });
}

async function saveLocalSnapshot(label) {
  try {
    const tree = await getChromeTree();
    const snapId = 'snap_' + Date.now();
    const snap = {
      id: snapId,
      label: label || ('快照 ' + new Date().toLocaleString()),
      createdAt: Date.now(),
      tree: tree
    };
    const existing = await new Promise((resolve) => {
      chrome.storage.local.get(['local_snapshots'], (res) => resolve(res.local_snapshots || []));
    });
    existing.unshift(snap);
    // 写入失败（典型为配额不足）时丢弃最旧快照重试，保证最新快照一定写得进去
    for (let keep = Math.min(LOCAL_SNAPSHOT_KEEP, existing.length); keep >= 1; keep--) {
      const ok = await trySetSnapshots(existing.slice(0, keep));
      if (ok) return { ok: true, id: snapId };
      console.warn(`[sync] 人工快照写入失败（疑似配额不足），丢弃最旧重试 keep=${keep - 1}`);
    }
    console.warn('[orchestrator] 人工快照写入失败：全部降级尝试仍失败');
    return { ok: false, error: 'quota_exceeded' };
  } catch (e) {
    console.warn('[orchestrator] 保存本地快照失败:', e.message);
    return { ok: false, error: e.message };
  }
}

// 保存「上次同步时的本地扁平树」到 sync_snapshots.localTree。
// background.js 的 onRemoved 监听依赖它回溯被删节点的 pathKey 并写墓碑；
// 若缺失，删除时拿不到 pathKey → 写不了墓碑 → 合并时被判为「云端新增」而复活。
async function saveLocalTreeSnapshot() {
  try {
    const tree = await getChromeTree();
    // 必须用 merger.chromeTreeToList（与 C2 快照差异检测读取端一致）。
    // 不能用 _treeToFlatList：它把所有节点 source 硬编码为 'other'，
    // 会导致 pathKey 全变成 ROOT:other/... 而实际是 ROOT:bar/...，
    // 墓碑 key 与云端 pathKey 对不上，删除无法传播（节点被判为云端新增而复活）。
    const flat = MiniSync.merger.chromeTreeToList(tree);
    const write = () => new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set({ sync_snapshots: { localTree: flat } }, () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve();
        });
      } catch (e) { reject(e); }
    });
    try {
      await write();
    } catch (e1) {
      // ★ 配额不足兜底：墓碑回溯快照的优先级高于人工快照——
      //   把人工快照清到 1 份再重试一次，确保删除传播链路不断
      console.warn('[sync] localTree 快照写入失败，清减人工快照后重试:', e1.message);
      await new Promise((resolve) => {
        chrome.storage.local.get(['local_snapshots'], (res) => {
          const snaps = res.local_snapshots || [];
          chrome.storage.local.set({ local_snapshots: snaps.slice(0, 1) }, resolve);
        });
      });
      await write();
    }
    return { ok: true, count: flat.length };
  } catch (e) {
    console.warn('[orchestrator] 保存 localTree 快照失败:', e.message);
    return { ok: false, error: e.message };
  }
}

// ================================================================
//  删除传播（三条路径共用）
// ================================================================
/**
 * C2 前置：快照差异检测（V1.0.3 的 locallyDeletedKeys 兜底机制）。
 *
 * 即使 onRemoved 监听因扩展重载 / Service Worker 被回收 / 批量删除未触发，也能通过
 * 「上次快照 vs 当前本地树」捕捉到删除，把差异 pathKey 追加进 sync_tombstones。
 *
 * ★ 上传与合并两条「会把本机状态写给云端」的路径都必须跑一次。漏跑的那条一旦写回云端，
 *   对端拿不到墓碑，就会把本端已删的节点判成「云端独有」重新建出来 —— 这正是「只加不删」
 *   的另一半（用户实测：删除已经发生，但别的端照样把它带回来）。
 *
 * @param {Array} localList 当前本地扁平树（MiniSync.merger.chromeTreeToList）
 * @returns {Promise<number>} 本次新捕捉到的删除数
 */
async function backfillDeletedTombstones(localList) {
  try {
    const snapData = await MiniSync.storage.getLocal([STORAGE_KEYS.SNAPSHOTS]);
    const prev = (snapData[STORAGE_KEYS.SNAPSHOTS] && snapData[STORAGE_KEYS.SNAPSHOTS].localTree) || [];
    if (prev.length === 0) return 0;
    const prevSet = new Set(MiniSync.xbelPath.computeJsonPathKeys(prev).values());
    const curSet = new Set(MiniSync.xbelPath.computeJsonPathKeys(Array.isArray(localList) ? localList : []).values());
    const deletedPKs = new Set();
    for (const pk of prevSet) {
      if (!curSet.has(pk)) deletedPKs.add(pk);
    }
    if (deletedPKs.size === 0) return 0;
    const existing = (await MiniSync.storage.getLocal([STORAGE_KEYS.TOMBSTONES]))[STORAGE_KEYS.TOMBSTONES] || [];
    const devId = await MiniSync.storage.getDeviceId();
    const merged = MiniSync.tombstone.mergeTombstones(existing, deletedPKs, null, devId);
    await MiniSync.storage.setLocal({ [STORAGE_KEYS.TOMBSTONES]: merged });
    return deletedPKs.size;
  } catch (e) {
    console.warn('[sync] 快照差异墓碑回溯失败（继续）:', e.message);
    return 0;
  }
}

/**
 * 把「本地 ∪ 云端」墓碑视图里、本机仍然存在的节点真正删掉，并把并集写回本地存储。
 *
 * ★ 上传 / 下载 / 合并三条路径共用。三个按钮都必须传播删除：
 *   · 合并：本来就按墓碑删（floccus 的双向语义）
 *   · 下载：云端已删的，本机也要删（旧实现纯增量、只加不删 —— 用户报障）
 *   · 上传：云端已删的，本机也要删（旧实现把本机整棵树覆盖上云 ⇒ 删除被反推回去
 *     变成「复活」，实测：手机删的书签被桌面点「上传」加回云端）
 *   只按墓碑删：云端没有、也没有墓碑的节点是「本端新增」，一条都不动（不扫荡）。
 *
 * 安全性来自同步范围本身：MiniSync.merger.chromeTreeToList 只产出【同步桶子树 +
 * Berry 主页子树】的节点，桶自身标 zoneRoot 没有 pathKey ⇒ 桶本身（以及桶外的
 * 用户文件夹）永远不会命中墓碑、永远不会被这里删掉。
 *
 * @param {Object|null} remoteData 云端解析结果（可含 bookmarks / tombstones）
 * @returns {Promise<{deletedCount:number, deletedIds:Array<string>, tombstones:Array, tombstoneKeys:Set<string>}>}
 *   tombstones 是本次写回的并集，调用方写云端 metadata 时必须用它（只写本机墓碑会把
 *   云端墓碑整份冲掉，其他端从此再也学不到这次删除）。
 */
async function applyTombstoneDeletions(remoteData) {
  const tree = await getChromeTree();
  const localList = MiniSync.merger.chromeTreeToList(tree);
  const tsData = await MiniSync.storage.getLocal([STORAGE_KEYS.TOMBSTONES, STORAGE_KEYS.SNAPSHOTS]);
  const myDeviceId = await MiniSync.storage.getDeviceId();

  const view = MiniSync.tombstone.buildTombstoneView({
    localTombstones: tsData[STORAGE_KEYS.TOMBSTONES] || [],
    remoteTombstones: (remoteData && Array.isArray(remoteData.tombstones)) ? remoteData.tombstones : [],
    localList,
    remoteList: (remoteData && Array.isArray(remoteData.bookmarks)) ? remoteData.bookmarks : [],
    myDeviceId,
    // 上次同步快照：本端在上一轮之后新建/挪回来的节点不受墓碑牵连（删过又加回来要能留下）
    prevSnapshotList: (tsData[STORAGE_KEYS.SNAPSHOTS] && tsData[STORAGE_KEYS.SNAPSHOTS].localTree) || []
  });

  const byId = new Map(localList.map(n => [String(n.id), n]));
  const hitIds = [];
  for (const [id, pk] of view.localPKs) {
    if (view.tombstoneKeys.has(pk)) hitIds.push(String(id));
  }
  // 命中墓碑的节点通常整棵子树都在墓碑里 ⇒ 只对「最外层」的那些下手，
  // 避免先删父再删子带来的大量「节点已不存在」噪音（结果等价，子树随父一起走）。
  const hitSet = new Set(hitIds);
  const topIds = hitIds.filter((id) => {
    let cur = byId.get(id);
    const seen = new Set([id]);
    while (cur && cur.parentId && !seen.has(String(cur.parentId))) {
      seen.add(String(cur.parentId));
      if (hitSet.has(String(cur.parentId))) return false;
      cur = byId.get(String(cur.parentId));
    }
    return true;
  });

  const deletedIds = [];
  const failedIds = [];
  for (const id of topIds) {
    const node = byId.get(String(id));
    try {
      await new Promise((resolve, reject) => {
        chrome.bookmarks[node && node.url ? 'remove' : 'removeTree'](String(id), () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve();
        });
      });
      deletedIds.push(id);
    } catch (e) {
      failedIds.push(id);
      console.warn(`[sync] 删除本地已删节点失败 "${(node && node.title) || id}": ${e.message}`);
    }
  }
  if (failedIds.length) {
    const error = new Error(`${failedIds.length} 条本地书签删除失败`);
    error.failedIds = failedIds;
    throw error;
  }

  await MiniSync.storage.setLocal({ [STORAGE_KEYS.TOMBSTONES]: view.tombstones });
  return {
    deletedCount: deletedIds.length,
    deletedIds,
    tombstones: view.tombstones,
    tombstoneKeys: view.tombstoneKeys
  };
}

return {
  getChromeTree,
  _getBrowserType,
  getLocalTreeForXbel,
  clearAllBookmarks,
  backupLocalTree,
  getLocalBackup,
  restoreLocalBackup,
  ensureSyncRelationship,
  recordLastSync,
  resolveSyncBucketSetting,
  saveLocalSnapshot,
  saveLocalTreeSnapshot,
  backfillDeletedTombstones,
  applyTombstoneDeletions,
  _treeToFlatList
};

})();
