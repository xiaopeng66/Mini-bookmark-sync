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

function mergeSync(options) {
  // ★ 互斥队列：同 sync-orchestrator.js 的 upload/download（排队而非打断，
  //   避免「自动合并进行中 → 手动/下一次 alarm 强设 IDLE 后并发跑」互相覆盖云端数据）
  return MiniSync.syncMutex.run(() => doMergeSync(options));
}

async function doMergeSync(options) {
  options = options || {};
  // 拿到锁后状态仍是 SYNCING → 必为 SW 崩溃/重启残留，恢复为 IDLE
  const status = await MiniSync.storage.getSyncStatus();
  if (status.status === SYNCING) {
    await MiniSync.storage.setSyncStatus({ status: IDLE });
  }

  try {
    await MiniSync.storage.setSyncStatus({ status: SYNCING, action: 'merge' });

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

    const remoteContent = await MiniSync.webdav.getFile(config.url, config.username, config.password, config.filename);
    const remoteData = remoteContent ? MiniSync.xbel.parseXbelFromString(remoteContent) : null;

    // ★ 云端已解析（parseXbelFromString 写入了它声明的容器名）之后才解析「同步文件夹」：
    //   桌面 Edge 只能靠那个声明认出「其他收藏夹/根目录」这层镜像就是自己的桶，
    //   早于云端解析就会退化成空的书签栏，还会把这个错误的答案固化进设置。
    try {
      mergeBucketInfo = await MiniSync.syncInput.resolveSyncBucketSetting();
    } catch (e) {
      console.warn('[sync] 解析同步文件夹失败:', e.message);
    }

    // 读取本机记录的「上次同步时云端文件的修改时间」。
    // 同时用 WebDAV getFileInfo 获取服务器当前文件时间，与 CLOUD_LAST_MODIFIED 同一口径。
    // 不直接用 XBEL metadata 里的 lastModified，因为它写入时用的是本机 Date.now()，和
    // WebDAV 服务器 Last-Modified 头可能差几百毫秒，导致顺序冲突判断误判。
    const lastSeenData = await MiniSync.storage.getLocal([STORAGE_KEYS.CLOUD_LAST_MODIFIED]);
    const localLastSeen = (lastSeenData && lastSeenData[STORAGE_KEYS.CLOUD_LAST_MODIFIED]) || 0;
    // 顺序冲突判断容差：仅为吸收「putFile 返回的 lastModified 与后续 getFileInfo 的
    // mtime」之间的秒级格式化偏差（同一文件的 mtime 本身不会变）。此前设 60s，导致
    // 「一端合并回写后，另一端在 1 分钟内合并」时真实的云端新顺序被误判为「云端未更新」
    // 而不覆盖（实测 51s 内必现），顺序传播失效。2s 足够吸收格式化偏差。
    const ORDER_TOLERANCE = 2000;
    let remoteLastModified = 0;
    try {
      const fileInfo = await MiniSync.webdav.getFileInfo(config.url, config.username, config.password, config.filename);
      remoteLastModified = (fileInfo && fileInfo.lastModified) || 0;
    } catch (e) {
      // 获取失败时保持 0（表示拿不到云端时间，保守保留本地顺序，不覆盖）。
      // 注：不可用 XBEL metadata 里的 lastModified 退路——那是本机 Date.now() 写入的，
      // 与 WebDAV 服务器时间口径不一致，会导致顺序冲突判断误判（详见 415 行注释）。
      console.warn('[sync] 获取云端文件信息失败，顺序冲突将保守保留本地:', e.message);
    }

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
        const flatList = MiniSync.merger.chromeTreeToList(localTree);
        const myDeviceId = await MiniSync.storage.getDeviceId();
        const cleaned = MiniSync.tombstone.cleanFakeTombstones(current, flatList, myDeviceId);
        if (cleaned.length < current.length) {
          await MiniSync.storage.setLocal({ [STORAGE_KEYS.TOMBSTONES]: cleaned });
        }
      }
    }

    // C2: 合并
    const mergeResult = await MiniSync.merger.mergeBookmarks(localTree, remoteData, config);

    // C3（前置）：是否需要在「落盘重排之后」写回云端。
    // 注意：云端写回必须放在落盘重排之后执行，否则会用重排前的旧本地顺序覆盖云端，
    // 把对端刚同步上来的新顺序抹掉（表现为「顺序又变回之前」）。
    let mergedTree = await MiniSync.syncInput.getChromeTree();
    const needWriteBack = mergeResult.remoteUpdated;

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
    // 落盘结果（importBookmarksFromData 的返回值），供最终统计展示实际增删。
    // 必须声明在 try 外：import 调用点在 try 内深层块，而 return 在 try/catch 之后读取它。
    let importResult = null;
    try {
      await MiniSync.syncInput.backupLocalTree();

      // ===== 顺序冲突判断 =====
      // 仅有顺序变化（无新增/删除）时，唯一差异是节点 _index。此时需判断哪端顺序更新：
      // - 若云端 XBEL 的修改时间 <= 本机上次同步记录的时间（remoteLastModified <= localLastSeen），
      //   说明云端文件自本机上次同步后没被别人改过，当前顺序差异来自本机本地改动，
      //   应以本机当前顺序为准写回云端（不重排本地）。
      // - 若云端修改时间 > 本机记录的时间，说明对端先改了顺序并已写回云端，
      //   本机应接受云端顺序（落盘重排为云端顺序）。
      // - localLastSeen === 0（本机从未同步过该文件）时，保守以云端为准（首次对齐）。
      // 注：remoteLastModified 取 XBEL metadata 里本程序写入的 lastModified，不受 WebDAV
      // 服务器文件系统时间漂移影响，可稳定比对。
      const onlyOrderChanged = mergeResult.orderChanged &&
        mergeResult.stats.added === 0 &&
        mergeResult.stats.deleted === 0 &&
        (mergeResult.localOnlyIds ? mergeResult.localOnlyIds.length === 0 : true);
      const localOrderWins = onlyOrderChanged && localLastSeen > 0 && remoteLastModified <= localLastSeen + ORDER_TOLERANCE;

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
            try {
              // 直接改真实 chrome 节点：保 id、保子树，后续 re-read 自然带上新标题
              chrome.bookmarks.update(String(rn.id), { title: rn.title || '' }, () => void chrome.runtime.lastError);
            } catch (e) {
              console.warn(`[sync] 本端改名失败 "${rn.title}" (${rn.id}): ${e.message}`);
            }
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
          const updateSet = new Set(mergeResult.contentUpdatedIds.map(id => String(id)));
          (function applyContentUpdate(node) {
            if (!node) return;
            if (updateSet.has(String(node.id))) {
              const pk = mPKs.get(String(node.id));
              const remoteNode = pk ? remoteByPk.get(pk) : null;
              if (remoteNode) {
                if (remoteNode.url !== undefined) node.url = remoteNode.url;
                if (remoteNode.title !== undefined) node.title = remoteNode.title;
                // ★ 同步更新真实 chrome 节点：import 的复用逻辑按 url+标题匹配，
                //   标题被改的节点永远匹配不上（落到全局 URL 复用也不改标题），
                //   不在此处直接 update，内容变更无法落盘（实测复现）。
                try {
                  chrome.bookmarks.update(String(node.id), { title: node.title }, () => void chrome.runtime.lastError);
                } catch (_) { /* mock/异常环境忽略 */ }
              }
            }
            if (node.children) for (const child of node.children) applyContentUpdate(child);
          })(mergedTree[0]);
        }

        // ===== 文件夹移动重定位（拖动文件夹跨路径落盘不生效的修复）=====
        // merge.js 把「不同父 + 同名」的文件夹识别为移动，写进 renamePairs(oldPk→newPk)。
        // 这里把它在本机树上真正搬过去，使落盘位置正确。
        // ★ 同步范围只有一个「同步桶」，所以移动只可能发生在桶内部：
        //   · 旧父在桶里 ⇒ 新旧父的 pk 都能在本地树里查到真实 id；
        //   · 新父是桶本身 ⇒ 用桶的 id 兜底（旧版这里要解析 ROOT:bar/other/mobile
        //     三套虚拟容器，还带硬编码 '1'/'2'/'3' 的兜底 —— 跨区移动、跨区降级删除
        //     就是「书签乱跑 / 两轮合并清空书签」的来源，整块删掉）。
        if (mergeResult.renamePairs && mergeResult.renamePairs.length > 0) {
          const flat = MiniSync.merger.chromeTreeToList(mergedTree);
          const pkMap = MiniSync.xbelPath.computeJsonPathKeys(flat);
          const idByPk = new Map();
          for (const n of flat) { const pk = pkMap.get(n.id); if (pk) idByPk.set(pk, n.id); }
          // 现存文件夹 id 集合：移动前先确认目标父真的存在，否则**不动**（宁可位置旧，
          // 也不许「删了重建」——那正是书签丢失的来源）。
          const existingFolderIds = new Set(flat.filter(n => !n.url).map(n => String(n.id)));
          const localBucket = MiniSync.utils.resolveSyncBucket(
            (mergedTree[0] && mergedTree[0].children) || [],
            {
              bucketId: MiniSync.utils.getSyncBucketId ? MiniSync.utils.getSyncBucketId() : '',
              declaredWrapper: MiniSync.utils.getDeclaredFlatRootContainer ? MiniSync.utils.getDeclaredFlatRootContainer() : ''
            }
          );
          const bucketId = localBucket ? String(localBucket.id) : null;
          if (bucketId) {
            existingFolderIds.add(bucketId);
          }
          // 本地「桶」对应的 pk 前缀：桶内内容的父链顶点（zoneRoot 节点 → 'ROOT:bar'）
          const bucketRootPk = 'ROOT:bar';

          const remotePKsMap = (remoteData && Array.isArray(remoteData.bookmarks))
            ? MiniSync.xbelPath.computeJsonPathKeys(remoteData.bookmarks) : new Map();
          const remoteByIdMp = new Map(((remoteData && remoteData.bookmarks) || []).map((n) => [String(n.id), n]));
          const remoteNodeByPk = new Map();
          for (const [rid, rpk] of remotePKsMap) {
            const rn = remoteByIdMp.get(String(rid));
            if (rn) remoteNodeByPk.set(rpk, rn);
          }
          for (const { oldPk, newPk } of mergeResult.renamePairs) {
            const nodeId = idByPk.get(oldPk);
            const localNode = nodeId != null ? flat.find((n) => String(n.id) === String(nodeId)) : null;
            const oldParent = localNode
              ? (pkMap.get(String(localNode.parentId)) || (String(localNode.parentId) === String(bucketId) ? bucketRootPk : null))
              : null;
            const remoteNode = remoteNodeByPk.get(newPk);
            let newParent = null;
            if (remoteNode) {
              newParent = (String(remoteNode.parentId) === ROOT_ID)
                ? bucketRootPk
                : (remotePKsMap.get(String(remoteNode.parentId)) || null);
            }
            let newParentId = newParent ? idByPk.get(newParent) : undefined;
            if (newParent === bucketRootPk) newParentId = bucketId;   // 移到桶顶层
            if (!oldParent || !newParent || oldParent === newParent) continue;
            crossZoneDiag.moves++;
            if (!nodeId || !newParentId) continue;
            if (!existingFolderIds.has(String(newParentId))) {
              // 目标文件夹在本机不存在（例如云端在某个尚未落盘的文件夹里动了它）⇒
              // 不动它：节点留在原处就是它在桶里的合法位置，删了才真的丢。
              crossZoneDiag.failed++;
              crossZoneDiag.skippedNoParent++;
              crossZoneDiag.details.push({ nodeId, oldPk, newPk, newParentId, error: '目标文件夹不存在，保留原节点' });
              continue;
            }
            try {
              await chrome.bookmarks.move(String(nodeId), { parentId: String(newParentId) });
            } catch (e) {
              // move 失败不再降级删除（旧实现在这里 removeTree 再靠落盘重建，一旦重建
              // 失败就永久丢失）。保持原位，如实记诊断。
              crossZoneDiag.failed++;
              crossZoneDiag.details.push({ nodeId, oldPk, newPk, newParentId, error: e.message });
              console.warn(`[sync] 文件夹移动失败（保持原位）"${nodeId}" -> ${newParentId}: ${e.message}`);
            }
          }
          // 移动后真实树已变更，重新拉取以保证后续落盘基于最新结构
          mergedTree = await MiniSync.syncInput.getChromeTree();
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
          // 顺序以谁为准：仅当云端文件确实比本机上次同步记录更新（remoteLastModified > localLastSeen + 容差）时，
          // 才用云端顺序覆盖本地；否则保留本地当前顺序（双向同步：本地刚调的顺序不能丢）。
          // 加容差是因为合并写回云端时记录的 lastSeen 与当前云端文件 mtime 可能相差数秒，
          // 不加容差会永远判定「云端更新」从而把本地改动回退（见 ORDER_TOLERANCE）。
          const useRemoteOrder = remoteLastModified > localLastSeen + ORDER_TOLERANCE;
          for (const [pk, node] of mergedIndexByKey) {
            if (remoteIndexByKey.has(pk)) {
              if (useRemoteOrder) {
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
            for (const node of remoteOnlyNodes) {
              const pk = remoteKeys.get(node.id);
              if (!pk || mergedKeySet.has(pk)) continue;
              const clone = JSON.parse(JSON.stringify(node));
              // 若父节点在本地已存在（bothPresent），把 parentId 从远程 id 映射到本地 id；
              // 若父节点也是 remoteOnly，则保持远程 id，父节点已先被追加进 mergedData。
              if (clone.parentId && clone.parentId !== ROOT_ID) {
                const parentPk = remoteKeys.get(clone.parentId);
                if (parentPk && pkToMergedId.has(parentPk)) {
                  clone.parentId = pkToMergedId.get(parentPk);
                }
              }
              mergedData.bookmarks.push(clone);
              mergedKeySet.add(pk);
              remoteOnlyAppended++;
            }
          }
        }

        // 读入 Berry/Via/Aira 变更，确保双向同步（受开关约束，与 bridge-patcher 写回保持一致）
        // 墓碑必须用 extractKeys 转成 pathKey 字符串集合：sync_tombstones 存的是
        // {key,deletedAt,deviceId} 对象数组，直接 new Set() 会让 has(pk) 永远为 false。
        const tombstoneRaw = (await MiniSync.storage.getLocal([STORAGE_KEYS.TOMBSTONES]))[STORAGE_KEYS.TOMBSTONES] || [];
        const tombstoneKeys = MiniSync.tombstone.extractKeys(tombstoneRaw);
        const bridgeOpts = await MiniSync.storage.getLocal(['option_berry_enabled', 'option_via_enabled', 'option_aira_enabled']);
        const berryOn = bridgeOpts.option_berry_enabled === true;
        const viaOn = bridgeOpts.option_via_enabled === true;
        const airaOn = bridgeOpts.option_aira_enabled === true;
        let finalMergedData = mergedData;
        // 桥接合并【必须传墓碑】。
        // 桥接函数内部 tombstoneKeys 只用于「过滤桥接端新增节点」（命中墓碑的不注入），
        // 从不删除本地节点——所以传墓碑是安全的。
        // 若不传，用户在 Edge 删除的文件夹只要还在 Aira/Berry/Via 文件里，
        // 就会被桥接重新注入落盘数据，表现为「删了又回来」。
        if (berryOn) {
          try {
            finalMergedData = { ...finalMergedData, bookmarks: await MiniSync.berry.mergeBerryData(finalMergedData.bookmarks, false, tombstoneKeys) };
          } catch (e) {
            console.warn('[sync] Berry 读入失败，跳过:', e.message);
          }
        }
        if (viaOn) {
          try {
            const viaResult = await MiniSync.via.mergeViaData(finalMergedData.bookmarks, tombstoneKeys);
            if (viaResult) finalMergedData = { ...finalMergedData, bookmarks: viaResult };
          } catch (e) {
            console.warn('[sync] Via 读入失败，跳过:', e.message);
          }
        }
        if (airaOn) {
          try {
            // ★ 传拷贝：mergeAiraData 内部会向列表追加 home 节点，
            //   若与 viaList 共享引用会把 Aira 数据污染进 Via 回写
            finalMergedData = { ...finalMergedData, bookmarks: await MiniSync.aira.mergeAiraData([...(finalMergedData.bookmarks || [])], false, tombstoneKeys) };
          } catch (e) {
            console.warn('[sync] Aira 读入失败，跳过:', e.message);
          }
        }

        // 顺序说明：mergedData 的 _index 已由上方「顺序同步修复」按云端新旧决定
        // （云端较新 → 云端序；否则本地序）；桥接 merge 内部再处理各自的顺序重排
        // 与新增节点补序（见各 adapter），此处不做全局重编——无条件按数组顺序重编
        // 会抹掉未开桥接时的云端顺序覆盖，导致顺序传播失效。

        // 与下载同源：桶就是「同步文件夹」（用户指定或自动探测，已在上面解析并固化）。
        // 所有非 home 内容都落进它 —— 桶外（其他收藏夹里的其它文件夹）不读不写。
        const mergeTargetId = mergeBucketInfo && mergeBucketInfo.id ? String(mergeBucketInfo.id) : null;
        if (!mergeTargetId) throw new Error('找不到同步文件夹（浏览器根下没有任何文件夹）');
        importResult = await MiniSync.importer.importBookmarksFromData(
          finalMergedData,
          // ★ Berry/Via 已在上面的桥接读入阶段 merge 进 finalMergedData（且带墓碑过滤），
          //   落盘时必须跳过，否则同一份 Berry 文件在一次合并里被重复读入：
          //   ① 重复注入（Berry处理完成日志出现多次，数量在 172/189/174 间摇摆）
          //   ② import 内部的 mergeBerryData 未传墓碑 → 已删节点复活
          //   ③ 每遍都覆盖 berry_pathkey_snapshot → 删除检测口径漂移
          { mode: DOWNLOAD_MODE, mergeIntoLocal: true, mergeMode: true, deletedIds: mergeResult.localDeletedIds || [], skipBerryBridge: true, skipViaBridge: true,
            targetParentId: mergeTargetId }
        );

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
            if (!targetParentId) continue;
            // 用 Chrome API 移动/创建节点到新父下
            try {
              if (adopted.isFolder) {
                await chrome.bookmarks.create({ parentId: targetParentId, title: adopted.title || '' });
              } else if (adopted.url) {
                await chrome.bookmarks.create({ parentId: targetParentId, title: adopted.title || '', url: adopted.url });
              }
            } catch (e) {
              console.warn(`[sync] 收养节点迁移失败 "${adopted.title}": ${e.message}`);
            }
          }
        }

        // C3（延后执行）：落盘重排之后，用「融合后的本地树」写回云端。
        // 此时本地顺序已是合并结果（含对端新顺序），写回云端不会把新顺序覆盖掉。
        if (needWriteBack) {
          const finalTree = await MiniSync.syncInput.getChromeTree();
          const deviceId = await MiniSync.storage.getDeviceId();
          // ★ 墓碑用 mergeBookmarks 落定的**并集**（本地 ∪ 云端），不能用本地存储单独取：
          //   只写本机墓碑 = 把云端带来的墓碑整份冲掉，其他端从此再也学不到这次删除
          //   （实测：手机删的书签，桌面同步一轮后云端墓碑变 []，第三台设备复活它）。
          const localTs = await MiniSync.storage.getLocal(['sync_tombstones']);
          const mergedTombstones = Array.isArray(mergeResult.tombstones)
            ? mergeResult.tombstones
            : (localTs.sync_tombstones || []);
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
          const putResult = await MiniSync.webdav.putFile(config.url, config.username, config.password, config.filename, xbelString);
          // 用 WebDAV 服务器返回的 lastModified 更新本机记录，与上传/下载分支口径一致。
          const cloudTs = (putResult && typeof putResult.lastModified === 'number') ? putResult.lastModified : writeTs;
          await MiniSync.storage.setLocal({ [STORAGE_KEYS.CLOUD_LAST_MODIFIED]: cloudTs });
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
        // 同样传墓碑：防止已删节点残留桥接文件，下次合并再次注入复活
        const tsRaw2 = (await MiniSync.storage.getLocal([STORAGE_KEYS.TOMBSTONES]))[STORAGE_KEYS.TOMBSTONES] || [];
        const tombstoneKeys2 = MiniSync.tombstone.extractKeys(tsRaw2);
        const berryList = berryOn2
          ? (await MiniSync.berry.mergeBerryData(mergedFlatList, false, tombstoneKeys2).catch(e => { console.warn('[sync] 合并时 Berry 读入失败，跳过:', e.message); return mergedFlatList; }))
          : mergedFlatList;
        const viaList = viaOn2
          ? (await MiniSync.via.mergeViaData(mergedFlatList, tombstoneKeys2).catch(e => { console.warn('[sync] 合并时 Via 读入失败，跳过:', e.message); return mergedFlatList; }) || mergedFlatList)
          : mergedFlatList;
        const airaList = airaOn2
          ? (await MiniSync.aira.mergeAiraData([...mergedFlatList], false, tombstoneKeys2).catch(e => { console.warn('[sync] 合并时 Aira 读入失败，跳过:', e.message); return mergedFlatList; }))
          : mergedFlatList;
        await MiniSync.bridgePatcher.patchBridges(
          { berryList, viaList, airaList },
          { berryOn: berryOn2, viaOn: viaOn2, airaOn: airaOn2 }
        );
      }

      // 统计：排除根容器，与上传/下载口径一致
      const mrgDataList = mergedFlatList.filter(n => !MiniSync.merger.isRootContainer(n));
      mergedTotal = mrgDataList.length;
      mergedBookmarkCount = mrgDataList.filter(n => n.url).length;
      mergedFolderCount = mrgDataList.filter(n => !n.url).length;
    } catch (e) {
      console.error('[sync] 合并后落盘失败，回滚备份:', e.message);
      try { await MiniSync.syncInput.restoreLocalBackup({ replaceCurrent: true }); } catch (re) { console.error('[sync] 回滚失败:', re.message); }
      throw e;
    }

    // ===== 回迁：记录本次同步信息（popup 首页渲染用；两参同值，本身即纯书签数） =====
    await MiniSync.syncInput.recordLastSync(mergedBookmarkCount, mergedBookmarkCount);

    // ===== 回迁：写入操作日志（options 页展示用，变化量兼容「N 条 (±N)」解析） =====
    const stats = mergeResult.stats;
    {
      // 日志已迁移到 sync-actions.js 统一写入
    }

    await MiniSync.storage.setSyncStatus({ status: SUCCESS });

    // 同步成功后刷新本地快照（供删除监听回溯被删节点 pathKey）
    await MiniSync.syncInput.saveLocalSnapshot();
    await MiniSync.syncInput.saveLocalTreeSnapshot();
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
    return {
      success: true,
      message: buildMergeMessage(failedWrites, conflictSamples, crossZoneDiag, importResult, remoteSpliced),
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
    await MiniSync.storage.setSyncStatus({ status: FAILED, error: error.message });
    return { success: false, message: `合并失败: ${error.message}` };
  }
}

return {
  mergeSync
};

})();
