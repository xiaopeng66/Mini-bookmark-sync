// core/sync-merge.js — 合并路径编排层
// 从 sync-orchestrator.js 抽离 mergeSync 整段（流程、状态机、冲突策略、历史修复）。
// 依赖 lib/merge.js (MiniSync.merger) 算法引擎、lib/import.js (MiniSync.importer) 落盘引擎、
// core/sync-input.js (MiniSync.syncInput) 输入/IO 辅助。

MiniSync.mergeStrategy = (function() {

// 合并结果文案：写入失败优先；此外如实告知「桶内文件夹位置没搬过去」——
// 落点不存在或宿主拒绝移动时我们选择保书签不动（而不是删了再重建），用户需要知道。
function buildMergeMessage(failedWrites, conflictSamples, crossZoneDiag, importResult, remoteSpliced) {
  const notes = [];
  if (crossZoneDiag && crossZoneDiag.skippedNoParent > 0) {
    notes.push(`${crossZoneDiag.skippedNoParent} 处文件夹位置调整没落到位（书签未删除，仍在原处）`);
  }
  // 如实告知「嵌套垃圾被拆平」——手机上肉眼可见，不说用户会以为书签被搬到了奇怪的地方。
  if (importResult && importResult.wrapperSpliced > 0) {
    notes.push(`已拆平本机 ${importResult.wrapperSpliced} 层重复的同名文件夹（子文件夹/书签已上提一级，没丢）`);
  }
  // ★ 重排的 move 失败必须如实说出来：历史实现把它计数后丢掉，用户看到「合并成功」，
  //   实际顺序没落到位（与 skippedNoParent 同一类问题，同一条提示路径）。
  if (importResult && importResult.moveFailed > 0) {
    notes.push(`${importResult.moveFailed} 处书签/文件夹顺序没落到位（内容没丢，位置没对齐）`);
  }
  if (remoteSpliced > 0) {
    notes.push(`云端 ${remoteSpliced} 层重复的同名文件夹已按摊平形态读入`);
  }
  if (importResult && importResult.bucketTitle) {
    notes.push(`同步文件夹：${importResult.bucketTitle}`);
  }
  const tail = notes.length > 0 ? `（${notes.join('；')}）` : '';
  if (failedWrites > 0) {
    return `合并完成，但有 ${failedWrites} 条没能写入本地：${conflictSamples.join('；')}${tail}`;
  }
  return notes.length > 0 ? `合并成功${tail}` : '合并成功';
}

// ===== 顺序冲突的三方判定（base = 上次同步快照）=====
// 旧实现按「云端文件 mtime > 本机上次同步记录」判顺序归属。真实环境里只要别的端在本机
// 上次同步之后写过云端（自动同步每 30 分钟一轮，「云端比本机记录新」是常态），本机刚拖好
// 的顺序就会被判成「云端更新」而整段丢弃 —— 用户实测：同一文件夹里换个顺序，同步后顺序
// 变回原样，另一端也拿不到。
// 判据改成与内容变更（lib/merge.js 5d）同一套三方比较，去掉对跨端时钟的依赖：
//   base = 上次成功同步时的本地树快照（sync_snapshots.localTree）
//   本机顺序 ≠ base ⇒ 本机是这次顺序改动的作者 ⇒ 本机胜（保留本地 _index，随写回上云）
//   本机 == base 而云端 ≠ base ⇒ 云端是作者 ⇒ 采用云端 _index（落盘重排）
//   两端都改过（真冲突）或无 base 证据 ⇒ 不表态，调用方退回时间戳兜底（结果确定、两端收敛）
// 逐父文件夹判定：A 端调文件夹 X、B 端调文件夹 Y 时，两处改动都能各自传出去。
// 比较只用「三端都有」的节点（按 pathKey）：新增/删除会让同父内的绝对序号整体错位，
// 拿绝对序号比会把「加了一个书签」误判成换序。
function orderParentKey(node, keys) {
  const parentPk = keys.get(String(node.parentId));
  if (parentPk) return parentPk;
  // 透明/虚拟父容器用路径根前缀对齐，桶顶层与主页分别排序。
  const pk = keys.get(node.id);
  return pk ? pk.split('/')[0] : ROOT_ID;
}

function computeOrderWinsByParent(input) {
  const wins = new Map(); // parentPk -> 'local' | 'remote'
  const pairs = [...(input.renamePairs || [])].sort((a, b) => b.oldPk.length - a.oldPk.length);
  const canonical = (pk) => {
    const seen = new Set();
    while (!seen.has(pk)) {
      seen.add(pk);
      const pair = pairs.find(p => pk === p.oldPk || pk.startsWith(p.oldPk + '/'));
      if (!pair) break;
      const next = pair.newPk + pk.substring(pair.oldPk.length);
      if (next === pk || seen.has(next)) break;
      pk = next;
    }
    return pk;
  };
  // 某一视图里「父 pathKey -> 子 pathKey 序列（按该视图自己的 _index）」
  const seqByParent = (list, keys) => {
    const buckets = new Map();
    for (const n of (list || [])) {
      const pk = keys.get(n.id);
      if (!pk) continue;
      const parentPk = canonical(orderParentKey(n, keys));
      if (!buckets.has(parentPk)) buckets.set(parentPk, []);
      buckets.get(parentPk).push({ pk: canonical(pk), index: typeof n._index === 'number' ? n._index : 0 });
    }
    const out = new Map();
    for (const [parentPk, arr] of buckets) {
      arr.sort((a, b) => a.index - b.index);
      out.set(parentPk, arr.map(item => item.pk));
    }
    return out;
  };
  const localByParent = seqByParent(input.localList, input.localKeys);
  const remoteByParent = seqByParent(input.remoteList, input.remoteKeys);
  const baseByParent = seqByParent(input.baseList, input.baseKeys);
  const sep = '\u0000'; // pathKey 里不可能出现的分隔符
  for (const [parentPk, localSeq] of localByParent) {
    const remoteSeq = remoteByParent.get(parentPk);
    if (!remoteSeq || remoteSeq.length < 2) continue;
    const remotePKSet = new Set(remoteSeq);
    const common = localSeq.filter(pk => remotePKSet.has(pk));
    if (common.length < 2) continue;
    const commonSet = new Set(common);
    const localOrder = localSeq.filter(pk => commonSet.has(pk)).join(sep);
    const remoteOrder = remoteSeq.filter(pk => commonSet.has(pk)).join(sep);
    if (localOrder === remoteOrder) continue; // 两端顺序本来就一致，无需判定
    const baseSeq = baseByParent.get(parentPk) || [];
    const baseSeqSet = new Set(baseSeq);
    const knownSet = new Set(common.filter(pk => baseSeqSet.has(pk)));
    if (knownSet.size < 2) continue; // 没有 base 证据（首次同步/快照缺失）⇒ 交给兜底
    const localKnown = localSeq.filter(pk => knownSet.has(pk)).join(sep);
    const remoteKnown = remoteSeq.filter(pk => knownSet.has(pk)).join(sep);
    const baseKnown = baseSeq.filter(pk => knownSet.has(pk)).join(sep);
    const localMoved = localKnown !== baseKnown;
    const remoteMoved = remoteKnown !== baseKnown;
    if (localMoved && !remoteMoved) wins.set(parentPk, 'local');
    else if (remoteMoved && !localMoved) wins.set(parentPk, 'remote');
    // 两端都动过（真冲突）：不表态，由时间戳兜底决定，避免两端各执一词来回拉扯。
  }
  return wins;
}

function bookmarkWrite(method, ...args) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks[method](...args, result => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message || String(error)));
      else resolve(result);
    });
  });
}

function bridgeListSignature(list) {
  return JSON.stringify(list.map(n => [String(n.id), String(n.parentId || ROOT_ID),
    n.title || '', n.url || '', n.source || '', n._index, !!n.isFolder])
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

async function applyBridgeRemaps(list, remaps, bucketId, createdIds) {
  if (!remaps.length) return;
  const tree = await MiniSync.syncInput.getChromeTree();
  const flat = MiniSync.merger.chromeTreeToList(tree);
  const keys = MiniSync.xbelPath.computeJsonPathKeys(flat);
  const scopedIds = new Set(flat.filter(n => !n.zoneRoot && !MiniSync.merger.isRootContainer(n))
    .map(n => String(n.id)));
  const live = new Map();
  (function index(node) {
    if (!node) return;
    live.set(String(node.id), node);
    for (const child of node.children || []) index(child);
  })(tree[0]);
  const byPath = new Map();
  for (const n of flat) {
    if (!live.has(String(n.id))) continue;
    const pk = keys.get(n.id);
    if (!byPath.has(pk)) byPath.set(pk, []);
    byPath.get(pk).push(String(n.id));
  }
  const planned = new Map(list.map(n => [String(n.id), n]));
  const plannedKeys = MiniSync.xbelPath.computeJsonPathKeys(list);
  const changes = new Map(remaps.map(n => [String(n.id), n]));
  const resolved = new Map();
  const resolving = new Set();
  let homeId = null;
  for (const top of (tree[0] && tree[0].children) || []) {
    if (top.url) continue;
    const home = [top, ...(top.children || [])].find(n => !n.url && String(n.id) !== String(bucketId)
      && FOLDER_TITLES.berryHome.some(t => t.toLowerCase() === String(n.title || '').toLowerCase()));
    if (home) { homeId = String(home.id); break; }
  }
  async function rootId(source) {
    if (source !== 'home') return String(bucketId);
    if (!homeId) {
      const other = ((tree[0] && tree[0].children) || []).find(n => !n.url
        && FOLDER_TITLES.otherBookmarks.some(t => t.toLowerCase() === String(n.title || '').toLowerCase()));
      const home = await bookmarkWrite('create', { parentId: String(other ? other.id : bucketId), title: 'Berry主页' });
      homeId = String(home.id);
      live.set(homeId, home);
      createdIds.add(homeId);
    }
    return homeId;
  }
  async function resolve(id, source) {
    id = String(id || ROOT_ID);
    if (id === HOME_FOLDER_ID) return rootId('home');
    if ([ROOT_ID, OTHER_FOLDER_ID, MOBILE_FOLDER_ID, String(bucketId)].includes(id)) return rootId(source);
    if (resolved.has(id)) return resolved.get(id);
    if (resolving.has(id)) throw new Error('手机文件夹移动包含循环，已停止导入');
    const node = planned.get(id);
    if (!node) throw new Error('手机文件夹移动缺少父节点，已停止导入');
    resolving.add(id);
    try {
      let current = scopedIds.has(id) ? live.get(id) : null;
      if (current && !changes.has(id)) { resolved.set(id, id); return id; }
      const parentId = await resolve(node.parentId, node.source || source);
      if (!current && !node.url) {
        const candidates = byPath.get(plannedKeys.get(node.id)) || [];
        if (candidates.length === 1) current = live.get(candidates[0]);
      }
      if (!current) {
        if (node.url) throw new Error('手机编辑对应的本地书签已不存在，已停止导入');
        current = await bookmarkWrite('create', { parentId, title: node.title || '' });
        live.set(String(current.id), current);
        createdIds.add(String(current.id));
      } else if (changes.has(id)) {
        const update = {};
        if ((current.title || '') !== (node.title || '')) update.title = node.title || '';
        if (node.url && current.url !== node.url) update.url = node.url;
        if (Object.keys(update).length) {
          await bookmarkWrite('update', String(current.id), update);
          Object.assign(current, update);
        }
        if (String(current.parentId) !== parentId) {
          if (MiniSync.utils && MiniSync.utils.noteTransactionMove) MiniSync.utils.noteTransactionMove(current.id);
          await bookmarkWrite('move', String(current.id), { parentId });
          current.parentId = parentId;
        }
      }
      resolved.set(id, String(current.id));
      return String(current.id);
    } finally { resolving.delete(id); }
  }
  for (const remap of remaps) {
    const id = String(remap.id);
    if (!scopedIds.has(id) || !live.has(id)) throw new Error('手机编辑超出本次同步范围，已停止导入');
    await resolve(id, (planned.get(id) || {}).source);
  }
}

function mergeSync(options) {
  // ★ 互斥队列：同 sync-orchestrator.js 的 upload/download（排队而非打断，
  //   避免「自动合并进行中 → 手动/下一次 alarm 强设 IDLE 后并发跑」互相覆盖云端数据）
  return MiniSync.syncMutex.run(() => doMergeSync(options));
}

async function doMergeSync(options) {
  options = options || {};
  // 本轮开始前登记的移动意图，在本轮提交成功后即视为已确认（见 clearConfirmedMoveIntents）
  const moveIntentCutoff = Date.now();
  // 拿到锁后状态仍是 SYNCING → 必为 SW 崩溃/重启残留，恢复为 IDLE
  const status = await MiniSync.storage.getSyncStatus();
  if (status.status === SYNCING) {
    await MiniSync.storage.setSyncStatus({ status: IDLE });
  }

  let mainCommitted = false;
  let localCommitted = false;
  let backupReady = false;
  let recovery = null;
  const warnings = [];
  try {
    await MiniSync.storage.setSyncStatus({ status: SYNCING, action: 'merge' });
    await MiniSync.syncInput.assertLocalRecoveryReady();

    // ★ 单同步桶：先把「同步文件夹」定下来（用户指定或自动探测并固化）。
    //   本机识别自己是扁平根宿主（手机）只能给出容器名，所以先 prime 名字，
    //   再解析设置 —— 云端已声明名字时 parseXbelFromString 会覆盖成云端那一份。
    try {
      const rawLocal = await MiniSync.syncInput.getChromeTree();
      const c = MiniSync.utils.detectFlatRootChild((rawLocal[0] && rawLocal[0].children) || []);
      if (c && c.title) MiniSync.utils.primeDeclaredFlatRootContainer(c.title);
    } catch (e) {
      console.warn('[sync] 读取本机容器名失败（按云端元数据处理）:', e.message);
    }
    let mergeBucketInfo = { id: null, title: '' };

    // C1: 获取本地和远程数据（Berry 扁平根目录走虚拟文件夹，1.0.4 对齐）
    const localTree = await MiniSync.syncInput.getLocalTreeForXbel();

    let config;
    let endpointKey;
    // 主文件写入拿到的并发保护级别（见 lib/webdav.js 的分层说明）；降档时要说给用户听。
    let mergeWriteProtectionNote = '';
    
    if (options.endpointKey && options.endpointKey !== MAIN_ENDPOINT_KEY) {
      const epData = await MiniSync.storage.getLocal(['sync_endpoints']);
      const eps = epData.sync_endpoints || {};
      const ep = eps[options.endpointKey];
      if (!ep) throw new Error(`端点 ${options.endpointKey} 不存在`);
      config = {
        url: ep.url,
        username: ep.username || '',
        password: ep.password || '',
        filename: ep.filename || DEFAULT_FILENAME
      };
      endpointKey = options.endpointKey;
    } else {
      config = await MiniSync.storage.getWebdavConfig();
      endpointKey = MAIN_ENDPOINT_KEY;
    }

    if (!config.url) throw new Error('请先配置 WebDAV 信息');
    // ★ 锁住本轮远端目标（同上传路径）：桥接读写必须与主文件指向同一账户/文件，
    //   否则中途改设置会让手机桥接写新账户、主文件写旧账户（审计复现）。
    MiniSync.utils.setTransactionWebDAVConfig(config);
    if (MiniSync.utils.beginTransactionDeletionTracking) MiniSync.utils.beginTransactionDeletionTracking();

    const remoteVersion = await MiniSync.webdav.getFileVersion(config.url, config.username, config.password, config.filename);
    const remoteContent = remoteVersion.content;
    const remoteData = remoteContent !== null ? MiniSync.xbel.parseXbelFromString(remoteContent) : null;
    if (remoteVersion.exists && !remoteData) throw new Error('XBEL 文件格式无效');
    // ★ 写条件按服务器实际能力分层：强 ETag→If-Match，退而用同一响应里的
    //   Last-Modified→If-Unmodified-Since。旧版在这里要求必须有强 ETag，
    //   坚果云这类不返回强 ETag 的服务因此完全无法合并（v2.2.0 实测回归）。
    const remoteWriteCondition = MiniSync.webdav.versionWriteCondition(remoteVersion);
    if (remoteVersion.exists && !MiniSync.webdav.isStrongETag(remoteVersion.etag)) {
      console.info(`[sync] 云端未提供强 ETag（etag=${JSON.stringify(remoteVersion.etag)}，`
        + `Last-Modified=${remoteVersion.serverModified || '(无)'}），本次写入保护级别：`
        + MiniSync.webdav.describeWriteProtection(remoteWriteCondition));
    }

    // ★ 云端已解析（parseXbelFromString 写入了它声明的容器名）之后才解析「同步文件夹」：
    //   桌面 Edge 只能靠那个声明认出「其他收藏夹/根目录」这层镜像就是自己的桶，
    //   早于云端解析就会退化成空的书签栏，还会把这个错误的答案固化进设置。
    try {
      mergeBucketInfo = await MiniSync.syncInput.resolveSyncBucketSetting();
    } catch (e) {
      console.warn('[sync] 解析同步文件夹失败:', e.message);
    }

    await MiniSync.syncInput.ensureSyncRelationship(config, mergeBucketInfo.id);
    // The version belongs to the same GET body, never to a later HEAD.
    const remoteLastModified = remoteVersion.lastModified || 0;
    const lastSeenData = await MiniSync.storage.getLocal([STORAGE_KEYS.CLOUD_LAST_MODIFIED]);
    const localLastSeen = lastSeenData[STORAGE_KEYS.CLOUD_LAST_MODIFIED] || 0;
    const ORDER_TOLERANCE = 2000;

    // C2 前置：快照差异检测（V1.0.3 的 locallyDeletedKeys 兜底机制）
    // 即使 onRemoved 监听因扩展重载/批量删除未触发，也能通过「上次快照 vs 当前本地树」
    // 捕捉删除，将差异 pathKey 追加进 sync_tombstones，确保删除必被传播。
    // 实现与「上传」路径共用同一个助手（core/sync-input.js），口径不许分叉。
    await MiniSync.syncInput.backfillDeletedTombstones(MiniSync.merger.chromeTreeToList(localTree));

    // C2 前置：清理假墓碑（文件夹重命名时 onRemoved 会给子节点写墓碑，但子节点实际没被删除）
    // 必须在 mergeBookmarks 之前清理，否则假墓碑会导致子节点被误判为 localDeleted 而被裁剪。
    // 注意：只清理【本地】sync_tombstones 并写回；【绝不能】覆盖 remoteData.tombstones，
    // 否则云端传来的「对端删除」真墓碑会被本地墓碑覆盖丢失，导致跨端删除失效
    // （表现为「A 端删了、B 端合并后还在」）。mergeBookmarks 会自己从 chrome.storage.local
    // 重新读干净的本地墓碑，云端墓碑走 remoteData.tombstones 原值参与合并。
    {
      const tsData = await MiniSync.storage.getLocal([STORAGE_KEYS.TOMBSTONES]);
      const current = tsData[STORAGE_KEYS.TOMBSTONES] || [];
      if (current.length > 0) {
        // ★ 必须用**当前**树做判定，不能用本轮开头（GET 之前）读到的 localTree：
        //   同步等待期间用户删掉的节点在旧树里仍然「存在」，假墓碑判定于是把它当
        //   改名残留清掉 —— 删除失去证据、下一轮云端旧节点被导回
        //   （审计 2026-10-11 复现 deleteDuringGet）。读一次实时树即可准确区分
        //   「节点还在（改名残留，清）」与「节点已不在（真删除，保留）」。
        const liveFlatList = MiniSync.merger.chromeTreeToList(
          await MiniSync.syncInput.getChromeTree());
        const myDeviceId = await MiniSync.storage.getDeviceId();
        const presentPKs = new Set(MiniSync.xbelPath
          .computeJsonPathKeys(liveFlatList).values());
        // 只有「墓碑 key 仍能在当前树里找到」才可能是假墓碑；已经不在树里的
        // 一律视为真删除并保留墓碑。
        const candidates = current.filter(item => {
          const pk = typeof item === 'string' ? item : (item && item.key) || '';
          return pk && presentPKs.has(pk);
        });
        if (candidates.length > 0) {
          const cleaned = MiniSync.tombstone.cleanFakeTombstones(candidates, liveFlatList, myDeviceId);
          const cleanedKeys = new Set(cleaned.map(t => (typeof t === 'string' ? t : (t && t.key) || '')));
          const removedKeys = new Set(candidates
            .map(t => (typeof t === 'string' ? t : (t && t.key) || ''))
            .filter(pk => pk && !cleanedKeys.has(pk)));
          if (removedKeys.size > 0) {
            // 只删除本次判定为「假」的那些 key，并**重新读一次** storage 后写入：
            // 若在读取与写入之间用户又删了书签（onRemoved 已登记新墓碑），
            // 整份覆盖会把这次真删除一起抹掉。
            const latest = await MiniSync.storage.getLocal([STORAGE_KEYS.TOMBSTONES]);
            const latestList = latest[STORAGE_KEYS.TOMBSTONES] || [];
            const mergedList = latestList.filter(t => {
              const pk = typeof t === 'string' ? t : (t && t.key) || '';
              return !pk || !removedKeys.has(pk);   // 只剔除确认的假墓碑，保留新登记的
            });
            if (mergedList.length !== latestList.length) {
              await MiniSync.storage.setLocal({ [STORAGE_KEYS.TOMBSTONES]: mergedList });
            }
          }
        }
      }
    }

    // C2: 合并
    const mergeResult = await MiniSync.merger.mergeBookmarks(localTree, remoteData, config);

    // C3（前置）：是否需要在「落盘重排之后」写回云端。
    // 注意：云端写回必须放在落盘重排之后执行，否则会用重排前的旧本地顺序覆盖云端，
    // 把对端刚同步上来的新顺序抹掉（表现为「顺序又变回之前」）。
    let mergedTree = await MiniSync.syncInput.getChromeTree();
    let needWriteBack = mergeResult.requiresWriteBack || mergeResult.needWriteBack || mergeResult.remoteUpdated;

    // ===== 落盘（智能覆盖，与下载分支一致）：合并结果通过 xbelToJson 转成嵌套三区结构，
    //        用 DOWNLOAD_MODE + mergeIntoLocal 增量导入 + 删除本地独有，
    //        保留本地节点 id（floccus 兼容），且 Berry 主页正确归位到其他收藏夹。
    //        不再使用 clearAllBookmarks() + 全量重建（会让本地 id 全变、破坏 Berry 归属）。
    const MERGE_MODE = MiniSync.constants.MERGE_MODE;
    let mergedFlatList;
    let mergedBookmarkCount;
    let mergedFolderCount; // 文件夹数（无 url 的节点）供控制台日志
    let mergedTotal; // 总数（书签+文件夹）供控制台日志
    const crossZoneDiag = { moves: 0, failed: 0, degraded: 0, skippedNoParent: 0, details: [] }; // 跨区移动诊断
    // 本轮真正要求本机落地的移动（跟随云端的位置调整）。落盘后必须逐条验证：
    // 部分移动端宿主的 bookmarks.move 会「回调成功但实际不动」，旧实现照样写回云端 ——
    // 等于用本机的旧位置覆盖云端，另一台设备再同步就被还原（用户实测）。
    const appliedMoves = [];
    let movesRepaired = 0;
    // 落盘结果（importBookmarksFromData 的返回值），供最终统计展示实际增删。
    // 必须声明在 try 外：import 调用点在 try 内深层块，而 return 在 try/catch 之后读取它。
    let importResult = null;
    // 本轮实际写进云端的扁平树（未写回时为 null ⇒ 基线按当前树记录）。
    // 基线只能代表云端已确认的状态：PUT 等待期间用户新拖的移动不在其中。
    let confirmedFlat = null;
    const mergeCreatedIds = new Set();
    let bridgeOutcome = { bridgeResults: {}, partial: false };
    const bridgeReadFailures = [];
    const bridgeSnapshotUpdates = {};
    // ★ 读入失败的桥接绝不允许写回（声明必须在 try 的**外层**作用域：写回发生在
    //   本 try 内更深层块，而块级 const 在那里不可见 —— 曾经因此直接抛
    //   "bridgeSkipWrite is not defined" 把整轮合并打断）。
    const bridgeSkipWrite = new Set(); // 'berry' | 'via' | 'aira'
    try {
      backupReady = await MiniSync.syncInput.backupLocalTree();
      if (!backupReady) {
        const failure = MiniSync.syncInput.getLocalBackupFailure();
        throw Object.assign(new Error(failure ? failure.message : '本地备份失败，已停止合并以保护书签'), failure);
      }

      // ===== 顺序冲突判断 =====
      // 仅有顺序变化（无新增/删除）时，唯一差异是节点 _index。顺序以谁为准由
      // computeOrderWinsByParent 逐父文件夹按三方比较（base=上次同步快照）判定，
      // 见该函数上方注释；只有它判不出结论（真冲突/无 base）时才退回时间戳兜底：
      // - 云端文件比本机上次同步记录新（remoteLastModified > localLastSeen + 容差）
      //   ⇒ 判「云端是顺序作者」，采用云端顺序；
      // - 否则保留本机当前顺序（本机领先，写回云端传播）。
      // 注：remoteLastModified 取 WebDAV 服务器给出的文件时间（与 PUT 返回值同一口径），
      // 只用于兜底分支，顺序传播不再依赖它。
      const useRemoteOrderFallback = remoteLastModified > localLastSeen + ORDER_TOLERANCE;

      // 旧逻辑曾为「仅顺序变化且本机领先」单独开一个 localOrderWins 分支，只写回云端、
      // 完全不落盘。该分支与下方落盘分支行为不一致，且会跳过 renamePairs 跨区移动，
      // 属于隐患。现已统一走下方落盘分支（它对纯顺序变化是幂等的，落盘后写回的也是
      // 融合后的真实树，行为更安全一致）。
      {
        // mergedTree 是合并后的完整本地树（含 Berry 主页挂在书签栏下），
        // 先转 XBEL 再 xbelToJson，得到正确的三区嵌套结构（Berry 主页 → source:'other'）。

        // ===== 本端就地改名（对端改名、本端跟随）=====
        // merge.js 判出「保留云端新名」时，会把本端旧名节点标记为 renameLocalNodes。
        // 必须在这里（拿最终树之前）真正改名：不改的话旧名文件夹带着内容留在原地，
        // 云端新名又被当 remoteOnly 建成空壳 —— 两端永久分裂（各保留自己的名字）。
        if (mergeResult.renameLocalNodes && mergeResult.renameLocalNodes.length > 0) {
          for (const rn of mergeResult.renameLocalNodes) {
            if (!rn || rn.id === undefined || rn.id === null) continue;
            await bookmarkWrite('update', String(rn.id), { title: rn.title || '' });
          }
        }

        // ===== 内容变更修复 =====
        // merge.js 检测到 bothPresent 节点的 URL/标题与云端不同（contentUpdatedIds），
        // 说明对端修改了内容。此处用远程数据覆盖本地对应节点，使落盘后内容一致。
        if (mergeResult.contentUpdatedIds && mergeResult.contentUpdatedIds.length > 0 && remoteData && remoteData.bookmarks) {
          // ★ 按 pathKey 对齐远程内容（同一节点在两端的 chrome id 不同，
          //   此前用云端 id 匹配本地节点 → 跨端场景全部 miss，内容覆盖失效）
          const remoteByPk = new Map();
          {
            const rById = new Map(remoteData.bookmarks.map((n) => [String(n.id), n]));
            for (const [rid, rpk] of MiniSync.xbelPath.computeJsonPathKeys(remoteData.bookmarks)) {
              const rn = rById.get(String(rid));
              if (rn) remoteByPk.set(rpk, rn);
            }
          }
          const mPKs = MiniSync.xbelPath.computeJsonPathKeys(MiniSync.merger.chromeTreeToList(mergedTree));
          const explicitUpdates = new Map((mergeResult.contentUpdates || []).map(n => [String(n.id), n]));
          const updateSet = new Set(mergeResult.contentUpdatedIds.map(id => String(id)));
          await (async function applyContentUpdate(node) {
            if (!node) return;
            if (updateSet.has(String(node.id))) {
              const pk = mPKs.get(String(node.id));
              const remoteNode = explicitUpdates.get(String(node.id)) || (pk ? remoteByPk.get(pk) : null);
              if (remoteNode) {
                if (remoteNode.url !== undefined) node.url = remoteNode.url;
                if (remoteNode.title !== undefined) node.title = remoteNode.title;
                // ★ 同步更新真实 chrome 节点：import 的复用逻辑按 url+标题匹配，
                //   标题被改的节点永远匹配不上（落到全局 URL 复用也不改标题），
                //   不在此处直接 update，内容变更无法落盘（实测复现）。
                //   ★ URL 也必须一起写：只改 title 时，被判定为「URL 变更」的编辑
                //   （如 #old → #new）会留下旧地址的节点、再按新地址重建一份 ——
                //   用户看到新旧两条（审计 2026-10-11 复现 editFragment）。
                const changes = { title: node.title };
                if (remoteNode.url !== undefined && remoteNode.url) changes.url = node.url;
                await bookmarkWrite('update', String(node.id), changes);
              }
            }
            if (node.children) for (const child of node.children) await applyContentUpdate(child);
          })(mergedTree[0]);
        }

        if (mergeResult.renamePairs && mergeResult.renamePairs.length > 0) {
          const remoteList = (remoteData && remoteData.bookmarks) || [];
          const remoteKeys = MiniSync.xbelPath.computeJsonPathKeys(remoteList);
          const remoteByPk = new Map(remoteList.map(n => [remoteKeys.get(n.id), n]));
          const localIds = new Map();
          async function refreshMoveView() {
            mergedTree = await MiniSync.syncInput.getChromeTree();
            localIds.clear();
            const flat = MiniSync.merger.chromeTreeToList(mergedTree);
            const keys = MiniSync.xbelPath.computeJsonPathKeys(flat);
            for (const n of flat) {
              const pk = keys.get(n.id);
              if (pk) localIds.set(pk, String(n.id));
            }
            localIds.set('ROOT:bar', String(mergeBucketInfo.id));
            const home = flat.find(n => String(n.id) === String(HOME_FOLDER_ID));
            if (home) {
              const physicalHome = (function find(node) {
                if (!node || node.url) return null;
                if (FOLDER_TITLES.berryHome.some(t => t.toLowerCase() === String(node.title || '').toLowerCase())) return node;
                for (const child of node.children || []) { const hit = find(child); if (hit) return hit; }
                return null;
              })(mergedTree[0]);
              if (physicalHome) localIds.set('ROOT:home', String(physicalHome.id));
            }
          }
          await refreshMoveView();
          const parentKey = (node) => orderParentKey(node, remoteKeys);
          // ★ 父级改名会就地改掉整条路径的前缀（renameLocalNodes），于是子节点在
          //   localIds 里的键已经从 oldPk 变成「新父前缀 + 原后缀」。用 renamePairs
          //   把 oldPk 的前缀逐级换算到当前路径，否则「父改名 + 子移动」同一轮里
          //   子移动会因为查不到 oldPk 而被静默跳过（2026-10-12 复现：A 是
          //   书签栏/Dest/Keep，B 停在书签栏/Archive/Keep，两端不收敛）。
          const renamePairsAll = [...mergeResult.renamePairs].sort((a, b) => b.oldPk.length - a.oldPk.length);
          const canonicalOldPk = (pk, selfOldPk) => {
            const seen = new Set();
            while (!seen.has(pk)) {
              seen.add(pk);
              // 只沿**祖先前缀**换算（pk 严格以 oldPk + '/' 开头）；等号情形是节点自身，
              // 不是它挂在哪个父下 —— 那由该 pair 自己的 move 处理，不能在这里改写。
              const pair = renamePairsAll.find(p => p.oldPk !== selfOldPk && pk.startsWith(p.oldPk + '/'));
              if (!pair) break;
              const next = pair.newPk + pk.substring(pair.oldPk.length);
              if (next === pk || seen.has(next)) break;
              pk = next;
            }
            return pk;
          };
          const creating = new Set();
          async function ensureMoveParent(pk) {
            if (localIds.has(pk)) return localIds.get(pk);
            const node = remoteByPk.get(pk);
            if (!node || !node.isFolder || creating.has(pk)) return null;
            creating.add(pk);
            try {
              const parentId = await ensureMoveParent(parentKey(node));
              if (!parentId) return null;
              const created = await bookmarkWrite('create', { parentId, title: node.title || '' });
              const id = String(created.id);
              mergeCreatedIds.add(id);
              localIds.set(pk, id);
              return id;
            } finally { creating.delete(pk); }
          }
          // Move parents first; descendant pairs become no-ops once the subtree arrives.
          const pairs = [...mergeResult.renamePairs].sort((a, b) => a.oldPk.length - b.oldPk.length);
          for (const { oldPk, newPk, localId } of pairs) {
            const liveId = localId != null && [...localIds.values()].includes(String(localId)) ? String(localId) : null;
            let nodeId = liveId || localIds.get(oldPk);
            if (!nodeId) nodeId = localIds.get(canonicalOldPk(oldPk, oldPk));
            const remoteNode = remoteByPk.get(newPk);
            if (!nodeId || !remoteNode) continue;
            const newParent = parentKey(remoteNode);
            const oldFlat = MiniSync.merger.chromeTreeToList(mergedTree);
            const oldKeys = MiniSync.xbelPath.computeJsonPathKeys(oldFlat);
            const localNode = oldFlat.find(n => String(n.id) === nodeId);
            if (!localNode || orderParentKey(localNode, oldKeys) === newParent) continue;
            crossZoneDiag.moves++;
            const newParentId = await ensureMoveParent(newParent);
            if (!newParentId) {
              crossZoneDiag.failed++;
              crossZoneDiag.skippedNoParent++;
              crossZoneDiag.details.push({ nodeId, oldPk, newPk, error: '目标文件夹不存在，保留原节点' });
              continue;
            }
            try {
              if (MiniSync.utils && MiniSync.utils.noteTransactionMove) MiniSync.utils.noteTransactionMove(nodeId);
              await bookmarkWrite('move', nodeId, { parentId: newParentId });
              appliedMoves.push({ id: String(nodeId), oldPk, newPk, newParentId });
              await refreshMoveView();
            } catch (e) {
              crossZoneDiag.failed++;
              crossZoneDiag.details.push({ nodeId, oldPk, newPk, newParentId, error: e.message });
            }
          }
        }

        // ★ 落盘校验：本机必须真的停在云端的位置上，才允许把本机树写回云端。
        //   部分移动端宿主的 bookmarks.move 会「回调成功但实际不动」（或被宿主自己的
        //   书签同步立刻改回去），旧实现只信封装的返回值：合并报告成功、随后把本机的
        //   旧位置 PUT 上云 —— 另一台设备只能跟随，用户看到的就是「移动被还原」。
        //   与其覆盖云端，不如明确失败：云端保留新位置，本轮报错让用户重试/排查。
        if (appliedMoves.length > 0) {
          const verifyLive = async () => {
            const flat = MiniSync.merger.chromeTreeToList(await MiniSync.syncInput.getChromeTree());
            return new Map(flat.map(n => [String(n.id), n]));
          };
          let liveById = await verifyLive();
          const findMissed = () => appliedMoves.filter(m => {
            const n = liveById.get(String(m.id));
            return !n || String(n.parentId) !== String(m.newParentId);
          });
          let missedMoves = findMissed();
          // 宿主可能把 move 推迟到下一个 tick 才落盘：先等一拍再复核，避免无谓重建。
          if (missedMoves.length > 0) {
            await new Promise(resolve => setTimeout(resolve, 120));
            liveById = await verifyLive();
            missedMoves = findMissed();
          }
          // 兜底：move 不生效但 create/remove 可用时，按「下载」路径的做法重建一份
          // （先建后删，建失败就什么都不删）。只处理书签；文件夹要整棵重建，风险大，
          // 留给用户明确失败，绝不偷偷删子树。
          let repaired = 0;
          const stillMissed = [];
          for (const m of missedMoves) {
            const node = liveById.get(String(m.id));
            if (!node || !node.url) { stillMissed.push(m); continue; }
            let createdId = null;
            try {
              const created = await bookmarkWrite('create', {
                parentId: String(m.newParentId), title: node.title || '', url: node.url
              });
              createdId = String(created.id);
              // ★ 顺序不可颠倒：必须先确认新节点真的出现在目标父节点下，才允许删旧节点。
              //   部分宿主 create 会「回调成功但暂时读不到」，先删后就等于把唯一副本删了
              //   （实测：移动失败 + 宿主读延迟 ⇒ 用户书签直接消失、备份事务卡住）。
              let after = await verifyLive();
              const createdVisible = after.get(createdId)
                && String(after.get(createdId).parentId) === String(m.newParentId);
              if (!createdVisible) {
                // 再等一拍确认不是读延迟；仍看不到就撤销新建，保留旧节点。
                await new Promise(resolve => setTimeout(resolve, 120));
                after = await verifyLive();
              }
              if (!after.get(createdId) || String(after.get(createdId).parentId) !== String(m.newParentId)) {
                try { await bookmarkWrite('remove', createdId); } catch (_) { /* 写集兜底 */ }
                stillMissed.push(m);
                continue;
              }
              await bookmarkWrite('remove', String(m.id));
              after = await verifyLive();
              if (after.has(String(m.id)) || !after.has(createdId)) {
                // 旧节点没删掉 = 会留下副本。撤销新建，按失败处理（回滚交给备份）。
                try { await bookmarkWrite('remove', createdId); } catch (_) { /* 写集兜底 */ }
                stillMissed.push(m);
                continue;
              }
              mergeCreatedIds.add(createdId);
              // ★ 旧节点是本轮主动放弃的（已删除）：必须登记进本轮删除集，
              //   否则导入引擎手里的 mergedData 仍带着它，会把旧位置再建一份
              //   （实测：重建后旧文件夹里又出现一个同名书签）。
              if (Array.isArray(mergeResult.localDeletedIds)) {
                mergeResult.localDeletedIds.push(String(m.id));
              }
              // 后续（导入后、写云前）的复核要用新 id：把登记项改到重建出来的节点上。
              m.id = createdId;
              repaired++;
              liveById = after;
            } catch (e) {
              if (createdId) { try { await bookmarkWrite('remove', createdId); } catch (_) { /* 写集兜底 */ } }
              stillMissed.push(m);
            }
          }
          movesRepaired = repaired;
          missedMoves = stillMissed;
          if (missedMoves.length > 0) {
            const error = new Error(
              `本机未能把 ${missedMoves.length} 个书签/文件夹移动到云端的新位置（宿主未落盘），`
              + '已停止写回云端以保护书签');
            error.failureCount = missedMoves.length;
            error.moveVerification = missedMoves;
            crossZoneDiag.failed += missedMoves.length;
            crossZoneDiag.details.push(...missedMoves.map(m => ({
              nodeId: m.id, oldPk: m.oldPk, newPk: m.newPk, error: '移动未落地（宿主未生效）'
            })));
            throw error;
          }
        }


        // ===== 删除传播修复 =====
        // merge.js 已把「命中云端墓碑的本地节点」标记在 localDeletedIds，但合并落盘时
        // mergedTree 仍含这些节点（它只是合并前的本地树快照），导致落盘把它们当「本地应有」
        // 保留，跨端删除在接收端无法生效（表现为「Edge 删了、Chrome 还在」）。
        // 这里在落盘前，从 mergedTree 递归移除 localDeletedIds 对应子树，使落盘后真正删除。
        // ★ 必须放在**最后一次 mergedTree 重取之后**：上面「文件夹移动重定位」会把
        //   mergedTree 整个换成新拉取的树（那次重取就是为了让移动生效），裁剪放在它前面
        //   等于被无声丢弃 —— 实测「改名/移动与删除同时发生」时删除静默失效，
        //   而且被删节点还会随写回重新上云。
        const adoptedNodes = []; // 收养节点：本地旧名下新增的，需迁移到新名下
        if (mergeResult.localDeletedIds && mergeResult.localDeletedIds.length > 0) {
          const removeSet = new Set(
            mergeResult.localDeletedIds.map(id => String(id))
          );
          const adoptSet = new Set(
            (mergeResult.adoptedLocalOnlyIds || []).map(id => String(id))
          );
          // 从根节点开始，移除命中 removeSet 的节点及其整棵子树（子孙一并丢弃，不保留）
          // 但 adoptedNodes 例外：收养节点保留并收集，后续迁移到新名文件夹下
          (function prune(node) {
            if (!node.children) return;
            const kept = [];
            for (const child of node.children) {
              if (adoptSet.has(String(child.id))) {
                // 收养节点：从当前父节点移除，收集起来后续迁移
                adoptedNodes.push(child);
                continue;
              }
              if (removeSet.has(String(child.id))) continue; // 丢弃该节点及其子树
              prune(child);
              kept.push(child);
            }
            node.children = kept;
          })(mergedTree[0]);
        }

        const deviceId = await MiniSync.storage.getDeviceId();
        // 写回云端/落盘中间态时把「云端声明的扁平根容器名」显式带上：桌面端靠它把
        // 「其他收藏夹/根目录」这层手机容器镜像摊平（否则云端永远带着包装）。
        const xbelStr = MiniSync.xbel.chromeToXbel(mergedTree, {
          version: CURRENT_VERSION,
          deviceId,
          flatRootContainer: MiniSync.utils.getDeclaredFlatRootContainer() || undefined
        });
        const mergedData = MiniSync.xbel.xbelToJson(xbelStr);

        // ===== 顺序同步修复 =====
        // 上面的 mergedData 由「本地树 → XBEL → JSON」绕一圈得到，其 _index 反映的
        // 是「本地当前顺序」，远端（如 Edge 拖动后上传）的新顺序完全没参与，导致
        // 合并后顺序永远等于本地原有顺序（表现为「顺序没变化」）。
        // 修复：mergedData 与 remoteData 同源（都解析自同一份云端 XBEL），用 pathKey
        // 把 remoteData 中云端记录的真实 _index 覆盖回 mergedData，使落盘重排采用
        // 远端（拖动后的）顺序，本地独有节点保留本地 _index 依次排在末尾。
        if (remoteData && Array.isArray(remoteData.bookmarks) && remoteData.bookmarks.length > 0) {
          const remoteKeys = MiniSync.xbelPath.computeJsonPathKeys(remoteData.bookmarks);
          // 先建 id→node 索引再循环，避免大书签库下 O(n²) 的循环内 find
          const remoteNodeById = new Map(remoteData.bookmarks.map(b => [b.id, b]));
          const remoteIndexByKey = new Map();
          for (const [id, pk] of remoteKeys) {
            const node = remoteNodeById.get(id);
            if (node && typeof node._index === 'number') remoteIndexByKey.set(pk, node._index);
          }
          const mergedKeys = MiniSync.xbelPath.computeJsonPathKeys(mergedData.bookmarks);
          const mergedNodeById = new Map(mergedData.bookmarks.map(b => [b.id, b]));
          const mergedIndexByKey = new Map();
          for (const [id, pk] of mergedKeys) {
            const node = mergedNodeById.get(id);
            if (node) mergedIndexByKey.set(pk, node);
          }
          // 本地最大的 _index，用于把「仅本地独有」的节点排在云端顺序之后
          let localMax = -1;
          for (const node of mergedData.bookmarks) {
            if (typeof node._index === 'number') localMax = Math.max(localMax, node._index);
          }
          let appendedTail = 0;
          let matchedCount = 0;
          // 顺序以谁为准：逐父文件夹三方比较（base = 上次同步快照）。
          // 本机改过顺序的文件夹保持本机顺序（写回云端传播）；只有云端改过的文件夹才用
          // 云端 _index 覆盖本地。判不出结论的（真冲突/无 base）退回时间戳兜底
          // （useRemoteOrderFallback，见函数顶部「顺序冲突判断」）。
          const orderSnapData = await MiniSync.storage.getLocal([STORAGE_KEYS.SNAPSHOTS]);
          const orderBaseList = (orderSnapData[STORAGE_KEYS.SNAPSHOTS]
            && orderSnapData[STORAGE_KEYS.SNAPSHOTS].localTree) || [];
          const orderWinsByParent = computeOrderWinsByParent({
            localList: mergedData.bookmarks,
            localKeys: mergedKeys,
            remoteList: remoteData.bookmarks,
            remoteKeys,
            baseList: orderBaseList,
            baseKeys: MiniSync.xbelPath.computeJsonPathKeys(orderBaseList),
            renamePairs: mergeResult.renamePairs
          });
          const useRemoteOrderFor = (node) => {
            const parentPk = orderParentKey(node, mergedKeys);
            const verdict = orderWinsByParent.get(parentPk);
            if (verdict) return verdict === 'remote';
            return useRemoteOrderFallback;
          };
          for (const [pk, node] of mergedIndexByKey) {
            if (remoteIndexByKey.has(pk)) {
              if (useRemoteOrderFor(node)) {
                node._index = remoteIndexByKey.get(pk);
              }
              // 否则保留 node._index（它已是本地顺序），不覆盖
              matchedCount++;
            } else {
              // 云端没有的本地独有节点：保留它在本端父文件夹内的原始 _index（即用户手动调整的位置），
              // 只在没有 _index 时才兜底追加到末尾。避免用户在本端新建的节点被强制排到最后。
              if (typeof node._index !== 'number') {
                node._index = ++localMax;
              }
              appendedTail++;
            }
          }
          // 关键修正：mergedData 从本地树 chromeToXbel->xbelToJson 生成，不包含远程独有节点。
          // 必须把 mergeResult.remoteOnlyIds 对应节点（如 Edge 新建的空文件夹）追加进来，
          // 否则落盘导入时它们会「提示新增但实际没创建」。
          // 保留原 _index：remoteOnly 与 bothPresent 共享同一份云端编号，直接对齐即可。
          if (mergeResult.remoteOnlyIds && mergeResult.remoteOnlyIds.length > 0) {
            const remoteNodeById = new Map();
            for (const n of remoteData.bookmarks) remoteNodeById.set(n.id, n);
            const mergedKeySet = new Set(mergedKeys.values());
            // pathKey -> 本地节点 id，用于把 remoteOnly 子节点挂到已存在的本地父文件夹下
            const pkToMergedId = new Map();
            for (const [id, pk] of mergedKeys) pkToMergedId.set(pk, id);
            const parentMappings = [...(mergeResult.renamePairs || [])].sort((a, b) => b.oldPk.length - a.oldPk.length);
            function landedKey(key) {
              const applied = new Set();
              let pair;
              while (key && (pair = parentMappings.find(p => !applied.has(p)
                && (key === p.oldPk || key.startsWith(p.oldPk + '/'))))) {
                applied.add(pair);
                key = pair.newPk + key.slice(pair.oldPk.length);
              }
              return key;
            }
            // 按深度排序，父节点先于子节点被追加，确保子节点 parentId 能找到父节点
            const remoteOnlyNodes = mergeResult.remoteOnlyIds
              .map(id => remoteNodeById.get(id))
              .filter(Boolean);
            function getDepth(node) {
              let depth = 0;
              let cur = node;
              while (cur && cur.parentId && cur.parentId !== ROOT_ID && depth < 100) {
                depth++;
                cur = remoteNodeById.get(cur.parentId);
              }
              return depth;
            }
            remoteOnlyNodes.sort((a, b) => getDepth(a) - getDepth(b));

            let remoteOnlyAppended = 0;
            // ★ 追加的远程独有节点必须重新分配【不与本地撞号】的 id：
            //   落盘引擎（lib/import.js）用扁平列表的 id 建 nodeMap，两端 chrome id 空间
            //   天然重叠（都是小整数自增）。远程 id 撞上某个本地 id 时，nodeMap 里后写入的
            //   条目会顶掉先写入的：被顶掉那支的子节点挂到错误对象上、整支被落盘静默跳过
            //   （实测：一端新建书签后，另一端那批节点既不参与复用也不参与重排，反被当成
            //   「本地独有」挪到父文件夹末尾 —— 表现为顺序被搅乱且同步不生效）。
            //   id 只在本次落盘的中间结构里使用：新建节点落盘后由 importedParentIds 换成
            //   真实 chrome id；跨端身份一律按 pathKey，重编号不影响墓碑/合并语义。
            const takenIds = new Set(mergedData.bookmarks.map(b => String(b.id)));
            const idRemap = new Map(); // 远程 id -> 追加时实际使用的 id
            let remapSeq = 0;
            for (const node of remoteOnlyNodes) {
              const pk = landedKey(remoteKeys.get(node.id));
              if (!pk || mergedKeySet.has(pk)) continue;
              const clone = JSON.parse(JSON.stringify(node));
              // 若父节点在本地已存在（bothPresent），把 parentId 从远程 id 映射到本地 id；
              // 若父节点也是 remoteOnly，则用父节点追加时分配的（可能已重编的）id —— 父节点
              // 已按深度先于子节点追加进 mergedData。
              if (clone.parentId && clone.parentId !== ROOT_ID) {
                const parentPk = landedKey(remoteKeys.get(clone.parentId));
                if (parentPk && pkToMergedId.has(parentPk)) {
                  clone.parentId = pkToMergedId.get(parentPk);
                } else if (idRemap.has(String(clone.parentId))) {
                  clone.parentId = idRemap.get(String(clone.parentId));
                }
              }
              let newId = String(node.id);
              if (takenIds.has(newId)) {
                // '__ro_' 前缀不可能与 chrome id（纯数字）撞号
                do { newId = '__ro_' + (++remapSeq); } while (takenIds.has(newId));
              }
              idRemap.set(String(node.id), newId);
              clone.id = newId;
              takenIds.add(newId);
              mergedData.bookmarks.push(clone);
              mergedKeySet.add(pk);
              pkToMergedId.set(pk, newId);
              remoteOnlyAppended++;
            }
          }
        }

        // 读入 Berry/Via/Aira 变更，确保双向同步（受开关约束，与 bridge-patcher 写回保持一致）
        // 墓碑必须用 extractKeys 转成 pathKey 字符串集合：sync_tombstones 存的是
        // {key,deletedAt,deviceId} 对象数组，直接 new Set() 会让 has(pk) 永远为 false。
        const bridgeState = await MiniSync.storage.getLocal([STORAGE_KEYS.TOMBSTONES, 'sync_tombstone_acked']);
        let bridgeTombstones = MiniSync.tombstone.mergeTombstoneSources(
          mergeResult.tombstones || [], bridgeState[STORAGE_KEYS.TOMBSTONES] || []);
        const revokedVersions = new Set();
        const versionKey = MiniSync.berry.bridgeIdentity.versionKey;
        const keepTombstone = item => !revokedVersions.has(versionKey(item));
        const bridgeRemaps = new Map();
        const bridgeOpts = await MiniSync.storage.getLocal(['option_berry_enabled', 'option_via_enabled', 'option_aira_enabled']);
        const berryOn = bridgeOpts.option_berry_enabled === true;
        const viaOn = bridgeOpts.option_via_enabled === true;
        const airaOn = bridgeOpts.option_aira_enabled === true;
        let finalMergedData = mergedData;
        const bridgeDeletedIds = new Set();
        const bridgeDeletedKeys = new Set();
        // ★ 读入失败的桥接绝不允许写回：读不到手机现状就用桌面列表覆盖，
        //   会把「还没合并的手机独有书签」直接抹掉 —— 手机端文件里的唯一副本就此消失
        //   （审计 2026-10-11 复现：Via/Berry 读取失败与 Via 缺 favorites.txt 三种路径）。
        //   读入不完整 = 本桥接本轮只读不写，如实报 partial。
        async function readBridge(enabled, name, key, read, list) {
          if (!enabled) return list;
          try {
            const changes = await read(list);
            if (!changes || changes.complete !== true || !Array.isArray(changes.list)) {
              bridgeReadFailures.push(`${name}: ${((changes && changes.errors) || ['读取不完整']).join('；')}`);
              bridgeSkipWrite.add(key);
              return list;
            }
            Object.assign(bridgeSnapshotUpdates, changes.snapshotUpdates || {});
            if (changes.changed || bridgeListSignature(list) !== bridgeListSignature(changes.list)) needWriteBack = true;
            for (const remap of changes.pathRemaps || []) bridgeRemaps.set(String(remap.id), remap);
            for (const item of changes.revokedTombstones || []) revokedVersions.add(versionKey(item));
            if (revokedVersions.size) {
              needWriteBack = true;
              bridgeTombstones = bridgeTombstones.filter(keepTombstone);
            }
            for (const id of changes.deletedIds || []) bridgeDeletedIds.add(String(id));
            for (const key2 of changes.deletedPathKeys || []) bridgeDeletedKeys.add(key2);
            return changes.list;
          } catch (e) {
            bridgeReadFailures.push(`${name}: ${e.message}`);
            bridgeSkipWrite.add(key);
            return list;
          }
        }
        const bridgeContext = () => ({ tombstones: bridgeTombstones,
          ackedPathKeys: bridgeState.sync_tombstone_acked || [] });
        finalMergedData = { ...finalMergedData, bookmarks: await readBridge(berryOn, 'Berry', 'berry',
          list => MiniSync.berry.mergeBerryDataWithChanges(list, false,
            MiniSync.tombstone.extractKeys(bridgeTombstones), bridgeContext()), finalMergedData.bookmarks) };
        finalMergedData = { ...finalMergedData, bookmarks: await readBridge(viaOn, 'Via', 'via',
          list => MiniSync.via.mergeViaDataWithChanges(list,
            MiniSync.tombstone.extractKeys(bridgeTombstones), bridgeContext()), finalMergedData.bookmarks) };
        finalMergedData = { ...finalMergedData, bookmarks: await readBridge(airaOn, 'Aira', 'aira',
          list => MiniSync.aira.mergeAiraDataWithChanges([...list], false,
            MiniSync.tombstone.extractKeys(bridgeTombstones), bridgeContext()), finalMergedData.bookmarks) };
        if (bridgeDeletedIds.size || bridgeDeletedKeys.size) {
          needWriteBack = true;
          const keys = MiniSync.xbelPath.computeJsonPathKeys(finalMergedData.bookmarks);
          finalMergedData.bookmarks = finalMergedData.bookmarks.filter(n =>
            !bridgeDeletedIds.has(String(n.id)) && !bridgeDeletedKeys.has(keys.get(n.id)));
          const currentTs = (await MiniSync.storage.getLocal([STORAGE_KEYS.TOMBSTONES]))[STORAGE_KEYS.TOMBSTONES] || [];
          const updatedTs = MiniSync.tombstone.mergeTombstones(currentTs, bridgeDeletedKeys, null, await MiniSync.storage.getDeviceId());
          await MiniSync.storage.setLocal({ [STORAGE_KEYS.TOMBSTONES]: updatedTs });
        }

        // 顺序说明：mergedData 的 _index 已由上方「顺序同步修复」按云端新旧决定
        // （云端较新 → 云端序；否则本地序）；桥接 merge 内部再处理各自的顺序重排
        // 与新增节点补序（见各 adapter），此处不做全局重编——无条件按数组顺序重编
        // 会抹掉未开桥接时的云端顺序覆盖，导致顺序传播失效。

        // 与下载同源：桶就是「同步文件夹」（用户指定或自动探测，已在上面解析并固化）。
        // 所有非 home 内容都落进它 —— 桶外（其他收藏夹里的其它文件夹）不读不写。
        const mergeTargetId = mergeBucketInfo && mergeBucketInfo.id ? String(mergeBucketInfo.id) : null;
        if (!mergeTargetId) throw new Error('找不到同步文件夹（浏览器根下没有任何文件夹）');
        await applyBridgeRemaps(finalMergedData.bookmarks,
          [...bridgeRemaps.values()].filter(remap => !bridgeDeletedIds.has(String(remap.id))),
          mergeTargetId, mergeCreatedIds);
        importResult = await MiniSync.importer.importBookmarksFromData(
          finalMergedData,
          // ★ Berry/Via 已在上面的桥接读入阶段 merge 进 finalMergedData（且带墓碑过滤），
          //   落盘时必须跳过，否则同一份 Berry 文件在一次合并里被重复读入：
          //   ① 重复注入（Berry处理完成日志出现多次，数量在 172/189/174 间摇摆）
          //   ② import 内部的 mergeBerryData 未传墓碑 → 已删节点复活
          //   ③ 每遍都覆盖 berry_pathkey_snapshot → 删除检测口径漂移
          { mode: DOWNLOAD_MODE, mergeIntoLocal: true, mergeMode: true,
            deletedIds: [...new Set([...(mergeResult.localDeletedIds || []), ...bridgeDeletedIds])],
            skipBerryBridge: true, skipViaBridge: true, targetParentId: mergeTargetId }
        );

        if (importResult && ((importResult.conflicts && importResult.conflicts.length) || importResult.moveFailed > 0 || crossZoneDiag.failed > 0)) {
          const failures = (importResult.conflicts || []).length + (importResult.moveFailed || 0) + crossZoneDiag.failed;
          const error = new Error(`${failures} 处本地写入或移动未完成，云端保持不变`);
          error.conflicts = importResult.conflicts || [];
          error.failureCount = failures;
          // 带上本事务写集：失败的 catch 回滚只撤销这些新节点，保留用户并发新增
          error.createdIds = importResult.createdIds || [];
          throw error;
        }

        // ===== 收养节点迁移 =====
        // 场景：A 把文件夹 C6 改名为 8888，B 在 C6 下新增了"新书签"。
        // 合并时 C6 被判为 localDeleted（重命名旧名），但"新书签"是 B 新增的，不应丢失。
        // prune 阶段把"新书签"从 C6 下取出放入 adoptedNodes，这里把它迁移到新名 8888 下。
        if (adoptedNodes.length > 0 && mergeResult.renamePairs && mergeResult.renamePairs.length > 0) {
          // 构建 oldPk → newPk 映射
          const renameMap = new Map(); // oldPk -> newPk
          for (const rp of mergeResult.renamePairs) renameMap.set(rp.oldPk, rp.newPk);
          // 获取当前 Chrome 树，找到新名文件夹的 chrome id
          const chromeTree = await MiniSync.syncInput.getChromeTree();
          const flatList = MiniSync.merger.chromeTreeToList(chromeTree);
          const pkMap = MiniSync.xbelPath.computeJsonPathKeys(flatList);
          for (const adopted of adoptedNodes) {
            // 找到这个收养节点原本在哪个旧名文件夹下（通过其 pathKey 匹配 renameMap 的前缀）
            const adoptedPk = pkMap.get(adopted.id);
            if (!adoptedPk) continue;
            // 找到匹配的重命名对（旧名前缀 → 新名前缀）
            let matchedOldPk = null;
            let matchedNewPk = null;
            for (const [oldPk, newPk] of renameMap) {
              if (adoptedPk === oldPk || adoptedPk.startsWith(oldPk + '/')) {
                matchedOldPk = oldPk;
                matchedNewPk = newPk;
                break; // 只取第一个（最近的祖先）重命名匹配
              }
            }
            if (!matchedOldPk) continue;
            // 目标父文件夹 = 重命名后的新名文件夹本身（matchedNewPk）。
            // 注意：不能对 fullPathUnderNew 用 lastIndexOf('/') 反推父路径——
            // 因为 pathKey 内部（如 URL 的 "https://" 或路径 "/x"）也含层级分隔符 '/'，
            // 会错误截断 targetParentPk，导致收养节点找不到目标父而迁移失败。
            // 收养节点统一落入新名文件夹根下即可保证"不丢书签"。
            const targetParentPk = matchedNewPk;
            // 反查新名父路径对应的 chrome id
            let targetParentId = null;
            for (const [id, pk] of pkMap) {
              if (pk === targetParentPk) { targetParentId = id; break; }
            }
            if (!targetParentId) {
              crossZoneDiag.failed++;
              crossZoneDiag.details.push({ adoptedId: adopted.id, error: '收养节点目标文件夹不存在' });
              continue;
            }
            // 用 Chrome API 移动/创建节点到新父下
            try {
              if (adopted.isFolder) {
                await bookmarkWrite('create', { parentId: targetParentId, title: adopted.title || '' });
              } else if (adopted.url) {
                await bookmarkWrite('create', { parentId: targetParentId, title: adopted.title || '', url: adopted.url });
              }
            } catch (e) {
              crossZoneDiag.failed++;
              crossZoneDiag.details.push({ adoptedId: adopted.id, error: e.message });
              console.warn(`[sync] 收养节点迁移失败 "${adopted.title}": ${e.message}`);
            }
          }
        }
        if (crossZoneDiag.failed > 0) {
          const error = new Error(`${crossZoneDiag.failed} 处本地移动或创建未完成，云端保持不变`);
          error.failureCount = crossZoneDiag.failed;
          throw error;
        }

        // C3（延后执行）：落盘重排之后，用「融合后的本地树」写回云端。
        // 此时本地顺序已是合并结果（含对端新顺序），写回云端不会把新顺序覆盖掉。
        if (needWriteBack) {
          const finalTree = await MiniSync.syncInput.getChromeTree();
          // ★ 云端收到的就是这棵树：提交后用它做基线。PUT 等待期间用户新拖的移动
          //   不在其中，不能进基线（否则下一轮会把它判成「跟随云端」迁回旧位置）。
          confirmedFlat = MiniSync.merger.chromeTreeToList(finalTree);
          // 写云前最后一次复核：导入/重排/收养迁移可能又动过这些节点，宿主也可能
          // 延迟把移动改回去。只要有一条不在目标父节点下，就绝不写回（云端保持原样）。
          if (appliedMoves.length > 0) {
            const finalById = new Map(confirmedFlat.map(n => [String(n.id), n]));
            const lateMissed = appliedMoves.filter(m => {
              const n = finalById.get(String(m.id));
              return !n || String(n.parentId) !== String(m.newParentId);
            });
            if (lateMissed.length > 0) {
              const error = new Error(
                `写回前复核发现 ${lateMissed.length} 个书签/文件夹不在云端的新位置，`
                + '已停止写回云端以保护书签');
              error.failureCount = lateMissed.length;
              error.moveVerification = lateMissed;
              crossZoneDiag.failed += lateMissed.length;
              throw error;
            }
          }
          const deviceId = await MiniSync.storage.getDeviceId();
          // ★ 墓碑用 mergeBookmarks 落定的**并集**（本地 ∪ 云端），不能用本地存储单独取：
          //   只写本机墓碑 = 把云端带来的墓碑整份冲掉，其他端从此再也学不到这次删除
          //   （实测：手机删的书签，桌面同步一轮后云端墓碑变 []，第三台设备复活它）。
          const localTs = await MiniSync.storage.getLocal(['sync_tombstones']);
          const mergedTombstones = MiniSync.tombstone.mergeTombstoneSources(
            (Array.isArray(mergeResult.tombstones) ? mergeResult.tombstones : []).filter(keepTombstone),
            (localTs.sync_tombstones || []).filter(keepTombstone));
          const snapshots = await MiniSync.storage.getLocal(['sync_snapshots']);
          const endpoints = await MiniSync.storage.getLocal(['sync_endpoints']);
          const myEndpoints = endpoints.sync_endpoints || {};
          const writeTs = Date.now();
          const meta = {
            version: CURRENT_VERSION,
            deviceId: deviceId,
            lastModified: writeTs,
            tombstones: mergedTombstones,
            endpoints: { [deviceId]: myEndpoints },
            snapshots: snapshots.sync_snapshots || {},
            // 云端声明的扁平根容器名：桌面端靠它把自己的「其他收藏夹/根目录」镜像包装摊平后写回
            flatRootContainer: MiniSync.utils.getDeclaredFlatRootContainer() || undefined
          };
          const xbelString = MiniSync.xbel.chromeToXbel(finalTree, Object.assign({ syncBucketId: mergeBucketInfo.id }, meta));
          const putResult = await MiniSync.webdav.putFile(config.url, config.username, config.password, config.filename, xbelString, undefined,
            remoteWriteCondition);
          mainCommitted = true;
          mergeWriteProtectionNote = await MiniSync.syncInput.writeProtectionNoteOnce(putResult.protection);
          // ★ 本端把墓碑成功写上了云 ⇒ 这些 key 就是「已确认上云」。
          //   撤销判定（tombstone.js 条件 ⑤）要求这条证据：只依赖「读到云端墓碑」不够，
          //   本端自己发布的墓碑不会再被自己读到，否则「另一设备重新添加」永远撤销不了
          //   （审计回归：readd 用例被打回）。
          try {
            const acked = new Set([
              ...((await MiniSync.storage.getLocal(['sync_tombstone_acked'])).sync_tombstone_acked || []),
              ...mergedTombstones.map(t => (typeof t === 'string' ? t : (t && t.key) || '')).filter(Boolean)
            ]);
            await MiniSync.storage.setLocal({ sync_tombstone_acked: [...acked] });
          } catch (e) { console.warn('[sync] 记录已上云墓碑失败（忽略）:', e.message); }
          // 用 WebDAV 服务器返回的 lastModified 更新本机记录，与上传/下载分支口径一致。
          const cloudTs = (putResult && typeof putResult.lastModified === 'number') ? putResult.lastModified : writeTs;
          try { await MiniSync.storage.setLocal({ [STORAGE_KEYS.CLOUD_LAST_MODIFIED]: cloudTs }); }
          catch (e) { warnings.push('云端版本记录失败: ' + e.message); }
        }
        localCommitted = true;
        if (revokedVersions.size) {
          try {
            const latest = await MiniSync.storage.getLocal([STORAGE_KEYS.TOMBSTONES]);
            await MiniSync.storage.setLocal({
              [STORAGE_KEYS.TOMBSTONES]: (latest[STORAGE_KEYS.TOMBSTONES] || []).filter(keepTombstone)
            });
          } catch (e) { warnings.push('手机重新添加的删除记录撤销失败: ' + e.message); }
        }
        const backupCompletion = await MiniSync.syncInput.completeLocalBackup();
        if (!backupCompletion.ok) warnings.push('备份事务状态保存失败: ' + backupCompletion.error);
        // Adapter reads only propose snapshots. Commit them after local import and
        // the conditional main-file write, so a failed attempt can detect deletions again.
        if (Object.keys(bridgeSnapshotUpdates).length) {
          try { await MiniSync.storage.setLocal(bridgeSnapshotUpdates); }
          catch (e) { warnings.push('手机桥接基线保存失败: ' + e.message); }
        }
      }

      // ★ 统计必须基于「落盘+收养迁移之后」的真实树重新拉取。
      //   此前复用落盘前的 mergedTree，导致合并成功日志显示旧数量（如 180），
      //   而 Chrome 实际已是落盘后的数量（如 186），数字对不上。
      mergedFlatList = MiniSync.merger.chromeTreeToList(await MiniSync.syncInput.getChromeTree());

      // ===== 回迁：合并后 Berry/Via/Aira 桥接各自写回自己的列表（不互相污染） =====
      {
        // 重新读取桥接开关（外层的 berryOn/viaOn/airaOn 在更深作用域，此处不可见）
        const bridgeOpts2 = await MiniSync.storage.getLocal(['option_berry_enabled', 'option_via_enabled', 'option_aira_enabled']);
        const berryOn2 = bridgeOpts2.option_berry_enabled === true;
        const viaOn2 = bridgeOpts2.option_via_enabled === true;
        const airaOn2 = bridgeOpts2.option_aira_enabled === true;
        // Bridge read output is already incorporated before import. Patching the landed tree
        // avoids a second read that could mutate adapter deletion snapshots or reintroduce nodes.
        // ★ 读入失败的桥接必须被排除在写回之外（见上方 bridgeSkipWrite 说明）：
        //   用一个「本地独一无二的标记」把这些桥接的开关临时置 false 交给同一个 patcher，
        //   而不是另开一条写回路径 —— 写回语义只有一处，避免两份实现漂移。
        const berryOnSafe = berryOn2 && !bridgeSkipWrite.has('berry');
        const viaOnSafe = viaOn2 && !bridgeSkipWrite.has('via');
        const airaOnSafe = airaOn2 && !bridgeSkipWrite.has('aira');
        try {
          bridgeOutcome = await MiniSync.bridgePatcher.patchBridges(
            { berryList: mergedFlatList, viaList: mergedFlatList, airaList: mergedFlatList },
            { berryOn: berryOnSafe, viaOn: viaOnSafe, airaOn: airaOnSafe }
          ) || bridgeOutcome;
          // 被跳过的桥接在结果里如实标成「未写回（读取不完整）」，不能显示成 skipped 让人以为
          // 是「本来就没开」——用户与诊断都靠这个字段区分「不用写」和「不敢写」。
          for (const [key, label] of [['berry', 'berry'], ['via', 'viaHtml'], ['aira', 'aira']]) {
            if (bridgeSkipWrite.has(key) && bridgeOutcome.bridgeResults) {
              bridgeOutcome.bridgeResults[label] = {
                status: 'failed',
                error: '读取不完整，本轮不写回该手机文件（避免覆盖未合并的手机书签）'
              };
              if (key === 'via') bridgeOutcome.bridgeResults.viaFavorites = bridgeOutcome.bridgeResults[label];
            }
          }
          if (bridgeSkipWrite.size) bridgeOutcome.partial = true;
        } catch (e) {
          bridgeOutcome = { bridgeResults: { unknown: { status: 'failed', error: e.message } }, partial: true };
          console.warn('[sync] 主文件已提交，手机桥接写回失败:', e.message);
        }
        if (bridgeReadFailures.length) {
          bridgeOutcome.partial = true;
          for (const error of bridgeReadFailures) {
            const name = error.split(':', 1)[0].toLowerCase();
            bridgeOutcome.bridgeResults[name] = { status: 'failed', error };
          }
        }
      }

      // 统计：排除根容器，与上传/下载口径一致
      const mrgDataList = mergedFlatList.filter(n => !MiniSync.merger.isRootContainer(n));
      mergedTotal = mrgDataList.length;
      mergedBookmarkCount = mrgDataList.filter(n => n.url).length;
      mergedFolderCount = mrgDataList.filter(n => !n.url).length;
    } catch (e) {
      console.error('[sync] 合并后落盘失败:', e.message);
      if (backupReady && !mainCommitted && !localCommitted) {
        try {
          recovery = await MiniSync.syncInput.restoreLocalBackup({ replaceCurrent: true, targetParentId: mergeBucketInfo.id,
            // ★ 合并的落盘阶段会按墓碑删除「移动端主页」里的书签（applyTombstoneDeletions 与
            //   落盘裁剪都覆盖 home 区）。提交失败回滚时如果只恢复桶，home 里被删的内容
            //   就永久留在已删状态，而备份里明明还有（审计 2026-10-11 复现 homeRollback）。
            //   因此合并回滚必须把 home 一起纳入恢复范围，并在整棵 home 被删时重建容器。
            includeHome: true, recreateMissingHome: true,
            createdIds: [...mergeCreatedIds, ...(e.writeSet || []), ...(e.createdIds || []),
              ...((importResult && importResult.createdIds) || [])] });
          if (!recovery.ok) console.error('[sync] 回滚未完成:', recovery.reason || recovery.conflicts);
        } catch (re) {
          recovery = { ok: false, reason: re.message };
          console.error('[sync] 回滚失败:', re.message);
        }
      }
      throw e;
    }

    // ===== 回迁：记录本次同步信息（popup 首页渲染用；两参同值，本身即纯书签数） =====
    await MiniSync.syncInput.recordLastSync(mergedBookmarkCount, mergedBookmarkCount);

    // ===== 回迁：写入操作日志（options 页展示用，变化量兼容「N 条 (±N)」解析） =====
    const stats = mergeResult.stats;
    {
      // 日志已迁移到 sync-actions.js 统一写入
    }

    // ★ 移动意图到这里才消费：提交（落盘 + 条件 PUT）已经成功。
    //   失败路径不会执行到这里，意图保留 ⇒ 重试仍认得出本端是发起方，
    //   不会跟着云端旧位置把书签移回去（审计 2026-10-11 复现 moveRetry）。
    if (mergeResult.consumedMoveIntents && mergeResult.consumedMoveIntents.length > 0) {
      try {
        const cur = await MiniSync.storage.getLocal(['sync_move_intents']);
        const intents = cur.sync_move_intents || {};
        let changed = false;
        for (const pk of mergeResult.consumedMoveIntents) {
          if (pk && Object.prototype.hasOwnProperty.call(intents, pk)) { delete intents[pk]; changed = true; }
        }
        if (changed) await MiniSync.storage.setLocal({ sync_move_intents: intents });
      } catch (e) {
        console.warn('[sync] 清理移动意图失败（忽略，下轮会重新判定）:', e.message);
      }
    }
    // 本轮开始前登记的意图（包括本轮没匹配到移动对的）也一并清掉：提交成功意味着
    // 云端已收到本机这一刻的树（本端发起的移动必定触发写回，见 merge.js remoteUpdated），
    // 再留着只会让下一次合并误以为本端仍是发起方、拒绝跟随云端后来的移动。
    // 同步等待期间用户新拖的意图（time > cutoff）保留，等下一轮带上云。
    if (MiniSync.syncInput.clearConfirmedMoveIntents) {
      await MiniSync.syncInput.clearConfirmedMoveIntents(moveIntentCutoff);
    }

    // 同步成功后刷新本地快照（供删除监听回溯被删节点 pathKey）
    await MiniSync.syncInput.saveLocalSnapshot();
    // 基线快照是删除传播的必要状态：写失败会被记录，先尝试补交上次欠的，
    // 再把本次结果如实并入 partial（见 core/sync-input.js saveLocalTreeSnapshot）。
    const baselineRepair = await MiniSync.syncInput.repairBaselineIfNeeded();
    const baselineSave = await MiniSync.syncInput.saveLocalTreeSnapshot(confirmedFlat || undefined);
    const baselineIncomplete = !baselineSave.ok || baselineRepair.ok === false;
    // ★ 同「下载」的真缺陷修复：processNode 的 create() 抛错会收进 conflicts，
    //   旧实现把它丢掉、对外仍说「合并成功」——手机上一条都没落地也看不出来。
    const failedWrites = (importResult && importResult.conflicts ? importResult.conflicts.length : 0);
    const remoteSpliced = (remoteData && remoteData.wrapperSplicedRemote) || 0;
    const conflictSamples = (importResult && importResult.conflicts ? importResult.conflicts : []).slice(0, 3).map(c =>
      `${c.type === 'folder' ? '文件夹' : '书签'}「${c.title || '(无标题)'}」：${c.error || '未知原因'}`);
    if (failedWrites > 0) {
      console.warn(`[sync] 合并落盘有 ${failedWrites} 条写入失败`);
    }
    try {
      await MiniSync.storage.setLocal({
        last_write_report: {
          at: Date.now(),
          via: 'merge',
          ok: failedWrites === 0,
          importedCount: importResult ? importResult.importedCount : 0,
          createdFolderCount: importResult ? importResult.createdFolderCount : 0,
          removedCount: importResult ? importResult.removedCount : 0,
          failedWrites,
          conflictSamples,
          cloudTotal: mergedTotal,
          cloudBmCount: mergedBookmarkCount,
          targets: (importResult && importResult.targets) || [],
          zoneIds: (importResult && importResult.zoneIds) || null,
          requestedTargetId: (importResult && importResult.requestedTargetId) || null,
          flatRootChildId: (importResult && importResult.flatRootChildId) || null,
          bucketId: (importResult && importResult.bucketId) || (mergeBucketInfo && mergeBucketInfo.id) || null,
          bucketTitle: (importResult && importResult.bucketTitle) || (mergeBucketInfo && mergeBucketInfo.title) || null,
          wrapperSpliced: (importResult && importResult.wrapperSpliced) || 0,
          wrapperSplicedRemote: remoteSpliced,
          rootId: (importResult && importResult.rootId) || null,
          rootChildTitles: (importResult && importResult.rootChildTitles) || [],
          landedSample: (importResult && importResult.landedSample) || [],
          crossZoneSkipped: crossZoneDiag.skippedNoParent,
          // 本轮移动判定结果：手机端 console 读不到时，这两个数是「为什么位置没变/被搬回」
          // 的唯一凭据（localMoved>0 = 本端是发起方并写回云端；movedPairs>0 = 本端跟随云端）。
          localMoved: (mergeResult && mergeResult.localMovedCount) || 0,
          movedPairs: (mergeResult && mergeResult.renamePairs ? mergeResult.renamePairs.length : 0),
          // 本机要求落地并经过校验的移动数 / 其中宿主不支持直接 move、改为「先建后删」的条数。
          movesApplied: appliedMoves.length,
          movesRepaired,
          // 重排阶段的真实代价：手机端 console 读不到，这两个数是唯一能看出「卡不卡」的证据。
          // 顺序本来就一致时 movesAttempted 必须是 0（2026-10-05 手机卡顿的根因就是它不是 0）。
          movesAttempted: (importResult && importResult.movesAttempted) || 0,
          movesSkippedParents: (importResult && importResult.movesSkippedParents) || 0,
          moveFailed: (importResult && importResult.moveFailed) || 0
        }
      });
    } catch (e) {
      console.warn('[sync] 写落盘台账失败（忽略）:', e.message);
    }
    if (bridgeOutcome.partial) warnings.push('手机桥接部分失败');
    if (baselineIncomplete) warnings.push('本地基线快照写入失败：删除传播可能延迟');
    try {
      await MiniSync.storage.setSyncStatus({ status: warnings.length ? 'partial' : SUCCESS,
        partial: warnings.length > 0, bridgeResults: bridgeOutcome.bridgeResults, error: warnings.join('；') });
    } catch (e) { warnings.push('同步状态保存失败: ' + e.message); }
    const mergeMessage = buildMergeMessage(failedWrites, conflictSamples, crossZoneDiag, importResult, remoteSpliced)
      + (movesRepaired > 0 ? `（本机宿主未支持直接移动，已重建 ${movesRepaired} 项落地）` : '')
      + (warnings.length ? '（主文件已同步，' + warnings.join('；') + '）' : '') + mergeWriteProtectionNote;
    return {
      success: true,
      partial: warnings.length > 0,
      bridgeResults: bridgeOutcome.bridgeResults || {},
      message: mergeMessage,
      stats: stats,
      importedCount: importResult ? importResult.importedCount : 0,
      removedCount: importResult ? importResult.removedCount : 0,
      conflictCount: failedWrites,
      conflictSamples,
      count: mergedTotal,
      bookmarkCount: mergedBookmarkCount,
      folderCount: mergedFolderCount,
      diff: {
        added: stats ? stats.added || 0 : 0,
        removed: stats ? stats.deleted || 0 : 0
      },
      crossZoneDiag
    };

  } catch (error) {
    console.error('[sync] 合并失败:', error.message);
    if (mainCommitted || localCommitted) {
      try { await MiniSync.syncInput.saveLocalTreeSnapshot(confirmedFlat || undefined); }
      catch (e) { warnings.push('本地基线快照写入失败: ' + e.message); }
      warnings.push(error.message);
      try { await MiniSync.storage.setSyncStatus({ status: 'partial', partial: true, error: warnings.join('；') }); }
      catch (_) { /* The confirmed commit must not be retried on a status storage failure. */ }
      return { success: true, partial: true, committed: true,
        message: '主文件已同步，后续处理未完成: ' + warnings.join('；') };
    }
    try { await MiniSync.storage.setSyncStatus({ status: FAILED, error: error.message }); }
    catch (e) { console.warn('[sync] 保存失败状态异常:', e.message); }
    return { success: false, message: `合并失败: ${error.message}`, code: error.code,
      retryable: error.retryable === true && (!backupReady || !!(recovery && recovery.ok)), recovery,
      conflictCount: error.failureCount || (error.conflicts || []).length, conflicts: error.conflicts || [] };
  } finally {
    // 事务结束必须解锁：后续同步要按当时的最新设置重新锁定目标。
    if (MiniSync.utils.clearTransactionWebDAVConfig) MiniSync.utils.clearTransactionWebDAVConfig();
    if (MiniSync.utils.endTransactionDeletionTracking) MiniSync.utils.endTransactionDeletionTracking();
  }
}

return {
  mergeSync
};

})();
