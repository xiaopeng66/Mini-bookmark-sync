// adapters/berry-adapter.js - Berry 浏览器桥接逻辑
// 负责：读写 bookmarks.json、继承图标、顺序同步、id 映射

// Shared by all three adapters (Berry is loaded first). Identity belongs to a
// parent chain, never to a global title/URL set. Reads only propose changes;
// callers commit snapshots/revocations after the corresponding writes succeed.
function createBridgeIdentity() {
  const paths = list => MiniSync.xbelPath.computeJsonPathKeys(list);
  const keyOf = item => typeof item === 'string' ? item : item && item.key;
  const versionOf = item => ({ key: keyOf(item), deletedAt: Number(item && item.deletedAt) || 0,
    deviceId: typeof item === 'object' && item ? item.deviceId || '' : '' });
  const versionKey = item => JSON.stringify(Object.values(versionOf(item)));
  const sameKeys = (a, b) => Array.isArray(a) && Array.isArray(b) &&
    JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
  const identityFields = ['id', 'parentId', 'title', 'url', 'isFolder', 'source', 'zoneRoot',
    '_index', 'addedAt', 'createdAt', 'updatedAt'];
  const copyNodes = list => list.map(n => Object.fromEntries(identityFields
    .filter(k => n[k] !== undefined).map(k => [k, n[k]])));

  async function stateFor(storageKey, owner, context) {
    const data = await MiniSync.utils.readLocalKeys([storageKey, storageKey + '_owner', storageKey + '_meta',
      'sync_relationship_key', 'sync_tombstones', 'sync_tombstone_acked']);
    const sameOwner = data[storageKey + '_owner'] === undefined || owner == null || data[storageKey + '_owner'] === owner;
    const keys = sameOwner && Array.isArray(data[storageKey]) ? data[storageKey] : [];
    const meta = data[storageKey + '_meta'];
    const trusted = sameOwner && meta && meta.version === 2 && meta.owner === owner &&
      meta.relationshipKey === (data.sync_relationship_key || null) && sameKeys(meta.keys, keys) && Array.isArray(meta.nodes);
    return { keys, meta: trusted ? meta : null, relationshipKey: data.sync_relationship_key || null,
      tombstones: context && Array.isArray(context.tombstones) ? context.tombstones : data.sync_tombstones || [],
      acked: new Set(context && context.ackedPathKeys || data.sync_tombstone_acked || []) };
  }

  function makeSnapshot(storageKey, owner, list, state) {
    const keys = [...new Set(paths(list).values())];
    const present = new Set(keys);
    // An acknowledgment is for this deletion version, not for this path forever.
    // Observing an absent phone path is necessary even when main XBEL acked it.
    const absentTombstones = state.tombstones.map(versionOf).filter(t => t.key && t.deletedAt > 0 &&
      state.acked.has(t.key) && !present.has(t.key));
    return { ...MiniSync.utils.scopedBridgeSnapshotUpdate(storageKey, owner, keys),
      [storageKey + '_meta']: { version: 2, owner, relationshipKey: state.relationshipKey,
        keys, nodes: copyNodes(list), observedAt: Date.now(), absentTombstones } };
  }

  async function snapshotUpdates(storageKey, owner, list, context) {
    return makeSnapshot(storageKey, owner, list, await stateFor(storageKey, owner, context));
  }

  function treeIndex(list) {
    const keys = paths(list);
    const byId = new Map(list.map(n => [n.id, n]));
    const byKey = new Map();
    const children = new Map();
    for (const n of list) {
      const pk = keys.get(n.id);
      if (pk && !byKey.has(pk)) byKey.set(pk, n);
      if (!children.has(n.parentId)) children.set(n.parentId, []);
      children.get(n.parentId).push(n);
    }
    const signatures = new Map();
    function signature(node, visiting = new Set()) {
      if (signatures.has(node.id)) return signatures.get(node.id);
      if (visiting.has(node.id)) throw new Error('桥接文件包含环形父链');
      visiting.add(node.id);
      const childrenSig = (children.get(node.id) || []).map(n => n.isFolder
        ? ['F', n.title, signature(n, visiting)] : ['L', n.title, n.url || '']);
      visiting.delete(node.id);
      const value = childrenSig.length ? JSON.stringify(childrenSig.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))) : '';
      signatures.set(node.id, value);
      return value;
    }
    const parentKey = n => keys.get(n.parentId) || (keys.get(n.id) || '').split('/')[0];
    return { keys, byId, byKey, children, signature, parentKey };
  }

  async function merge({ kind, storageKey, owner, currentList, phoneList, tombstoneKeys,
    context, stableIds = true, preferPhoneOrder = false }) {
    const state = await stateFor(storageKey, owner, context);
    const cur = treeIndex(currentList);
    const ph = treeIndex(phoneList);
    const previous = state.meta ? treeIndex(state.meta.nodes) : null;
    const resolveLegacy = MiniSync.xbelPath.legacyKeyResolver([currentList, phoneList]);
    const previousKeys = new Set(state.meta ? state.keys : state.keys.map(resolveLegacy).filter(Boolean));
    const blocked = new Set(tombstoneKeys || []);
    const changes = { list: currentList, deletedIds: [], deletedPathKeys: [], revokedPathKeys: [],
      revokedTombstones: [], pathRemaps: [], changed: false, complete: true, errors: [] };
    const absenceVersions = new Set(state.meta && owner != null
      ? (state.meta.absentTombstones || []).map(versionKey) : []);
    for (const item of state.tombstones) {
      const t = versionOf(item);
      if (blocked.has(t.key) && ph.byKey.has(t.key) && !previousKeys.has(t.key) &&
          !cur.byKey.has(t.key) && state.acked.has(t.key) && absenceVersions.has(versionKey(t))) {
        changes.revokedPathKeys.push(t.key);
        changes.revokedTombstones.push(t);
        blocked.delete(t.key);
      }
    }
    function blockedNode(n, index) {
      const seen = new Set();
      while (n && !seen.has(n.id)) {
        seen.add(n.id);
        if (blocked.has(index.keys.get(n.id))) return true;
        n = index.byId.get(n.parentId);
      }
      return false;
    }

    const phoneToCurrent = new Map();
    const usedCurrent = new Set();
    const pair = (p, c) => {
      if (!p || !c || !!p.isFolder !== !!c.isFolder || phoneToCurrent.has(p.id) || usedCurrent.has(c.id) ||
          blockedNode(p, ph) || blockedNode(c, cur)) return false;
      phoneToCurrent.set(p.id, c.id);
      usedCurrent.add(c.id);
      return true;
    };
    // Stable native ID is evidence only when the *committed phone tree* maps it
    // back to the old local path. Device-local IDs are not globally unique.
    if (stableIds && previous) {
      for (const p of phoneList) {
        const old = previous.byId.get(p.id);
        if (!old || (old.createdAt && p.createdAt && old.createdAt !== p.createdAt)) continue;
        const oldPk = previous.keys.get(p.id);
        if (oldPk && previousKeys.has(oldPk)) pair(p, cur.byKey.get(oldPk));
      }
    }
    for (const p of phoneList) pair(p, cur.byKey.get(ph.keys.get(p.id)));

    // HTML has no persistent ID. Infer a rename only within an already mapped
    // parent, with one nonempty, complete subtree signature on each side and a
    // committed baseline for its children. Never match a lone URL/title globally.
    const mappedParent = p => phoneToCurrent.get(p.parentId) || null;
    const baselineSubtree = n => {
      const kids = cur.children.get(n.id) || [];
      return kids.length > 0 && kids.every(c => (previousKeys.has(cur.keys.get(c.id)) ||
        (c.isFolder && baselineSubtree(c))) && (!c.isFolder || !(cur.children.get(c.id) || []).length || baselineSubtree(c)));
    };
    let progress = true;
    while (progress) {
      progress = false;
      // Descendants follow a proved parent identity; match only direct children.
      for (const p of phoneList) {
        if (phoneToCurrent.has(p.id)) continue;
        const parentId = mappedParent(p);
        if (!parentId) continue;
        const candidates = (cur.children.get(parentId) || []).filter(c => !usedCurrent.has(c.id) &&
          !!c.isFolder === !!p.isFolder && (c.isFolder ? c.title === p.title :
            MiniSync.xbel.normalizeUrl(c.url) === MiniSync.xbel.normalizeUrl(p.url)));
        if (candidates.length === 1 && pair(p, candidates[0])) progress = true;
      }
      const candidates = [];
      for (const p of phoneList) {
        if (!p.isFolder || phoneToCurrent.has(p.id) || blockedNode(p, ph)) continue;
        const sig = ph.signature(p);
        if (!sig) continue;
        const parent = mappedParent(p);
        for (const c of currentList) {
          if (!c.isFolder || usedCurrent.has(c.id) || ph.byKey.has(cur.keys.get(c.id))) continue;
          const sameParent = parent ? c.parentId === parent : cur.parentKey(c) === ph.parentKey(p);
          if (sameParent && baselineSubtree(c) && cur.signature(c) === sig) candidates.push([p, c]);
        }
      }
      for (const [p, c] of candidates) {
        if (candidates.filter(([other]) => other.id === p.id).length !== 1 ||
            candidates.filter(([, other]) => other.id === c.id).length !== 1) continue;
        if (pair(p, c)) progress = true;
      }
    }

    const removed = new Set();
    for (const n of currentList) {
      const pk = cur.keys.get(n.id);
      if (pk && previousKeys.has(pk) && !ph.byKey.has(pk) && !usedCurrent.has(n.id)) removed.add(n.id);
    }
    const idMap = new Map(phoneToCurrent);
    const taken = new Set([...currentList.map(n => String(n.id)), ROOT_ID, HOME_FOLDER_ID,
      OTHER_FOLDER_ID, MOBILE_FOLDER_ID, '0', '1', '2', '3']);
    const newByKey = new Map();
    let seq = 0;
    for (const p of phoneList) {
      const pk = ph.keys.get(p.id);
      if (!pk || idMap.has(p.id) || blockedNode(p, ph)) continue;
      if (newByKey.has(pk)) { idMap.set(p.id, newByKey.get(pk)); continue; }
      let id = String(p.id);
      while (taken.has(id)) id = '__bridge_' + kind + '_' + (++seq);
      taken.add(id);
      idMap.set(p.id, id);
      newByKey.set(pk, id);
    }
    const rootsBySource = new Map(currentList.filter(n => n.isFolder && !cur.keys.has(n.id))
      .map(n => [n.source, n.id]));
    function parentIdFor(p) {
      if (idMap.has(p.parentId)) return idMap.get(p.parentId);
      const root = (ph.keys.get(p.id) || '').split('/')[0];
      const source = root.slice('ROOT:'.length);
      if (rootsBySource.has(source)) return rootsBySource.get(source);
      return { home: HOME_FOLDER_ID, other: OTHER_FOLDER_ID, mobile: MOBILE_FOLDER_ID }[source] || ROOT_ID;
    }

    const resultById = new Map(currentList.map(n => [n.id, { ...n }]));
    const incomingIds = [];
    for (const p of phoneList) {
      const id = idMap.get(p.id);
      if (!id || blockedNode(p, ph)) continue;
      if (!incomingIds.includes(id)) incomingIds.push(id);
      const existing = resultById.get(id);
      if (!existing) {
        resultById.set(id, { ...p, id, parentId: parentIdFor(p) });
        continue;
      }
      const oldPk = cur.keys.get(id);
      const newPk = ph.keys.get(p.id);
      if (oldPk !== newPk) {
        existing.parentId = parentIdFor(p);
        existing.title = p.title;
        if (!p.isFolder) existing.url = p.url;
      } else if (previous) {
        const old = previous.byId.get(p.id) || previous.byKey.get(newPk);
        // Keep local edits in a true conflict; adopt proved phone-only edits.
        for (const key of p.isFolder ? ['title'] : ['title', 'url']) {
          if (old && p[key] !== old[key] && existing[key] === old[key]) existing[key] = p[key];
        }
      }
      for (const key of ['favicon', 'color', 'customIcon']) if (!existing[key] && p[key]) existing[key] = p[key];
      if (oldPk !== newPk || existing.title !== cur.byId.get(id).title || existing.url !== cur.byId.get(id).url) {
        changes.pathRemaps.push({ id, oldPk, newPk, title: existing.title, parentId: existing.parentId,
          ...(existing.url ? { url: existing.url } : {}) });
      }
    }
    // A concurrently added local child cannot be orphaned by deleting its old
    // parent. Preserve that parent unless the child was proved to move elsewhere.
    for (const n of resultById.values()) {
      if (removed.has(n.id) || blockedNode(n, cur)) continue;
      let parent = resultById.get(n.parentId);
      const seen = new Set();
      while (parent && !seen.has(parent.id)) {
        seen.add(parent.id);
        removed.delete(parent.id);
        parent = resultById.get(parent.parentId);
      }
    }
    for (const id of removed) {
      changes.deletedIds.push(id);
      changes.deletedPathKeys.push(cur.keys.get(id));
      resultById.delete(id);
    }
    let result = [...resultById.values()].filter(n => !blockedNode(n, cur));
    if (preferPhoneOrder) {
      const ranked = new Map(result.map(n => [n.id, n]));
      result = [...incomingIds.filter(id => ranked.has(id)).map(id => ranked.get(id)),
        ...result.filter(n => !incomingIds.includes(n.id))];
      const counters = new Map();
      for (const n of result) {
        n._index = counters.get(n.parentId) || 0;
        counters.set(n.parentId, n._index + 1);
      }
    }
    MiniSync.utils.fillMissingSiblingIndex(result);
    changes.list = result;
    const visible = list => list.map(n => [n.id, n.parentId, n.title, n.url, n._index]);
    changes.changed = JSON.stringify(visible(currentList)) !== JSON.stringify(visible(result));
    changes.snapshotUpdates = makeSnapshot(storageKey, owner, phoneList, state);
    return changes;
  }

  return { merge, snapshotUpdates, versionKey };
}

// Berry 文件字段兼容：新版用 data，旧版/外部格式可能用 bookmarks
function getBerryList(berryData) {
  if (!berryData) return null;
  if (Array.isArray(berryData.data)) return berryData.data;
  if (Array.isArray(berryData.bookmarks)) return berryData.bookmarks;
  return null;
}

function validateBerryList(list) {
  if (!Array.isArray(list)) throw new Error('Berry 文件格式无效');
  const ids = new Set();
  const byId = new Map();
  for (const node of list) {
    if (!node || typeof node.id !== 'string' || !node.id || ids.has(node.id) ||
        typeof node.title !== 'string' || typeof node.parentId !== 'string' ||
        typeof node.isFolder !== 'boolean' || (!node.isFolder && typeof node.url !== 'string')) {
      throw new Error('Berry 书签节点格式无效');
    }
    ids.add(node.id);
    byId.set(node.id, node);
  }
  // ★ 环形父链必须当场拒绝：computePathKeys 沿父链会退化成 ROOT:cyclic，
  //   而「路径集里一个都没有」会被删除检测读成「手机端删光了」——
  //   受控输入即可触发本机与云端书签被整批删除（审计 2026-10-11 复现）。
  //   格式非法不是空快照：这里抛错让读取判为不完整，删除检测与写回一并停下。
  for (const node of list) {
    const seen = new Set([node.id]);
    let parentId = node.parentId;
    while (parentId && parentId !== ROOT_ID) {
      if (seen.has(parentId)) throw new Error('Berry 书签节点包含环形父链');
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break; // 悬空父：不是环，交给 pathKey 兜底处理
      parentId = parent.parentId;
    }
  }
}

// ========== Berry 桥接：将变更 patch 进 bookmarks.json ==========
// 以 Berry 数据为基底，只做节点增删，保留 Berry 的 favicon/color/customIcon
// 关键：新增节点的 parentId 需要从 Chrome id 映射到 Berry id（通过 pathKey 桥接）
async function patchBerryFile(mergedList) {
  const berryData = await downloadBerryBookmarks();
  if (berryData && !getBerryList(berryData)) {
    throw new Error('Berry 文件格式无法识别（无 data/bookmarks 数组）');
  }
  // 缺失文件才按空列表创建；损坏文件不能被空集合覆盖。
  const berryList = getBerryList(berryData) || [];
  validateBerryList(berryList);

  // 建立 Berry 的 pathKey → 节点映射
  const berryPathKeys = computePathKeys(berryList);
  const berryByPathKey = new Map();
  for (const n of berryList) {
    const pk = berryPathKeys.get(n.id);
    if (pk) berryByPathKey.set(pk, n);
  }

  // 建立合并结果的 pathKey 映射
  const mergedPathKeys = computePathKeys(mergedList);

  // 建立 merged id → Berry id 的映射（通过 pathKey 桥接）
  // 用途：新增节点的 parentId 是 Chrome 的 id，需要映射成 Berry 已有的 id
  const mergedIdToBerryId = new Map();
  for (const n of mergedList) {
    // 与写回逻辑一致：Berry 主页节点不参与映射，避免其他节点 parentId 误指向主页
    if (n.id === HOME_FOLDER_ID || n.source === 'home' || n.parentId === HOME_FOLDER_ID) continue;
    const pk = mergedPathKeys.get(n.id);
    if (!pk) continue;
    const berryNode = berryByPathKey.get(pk);
    if (berryNode) {
      mergedIdToBerryId.set(n.id, berryNode.id);
    }
  }

  // ===== 系统根容器 → Berry 虚拟容器映射 =====
  // Chrome 的「其他书签/移动书签」根容器在 computePathKeys 中被跳过（无 pathKey），
  // 上面的循环不会为其建立映射，导致 other/mobile 子节点写回时 parentId 指向
  // Chrome 根容器 id（如 '2'/'3'）而在 Berry 文件中悬空成孤儿。
  // 这里按「parentId=ROOT + 标题匹配系统根 + source 对应」识别根容器，
  // 映射到 Berry 虚拟容器 id（__other_folder__ / __mobile_folder__），与 Berry 端
  // 「移动收藏夹」的挂载机制对称。注意排除 HOME_FOLDER_ID（Berry主页容器 source 也是 other）。
  for (const n of mergedList) {
    if (n.parentId !== ROOT_ID || !n.isFolder || n.id === HOME_FOLDER_ID) continue;
    const title = (n.title || '').toLowerCase();
    if (n.source === 'other' && FOLDER_TITLES.otherBookmarks.some(t => t.toLowerCase() === title)) {
      mergedIdToBerryId.set(n.id, OTHER_FOLDER_ID);
    } else if (n.source === 'mobile' && FOLDER_TITLES.mobileBookmarks.some(t => t.toLowerCase() === title)) {
      mergedIdToBerryId.set(n.id, MOBILE_FOLDER_ID);
    }
  }

  // 为新增节点分配 Berry 风格的 id（纯数字，取最大值+1）
  // ⚠️ 下界必须是 3（即新 id 从 4 起）：Chromium 系统根容器 id 恒为 '1'/'2'/'3'
  //   （书签栏/其他书签/移动设备），而新建文件时 berryList 为空、最大值取不到它们。
  //   从 1 起会撞号——书签栏第一个书签拿到 id='1' 且 parentId='1' 自我引用，
  //   下一轮 computePathKeys 沿父链立即回到自身、判定 'ROOT:cyclic' 永远匹配不上，
  //   于是每次同步都重新分配一个新 id（手机端 favicon/顺序随之丢失）。
  let maxBerryNumId = 3;
  for (const n of berryList) {
    const num = parseInt(n.id, 10);
    if (!isNaN(num) && num > maxBerryNumId) maxBerryNumId = num;
  }
  let newIdCounter = maxBerryNumId;

  // 构建最终 Berry 输出列表
  const finalBerryList = [];
  const newNodeIdMap = new Map(); // merged id → 新分配的 Berry id（给子节点的 parentId 用）
  let keptCount = 0, addedCount = 0, skippedHome = 0, skippedNoPK = 0;

  for (const n of mergedList) {
    // ★ 主页（home）节点正常写入 __home_folder__ 区：实测 Berry 手机端上传的
    //   bookmarks.json 原生含 __home_folder__ 容器与主页书签（含 favicon），
    //   主页区是 Berry 文件的一等公民，必须双向同步（早期跳过主页导致桌面主页
    //   变更永远无法到达手机端）。
    // HOME 容器本体（id=__home_folder__）：标题「Berry主页」命中系统名 → 无 pathKey，
    // 但它是 Berry 文件主页区的挂载点（手机端原版文件必含），必须写入：
    // 保留手机端原对象字段（favicon/color 等），标题随桌面；缺失时按规范结构新建。
    if (n.id === HOME_FOLDER_ID) {
      const prevHomeContainer = (berryList || []).find(x => x && x.id === HOME_FOLDER_ID) || null;
      finalBerryList.push(prevHomeContainer
        ? { ...prevHomeContainer, title: n.title || prevHomeContainer.title, isFolder: true, parentId: ROOT_ID }
        : { id: HOME_FOLDER_ID, title: n.title || '主页文件夹', url: '', isFolder: true, parentId: ROOT_ID, color: '', favicon: '', customIcon: '', addedAt: Date.now() });
      continue;
    }
    const pk = mergedPathKeys.get(n.id);
    if (!pk) {
      // 无指纹节点诊断：已知容器静音（Chrome 标准 '1'/'2'/'3'、挂虚拟根下的根容器——
      // 如 Edge 的「其他收藏夹」id=195）；其余真实数据节点打印便于发现漏同步。
      if (!['1', '2', '3'].includes(String(n.id)) && !(n.isFolder && n.parentId === ROOT_ID)) {
        console.log(`[sync] 🍓 Berry 跳过无指纹节点: "${n.title || '(无标题)'}" (id=${n.id}, parentId=${n.parentId}, source=${n.source || '-'})`);
      }
      skippedNoPK++;
      continue;
    }
    const berryNode = berryByPathKey.get(pk);
    if (berryNode) {
      // 已有节点：保留 Berry 原有的 id/parentId/favicon/color/customIcon
      keptCount++;
      finalBerryList.push({
        ...berryNode,
        title: n.title || berryNode.title,
        url: n.url || berryNode.url,
        isFolder: n.isFolder,
        source: n.source
      });
    } else {
      // 新增节点：分配新 Berry id，parentId 映射到 Berry 体系
      addedCount++;
      let newBerryId;
      if (n.id === HOME_FOLDER_ID) {
        // HOME 容器首次写入：保留规范虚拟 id（不分配数字 id），Berry 端按此 id 识别主页区
        newBerryId = HOME_FOLDER_ID;
      } else {
        newIdCounter++;
        newBerryId = String(newIdCounter);
      }
      newNodeIdMap.set(n.id, newBerryId);
      mergedIdToBerryId.set(n.id, newBerryId);

      // 映射 parentId
      let mappedParentId = n.parentId;
      if (mergedIdToBerryId.has(n.parentId)) {
        mappedParentId = mergedIdToBerryId.get(n.parentId);
      } else if (newNodeIdMap.has(n.parentId)) {
        mappedParentId = newNodeIdMap.get(n.parentId);
      }
      // 特殊 id 保持不变
      if (n.parentId === ROOT_ID || n.parentId === HOME_FOLDER_ID || n.parentId === MOBILE_FOLDER_ID || n.parentId === OTHER_FOLDER_ID) {
        mappedParentId = n.parentId;
      }

      finalBerryList.push({
        ...n,
        id: newBerryId,
        parentId: mappedParentId
      });
    }
  }

  // 上传更新后的 Berry 文件（使用 Berry 端格式 schemaVersion:2）
  const patchDeviceId = await getDeviceId();
  const updatedBerryData = {
    schemaVersion: 2,
    deviceId: patchDeviceId,
    timestamp: Date.now(),
    data: finalBerryList
  };
  await uploadBerryBookmarks(updatedBerryData);
  const snapshotUpdates = await MiniSync.berry.bridgeIdentity.snapshotUpdates('berry_pathkey_snapshot',
    await MiniSync.utils.bridgeResourceUrl('berry'), finalBerryList);
  console.log(`[sync] 🍓 Berry 回写完成: ${zoneSummary(finalBerryList)}`);
  return { status: 'success', snapshotUpdates };
}

// 从 Berry 文件读取变更并合并：继承图标 + 合并新增节点 + 决定顺序
async function mergeBerryData(currentList, preferLocalOrder = false, tombstoneKeys = null) {
  const result = await mergeBerryDataWithChanges(currentList, preferLocalOrder, tombstoneKeys);
  if (result.complete && result.snapshotUpdates) await chrome.storage.local.set(result.snapshotUpdates);
  return result.list;
}

async function mergeBerryDataWithChanges(currentList, preferLocalOrder = false, tombstoneKeys = null, bridgeContext = null) {
  try {
    const berryData = await downloadBerryBookmarks();
    if (!berryData) throw new Error('Berry 文件不存在');
    const berryList = getBerryList(berryData);
    validateBerryList(berryList);
    const phoneList = berryList.map(n => {
      if (n.source) return { ...n };
      const source = n.parentId === HOME_FOLDER_ID ? 'home' : n.parentId === MOBILE_FOLDER_ID ? 'mobile'
        : n.parentId === OTHER_FOLDER_ID ? 'other' : n.parentId === ROOT_ID ? 'bar' : '';
      return { ...n, source };
    });
    const owner = await MiniSync.utils.bridgeResourceUrl('berry');
    const state = await MiniSync.utils.readLocalKeys([STORAGE_KEYS.CLOUD_LAST_MODIFIED]);
    const changes = await MiniSync.berry.bridgeIdentity.merge({ kind: 'berry', storageKey: 'berry_pathkey_snapshot',
      owner, currentList, phoneList, tombstoneKeys, context: bridgeContext,
      preferPhoneOrder: !preferLocalOrder && (berryData.lastModified || 0) > (state[STORAGE_KEYS.CLOUD_LAST_MODIFIED] || 0) });
    console.log(`[sync] Berry 处理完成: ${zoneSummary(changes.list)}`);
    return changes;
  } catch (e) {
    return { list: currentList, deletedIds: [], deletedPathKeys: [], complete: false, errors: [e.message] };
  }
}

// 挂载到 MiniSync，供 sync-orchestrator 在合并阶段调用
MiniSync.berry = {
  bridgeIdentity: createBridgeIdentity(),
  mergeBerryData,
  mergeBerryDataWithChanges,
  patchBerryFile
};
