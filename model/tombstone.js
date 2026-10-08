// tombstone.js — 墓碑管理工具
// 统一管理墓碑（已删除项记录）的清理和 key 提取

MiniSync.tombstone = (function() {

/**
 * 保留墓碑，直到所有设备明确确认删除。
 *
 * A TTL alone cannot prove every device has observed a deletion. Keep valid
 * tombstones until explicit acknowledgment from every registered device exists.
 * This module has no device registry or acknowledgment protocol yet, so it
 * conservatively retains them (except malformed entries).
 *
 * @param {Array} tombstones
 * @param {number} [ttlMs]
 * @param {{localPKSet?:Set<string>, remotePKSet?:Set<string>}} [ctx]
 */
function cleanExpired(tombstones, ttlMs, ctx) {
  if (!Array.isArray(tombstones)) return [];
  return tombstones.filter(item => typeof item === 'string' ? !!item : !!(item && item.key));
}

/** 提取墓碑 key 集合（支持 string 和 object 两种格式） */
function extractKeys(tombstones) {
  const set = new Set();
  if (!tombstones || !Array.isArray(tombstones)) return set;
  for (const item of tombstones) {
    const pk = typeof item === 'string' ? item : (item && item.key ? item.key : null);
    if (pk) set.add(pk);
  }
  return set;
}

/** 合并新旧墓碑列表，去重并保留最新时间戳 */
function mergeTombstones(existing, newlyDeleted, readdedPKs, deviceId) {
  const now = Date.now();
  const finalTombstones = [];

  if (existing && Array.isArray(existing)) {
    for (const item of existing) {
      const pk = typeof item === 'string' ? item : (item && item.key ? item.key : null);
      if (!pk) continue;
      // 如果被重新加回来，跳过
      if (readdedPKs && readdedPKs.has(pk)) continue;
      // 没有全设备确认协议，不做时间过期回收；否则离线端可能使节点复活。
      if (typeof item === 'string') {
        finalTombstones.push({ key: pk, deletedAt: now, deviceId: deviceId || '' });
      } else {
        finalTombstones.push(item);
      }
    }
  }

  // 添加本次新删除的
  if (newlyDeleted) {
    for (const pk of newlyDeleted) {
      if (!finalTombstones.some(t => t.key === pk)) {
        finalTombstones.push({ key: pk, deletedAt: now, deviceId: deviceId || '' });
      }
    }
  }

  return finalTombstones;
}

/** 合并本地与云端墓碑，同一 pathKey 以 deletedAt 较新者为准 */
function mergeTombstoneSources(local, remote) {
  const byKey = new Map();
  const push = (item) => {
    const pk = typeof item === 'string' ? item : (item && item.key ? item.key : null);
    if (!pk) return;
    const delAt = typeof item === 'string' ? 0 : (item.deletedAt || 0);
    const devId = (typeof item === 'string') ? '' : (item.deviceId || '');
    const existing = byKey.get(pk);
    if (!existing || delAt > existing.deletedAt) {
      byKey.set(pk, { key: pk, deletedAt: delAt, deviceId: devId });
    }
  };
  if (Array.isArray(local)) local.forEach(push);
  if (Array.isArray(remote)) remote.forEach(push);
  return Array.from(byKey.values());
}

/** 清理假墓碑：节点实际还存在但被误标记为已删除的记录（如文件夹重命名场景）
 *  @param {Array} tombstones  墓碑列表（{key,deletedAt,deviceId}）
 *  @param {Array} currentTree 当前本地树扁平列表
 *  @param {string} [myDeviceId] 本端设备 id。
 *    仅当「墓碑由本端产生」且「节点在当前树中存在」时才视为假墓碑清除（重命名导致子节点短暂离父）；
 *    其他设备产生的墓碑代表「对端已删除」，本端节点仍存在正好说明需要删除，必须保留，
 *    否则会出现「A 端删除、B 端合并后还在」的跨端删除失效。
 *  @param {Array} [prevSnapshotList] 上次成功同步时的本地扁平树（sync_snapshots.localTree）。
 *    用于把「本端在上一轮同步之后新建/挪回来的节点」从「对端已删、本端还没删的残留」里分出来：
 *    墓碑命中一个**当前存在、但上次快照里没有**的 pathKey ⇒ 是本端的新动作（用户意图），
 *    墓碑作废，否则新建/挪回的书签会被旧墓碑持续挡住。
 */
function cleanFakeTombstones(tombstones, currentTree, myDeviceId, prevSnapshotList) {
  if (!tombstones || !Array.isArray(tombstones) || !currentTree || !Array.isArray(currentTree)) return tombstones;
  // 构建当前树所有节点的 pathKey → id 映射
  const pkMap = computePathKeys(currentTree);
  const existingPKs = new Set(pkMap.values());
  // 上次同步快照的 pathKey 集合（快照为空＝本端从未同步过，无从判定，不做这层清理）
  const snapPKs = (Array.isArray(prevSnapshotList) && prevSnapshotList.length > 0)
    ? new Set(computePathKeys(prevSnapshotList).values()) : null;
  // 只保留「真正已删除」或「由其他设备产生」的墓碑
  return tombstones.filter(item => {
    const pk = typeof item === 'string' ? item : (item && item.key ? item.key : null);
    if (!pk) return false; // 无效条目，丢弃
    // 节点当前树中已不存在 → 真墓碑，保留
    if (!existingPKs.has(pk)) return true;
    // ★ 节点在、但上次同步时还没有这个路径 ⇒ 本端新建/挪回（用户刚把它加回来），墓碑作废
    if (snapPKs && !snapPKs.has(pk)) return false;
    // 节点仍存在：仅当本端产生的墓碑才算「重命名假墓碑」清除
    const devId = typeof item === 'string' ? '' : (item.deviceId || '');
    if (!myDeviceId || devId === myDeviceId) return false; // 本端假墓碑 → 移除
    return true; // 其他设备的删除指令 → 保留
  });
}

/**
 * 构建一次同步使用的完整「墓碑视图」——**上传 / 下载 / 合并三条路径必须共用同一份口径**。
 *
 * 为什么必须共用：三个按钮若各按各的规则消费墓碑，同一个删除在不同按钮上表现不同。
 * 实测（用户报障）：手机删了书签并同步上云，桌面点「上传」→ 书签被加回云端（墓碑被
 * 覆盖/忽略），点「合并」→ 书签被正常删掉。用户看到的是一只薛定谔的书签。
 *
 * 视图的含义（顺序与历史实现逐条对齐，改动等于改变删除语义）：
 *   ① 本地 ∪ 云端墓碑，同 key 取 deletedAt 较新者（时间戳更深者代表更新的删除意图）
 *   ② 墓碑不按时间或当前两端可见性回收，等待全设备确认机制
 *   ③ 假墓碑清理：本端产生、但节点仍在本地树里的（重命名残留）丢弃；
 *      本端在上一轮同步之后新建/挪回来的节点（当前树里有、上次快照里没有）也丢弃——
 *      否则旧墓碑会把用户重新加回的书签持续挡住；
 *      他端产生的、且本端上次同步时就有的残留节点保留（那正是「对端已删除，本端要跟上」）
 *   ④ 两端都存在的节点，墓碑一律作废（它确实活着，说明删除已被撤销/被重新加回）
 *
 * @param {{localTombstones?:Array, remoteTombstones?:Array, localList?:Array,
 *          remoteList?:Array, myDeviceId?:string, prevSnapshotList?:Array}} opts
 * @returns {{tombstones:Array, tombstoneKeys:Set<string>, localPKs:Map,
 *           remotePKs:Map, localPKSet:Set<string>, remotePKSet:Set<string>,
 *           bothPresentPKs:Set<string>}}
 */
function buildTombstoneView(opts) {
  const o = opts || {};
  const localList = Array.isArray(o.localList) ? o.localList : [];
  const remoteList = Array.isArray(o.remoteList) ? o.remoteList : [];

  const localPKs = MiniSync.xbelPath.computeJsonPathKeys(localList);
  const remotePKs = MiniSync.xbelPath.computeJsonPathKeys(remoteList);
  const localPKSet = new Set(localPKs.values());
  const remotePKSet = new Set(remotePKs.values());
  // 双方都存在的 pk（确实活着的节点，墓碑应清）；云端有但本地已删的节点不在此集，
  // 其墓碑必须保留以实现删除传播。
  const bothPresentPKs = new Set([...localPKSet].filter(pk => remotePKSet.has(pk)));

  let tombstones = mergeTombstoneSources(o.localTombstones || [], o.remoteTombstones || []);
  tombstones = cleanExpired(tombstones, null, { localPKSet, remotePKSet });
  tombstones = cleanFakeTombstones(tombstones, localList, o.myDeviceId,
    Array.isArray(o.prevSnapshotList) ? o.prevSnapshotList : null);
  tombstones = tombstones.filter(item => {
    const pk = typeof item === 'string' ? item : (item && item.key ? item.key : null);
    return pk && !bothPresentPKs.has(pk);
  });

  return {
    tombstones,
    tombstoneKeys: extractKeys(tombstones),
    localPKs,
    remotePKs,
    localPKSet,
    remotePKSet,
    bothPresentPKs
  };
}

return {
  cleanExpired: cleanExpired,
  extractKeys: extractKeys,
  mergeTombstones: mergeTombstones,
  mergeTombstoneSources: mergeTombstoneSources,
  cleanFakeTombstones: cleanFakeTombstones,
  buildTombstoneView: buildTombstoneView
};

})();
