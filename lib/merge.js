// lib/merge.js — 书签合并引擎
// C 路径：本地 Chrome 树 + 远程 XBEL → 合并结果
// 核心算法：pathKey 指纹匹配 + 三向合并 + 墓碑机制

MiniSync.merger = (function() {

/**
 * 纯函数：按 pathKey 将本地/远程节点分类为 双端存在 / 仅本地 / 仅远程 / 墓碑删除。
 * 抽离自 mergeBookmarks 的「5. 分类节点」段，便于单测且不依赖 chrome API。
 * @param {Map<string,string>} localPKs  localId -> pathKey（来自 computeJsonPathKeys）
 * @param {Map<string,string>} remotePKs remoteId -> pathKey
 * @param {Set<string>} tombstoneKeys    墓碑中的 pathKey 集合
 * @returns {{bothPresent:Array,localOnly:Array,remoteOnly:Array,localDeleted:Array,remoteDeleted:Array}}
 */
function classifyNodes(localPKs, remotePKs, tombstoneKeys) {
  const localPKSet = new Set(localPKs.values());
  const remotePKSet = new Set(remotePKs.values());
  const bothPresent = [];
  const localOnly = [];
  const remoteOnly = [];
  const localDeleted = [];
  const remoteDeleted = [];

  for (const [id, pk] of localPKs) {
    if (tombstoneKeys.has(pk)) localDeleted.push(id);
    else if (remotePKSet.has(pk)) bothPresent.push({ localId: id, pk });
    else localOnly.push(id);
  }
  for (const [id, pk] of remotePKs) {
    if (tombstoneKeys.has(pk)) remoteDeleted.push(id);
    else if (!localPKSet.has(pk)) remoteOnly.push(id);
  }
  return { bothPresent, localOnly, remoteOnly, localDeleted, remoteDeleted };
}

/**
 * 判断节点是否为 Chrome/Edge 内置根容器（书签栏/其他收藏夹/移动书签）
 */
function isRootContainer(n) {
  if (!n || n.parentId !== ROOT_ID) return false;
  const id = String(n.id);
  if (['1', '2', '3'].includes(id)) return true;
  const title = (n.title || '').toLowerCase();
  const rootTitles = (FOLDER_TITLES.bookmarkBar || [])
    .concat(FOLDER_TITLES.otherBookmarks || [])
    .concat(FOLDER_TITLES.mobileBookmarks || [])
    .map(t => t.toLowerCase());
  return rootTitles.includes(title);
}

/**
 * 从 Chrome 书签树提取扁平列表
 */
function chromeTreeToList(tree) {
  const root = tree && tree[0];
  if (!root || !root.children) return [];

  const list = [];
  let indexCounter = 0;

  const push = (node, parentId, source, extra) => {
    list.push(Object.assign({
      id: String(node.id),
      title: node.title || '',
      url: node.url || '',
      isFolder: !node.url,
      parentId: String(parentId),
      source: source,
      addedAt: node.dateAdded || Date.now(),
      color: null,
      favicon: null,
      customIcon: null,
      _index: indexCounter++
    }, extra || {}));
  };
  function walkPlain(node, parentId, source) {
    push(node, parentId, source);
    if (!node.url) for (const c of (node.children || [])) walkPlain(c, node.id, source);
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

  // ===== 同步桶：本机唯一参与同步的文件夹，见 utils.resolveSyncBucket =====
  // 桶的子节点全集 = 同步内容。桶以外的节点（其他收藏夹里的其它文件夹、移动收藏夹、
  // 根下其它文件夹）**不进列表** ⇒ 既不参与合并比对，也不会被上传/落盘/删除。
  // 这是「其他收藏夹不要备份」与「书签不许乱跑」的结构性保证：不再靠猜。
  // 桶自身标 zoneRoot ⇒ pathKey 不产生路径段，桶内内容统一归 ROOT:bar；
  // 于是手机（容器 F0）与桌面（书签栏，或其他收藏夹/根目录 镜像）的同一批书签
  // 得到同一个指纹，跨端合并是固定点。
  const bucket = (MiniSync.utils && MiniSync.utils.resolveSyncBucket)
    ? MiniSync.utils.resolveSyncBucket(root.children, {
        bucketId: MiniSync.utils.getSyncBucketId ? MiniSync.utils.getSyncBucketId() : '',
        declaredWrapper: MiniSync.utils.getDeclaredFlatRootContainer ? MiniSync.utils.getDeclaredFlatRootContainer() : ''
      })
    : null;

  // 桶内「同名包装」（旧版合并 bug 遗留的 根目录/根目录）是透明层：不产生路径段、
  // 子节点上提一级。判据**不跨普通文件夹**：用户自己在「学习」下建的同名文件夹原样
  // 保留 —— 与云端解析端（xbelToJson）同一条规则，两端必须对称，否则来回搬运。
  const bucketTitle = bucket ? String(bucket.title || '') : '';
  const isWrapperHere = (node, eligible) => !!eligible && bucketTitle !== ''
    && !node.url && String(node.title || '') === bucketTitle;

  // ===== Berry 主页真实节点（先解析，桶遍历要用）=====
  // 它可能挂在根下，也可能是「其他收藏夹」的直接子文件夹。必须在桶遍历**之前**解析出来：
  // 桌面端桶 = 其他收藏夹/根目录 镜像时，home 容器是桶的直接子节点，桶遍历会把它当成
  // 普通文件夹收进列表（source='bar'），而下面 home 段又按虚拟 id HOME_FOLDER_ID 收一次
  // ⇒ 同一个文件夹进列表两次。普通的那一份会被写进云端（空壳「移动端主页」每次同步都回来），
  // 且与 home 段争抢同一批子节点。这里让桶遍历跳过它，列表里只剩虚拟 id 那一份。
  let berryHomeNode = null;
  for (const top of root.children) {
    if (!top || top.url) continue;
    if (isBerryHomeTitle(top.title) && (!bucket || String(top.id) !== String(bucket.id))) {
      berryHomeNode = top;
      break;
    }
    const hit = (top.children || []).find(c => c && !c.url && isBerryHomeTitle(c.title)
      && (!bucket || String(c.id) !== String(bucket.id)));
    if (hit) { berryHomeNode = hit; break; }
  }
  const homeNodeId = berryHomeNode ? String(berryHomeNode.id) : null;

  function walkBucket(userNode, parentId, wrapperEligible) {
    if (!userNode) return;
    if (homeNodeId && String(userNode.id) === homeNodeId) return; // ★ 见上：home 容器只由 home 段收
    if (isWrapperHere(userNode, wrapperEligible)) {
      push(userNode, parentId, 'bar', { zoneRoot: true });
      for (const child of (userNode.children || [])) walkBucket(child, userNode.id, true);
      return;
    }
    push(userNode, parentId, 'bar');
    if (!userNode.url) {
      for (const child of (userNode.children || [])) walkBucket(child, userNode.id, false);
    }
  }

  const bucketNode = bucket ? findFolder(root.children, bucket.id) : null;
  if (bucketNode) {
    push(bucketNode, ROOT_ID, 'bar', { zoneRoot: true });
    for (const child of (bucketNode.children || [])) walkBucket(child, bucketNode.id, true);
  }

  // ===== Berry 主页：独立功能（自家 home 区），不属于同步桶，照旧携带 =====
  // 节点已在上面解析（桶遍历要跳过它）。虚拟 id HOME_FOLDER_ID 与云端解析端一致，
  // 使 pathKey 前缀为 ROOT:home。
  if (berryHomeNode) {
    list.push({
      id: HOME_FOLDER_ID, title: berryHomeNode.title || '', url: '', isFolder: true,
      parentId: ROOT_ID, source: 'other', addedAt: berryHomeNode.dateAdded || Date.now(),
      color: null, favicon: null, customIcon: null, _index: indexCounter++
    });
    for (const child of (berryHomeNode.children || [])) walkPlain(child, HOME_FOLDER_ID, 'home');
  }

  return list;
}

/**
 * 核心合并函数：本地树 + 远程数据 → 合并统计
 */
async function mergeBookmarks(localTree, remoteData, webdavConfig) {
  // 1. 提取本地扁平列表
  const localList = chromeTreeToList(localTree);

  // 3. 计算 pathKey 映射（统一使用 xbelPath，避免本地/远程口径不一致）
  //    storageData 提前到这里取：下面的「云端为空」分支也要用快照 + 墓碑判删除。
  const storageData = await new Promise(resolve => chrome.storage.local.get(
    ['sync_tombstones', STORAGE_KEYS.CLOUD_LAST_MODIFIED, 'sync_move_intents', STORAGE_KEYS.SNAPSHOTS], resolve
  ));

  // A present remote response must have been parsed successfully. Never interpret it as first sync.
  if (remoteData != null && (!remoteData || !Array.isArray(remoteData.bookmarks))) {
    throw new Error('Invalid remote XBEL data');
  }
  // 2. 云端没有任何书签节点：可能是「首次同步」，也可能是「对端把同步桶删空」后的结果。
  if (!remoteData || !remoteData.bookmarks || remoteData.bookmarks.length === 0) {
    // ★ 空云端 ≠ 首次同步。
    //   ① 本机墓碑必须随之上云：云端此刻空空如也，可能正是别的端「删到一条不剩」的结果，
    //      丢掉墓碑会让下一台设备把自己的副本推回去。
    //   ② 更关键：**墓碑点名的本机节点必须按删除处理**，不能像历史实现那样把本机全部节点
    //      原样重传上云 —— 否则「A 端把桶删空 → B 端一合并就把它们全推回去」，
    //      删除被反转成复活，两端来回拉扯。
    //   这里用与常规路径**同一套**墓碑视图（remoteList 为空）判出 localDeletedIds：
    //   返回给调用方在本机删掉（走它既有的 prune+落盘逻辑），
    //   写回云端的树也先按同一批 id 裁剪，云端因此保持「空」而不是被复活内容填满。
    const ownTombstones = storageData.sync_tombstones || [];
    const remoteTs = (remoteData && Array.isArray(remoteData.tombstones)) ? remoteData.tombstones : [];
    const mergedTs = MiniSync.tombstone.mergeTombstoneSources(ownTombstones, remoteTs);
    const view = MiniSync.tombstone.buildTombstoneView({
      localTombstones: ownTombstones,
      remoteTombstones: remoteTs,
      localList,
      remoteList: [],
      myDeviceId: await MiniSync.storage.getDeviceId(),
      prevSnapshotList: (storageData[STORAGE_KEYS.SNAPSHOTS] && storageData[STORAGE_KEYS.SNAPSHOTS].localTree) || []
    });
    const localDeletedIds = [];
    for (const n of localList) {
      const pk = view.localPKs.get(n.id);
      if (pk && view.tombstoneKeys.has(pk)) localDeletedIds.push(n.id);
    }
    // The orchestrator owns the conditional cloud write, after local import succeeds.
    await new Promise(resolve =>
      chrome.storage.local.set({ sync_tombstones: mergedTs }, resolve)
    );
    // 云端文件里还没有的墓碑（纯删除场景）仍需随这次写回上云，否则其他端永远学不到
    const remoteTsKeys = new Set(remoteTs
      .map(t => (typeof t === 'string' ? t : (t && t.key) || ''))
      .filter(Boolean));
    let pendingTombstones = 0;
    for (const pk of view.tombstoneKeys) if (!remoteTsKeys.has(pk)) pendingTombstones++;
    return {
      stats: {
        added: localList.length - localDeletedIds.length,
        updated: 0, skipped: 0, deleted: localDeletedIds.length
      },
      localUpdated: false,
      firstSync: remoteData == null,
      needWriteBack: true,
      requiresWriteBack: true,
      remoteUpdated: true,
      pendingTombstones,
      orderChanged: false,
      contentUpdatedIds: [],
      localOnlyIds: [],
      remoteOnlyIds: [],
      localDeletedIds,
      adoptedLocalOnlyIds: [],
      renamePairs: [],
      tombstones: mergedTs
    };
  }

  const localPKs = MiniSync.xbelPath.computeJsonPathKeys(localList);
  const remotePKs = MiniSync.xbelPath.computeJsonPathKeys(remoteData.bookmarks);

  // 4. 墓碑视图：**上传 / 下载 / 合并三个入口共用同一份口径**（model/tombstone.js
  //    buildTombstoneView）。历史实现把这段逻辑内联在这里，于是「上传」和「下载」
  //    各按各的规则处理删除 —— 同一个删除在不同按钮上表现不同（实测：手机删的书签，
  //    桌面点「合并」会删、点「上传」会复活）。
  //
  //    视图内部（顺序即语义，改动等于改变删除语义）：
  //      ① 本地 ∪ 云端墓碑，同 key 取 deletedAt 较新者
  //      ② 墓碑保留到所有设备确认删除；当前没有确认协议，不按 TTL 回收
  //      ③ 假墓碑清理：本端产生、节点仍在本地树里的（重命名残留）丢弃；他端产生的保留
  //      ④ 两端都存在的节点，墓碑作废（确实活着）
  //    清理基准只能用「两端并集视图」，绝不能用本地 pk 单独判：
  //      云端存在 → 节点被重新加回，墓碑该清；
  //      本地存在、云端不存在而命中墓碑 → 正是「对端删过、本端要跟上」的 localDeleted。
  const view = MiniSync.tombstone.buildTombstoneView({
    localTombstones: storageData.sync_tombstones || [],
    remoteTombstones: (remoteData && Array.isArray(remoteData.tombstones)) ? remoteData.tombstones : [],
    localList,
    remoteList: Array.isArray(remoteData.bookmarks) ? remoteData.bookmarks : [],
    myDeviceId: await MiniSync.storage.getDeviceId(),
    // 上次同步快照：把「本端在上一轮之后新建/挪回来的节点」与「对端已删、本端还没删的残留」
    // 分开（见 cleanFakeTombstones 第 4 个参数）。缺了它，删过又加回来的书签会被永久拉黑。
    prevSnapshotList: (storageData[STORAGE_KEYS.SNAPSHOTS] && storageData[STORAGE_KEYS.SNAPSHOTS].localTree) || []
  });
  let tombstones = view.tombstones;
  const tombstoneKeys = view.tombstoneKeys;
  const localPKSet = view.localPKSet;
  const remotePKSet = view.remotePKSet;
  const bothPresentPKs = view.bothPresentPKs;
  // 需"收养"的本地孤立节点集合（重命名场景下，本地旧名文件夹下新增的节点要迁移到对端新名）
  const adoptedLocalOnly = new Set();
  // ★ 移动方向判定依据「移动意图表」（onMoved 时写入 sync_move_intents）：
  //   本端近期挪过该节点 → 本端是发起方，本地即最新状态，绝不迁移；
  //   无意图 → 本端是接收方，生成 renamePairs 迁移跟随云端。
  //   显式意图不依赖跨端时钟（服务器时间/本机时间/各端时钟偏差曾导致接收端被
  //   误判为发起端，表现为「挪动书签后另一端合并不跟随」）。
  const moveIntents = storageData.sync_move_intents || {};
  const snapTreeForRename = (storageData[STORAGE_KEYS.SNAPSHOTS] && storageData[STORAGE_KEYS.SNAPSHOTS].localTree) || [];
  const baselinePKs = new Set(MiniSync.xbelPath.computeJsonPathKeys(snapTreeForRename).values());
  // TTL 需覆盖「移动后到下一次合并」的正常窗口（onMoved 防抖 3s 已触发即时合并，
  // 这里兜底自动同步场景：默认间隔 30 分钟，取 65 分钟覆盖 30/60 分钟档位 + 防抖延迟）。
  // 过短的话，本端挪动后等到下个周期才合并，意图已过期 → 被判为「接收方」迁回旧位置，
  // 移动被回滚。加长无副作用：本端没挪过就根本没有意图记录，不影响「接收方跟随云端」。
  const MOVE_INTENT_TTL = 65 * 60 * 1000;
  // 5. 分类节点（抽离为纯函数 classifyNodes，便于单测）
  const renamePairs = [];     // { oldPk, newPk }：识别出的「重命名 / 文件夹移动」对，供 orchestrator 落盘迁移
  const localRenames = [];    // { id, title }：本端旧名节点要「就地改名」（保 id、保子树）
  const {
    bothPresent,
    localOnly,
    remoteOnly,
    localDeleted,
    remoteDeleted,
  } = classifyNodes(localPKs, remotePKs, tombstoneKeys);

  // ★ 过时他端墓碑放行：若「拦截 remoteOnly 的墓碑」正是云端文件上传者自己产生的，
  //   且墓碑时间早于云端文件修改时间——说明上传者是带着这条旧墓碑、仍把该节点
  //   重新上传上云的（并未真正删除它，墓碑过时，多为历史 bug 残留或本端复活未
  //   同步干净），此时应放行该节点追加落盘，而非拦截。
  //   实测场景：Edge 端残留 A/B 两条路径的墓碑且书签在 Edge 端活着并回写云端 →
  //   Chrome 合并时旧位置命中墓碑被删 + 新位置命中墓碑被拦 → 书签凭空消失。
  // ★ 时间判据必不可少：仅凭「墓碑作者 == 云端上传者」放行，会把「上传者自己
  //   删除自己上传的书签」（最常见操作！）的新墓碑也放行复活——上传文件是删除
  //   前生成的，节点自然"仍存在"于其中。必须比较墓碑 deletedAt 与云端文件
  //   lastModified：墓碑更新于云端文件之后 = 上传后的新删除 = 真删除，不放行。
  if (remoteData.deviceId && remoteDeleted.length > 0) {
    const cloudLastMs = remoteData.lastModified || 0;
    const tombstoneInfoByPk = new Map();
    for (const t of tombstones) {
      const pk = typeof t === 'string' ? t : (t && t.key);
      if (pk) {
        tombstoneInfoByPk.set(pk, {
          dev: typeof t === 'string' ? '' : (t.deviceId || ''),
          at: typeof t === 'string' ? 0 : (t.deletedAt || 0),
        });
      }
    }
    for (let i = remoteDeleted.length - 1; i >= 0; i--) {
      const rid = remoteDeleted[i];
      const pk = remotePKs.get(rid);
      const info = pk ? tombstoneInfoByPk.get(pk) : null;
      if (info && info.dev && info.dev === remoteData.deviceId
        && info.at > 0 && cloudLastMs > 0 && info.at < cloudLastMs) {
        remoteOnly.push(rid);
        remoteDeleted.splice(i, 1);
      }
    }
  }

  // 5f. 文件夹「移动 / 跨路径同名」识别（修复 Bug 2：拖动文件夹跨路径被误判为删除+新建）
  //     当 localOnly 文件夹在远程有「同名」的文件夹时，无论父路径是否相同，都视为同一节点：
  //       - 父路径相同：纯属 pathKey 口径不一致的兜底（防御，本不该发生）
  //       - 父路径不同：文件夹被拖动到新位置 → 识别为「移动」，而非「本地删除+云端新建」
  //     匹配成功即移入 bothPresent（不再删本地、不再建云端），并把 (localPk→remotePk)
  //     加入 renamePairs，复用重命名迁移机制让子树随父前缀整体迁移到新位置落盘。
  //     关键：移动/重命名都是「保留新位置」，绝不可写墓碑丢弃旧位置，否则旧子树会被删。
  const fuzzyMatchedLocalIds = new Set();   // 从 localOnly 移除的 id
  const fuzzyMatchedRemoteIds = new Set();  // 从 remoteOnly 移除的 id
  const moveMatchedPKs = new Set();         // 移动/匹配命中的 pk（用于从墓碑候选剔除）
  {
    // 构建本地 id→node 和 远程 id→node 的快速查找
    const localById = new Map();
    for (const n of localList) localById.set(n.id, n);
    const remoteById = new Map();
    for (const n of remoteData.bookmarks) remoteById.set(String(n.id), n);

    // 移动识别候选：本地 localOnly（云端无同 pk）以及 localDeleted（命中墓碑）中的文件夹。
    // 关键修复：拖动文件夹时源端会为「旧位置」记墓碑，目标端合并时本地同 pk 文件夹会命中该墓碑、
    // 被误判为「云端已删除」而整棵删除。若云端 remoteOnly 存在同标题文件夹（无论父路径），实为移动，
    // 必须撤销误删（从 localDeleted 移除）并写入 renamePairs 让落盘把子树迁移到新位置。
    const moveCandidates = [...localOnly, ...localDeleted];
    for (let i = moveCandidates.length - 1; i >= 0; i--) {
      const id = moveCandidates[i];
      const ln = localById.get(id);
      if (!ln) continue; // 文件夹与书签都参与移动识别

      // 在 remoteOnly（云端独有）以及 remoteDeleted（云端被墓碑标记，实为移动旧名）中
      // 搜索同一节点（不限父路径）。历史残留墓碑会让移动后的节点落入 remoteDeleted，
      // 导致只搜 remoteOnly 时匹配不到、本地被误删（如「测试5」反复测试残留墓碑）。
      // ★ 书签也参与：跨文件夹挪动书签时 pk 变化，旧位置落入 remoteOnly——若不识别为
      //   移动，旧位置会被「云端独有追加」复活（表现为「书签挪走后又跑回原处」）。
      const remoteMoveCandidates = [...remoteOnly, ...remoteDeleted];
      for (let j = remoteMoveCandidates.length - 1; j >= 0; j--) {
        const rid = remoteMoveCandidates[j];
        const rn = remoteById.get(rid);
        if (!rn) continue;
        // 类型一致；文件夹按标题、书签按标题+URL 完全一致。
        // ★ 不比较 addedAt：同一书签在两端的 addedAt 天然不一致（副本由各端同步创建，
        //   落盘 create 时机不同），加此条件会让跨端移动识别永远失败（实测表现为
        //   「一端挪动书签后，另一端合并不跟随、旧位置保留 + 新位置重复」）。
        //   取舍：同名同 URL 的合法两处副本会被识别为移动合并成一份——移动正确性优先。
        if (!!rn.isFolder !== !!ln.isFolder) continue;
        if (rn.title !== ln.title) continue; // 标题必须完全一致
        if (!ln.isFolder && (rn.url || '') !== (ln.url || '')) continue;

        const localPk = localPKs.get(id);
        const remotePk = remotePKs.get(rid);
        if (!localPk || !remotePk) continue;
        // Cross-path equality is not identity: two folders may hold independent
        // bookmarks with the same title and URL. Require evidence of an older path.
        if (!baselinePKs.has(localPk) && !baselinePKs.has(remotePk)
          && !tombstoneKeys.has(localPk) && !tombstoneKeys.has(remotePk)
          && !moveIntents[localPk] && !moveIntents[remotePk]) continue;

        // 匹配成功！视为同一节点的移动/重定位，加入 bothPresent 并撤销两端误删
        bothPresent.push({ localId: id, pk: localPk });
        fuzzyMatchedLocalIds.add(id);
        fuzzyMatchedRemoteIds.add(rid);
        moveMatchedPKs.add(localPk);
        moveMatchedPKs.add(remotePk);
        // 从 localOnly / localDeleted 移除，避免本端被当作「需删除」或「云端独有重建」
        const li = localOnly.indexOf(id); if (li >= 0) localOnly.splice(li, 1);
        const di = localDeleted.indexOf(id); if (di >= 0) localDeleted.splice(di, 1);
        // 从 remoteOnly / remoteDeleted 移除，避免云端删除被错误传播
        const roi = remoteOnly.indexOf(rid); if (roi >= 0) remoteOnly.splice(roi, 1);
        const rdi = remoteDeleted.indexOf(rid); if (rdi >= 0) remoteDeleted.splice(rdi, 1);
        // ★ renamePairs 方向判定（移动意图）：本端近期挪过该节点（新旧 pk 任一命中
        //   意图表且未过期）→ 本端是发起方，本地即最新状态，不生成迁移对（否则会被
        //   renamePairs 迁回旧位置，实测表现为「挪动书签合并后又跑回原处」），靠落盘
        //   +回写自然传播；无意图 → 本端是接收方，生成迁移对跟随云端。意图在消费后
        //   从表中删除（该次移动已达成目的）。
        const nowMs = Date.now();
        const hasFreshIntent = (pk) => {
          const it = moveIntents[pk];
          return !!(it && typeof it.time === 'number' && (nowMs - it.time) < MOVE_INTENT_TTL);
        };
        if (hasFreshIntent(localPk) || hasFreshIntent(remotePk)) {
          delete moveIntents[localPk];
          delete moveIntents[remotePk];
          await chrome.storage.local.set({ sync_move_intents: moveIntents });
        } else {
          // 接收方：加入 renamePairs，让落盘阶段把本地节点迁移到云端新位置
          renamePairs.push({ oldPk: localPk, newPk: remotePk });
        }
        break;
      }
    }
  }

  // 5b. 顺序变化检测：pathKey 相同但同父内相对顺序不同 → 需回写云端。
  // ★ _index 语义归一：localList 来自本地树扁平化，_index 是全局递增计数（跨父不重置）；
  //   remoteData._index 是同父内序号（0..n-1）。直接比较数值会恒不等 → orderChanged
  //   恒 true → remoteUpdated 恒 true → 每次合并都回写云端（噪音）且干扰顺序冲突判定。
  //   这里把本地 _index 按同父出现顺序归一化为 0..n-1 后再比较。
  const localSibRankByPk = new Map();
  {
    const rank = new Map();
    for (const n of localList) {
      const key = n.parentId || '__root__';
      const idx = rank.get(key) || 0;
      const pk = localPKs.get(n.id);
      if (pk) localSibRankByPk.set(pk, idx);
      rank.set(key, idx + 1);
    }
  }
  const remoteIndexByPk = new Map();
  for (const [id, pk] of remotePKs) {
    const n = remoteData.bookmarks.find(x => x.id === id);
    if (n && typeof n._index === 'number') remoteIndexByPk.set(pk, n._index);
  }
  let orderChanged = false;
  for (const { pk } of bothPresent) {
    if (localSibRankByPk.has(pk) && remoteIndexByPk.has(pk) &&
        localSibRankByPk.get(pk) !== remoteIndexByPk.get(pk)) {
      orderChanged = true;
      break;
    }
  }

  // 5d. 内容变更检测：pathKey 相同但 url/title 不同 → 用「上次同步快照」三方判定
  // ★ 不能用 addedAt 决胜：副本在各端创建时 dateAdded 天然不同（编辑者节点的
  //   addedAt 往往比接收端副本旧），按 addedAt 判会回滚真实编辑（实测复现）。
  //   正确判据是 base = sync_snapshots.localTree（每次成功同步后刷新，记录
  //   「上次双方一致的内容」）：
  //     本地 ≠ base → 本端在本地改过（尚未传播）→ 本地胜，回写云端传播
  //     本地 == base → 本端没动、云端被改 → 云端胜，覆盖本地
  //     两端都 ≠ base（真冲突）或无 base → 云端为准（确定性、可预期）
  const contentUpdated = new Set();    // 需要用远程内容覆盖本地的 id 集合
  const localContentNewer = new Set(); // 本端内容改过：需触发写回云端传播
  {
    const snapTree = (storageData[STORAGE_KEYS.SNAPSHOTS] && storageData[STORAGE_KEYS.SNAPSHOTS].localTree) || [];
    const snapByPk = new Map(); // pk → 快照节点 {title,url}
    if (snapTree.length > 0) {
      const snapById = new Map(snapTree.map((n) => [String(n.id), n]));
      for (const [sid, spk] of MiniSync.xbelPath.computeJsonPathKeys(snapTree)) {
        const sn = snapById.get(String(sid));
        if (sn) snapByPk.set(spk, sn);
      }
    }
    const localNodeMap = new Map();   // pk → local node
    for (const n of localList) {
      const pk = localPKs.get(n.id);
      if (pk) localNodeMap.set(pk, n);
    }
    const remoteNodeMap = new Map();  // pk → remote node
    for (const n of remoteData.bookmarks) {
      const pk = remotePKs.get(n.id);
      if (pk) remoteNodeMap.set(pk, n);
    }
    for (const { localId, pk } of bothPresent) {
      const ln = localNodeMap.get(pk);
      const rn = remoteNodeMap.get(pk);
      if (!ln || !rn) continue;
      // 比较 url 和 title，任一不同即视为内容变更
      if ((ln.url || '') !== (rn.url || '') || (ln.title || '') !== (rn.title || '')) {
        const snap = snapByPk.get(pk);
        const localChanged = snap
          ? ((ln.title || '') !== (snap.title || '') || (ln.url || '') !== (snap.url || ''))
          : false; // 无 base（如从未成功同步过快照）：无法证明本端改过，云端为准
        if (localChanged) {
          localContentNewer.add(localId); // 本端改过且未传播 → 回写云端
        } else {
          contentUpdated.add(localId);    // 本端没动、云端改了（或真冲突）→ 云端为准
        }
      }
    }
  }

  // 5c. 重命名检测：同一父路径下两端各有一个不同名节点 → 识别为重命名（非两个独立节点）
  const renamedDiscardPKs = new Set();   // 旧名 pk（写入墓碑防复活）
  {
    // 收集所有节点及其父路径（不再限制 isFolder，书签也参与）
    function nodeParentGroups(list, pkMap) {
      const byParent = new Map();
      for (const n of list) {
        const pk = pkMap.get(n.id);
        if (!pk) continue;
        const slashIdx = pk.lastIndexOf('/');
        const parentPath = slashIdx > 0 ? pk.substring(0, slashIdx) : '';
        if (!byParent.has(parentPath)) byParent.set(parentPath, []);
        byParent.get(parentPath).push({ node: n, pk });
      }
      return byParent;
    }
    const localNodeGroups = nodeParentGroups(localList, localPKs);
    const remoteNodeGroups = nodeParentGroups(remoteData.bookmarks, remotePKs);

    const allParents = new Set([...localNodeGroups.keys(), ...remoteNodeGroups.keys()]);
    for (const parentPath of allParents) {
      // 单端候选：仅排除双端共存节点（bothPresent 不算重命名）。
      // 注意：命中墓碑的旧名节点【不排除】——它可能是被重命名的旧名（onRemoved 无法区分
      // 真删除与重命名，重命名也会写墓碑），需在此识别为重命名而非真删除。
      const localNodes = (localNodeGroups.get(parentPath) || [])
        .filter(g => !remotePKSet.has(g.pk));
      const remoteNodes = (remoteNodeGroups.get(parentPath) || [])
        .filter(g => !localPKSet.has(g.pk));

      // ★ 「父级两端都存在」不能只看 pk 集合：zone 根（ROOT:bar/ROOT:other/ROOT:mobile/
      //   ROOT:home）与虚拟根 ROOT 被 computeJsonPathKeys **主动跳过**，永远不作为某个节点的
      //   pk 出现 ⇒ 对「同步桶的直接子层」而言 parentCoexists 恒为 false，顶层文件夹的
      //   改名/移动**永远识别不了**：旧名留着（内容还在里面）、新名建成空壳，两端永久分裂
      //   （而桶的直接子层恰恰是手机/扁平根宿主上最常见的层级）。
      //   这些虚拟父路径是两端天然存在的容器，必须视为「父级存在」。
      const VIRTUAL_PARENT_RE = /^ROOT(?::(?:bar|other|mobile|home))?$/;
      const parentCoexists = VIRTUAL_PARENT_RE.test(parentPath) ||
        localPKSet.has(parentPath) || remotePKSet.has(parentPath) ||
        bothPresentPKs.has(parentPath);
      if (!parentCoexists) continue;
      // 严格 1:1 才判为重命名：本地一个单端节点 + 云端一个单端节点（同名父、不同名）。
      // 云端残留旧名（如重命名未清干净）的场景由 onRemoved 墓碑机制覆盖，不在此误杀新建节点。
      if (localNodes.length === 1 && remoteNodes.length === 1) {
        // 排除「同名但 URL 不同」的书签：这是两端独立新增的不同书签，不是重命名。
        // 文件夹没有 URL，此检查只对书签生效。
        const ln = localNodes[0].node;
        const rn = remoteNodes[0].node;
        if (ln.url && rn.url && (ln.url || '') !== (rn.url || '')) {
          continue; // URL 不同 → 不是重命名，跳过
        }
        if (!!ln.isFolder !== !!rn.isFolder) continue;
        const lpk = localNodes[0].pk;
        const rpk = remoteNodes[0].pk;
        // A baseline path only proves prior existence, not the identity of its peer.
        const hasHistory = baselinePKs.has(lpk) || baselinePKs.has(rpk);
        const hasExplicitEvidence = tombstoneKeys.has(lpk) || tombstoneKeys.has(rpk)
          || !!moveIntents[lpk] || !!moveIntents[rpk];
        const hasMatchingContent = ln.isFolder
          ? [...localPKSet].some(pk => pk.startsWith(lpk + '/') && pk.includes('/L:')
            && remotePKSet.has(rpk + pk.substring(lpk.length)))
          : !!ln.url && ln.url === rn.url;
        if (!hasExplicitEvidence && !(hasHistory && hasMatchingContent)) continue;
        const discardPk = _decideRenameDiscard(localNodes[0], remoteNodes[0], tombstoneKeys);
        renamedDiscardPKs.add(discardPk);
        // 记录重命名对（oldPk=被丢弃侧旧名，newPk=保留侧新名），用于携带子孙抵消（仅文件夹有效）。
        if (discardPk === remoteNodes[0].pk) {
          renamePairs.push({ oldPk: remoteNodes[0].pk, newPk: localNodes[0].pk });
        } else {
          // ★ 丢弃的是本端旧名 ⇒ 保留云端新名 ⇒ 本端这个旧名节点必须**就地改名**
          //   （保 chrome id、保留整棵子树），并把云端新名节点从 remoteOnly 摘掉。
          //   历史实现这里只统计不落盘：旧名文件夹带着内容留在原地、云端新名被当
          //   remoteOnly 建成空壳，两端永久分裂（下一轮双方又各自「保留本地」互不相让）。
          localRenames.push({
            id: localNodes[0].node.id,
            title: remoteNodes[0].node.title || localNodes[0].node.title || ''
          });
          // 改名不是删除：把该节点本身从「待删」里摘出来（子孙由 5f 同名匹配携带，
          // 匹配不上的按真删除处理）。否则落盘会先把刚改好名的文件夹整棵删掉。
          const di = localDeleted.indexOf(localNodes[0].node.id);
          if (di >= 0) localDeleted.splice(di, 1);
          renamePairs.push({ oldPk: localNodes[0].pk, newPk: remoteNodes[0].pk, localRenamed: true });
        }
      }
    }
  }
  // 重命名携带的子孙节点：文件夹改名后，其下子节点父路径跟着变，pathKey 全变，
  // 会被误判为「本地新增(localOnly) / 云端新增(remoteOnly) / 本地墓碑删除(localDeleted)」。
  // 抵消原则：只有「父文件夹改名、自己 segment 没变」的节点才算「携带」；
  // 子书签自己也改名了的，应保留为真实新增/上传。
  // 判定方法：把节点 pk 里的 oldPk 前缀替换成 newPk（或反向），若替换后的 pk 能在对端找到，
  // 则视为同一节点的重命名，从统计里抵消；否则保留为真实差异。
  const carryLocalIds = new Set();   // 需从 localOnly 移除的 id（父文件夹改名携带）
  const carryRemoteIds = new Set();  // 需从 remoteOnly 移除的 id（父文件夹改名携带）
  let renamedDelFromLocal = 0;       // 旧名子树中算 renamed 不计 deleted 的节点数
  let renamedAddFromRemote = 0;      // 新名子树中算 renamed 不计 added 的节点数
  const localIdToPk = new Map([...localPKs].map(([id, pk]) => [id, pk]));
  const remoteIdToPk = new Map([...remotePKs].map(([id, pk]) => [id, pk]));
  function mapPk(pk, fromPk, toPk) {
    if (pk === fromPk) return toPk;
    if (pk.startsWith(fromPk + '/')) return toPk + pk.substring(fromPk.length);
    return null;
  }
  for (const pair of renamePairs) {
    const { oldPk, newPk } = pair;
    // 本端持有哪一侧：默认（5f 移动、本端已改名）本端持有 newPk；
    // localRenamed 时本端持有 oldPk（本端旧名节点将就地改名为 newPk）。
    const localSide = pair.localRenamed ? oldPk : newPk;
    const remoteSide = pair.localRenamed ? newPk : oldPk;
    // 本端 localSide 子树（替换前缀后云端 remoteSide 有对应）：改名携带，
    // 不应单独上传（会随整树回传）。从 localOnly 移除。
    for (const [id, pk] of localPKs) {
      if (!(pk === localSide || pk.startsWith(localSide + '/'))) continue;
      const mapped = mapPk(pk, localSide, remoteSide);
      if (mapped && remotePKSet.has(mapped)) {
        if (localOnly.includes(id)) carryLocalIds.add(id);
      }
    }
    // 云端 remoteSide 子树（替换前缀后本端 localSide 有对应）：本端已有一份，
    // 不许再当云端独有追加（否则重建出空壳新名文件夹/重复节点）。从 remoteOnly 移除。
    for (const [id, pk] of remotePKs) {
      if (!(pk === remoteSide || pk.startsWith(remoteSide + '/'))) continue;
      const mapped = mapPk(pk, remoteSide, localSide);
      if (mapped && localPKSet.has(mapped)) {
        if (remoteOnly.includes(id)) carryRemoteIds.add(id);
      }
    }
    // 统计抵消量：本地旧名子树（命中墓碑的 localDeleted）能在云端新名子树找到对应 → 算 renamed 不计 deleted
    for (const id of localDeleted) {
      const pk = localIdToPk.get(id);
      if (!pk) continue;
      const mapped = mapPk(pk, oldPk, newPk);
      if (mapped && remotePKSet.has(mapped)) renamedDelFromLocal++;
    }
    // 统计抵消量：云端新名子树（remoteOnly）能在本地旧名子树找到对应 → 算 renamed 不计 added
    for (const id of remoteOnly) {
      const pk = remoteIdToPk.get(id);
      if (!pk) continue;
      const mapped = mapPk(pk, newPk, oldPk);
      if (mapped && localPKSet.has(mapped)) renamedAddFromRemote++;
    }
    // 反向携带：本地旧名下有节点 → 映射到新名 → 远程没有 → 这是"本地在旧名文件夹下新增的"
    // （对端已改名，但本地还不知道）。这些节点不应随旧名文件夹被 prune 裁剪，
    // 而应保留并迁移到新名文件夹下。
    // ★ localRenamed（本端就地改名）不走收养：本端旧名文件夹不是被删而是被改名，
    //   子树原地保留，本地新增的节点留在里面、由落盘正常上传即可（收养会多建一份）。
    if (pair.localRenamed) continue;
    for (const [id, pk] of localPKs) {
      if (!(pk === oldPk || pk.startsWith(oldPk + '/'))) continue;
      if (localDeleted.includes(id)) continue; // 已被删的不处理
      const mapped = mapPk(pk, oldPk, newPk); // 旧名→新名
      if (mapped && !remotePKSet.has(mapped)) { // 远程新名下没有对应节点
        adoptedLocalOnly.add(id); // 标记为"需收养"
      }
    }
  }
  // 移动/模糊匹配命中的节点（5f）本质是「同一节点换了位置」，不是删除，
  // 其旧 pathKey 必须从墓碑候选中剔除，否则会被误判为「删除」而误删旧位置子树。
  for (const pk of moveMatchedPKs) renamedDiscardPKs.delete(pk);

  // 重命名被丢弃的旧名 pathKey 写入墓碑，避免下次同步其作为 remoteOnly/localOnly 被重建复活。
  if (renamedDiscardPKs.size > 0) {
    const devId = await MiniSync.storage.getDeviceId();
    tombstones = MiniSync.tombstone.mergeTombstones(tombstones, renamedDiscardPKs, bothPresentPKs, devId);
    const dropLocal = carryLocalIds;
    const dropRemote = carryRemoteIds;
    if (dropLocal.size || dropRemote.size) {
      for (let i = remoteOnly.length - 1; i >= 0; i--) if (dropRemote.has(remoteOnly[i])) remoteOnly.splice(i, 1);
      for (let i = localOnly.length - 1; i >= 0; i--) if (dropLocal.has(localOnly[i])) localOnly.splice(i, 1);
    }
  }

  // 6. 三向合并分类统计（不直接写入 Chrome，由 orchestrator 统一完成）
  const renamedCount = renamedDiscardPKs.size;
  const stats = {
    added: Math.max(0, remoteOnly.length - renamedAddFromRemote), // 远程独有 → 新增；重命名新名已抵消
    updated: contentUpdated.size + localContentNewer.size, // 内容变更（URL/标题修改，双向）数量
    skipped: bothPresent.length - contentUpdated.size,  // 跳过 = 共存 - 内容变更
    // 注意：本地独有（localOnly）是「本机有、云端无」的节点，在三向合并中应上推云端保留，
    // 不应计为删除。真正会被删除的是墓碑标记的 localDeleted。
    deleted: Math.max(0, localDeleted.length - renamedDelFromLocal),
    renamed: renamedCount,     // 重命名对数（旧名→新名，提示为「变化N」）
    localOnly: localOnly.length // 本地独有（将上推云端）；重命名新名及子孙已抵消
  };

  // 7. 更新墓碑（仅记录真正被删除的节点 pathKey）
  //    readdedPKs 只能用【云端】现存 pk——本地存在、云端缺失却命中墓碑的节点，
  //    恰恰是本次要同步删除的 localDeleted，必须从墓碑保留，否则删除传不过去。
  const newlyDeleted = new Set(localDeleted.map(id => localPKs.get(id)).filter(Boolean));
  // 清理基准同样用「双方都存在」的 pk：本地已删、云端仍在的节点（待删除传播）墓碑必须保留。
  tombstones = MiniSync.tombstone.mergeTombstones(tombstones, newlyDeleted, bothPresentPKs);
  await new Promise(resolve =>
    chrome.storage.local.set({ sync_tombstones: tombstones }, resolve)
  );

  // 8. 更新云端时间戳
  // 注：不在合并引擎里提前写 CLOUD_LAST_MODIFIED——写回云端尚未发生，
  // 此处用本机 Date.now() 虚推本地记录，若后续 putFile 失败走回滚，
  // 下次合并的顺序冲突判定会误判「云端没被别人改过」而忽略云端新顺序。
  // 写回成功后由 sync-merge.js 用服务器返回的 lastModified 更新（口径正确）。

  // ★ 删除传播的关键：本地墓碑视图里有、云端还没有的墓碑（pending），必须随本次
  //   写回上云——否则「纯删除」场景（无新增/顺序/内容变化）remoteUpdated=false，
  //   合并成功却不写回，墓碑永远留在本地，其他端永远删不掉（实测复现）。
  const remoteTsKeys = new Set(
    ((remoteData && Array.isArray(remoteData.tombstones)) ? remoteData.tombstones : [])
      .map((t) => ((typeof t === 'string' ? t : t && t.key) || ''))
      .filter(Boolean)
  );
  let pendingTombstones = 0;
  for (const pk of tombstoneKeys) {
    if (!remoteTsKeys.has(pk)) pendingTombstones++;
  }

  return {
    stats,
    // 远端有独有节点 → 需要落盘智能覆盖以导入；本地有独有节点 → 需要写回云端
    localUpdated: localOnly.length > 0,
    remoteUpdated: localOnly.length > 0 || remoteOnly.length > 0 || orderChanged
      || contentUpdated.size > 0 || localContentNewer.size > 0
      || pendingTombstones > 0
      // ★ 本端就地改名（保留云端新名）必须回写云端：本地标题变了、云端还是旧名，
      //   不回写的话下一轮又判一次改名、永远不收敛（实测：两端各自保留自己的名字）。
      || localRenames.length > 0,
    // 本地有、云端还没有的墓碑数（删除传播待上云），供诊断
    pendingTombstones,
    orderChanged,
    // 内容变更：需用远程内容覆盖本地的节点 id 列表（落盘时更新 URL/标题）
    contentUpdatedIds: [...contentUpdated],
    // 把独有节点 id 列表暴露给 orchestrator，便于落盘时追加 remoteOnly 节点（如空文件夹）
    localOnlyIds: localOnly,
    remoteOnlyIds: remoteOnly,
    // 本地命中墓碑、需在本端删除的节点 id 列表（落盘时移除，实现删除的跨端传播）
    localDeletedIds: localDeleted,
    // 反向携带：本地旧名文件夹下新增的节点（对端已改名但本地不知道），需保留并迁移到新名下
    adoptedLocalOnlyIds: [...adoptedLocalOnly],
    // 重命名对列表（oldPk→newPk），供 orchestrator 收养节点迁移时查找新父路径
    renamePairs: renamePairs,
    // 本端就该地改名的节点（{id,title}）：落盘前用 chrome.bookmarks.update 改名，
    // 保 id、保整棵子树（对端改名、本端跟随的场景）
    renameLocalNodes: localRenames,
    // 本次合并落定的墓碑并集（已写回本地存储）。调用方写云端 metadata 时必须用它 ——
    // 只写本机墓碑会把云端带来的墓碑整份冲掉，其他端从此学不到这次删除。
    tombstones: tombstones
  };
}

/**
 * 获取节点的父路径标题链（用于模糊匹配）
 * 返回格式: "ROOT:bar/父文件夹1/父文件夹2"
 */
function _getParentTitleChain(node, byId, pkMap) {
  const pk = pkMap.get(node.id);
  if (!pk) return '';
  // 取父路径部分（去掉最后的 segment）
  const lastSlash = pk.lastIndexOf('/');
  if (lastSlash <= 0) return pk;  // 根级别，直接返回 pk
  return pk.substring(0, lastSlash);
}

/**
 * 重命名对判定：返回应被丢弃（旧名）那一侧的 pathKey。
 * 墓碑优先：被墓碑标记的一侧是旧名；否则按 addedAt 取较新者保留，相等优先本地。
 */
function _decideRenameDiscard(localItem, remoteItem, tombstoneKeys) {
  const lInTomb = tombstoneKeys && tombstoneKeys.has(localItem.pk);
  const cInTomb = tombstoneKeys && tombstoneKeys.has(remoteItem.pk);
  if (lInTomb && !cInTomb) return localItem.pk;   // 本地旧名，丢弃本地
  if (cInTomb && !lInTomb) return remoteItem.pk;  // 云端旧名，丢弃云端
  const lTime = localItem.node.addedAt || 0;
  const cTime = remoteItem.node.addedAt || 0;
  return lTime >= cTime ? remoteItem.pk : localItem.pk;
}

return {
  chromeTreeToList,
  mergeBookmarks,
  classifyNodes,         // 纯函数：pathKey 分类，已单测覆盖
  _decideRenameDiscard,  // 纯函数：重命名丢弃决策，已单测覆盖
  isRootContainer        // 统一识别浏览器内置根容器
};

})();
