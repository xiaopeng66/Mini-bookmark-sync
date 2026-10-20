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

const LOCAL_BACKUP_META = 'local_bookmark_backup_meta';
const LOCAL_BACKUP_COMMIT = 'local_bookmark_backup_commit';
const LOCAL_RECOVERY_CHECKPOINT = 'local_bookmark_recovery_checkpoint';
const RECOVERY_REQUIRED_MESSAGE = '上次本地事务尚未完成，请打开「本地书签恢复」检查备份后再同步';
let activeLocalBackupId = null;
let acceptedLocalBackup = null;
let localBackupFailure = null;
const backupNeedsRecovery = meta => MiniSync.utils.localBackupNeedsRecovery(meta);
const newBackupId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);

function matchingCommit(meta, receipt) {
  return !!meta && meta.status === 'pending' && !!meta.id && !!receipt && receipt.version === 1
    && receipt.backupId === meta.id && receipt.backupCreatedAt === meta.createdAt
    && receipt.sourceBucketId === meta.sourceBucketId
    && receipt.relationshipKey === (meta.relationshipKey || null)
    && Number.isFinite(receipt.completedAt) && receipt.completedAt >= meta.createdAt;
}

async function repairLocalBackupCompletion() {
  try {
    const data = await MiniSync.storage.getLocal([LOCAL_BACKUP_META, LOCAL_BACKUP_COMMIT]);
    const meta = data[LOCAL_BACKUP_META];
    if (!backupNeedsRecovery(meta)) return { ok: true, skipped: true };
    const receipt = matchingCommit(meta, acceptedLocalBackup) ? acceptedLocalBackup : data[LOCAL_BACKUP_COMMIT];
    if (!matchingCommit(meta, receipt)) return { ok: false, code: 'RECOVERY_REQUIRED', error: RECOVERY_REQUIRED_MESSAGE };
    await MiniSync.storage.setLocal({ [LOCAL_BACKUP_META]: { ...meta, status: 'committed', completedAt: receipt.completedAt } });
    const saved = (await MiniSync.storage.getLocal([LOCAL_BACKUP_META]))[LOCAL_BACKUP_META];
    if (saved?.id !== meta.id || saved.status !== 'committed') throw new Error('备份完成状态校验失败');
    if (activeLocalBackupId === meta.id) activeLocalBackupId = null;
    acceptedLocalBackup = null;
    return { ok: true, repaired: true };
  } catch (e) {
    return { ok: false, code: 'LOCAL_BACKUP_FAILED', error: e.message };
  }
}

async function assertLocalRecoveryReady() {
  const result = await repairLocalBackupCompletion();
  if (!result.ok) throw Object.assign(new Error(RECOVERY_REQUIRED_MESSAGE), {
    code: 'RECOVERY_REQUIRED', retryable: false
  });
}

function findBackupNode(node, id) {
  if (!node) return null;
  if (String(node.id) === String(id)) return node;
  for (const child of node.children || []) {
    const hit = findBackupNode(child, id);
    if (hit) return hit;
  }
  return null;
}

function countBackupBookmarks(node) {
  if (!node) return 0;
  return (node.url ? 1 : 0) + (node.children || []).reduce((n, child) => n + countBackupBookmarks(child), 0);
}

async function getLocalRecoveryStatus() {
  const data = await MiniSync.storage.getLocal(['local_bookmark_backup', LOCAL_BACKUP_META, LOCAL_BACKUP_COMMIT,
    'bookmark_target_id', 'sync_relationship_key', 'webdav_config', 'webdav_url', 'webdav_user',
    'webdav_password', 'webdav_bookmark_path']);
  const summary = MiniSync.utils.localRecoverySummary(data);
  const meta = data[LOCAL_BACKUP_META];
  const tree = await getChromeTree();
  const source = summary.sourceBucketId || String(data.bookmark_target_id || MiniSync.utils.getSyncBucketId() || '');
  const current = summary.currentBucketId || source;
  const savedBucket = findBackupNode(data.local_bookmark_backup?.[0], source);
  const currentBucket = findBackupNode(tree[0], current);
  let relationshipMatches = null;
  if (meta?.relationshipKey) {
    try {
      const config = MiniSync.utils.resolveWebDAVConfigData(data);
      relationshipMatches = meta.relationshipKey === MiniSync.utils.syncRelationshipKey(config, source);
    } catch (_) { relationshipMatches = false; }
  }
  const available = summary.available && !!savedBucket && !savedBucket.url;
  const receipt = matchingCommit(meta, acceptedLocalBackup) ? acceptedLocalBackup : data[LOCAL_BACKUP_COMMIT];
  const canRepairCompletion = matchingCommit(meta, receipt);
  const busy = !!MiniSync.syncMutex.active;
  return { ...summary, ok: true, available, busy, backupId: meta?.id || null, relationshipMatches,
    targetTitle: String(savedBucket?.title || currentBucket?.title || ''),
    targetExists: !!currentBucket && !currentBucket.url,
    backupBookmarkCount: countBackupBookmarks(savedBucket), currentBookmarkCount: countBackupBookmarks(currentBucket),
    canRepairCompletion,
    canRestore: !busy && available && summary.needsRecovery && summary.status !== 'unknown'
      && summary.targetMatches && relationshipMatches !== false && !canRepairCompletion,
    restoreMode: meta?.restoreOptions?.replaceCurrent ? 'rollback' : 'supplement',
    includeHome: meta?.restoreOptions?.includeHome !== false,
    lastRecovery: summary.lastRecovery };
}

async function saveRecoveryCheckpoint(meta) {
  const data = await MiniSync.storage.getLocal([LOCAL_RECOVERY_CHECKPOINT]);
  const existing = data[LOCAL_RECOVERY_CHECKPOINT];
  if (existing?.backupId === meta.id && existing.backupCreatedAt === meta.createdAt && Array.isArray(existing.tree)) return;
  const checkpoint = { version: 1, backupId: meta.id, backupCreatedAt: meta.createdAt,
    at: Date.now(), tree: await getChromeTree() };
  await MiniSync.storage.setLocal({ [LOCAL_RECOVERY_CHECKPOINT]: checkpoint });
  const saved = (await MiniSync.storage.getLocal([LOCAL_RECOVERY_CHECKPOINT]))[LOCAL_RECOVERY_CHECKPOINT];
  if (JSON.stringify(saved) !== JSON.stringify(checkpoint)) throw new Error('恢复前副本校验失败');
}

async function exportLocalRecovery() {
  const data = await MiniSync.storage.getLocal(['local_bookmark_backup', LOCAL_BACKUP_META, LOCAL_RECOVERY_CHECKPOINT]);
  const checkpoint = data[LOCAL_RECOVERY_CHECKPOINT];
  const meta = data[LOCAL_BACKUP_META];
  return { format: 'minibookmark-sync-local-recovery', version: 1, exportedAt: Date.now(),
    currentTree: await getChromeTree(), originalBackup: data.local_bookmark_backup || null,
    backup: meta ? { id: meta.id, status: meta.status, createdAt: meta.createdAt,
      sourceBucketId: meta.sourceBucketId, currentBucketId: meta.currentBucketId,
      restoredIds: meta.restoredIds || {}, restoreOptions: meta.restoreOptions || null } : null,
    recoveryCheckpoint: checkpoint ? { backupId: checkpoint.backupId, at: checkpoint.at, tree: checkpoint.tree } : null };
}

// 备份与事务状态一起落盘。未完成的恢复副本不能被重试时的空树/半成品覆盖。
async function backupLocalTree(tree) {
  localBackupFailure = null;
  try {
    const data = await MiniSync.storage.getLocal([LOCAL_BACKUP_META, 'sync_relationship_key', 'bookmark_target_id']);
    if (backupNeedsRecovery(data[LOCAL_BACKUP_META])) {
      const repair = await repairLocalBackupCompletion();
      if (!repair.ok) {
        localBackupFailure = { code: 'RECOVERY_REQUIRED', retryable: false, message: RECOVERY_REQUIRED_MESSAGE };
        return false;
      }
    }
    if (!tree) tree = await getChromeTree();
    const bucketId = String((MiniSync.utils.getSyncBucketId && MiniSync.utils.getSyncBucketId()) || data.bookmark_target_id || '');
    const meta = { version: 1, id: newBackupId(), status: 'pending', createdAt: Date.now(),
      relationshipKey: data.sync_relationship_key || null, sourceBucketId: bucketId,
      currentBucketId: bucketId, restoredIds: {} };
    await MiniSync.storage.setLocal({ local_bookmark_backup: tree, [LOCAL_BACKUP_META]: meta, [LOCAL_BACKUP_COMMIT]: null });
    acceptedLocalBackup = null;
    const saved = await MiniSync.storage.getLocal(['local_bookmark_backup', LOCAL_BACKUP_META]);
    if (!Array.isArray(saved.local_bookmark_backup) || JSON.stringify(saved.local_bookmark_backup) !== JSON.stringify(tree)
        || saved[LOCAL_BACKUP_META]?.id !== meta.id) throw new Error('备份校验失败');
    activeLocalBackupId = meta.id;
    return true;
  } catch (e) {
    localBackupFailure = { code: 'LOCAL_BACKUP_FAILED', retryable: false, message: e.message };
    console.warn('[orchestrator] 备份本地书签失败:', e.message);
    return false;
  }
}

// 保持 backupLocalTree 的 boolean 契约，同时让编排层区分恢复阻断与普通存储失败。
function getLocalBackupFailure() {
  return localBackupFailure ? { ...localBackupFailure } : null;
}

// 只由持有本次备份的编排调用方在确认提交后调用，不能放在 finally。
async function completeLocalBackup() {
  try {
    const data = await MiniSync.storage.getLocal([LOCAL_BACKUP_META]);
    const meta = data[LOCAL_BACKUP_META];
    if (!meta || ['committed', 'restored'].includes(meta.status)) return { ok: true, skipped: true };
    if (meta.id !== activeLocalBackupId || meta.status !== 'pending') {
      return { ok: false, code: 'RECOVERY_REQUIRED', error: '不能提交其他事务或尚未完成恢复的备份' };
    }
    const receipt = { version: 1, backupId: meta.id, backupCreatedAt: meta.createdAt,
      sourceBucketId: meta.sourceBucketId, relationshipKey: meta.relationshipKey || null, completedAt: Date.now() };
    acceptedLocalBackup = receipt;
    // 只有编排层确认提交后才产生凭据；独立保存，避免完成标记失败后误回滚已提交的书签。
    try { await MiniSync.storage.setLocal({ [LOCAL_BACKUP_COMMIT]: receipt }); }
    catch (e) { console.warn('[sync] 提交凭据保存失败:', e.message); }
    return await repairLocalBackupCompletion();
  } catch (e) {
    return { ok: false, code: 'LOCAL_BACKUP_FAILED', error: e.message };
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
  options = { ...(options || {}) };
  const data = await MiniSync.storage.getLocal(['local_bookmark_backup', LOCAL_BACKUP_META, 'bookmark_target_id', 'sync_relationship_key']);
  const backup = data.local_bookmark_backup;
  const storedMeta = data[LOCAL_BACKUP_META];
  if (options.preserveCurrent && (typeof options.backupId !== 'string' || !options.backupId
      || !['pending', 'restoring', 'failed'].includes(options.expectedStatus))) {
    return { ok: false, restored: 0, conflicts: [], code: 'BACKUP_CHANGED', reason: 'confirmation_required' };
  }
  if (options.backupId !== undefined && (storedMeta?.id !== options.backupId
      || (options.expectedStatus && storedMeta?.status !== options.expectedStatus))) {
    return { ok: false, restored: 0, conflicts: [], code: 'BACKUP_CHANGED', reason: 'backup_changed' };
  }
  if (matchingCommit(storedMeta, acceptedLocalBackup)
      || matchingCommit(storedMeta, (await MiniSync.storage.getLocal([LOCAL_BACKUP_COMMIT]))[LOCAL_BACKUP_COMMIT])) {
    const completion = await repairLocalBackupCompletion();
    return { ok: completion.ok, completionRepaired: completion.ok, restored: 0, conflicts: [],
      code: completion.ok ? undefined : 'RECOVERY_METADATA_FAILED', reason: completion.error };
  }
  if (options.repairOnly) {
    return { ok: false, restored: 0, conflicts: [], code: 'BACKUP_CHANGED', reason: 'commit_receipt_changed' };
  }
  if (!Array.isArray(backup) || !backup.length) return { ok: false, restored: 0, conflicts: [], code: 'BACKUP_MISSING', reason: 'no_backup' };
  const requested = String(options.targetParentId || data.bookmark_target_id
    || (MiniSync.utils.getSyncBucketId && MiniSync.utils.getSyncBucketId()) || '');
  const meta = data[LOCAL_BACKUP_META] || { version: 1, id: newBackupId(), sourceBucketId: requested,
    currentBucketId: requested, relationshipKey: data.sync_relationship_key || null, restoredIds: {} };
  const sourceId = String(meta.sourceBucketId || requested);
  const currentId = String((meta.restoredIds || {})[sourceId] || meta.currentBucketId || sourceId);
  if (requested && requested !== sourceId && requested !== currentId) {
    return { ok: false, restored: 0, conflicts: [], code: 'BACKUP_TARGET_MISMATCH', reason: 'backup_target_mismatch' };
  }
  if (options.preserveCurrent) {
    if (meta.relationshipKey) {
      let relationshipMatches = false;
      try {
        const config = await MiniSync.storage.getWebdavConfig();
        relationshipMatches = meta.relationshipKey === MiniSync.utils.syncRelationshipKey(config, sourceId);
      } catch (_) { /* 无法确认目标时，不允许改树。 */ }
      if (!relationshipMatches) return { ok: false, restored: 0, conflicts: [],
        code: 'BACKUP_RELATIONSHIP_MISMATCH', reason: 'backup_relationship_mismatch' };
    }
    try { await saveRecoveryCheckpoint(meta); }
    catch (e) { return { ok: false, restored: 0, conflicts: [], code: 'RECOVERY_CHECKPOINT_FAILED', reason: e.message }; }
  }
  // 默认公开重试继续尚未完成的恢复范围/写集，而不是把只补回桶误报为完整回滚。
  const { backupId, expectedStatus, preserveCurrent, repairOnly, ...restoreOptions } = options;
  options = restoreOptions;
  if (backupNeedsRecovery(meta) && meta.restoreOptions) options = { ...meta.restoreOptions, ...options };
  if (preserveCurrent) {
    options = { includeHome: true, recreateMissingHome: true, ...options };
    // 缺失写集不能证明哪些新增项属于事务；手动恢复不得猜测删除范围。
    if (!Array.isArray(options.createdIds)) options.createdIds = [];
  }
  options.targetParentId = sourceId;
  meta.sourceBucketId = sourceId;
  meta.restoredIds = meta.restoredIds || {};
  meta.status = 'restoring';
  meta.restoreOptions = { ...options };
  meta.lastRecovery = { at: Date.now(), code: 'RECOVERY_RUNNING', restored: 0, conflictCount: 0 };
  let result;
  try {
    // 必须在改树前落盘：失败/worker 回收后的下一轮仍能看到恢复未完成。
    await MiniSync.storage.setLocal({ [LOCAL_BACKUP_META]: meta });
    result = await restoreLocalBackupTree(backup, options, meta);
  } catch (e) {
    result = { ok: false, restored: 0, conflicts: [{ error: e.message }], reason: e.message };
  }
  try {
    meta.status = result.ok ? 'restored' : 'failed';
    if (!result.ok && !result.code) result.code = result.reason === 'bucket_not_found' ? 'BACKUP_TARGET_MISSING' : 'RECOVERY_FAILED';
    meta.lastRecovery = { at: Date.now(), code: result.ok ? 'RECOVERY_COMPLETE' : result.code,
      restored: result.restored || 0, conflictCount: (result.conflicts || []).length };
    if (result.ok) meta.completedAt = Date.now();
    await MiniSync.storage.setLocal({ [LOCAL_BACKUP_META]: meta });
    const saved = (await MiniSync.storage.getLocal([LOCAL_BACKUP_META]))[LOCAL_BACKUP_META];
    if (saved?.id !== meta.id || saved.status !== meta.status) throw new Error('恢复完成状态校验失败');
    if (result.ok && activeLocalBackupId === meta.id) activeLocalBackupId = null;
  } catch (e) {
    result = { ...result, ok: false, code: 'RECOVERY_METADATA_FAILED', reason: e.message,
      conflicts: [...(result.conflicts || []), { type: 'metadata', error: e.message }] };
  }
  return result;
}

async function restoreLocalBackupTree(backup, options, meta) {
  const root = backup[0];
  const current = (await getChromeTree())[0];
  const bucketId = String(meta.sourceBucketId);
  const restoredId = id => String(meta.restoredIds[String(id)] || id);
  // ★ conflicts 必须在任何重建/恢复分支之前声明：home 重建失败会在下面的 try/catch 里
  //   往里推记录，旧实现把它声明在重建之后 ⇒ 一旦走到那条分支就抛 TDZ
  //   （"Cannot access 'conflicts' before initialization"），回滚直接失败。
  const conflicts = [];
  // ★ 只撤销本事务新建的节点（options.createdIds 由 importer 返回）。
  //   旧实现把「备份之外的一切」当半成品删除，于是同步等待期间用户新建的书签
  //   也被删掉，而备份里没有它 ⇒ 永久丢失（审计 2026-10-11 复现）。
  //   targets 归一化阶段就要用它判定「这条 home 是不是本事务新建的」，故提前到此处。
  const writeSet = Array.isArray(options.createdIds)
    ? new Set(options.createdIds.map(String)) : null;
  let restored = 0;
  const call = (method, ...args) => new Promise((resolve, reject) => {
    if (method === 'remove' || method === 'removeTree') MiniSync.utils.noteTransactionDeletion(args[0]);
    chrome.bookmarks[method](...args, value => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(value);
    });
  });
  // 在 Chrome 树里按 id 定位节点（含虚拟根）
  function find(node, id) {
    if (String(node.id) === id) return node;
    for (const child of node.children || []) { const match = find(child, id); if (match) return match; }
    return null;
  }
  // 从 root 到目标节点的祖先链（不含目标自身），供「容器缺失时按父锚点逐级重建」。
  function ancestorChain(node, id, chain) {
    chain = chain || [];
    if (String(node.id) === id) return chain;
    for (const child of node.children || []) {
      const hit = ancestorChain(child, id, [...chain, node]);
      if (hit) return hit;
    }
    return null;
  }
  // 恢复身份按备份 id 持久化，不按标题合并。两个同名祖先也必须保持各自身份。
  async function rememberRestored(savedId, liveId) {
    meta.restoredIds[String(savedId)] = String(liveId);
    await MiniSync.storage.setLocal({ [LOCAL_BACKUP_META]: meta });
  }
  async function resolveTarget(savedNode) {
    const live = current && find(current, restoredId(savedNode.id));
    if (live && !live.url) return live;
    if (!options.recreateMissingHome) return null;
    const chain = [...(ancestorChain(root, String(savedNode.id)) || []), savedNode];
    let parentId = String(current.id);
    for (const ancestor of chain) {
      const existing = find(current, restoredId(ancestor.id));
      if (existing && !existing.url) { parentId = String(existing.id); continue; }
      const created = await call('create', { parentId, title: ancestor.title || '' });
      const node = { ...created, id: String(created.id), parentId, children: [] };
      const parentLive = find(current, parentId);
      if (parentLive) { parentLive.children = parentLive.children || []; parentLive.children.push(node); }
      // 在改选当前桶之前持久化 alias。后续叶子创建失败/worker 重启仍能找到该容器。
      await rememberRestored(ancestor.id, created.id);
      parentId = String(created.id);
    }
    return find(current, parentId);
  }
  const savedBucket = root && find(root, bucketId);  if (!savedBucket) {
    return { ok: false, restored: 0, conflicts, reason: 'bucket_not_found' };
  }
  // 桶可能整个被清掉了：按备份路径重建（含祖先链）。
  let currentBucket = current && find(current, restoredId(bucketId));
  if (!currentBucket || currentBucket.url) {
    try { currentBucket = await resolveTarget(savedBucket); }
    catch (e) { conflicts.push({ type: 'folder', id: bucketId, error: e.message }); }
  }
  if (!currentBucket) {
    return { ok: false, restored: 0, conflicts, reason: 'bucket_not_found' };
  }
  // ★ 桶被整棵删除后重建：新容器拿到的是新 id，持久化的 bookmark_target_id 与内存桶
  //   都还指着已删除的旧 id。必须就地改指新容器，否则恢复完用户下次同步又找不到桶
  //   （审计复现：missing nested bucket 恢复后 bookmark_target_id 仍是旧 id）。
  if (String(currentBucket.id) !== bucketId) {
    meta.currentBucketId = String(currentBucket.id);
    // 即使上一轮仅重建了桶就中断，下一轮也能凭持久化 alias 补齐设置。
    await MiniSync.storage.setLocal({ [LOCAL_BACKUP_META]: meta, bookmark_target_id: String(currentBucket.id) });
    if (MiniSync.utils.setSyncBucketId) MiniSync.utils.setSyncBucketId(currentBucket.id);
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
    function contains(node, id) { return !!find(node, String(id)); }
    // home 若被桶包住（含祖先关系）就不单列，避免同一子树恢复两遍。
    if (savedHome && !contains(savedBucket, savedHome.id) && !contains(currentBucket, savedHome.id)
        && String(savedHome.id) !== String(currentBucket.id)) {
      const currentHome = find(current, restoredId(savedHome.id));
      if (currentHome && !currentHome.url) {
        targets.push({ saved: savedHome, current: currentHome });
      } else if (options.recreateMissingHome) {
        // ★ 本轮把「移动端主页」整个删掉了（下载重建清空、或墓碑删除命中它）：
        //   旧实现要求「备份里与当前都存在」才恢复 ⇒ 主页内容永久留在已删状态。
        //   这里按 saved 祖先链重建容器（含缺失的父文件夹），再由通用恢复流程填回内容。
        //   只在调用方明确要求时执行：删除主页可能是用户真实意图，不能默认回滚。
        try {
          const recreated = await resolveTarget(savedHome);
          if (recreated) targets.push({ saved: savedHome, current: recreated });
        } catch (e) { conflicts.push({ type: 'folder', title: savedHome.title || '', error: e.message }); }
      }
    } else if (!savedHome && options.recreateMissingHome) {
      // ★ 备份里没有 home，但当前树里有：只可能是**本事务导入时新建的**（下载清空重建
      //   会先删掉旧 home 再重建，新建的这条 home 进了 importer 写集）。回滚必须把它
      //   连同其中的新建内容一起撤掉，否则用户会看到一个「回滚后仍多出来的主页」
      //   （审计复现：home-write-cleanup）。只撤写集内的节点，用户后来加进去的保留。
      const currentHome = findHome(current);
      if (currentHome && currentHome.id && (!writeSet || writeSet.has(String(currentHome.id)))) {
        targets.push({ saved: { id: String(currentHome.id), title: currentHome.title || '', children: [] },
          current: currentHome, dropContainer: true });
      }
    }
  }
  async function recreate(node, parentId, index) {
    const info = { parentId, index, title: node.title || '' };
    if (node.url) info.url = node.url;
    const created = await call('create', info);
    restored++;
    for (const [i, child] of (node.children || []).entries()) await recreate(child, String(created.id), i);
  }
  // 与 recreate 相同，但返回新建节点（供递归恢复把它挂进内存树，继续比对其后代）。
  async function recreateReturning(node, parentId, index) {
    const info = { parentId, index, title: node.title || '' };
    if (node.url) info.url = node.url;
    const created = await call('create', info);
    restored++;
    const built = { id: String(created && created.id), title: node.title || '', url: node.url || '', children: [] };
    for (const [i, child] of (node.children || []).entries()) {
      const sub = await recreateReturning(child, built.id, i);
      if (sub) built.children.push(sub);
    }
    return built;
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
    // ★ 归一化重叠目标：home 可能包着桶（或反之），任一 target 的子树里可能嵌着另一个 target。
    //   记录「所有 target 自身 + 它们通往根的祖先连接路径」，删除多余节点时一律跳过，
    //   否则恢复外层目标会把内层目标整棵 removeTree 掉，刚刚补回的内容又没了
    //   （审计复现：clear-first 失败后 bucket-under-home 内容没恢复成原样）。
    const targetIds = new Set(targets.map(target => String(target.current.id)));
    // ★ 重叠判定要同时覆盖「当前 id」和「备份里的 id」：容器被整棵删除后重建，
    //   当前 id 是新的，但外层 target 的**备份树**里仍挂着旧 id 的那棵子树；
    //   只按当前 id 判断会漏掉它 ⇒ 内外两个 target 各恢复一遍（审计复现
    //   missing nested bucket 的 SavedBucket 重复）。
    for (const target of targets) {
      targetIds.add(String(target.current.id));
      targetIds.add(String(target.saved.id));
    }
    const isOtherTarget = (id, selfId) => targetIds.has(String(id)) && String(id) !== String(selfId);
    const protectedPath = new Set();
    (function markProtected(node) {
      let onPath = targetIds.has(String(node.id));
      for (const child of node.children || []) {
        if (markProtected(child)) onPath = true;
      }
      if (onPath) protectedPath.add(String(node.id));
      return onPath;
    })(current);
    // ★ writeSet 已在函数上方声明（targets 归一化阶段就要用）；未传入 createdIds
    //   （老调用方/直接恢复）时为 null，沿用「备份之外全删」的替换式语义。
    async function stage(node, parentId, index) {
      let live = surviving.get(String(node.id));
      if (!live || !!live.url !== !!node.url) {
        const info = { parentId, title: node.title || '' };
        if (node.url) info.url = node.url;
        live = await call('create', info);
        if (!stagedIds.has(parentId)) stagedRoots.push({ id: String(live.id), url: !!live.url });
        stagedIds.add(String(live.id));
      }
      const id = String(live.id);
      desiredIds.add(id);
      planned.push({ node, id, parentId, index });
      restored++;
      for (const [i, child] of (node.children || []).entries()) {
        // ★ 归一化重叠目标：某个后代是**另一个 target**（按其备份 id 或当前 id 判定）时，
        //   停在这里不再下钻 —— 那个目标会由它自己的 target 循环恢复内容。
        if (isOtherTarget(child.id, node.id)) continue;
        await stage(child, id, i);
      }
    }
    try {
      // No original is changed or removed until every required create succeeds.
      for (const target of targets) {
        for (const [i, child] of (target.saved.children || []).entries()) {
          // ★ 归一化重叠目标：这个 child 本身是**另一个 target**（如 home 包着的桶）时，
          //   它的内容由它自己的 target 循环恢复；这里既不复用也不下钻，避免重复恢复。
          if (isOtherTarget(child.id, target.current.id)) continue;
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
        if (!live) continue; // 节点在恢复过程中已被外部删除：不重建，也不报错
        const changes = {};
        if ((live.title || '') !== (entry.node.title || '')) changes.title = entry.node.title || '';
        if (entry.node.url && live.url !== entry.node.url) changes.url = entry.node.url;
        if (Object.keys(changes).length) {
          await call('update', entry.id, changes);
          Object.assign(live, changes);
        }
        const parent = liveNodes.get(entry.parentId);
        if (String(live.parentId) !== entry.parentId || String((parent.children || [])[entry.index]?.id) !== entry.id) {
          if (MiniSync.utils && MiniSync.utils.noteTransactionMove) MiniSync.utils.noteTransactionMove(entry.id);
          await call('move', entry.id, { parentId: entry.parentId, index: entry.index });
          const oldParent = liveNodes.get(String(live.parentId));
          if (oldParent) oldParent.children = (oldParent.children || []).filter(child => String(child.id) !== entry.id);
          parent.children = parent.children || [];
          parent.children.splice(entry.index, 0, live);
          live.parentId = entry.parentId;
        }
      }
      // 删除多余节点：有写集时只删本事务新建的（保留用户并发新增与其他既有内容）；
      // 无写集时沿用「备份之外全删」的替换式语义。
      // ★ 保护祖先连接路径与所有 target 子树：恢复外层目标不能把内层目标一并删掉。
      const cleaned = new Set();
      async function removeExtras(parent) {
        if (!parent || cleaned.has(String(parent.id))) return;
        cleaned.add(String(parent.id));
        for (const child of [...(parent.children || [])]) {
          const id = String(child.id);
          if (desiredIds.has(id)) { await removeExtras(child); continue; }
          if (protectedPath.has(id)) { await removeExtras(child); continue; }
          if (writeSet && !writeSet.has(id)) { await removeExtras(child); continue; }
          // ★ 本事务新建的文件夹里可能已经混进了用户后来加的内容：整只 removeTree 会把
          //   用户内容一起删掉。先看看有没有「不该删」的后代（非写集/非目标保护段），
          //   有就只递归清理写集部分，保留文件夹本身与用户内容
          //   （审计复现：rollback never removes a transaction folder containing user-added descendants）。
          if (!child.url && hasKeptDescendant(child)) { await removeExtras(child); continue; }
          await call(child.url ? 'remove' : 'removeTree', id);
          parent.children = (parent.children || []).filter(n => String(n.id) !== id);
          (function unindex(node) {
            liveNodes.delete(String(node.id));
            for (const descendant of node.children || []) unindex(descendant);
          })(child);
        }
      }
      function hasKeptDescendant(node) {
        for (const child of node.children || []) {
          const id = String(child.id);
          if (desiredIds.has(id) || protectedPath.has(id)) return true;
          if (writeSet && !writeSet.has(id)) return true;
          if (hasKeptDescendant(child)) return true;
        }
        return false;
      }
      for (const target of targets) await removeExtras(liveNodes.get(String(target.current.id)));
      // ★ 本事务新建的 home 容器：清掉其写集内容后，若里面已没有用户后来加进来的东西
      //   （没有非写集后代），就把这个多余的空壳也撤掉；只要残留了用户内容就整只保留。
      for (const target of targets) {
        if (!target.dropContainer) continue;
        const live = liveNodes.get(String(target.current.id)) || find((await getChromeTree())[0], String(target.current.id));
        if (!live) continue;
        const hasKept = (function anyKept(node) {
          for (const child of node.children || []) {
            const id = String(child.id);
            if (desiredIds.has(id) || protectedPath.has(id)) return true;
            if (writeSet && !writeSet.has(id)) return true;
            if (anyKept(child)) return true;
          }
          return false;
        })(live);
        if (!hasKept) {
          try { await call('removeTree', String(live.id)); }
          catch (e) { conflicts.push({ type: 'delete', id: String(live.id), error: e.message }); }
        }
      }
      return { ok: conflicts.length === 0, restored, conflicts, result: { importedCount: restored, conflicts } };
    } catch (e) {
      conflicts.push({ error: e.message });
      return { ok: false, restored, conflicts, reason: e.message };
    }
  }
  // 叠加式恢复（默认）：只补回缺失节点，绝不删除任何现存内容。
  // ★ 必须遍历**全部 targets**（桶 + 主页）：旧实现只走 savedBucket.children，
  //   于是主页区被墓碑删掉的内容永远补不回来 —— 上传路径的回滚正是叠加式，
  //   表现为「recovery.ok=true、restored=0、主页书签却没了」
  //   （审计 2026-10-11 复现 home-rollback-upload）。
  for (const target of targets) {
    // ★ 命中的既有文件夹要**递归补回缺失后代**，不能整棵跳过：用户的典型场景是
    //   「文件夹还在、里面的书签被误删」—— 旧实现找到同名文件夹就 continue，
    //   恢复条数为 0、书签依旧缺失（审计 2026-10-11 复现 restore-existing-folder）。
    //   递归时只新增缺失项，不动既有内容（叠加式语义不变）。
    async function restoreMissing(savedNode, liveNode) {
      for (const [i, child] of (savedNode.children || []).entries()) {
        const existing = (liveNode.children || []).find(n => n.title === child.title && n.url === child.url);
        if (existing) {
          if (!child.url) await restoreMissing(child, existing);   // 文件夹：继续往下补
          continue;
        }
        try {
          const created = await recreateReturning(child, String(liveNode.id), i);
          // recreate 返回新节点；把它挂进 liveNode.children 供后续同级比对
          if (created) {
            liveNode.children = liveNode.children || [];
            liveNode.children.splice(Math.min(i, liveNode.children.length), 0, created);
          }
        } catch (e) { conflicts.push({ title: child.title, error: e.message }); }
      }
    }
    await restoreMissing(target.saved, target.current);
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
  const key = MiniSync.utils.syncRelationshipKey(config, bucketId);
  const data = await MiniSync.storage.getLocal(['sync_relationship_key', 'sync_relationship_states', 'sync_baseline_repair_needed', STORAGE_KEYS.TOMBSTONES, STORAGE_KEYS.SNAPSHOTS, STORAGE_KEYS.CLOUD_LAST_MODIFIED]);
  if (data.sync_relationship_key === key) return { changed: false, key };
  const states = data.sync_relationship_states || {};
  if (data.sync_relationship_key) {
    states[data.sync_relationship_key] = {
      tombstones: data[STORAGE_KEYS.TOMBSTONES] || [],
      snapshots: data[STORAGE_KEYS.SNAPSHOTS] || {},
      cloudLastModified: data[STORAGE_KEYS.CLOUD_LAST_MODIFIED] || 0,
      baselineRepair: data.sync_baseline_repair_needed || null
    };
  }
  const next = states[key] || { tombstones: [], snapshots: {}, cloudLastModified: 0 };
  await MiniSync.storage.setLocal({
    sync_relationship_key: key, sync_relationship_states: states,
    [STORAGE_KEYS.TOMBSTONES]: next.tombstones,
    [STORAGE_KEYS.SNAPSHOTS]: next.snapshots,
    [STORAGE_KEYS.CLOUD_LAST_MODIFIED]: next.cloudLastModified,
    sync_baseline_repair_needed: next.baselineRepair || null,
    ...Object.fromEntries(['berry_pathkey_snapshot', 'via_pathkey_snapshot', 'aira_pathkey_snapshot', 'aira_home_pathkey_snapshot']
      .flatMap(name => [[name, []], [name + '_owner', null], [name + '_meta', null]]))
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

/**
 * 成功把本机状态写回云端之后清理移动意图。
 *
 * 移动意图只用来回答「这次路径变化是谁改的」。一旦云端已经收到本机这一刻的树
 * （上传/合并提交成功），cutoff 之前登记的意图都已被确认或不再影响判定，继续留着
 * 会让下一轮合并误以为本端仍是发起方，反过来拒绝跟随云端后来的移动。
 * cutoff 之后登记的意图（同步等待期间用户新拖的）必须保留 —— 那才是尚未上云的改动。
 *
 * @param {number} cutoffAt 本轮同步开始的时间
 * @returns {Promise<number>} 清掉的条数
 */
async function clearConfirmedMoveIntents(cutoffAt) {
  try {
    const data = await MiniSync.storage.getLocal(['sync_move_intents']);
    const intents = data.sync_move_intents || {};
    let removed = 0;
    for (const key of Object.keys(intents)) {
      const at = intents[key] && typeof intents[key].time === 'number' ? intents[key].time : 0;
      if (at <= cutoffAt) { delete intents[key]; removed++; }
    }
    if (removed > 0) await MiniSync.storage.setLocal({ sync_move_intents: intents });
    return removed;
  } catch (e) {
    console.warn('[sync] 清理移动意图失败（忽略）:', e.message);
    return 0;
  }
}

/**
 * 并发保护降档提示：**同一级别只提示一次**。
 *
 * 坚果云这类服务不返回可用 ETag，于是每一轮上传/合并都会在结果里追加一句
 * 「本次写入没有并发保护」。事实没错，但每 30 分钟弹一次没有新信息，用户只看到
 * 满屏提示（实测反馈：不想要这些提示）。级别再次降档（例如从
 * last-modified 变成 none）时重新提示一次；恢复到满档时清掉记录，之后若再降档
 * 仍会提示。
 *
 * 提示本身不丢失：诊断/控制台日志里仍有完整的保护级别说明。
 * @param {'etag'|'last-modified'|'none'|string} protection
 * @returns {Promise<string>} 需要追加到结果文案的说明（空串=不提示）
 */
async function writeProtectionNoteOnce(protection) {
  const note = MiniSync.webdav.writeProtectionNote(protection);
  try {
    const data = await MiniSync.storage.getLocal(['last_write_protection']);
    const previous = data.last_write_protection || '';
    if (!note) {
      if (previous) await MiniSync.storage.setLocal({ last_write_protection: '' });
      return '';
    }
    if (previous === protection) return '';
    await MiniSync.storage.setLocal({ last_write_protection: protection });
  } catch (_) { /* 记账失败不影响同步，也不能把提示弄丢 */ }
  return note;
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
function pendingBaseline(data) {
  const pending = data.sync_baseline_repair_needed;
  return pending && Array.isArray(pending.localTree)
    && (pending.relationshipKey || null) === (data.sync_relationship_key || null) ? pending : null;
}

async function getDeletionBaseline() {
  const data = await MiniSync.storage.getLocal(['sync_relationship_key', 'sync_baseline_repair_needed', STORAGE_KEYS.SNAPSHOTS]);
  const pending = pendingBaseline(data);
  return pending ? pending.localTree : (data[STORAGE_KEYS.SNAPSHOTS] || {}).localTree || [];
}

async function recordBaselineDeletions(previous, current) {
  const oldKeys = new Set(MiniSync.xbelPath.computeJsonPathKeys(previous).values());
  const newKeys = new Set(MiniSync.xbelPath.computeJsonPathKeys(current).values());
  const deleted = new Set([...oldKeys].filter(key => !newKeys.has(key)));
  if (!deleted.size) return 0;
  const data = await MiniSync.storage.getLocal([STORAGE_KEYS.TOMBSTONES]);
  const tombstones = MiniSync.tombstone.mergeTombstones(data[STORAGE_KEYS.TOMBSTONES] || [], deleted, null,
    await MiniSync.storage.getDeviceId());
  await MiniSync.storage.setLocal({ [STORAGE_KEYS.TOMBSTONES]: tombstones });
  return deleted.size;
}

async function writeBaseline(flat) {
  const data = await MiniSync.storage.getLocal([STORAGE_KEYS.SNAPSHOTS]);
  await MiniSync.storage.setLocal({
    [STORAGE_KEYS.SNAPSHOTS]: { ...(data[STORAGE_KEYS.SNAPSHOTS] || {}), localTree: flat },
    sync_baseline_repair_needed: null
  });
}

async function saveLocalTreeSnapshot(overrideFlat) {
  let flat;
  let relationshipKey;
  let mayReplacePending = false;
  try {
    // ★ 上传/合并提交成功时必须传入**实际写进云端的扁平树**（overrideFlat）：
    //   在这里再读一次当前树，会把「PUT 等待期间用户新拖的书签」记进基线 ——
    //   云端并没有这次移动，下一轮三方比较就会把它当成「上次同步时就在那里」，
    //   于是把用户的移动判成「跟随云端」并迁回原位（实测：移动后同步，位置被还原）。
    //   基线只应代表**云端已确认的状态**。下载路径不写云端，仍按当前树记录。
    flat = Array.isArray(overrideFlat)
      ? overrideFlat
      : MiniSync.merger.chromeTreeToList(await getChromeTree());
    const data = await MiniSync.storage.getLocal(['sync_relationship_key', 'sync_baseline_repair_needed']);
    relationshipKey = data.sync_relationship_key || null;
    const previous = pendingBaseline(data);
    // Never discard historical evidence until intervening deletions are durable.
    if (previous) await recordBaselineDeletions(previous.localTree, flat);
    mayReplacePending = true;
    try {
      await writeBaseline(flat);
    } catch (error) {
      console.warn('[sync] localTree 快照写入失败，清减人工快照后重试:', error.message);
      const snapshots = await MiniSync.storage.getLocal(['local_snapshots']);
      await MiniSync.storage.setLocal({ local_snapshots: (snapshots.local_snapshots || []).slice(0, 1) });
      await writeBaseline(flat);
    }
    return { ok: true, count: flat.length };
  } catch (error) {
    console.warn('[orchestrator] 保存 localTree 快照失败:', error.message);
    if (flat && mayReplacePending) {
      try {
        await MiniSync.storage.setLocal({ sync_baseline_repair_needed: {
          at: Date.now(), error: error.message, relationshipKey, localTree: flat
        } });
      } catch (_) { /* Both baseline stores can fail; removal events still carry their subtree. */ }
    }
    return { ok: false, error: error.message };
  }
}

// Replay the exact failed baseline. A fresh capture cannot recover lost history.
async function repairBaselineIfNeeded() {
  try {
    const data = await MiniSync.storage.getLocal(['sync_relationship_key', 'sync_baseline_repair_needed']);
    if (!data.sync_baseline_repair_needed) return { ok: true, skipped: true };
    const pending = pendingBaseline(data);
    if (!pending) return { ok: false, error: '缺少原始历史基线，无法补交' };
    await writeBaseline(pending.localTree);
    return { ok: true, repaired: true };
  } catch (error) {
    return { ok: false, error: error.message };
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
    await repairBaselineIfNeeded();
    const previous = await getDeletionBaseline();
    return await recordBaselineDeletions(previous, Array.isArray(localList) ? localList : []);
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
      // 登记为「本轮同步自身造成的删除」：background 的删除监听据此跳过，
      // 而用户在同步期间的手动删除（未登记）照常写墓碑（审计 2026-10-11 修复）。
      // 导入模块未加载（精简 harness）时退回直接删除，行为与旧实现一致。
      if (MiniSync.importer && MiniSync.importer.removeNode) {
        await MiniSync.importer.removeNode(String(id), !(node && node.url));
      } else {
        await new Promise((resolve, reject) => {
          chrome.bookmarks[node && node.url ? 'remove' : 'removeTree'](String(id), () => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve();
          });
        });
      }
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
  completeLocalBackup,
  repairLocalBackupCompletion,
  assertLocalRecoveryReady,
  getLocalRecoveryStatus,
  exportLocalRecovery,
  getLocalBackupFailure,
  getLocalBackup,
  restoreLocalBackup,
  ensureSyncRelationship,
  recordLastSync,
  clearConfirmedMoveIntents,
  writeProtectionNoteOnce,
  resolveSyncBucketSetting,
  saveLocalSnapshot,
  saveLocalTreeSnapshot,
  getDeletionBaseline,
  repairBaselineIfNeeded,
  backfillDeletedTombstones,
  applyTombstoneDeletions,
  _treeToFlatList
};

})();
