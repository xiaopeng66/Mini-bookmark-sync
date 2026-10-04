// core/sync-orchestrator.js — 同步编排层（薄壳）
// 仅保留上传/下载两条路径，并透传备份/快照辅助；合并路径已迁移至 core/sync-merge.js。
// 输入/IO 辅助位于 core/sync-input.js (MiniSync.syncInput)。
// 对外接口保持：MiniSync.orchestrator.{uploadBookmarks,downloadBookmarks,mergeSync,restoreLocalBackup,saveLocalSnapshot}

MiniSync.orchestrator = (function() {

function uploadBookmarks(options) {
  // ★ 互斥队列：同一实例同一时刻只允许一个同步流程执行。手动操作排队等待
  //   （而非打断进行中的流程），避免两个流程并发读写云端 XBEL 互相覆盖。
  //   （此前是检测到 SYNCING 强设 IDLE 直接开跑——正是并发覆盖的缺口）
  return MiniSync.syncMutex.run(() => doUploadBookmarks(options));
}

async function doUploadBookmarks(options) {
  options = options || {};
  // 拿到互斥锁后状态仍是 SYNCING → 必为 SW 崩溃/重启残留（真在跑的流程占着内存锁），
  // 恢复为 IDLE；storage.getSyncStatus 自带 5 分钟看门狗兜底释放陈旧状态。
  const status = await MiniSync.storage.getSyncStatus();
  if (status.status === SYNCING) {
    await MiniSync.storage.setSyncStatus({ status: IDLE });
  }

  try {
    await MiniSync.storage.setSyncStatus({ status: SYNCING, action: 'upload' });

    // ★ 顺序很要紧：本机的树与 deviceId 都要**等云端读过、墓碑消费过之后**再取。
    //   ① 「同步文件夹」只能靠云端那份 flatRootContainer 声明才能认出来（桌面 Edge 必须
    //      靠它认出「其他收藏夹/根目录」这层手机镜像就是自己的桶）。先解析的话桌面会把
    //      （多半为空的）书签栏固化成桶 —— 镜像里的书签被甩在同步范围外，上传还把云端写成空的。
    //   ② 「上传」必须先把云端删过的节点在本机删掉（applyTombstoneDeletions），否则会把
    //      它们原样覆盖回云端 —— 删除被反推成复活（实测：手机删的书签，桌面点上传又回来了）。
    //   所以 config → 读云端 → 定桶 → 删本地 → 再取树 → 写云端。
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

    // ===== 回迁：上传前云端冲突检测（非强制上传） =====
    // 云端文件 lastModified 比本地记录新 → 说明被其他设备修改过，需用户确认
    if (!options.force) {
      try {
        const remoteInfo = await MiniSync.webdav.getFileInfo(config.url, config.username, config.password, config.filename);
        if (remoteInfo.exists && remoteInfo.lastModified > 0) {
          const stored = await MiniSync.storage.getLocal([STORAGE_KEYS.CLOUD_LAST_MODIFIED]);
          const lastSeen = stored[STORAGE_KEYS.CLOUD_LAST_MODIFIED] || 0;
          if (lastSeen > 0 && remoteInfo.lastModified > lastSeen) {
            console.warn(`[sync] 检测到云端文件已被其他设备修改 (${endpointKey})`);
            await MiniSync.storage.setSyncStatus({ status: IDLE });
            return {
              success: false,
              code: 'CLOUD_CONFLICT',
              message: '云端书签已被其他设备修改，请选择「仍然上传」覆盖，或先「下载同步」',
              remoteModified: remoteInfo.lastModified,
              endpointKey: endpointKey
            };
          }
        }
      } catch (e) {
        // 冲突检测失败不阻断上传（网络抖动等场景保持兼容）
        console.warn('[sync] 上传前冲突检测失败（忽略）:', e.message);
      }
    }

    // ★ 上传前尽力读一次云端正文，只为取「写入端声明的扁平根容器名」：
    //   桌面 Edge 本机是标准三区（根下有书签栏/其他收藏夹），它识别不出自己
    //   「其他收藏夹/根目录」这一层是手机容器的镜像 —— 只能靠云端 XBEL 的
    //   <flatRootContainer> 元数据。拿到名字后 chromeToXbel 才会把这层包装摊平再写回，
    //   否则云端永远带着包装（手机端每轮都得拆一次，云端文件反复变）。
    //   读失败不影响上传（按本机形态写，与旧行为一致）。
    let remoteBookmarkCount = 0;
    let remoteData = null;
    try {
      const remoteContent = await MiniSync.webdav.getFile(config.url, config.username, config.password, config.filename);
      if (remoteContent) {
        const rd = MiniSync.xbel.parseXbelFromString(remoteContent);
        if (rd) {
          remoteData = rd;
          remoteBookmarkCount = (rd.bookmarks || []).filter(n => n.url).length;
          if (rd.flatRootContainer) MiniSync.utils.setDeclaredFlatRootContainer(rd.flatRootContainer);
        }
      }
    } catch (e) {
      console.warn('[sync] 上传前读取云端声明失败（按本机形态写）:', e.message);
    }

    // ★ 单同步桶：「同步文件夹」必须在**读过云端声明之后**才解析（顺序不能反）。
    //   桌面 Edge 是标准三区宿主，它认出「其他收藏夹/根目录」这层手机镜像就是自己的
    //   同步文件夹，靠的只有云端那份 flatRootContainer 声明。先解析的话，桌面会把
    //   （多半为空的）书签栏固化成桶 —— 于是镜像里的书签被甩在同步范围之外，
    //   上传还会把云端写成空的（实测复现并修掉）。
    const declaredCloud = MiniSync.utils.getDeclaredFlatRootContainer
      ? MiniSync.utils.getDeclaredFlatRootContainer() : '';
    const bucketInfo = await MiniSync.syncInput.resolveSyncBucketSetting();
    if (!bucketInfo.id) throw new Error('找不到同步文件夹（浏览器根下没有任何文件夹）');
    // 「上传」是「以本机为准覆盖云端」的动作。若云端声明的同步文件夹在本机不存在
    // （典型：手机建的容器还没同步到这台桌面），本次上传的覆盖范围会以本机探测到的
    // 文件夹为准 —— 如实说出来，用户才知道该先点「合并」。
    let uploadNote = '';
    if (declaredCloud && String(declaredCloud) !== String(bucketInfo.title || '')) {
      uploadNote = `（注意：云端的同步文件夹「${declaredCloud}」在本机不存在，本次以本机「${bucketInfo.title}」为准覆盖云端`
        + '；若云端有要保留的书签，请先点「合并」）';
    }

    // ===== 增量删减：上传也要减量，不是「只加不删」 =====
    // ① 快照差异回溯：本机删过、但 onRemoved 没触发的节点，在此补记墓碑（与合并共用助手）。
    //    只加不记的话，云端文件里少了这些节点却没有墓碑，对端会把它们当「云端新增」建回来。
    let backfilled = 0;
    try {
      backfilled = await MiniSync.syncInput.backfillDeletedTombstones(
        MiniSync.merger.chromeTreeToList(await MiniSync.syncInput.getChromeTree())
      );
    } catch (e) {
      console.warn('[sync] 上传前墓碑回溯失败（继续）:', e.message);
    }
    // ② 消费「本地 ∪ 云端」墓碑：云端已删、而本机还留着的节点，先在本机删掉再上传。
    //    不删的话本机会把它们原样覆盖回云端 —— 用户的删除被反推成「复活」。
    let deletions = { deletedCount: 0, tombstones: null };
    try {
      deletions = await MiniSync.syncInput.applyTombstoneDeletions(remoteData);
    } catch (e) {
      console.warn('[sync] 上传前应用云端删除失败（按本机状态上传）:', e.message);
    }
    if (deletions.deletedCount > 0) {
      uploadNote += `（按云端的删除记录，已同时从本机删掉 ${deletions.deletedCount} 项）`;
    }
    if (backfilled > 0) {
      console.log(`[sync] 快照差异回溯补充墓碑 ${backfilled} 条`);
    }

    // 树必须在删除之后取：写出去的就是删完的真实本机状态。
    const tree = await MiniSync.syncInput.getChromeTree();
    // ===== 回迁：Berry 扁平根目录上传时用虚拟文件夹结构（避免顶层书签丢失/分层错乱） =====
    const xbelTree = await MiniSync.syncInput.getLocalTreeForXbel();

    const deviceId = await MiniSync.storage.getDeviceId();
    const snapshots = await MiniSync.storage.getLocal(['sync_snapshots']);
    const endpoints = await MiniSync.storage.getLocal(['sync_endpoints']);
    const myEndpoints = endpoints.sync_endpoints || {};
    const meta = {
      version: CURRENT_VERSION,
      deviceId: deviceId,
      lastModified: Date.now(),
      // ★ 写**并集**（本地 ∪ 云端）：只写本机墓碑会把云端墓碑整份冲掉，
      //   其他端从此再也学不到这次删除（实测：桌面点一次上传，云端墓碑变 []）。
      tombstones: Array.isArray(deletions.tombstones) ? deletions.tombstones : [],
      endpoints: { [deviceId]: myEndpoints },
      snapshots: snapshots.sync_snapshots || {},
      // 云端声明的扁平根容器名：桌面端靠它把自己的「其他收藏夹/根目录」镜像包装摊平后写回
      flatRootContainer: declaredCloud || undefined
    };

    const xbelString = MiniSync.xbel.chromeToXbel(xbelTree, Object.assign({ syncBucketId: bucketInfo.id }, meta));
    const putResult = await MiniSync.webdav.putFile(config.url, config.username, config.password, config.filename, xbelString);
    // 记录云端 lastModified，供下次上传冲突检测使用
    await MiniSync.storage.setLocal({ [STORAGE_KEYS.CLOUD_LAST_MODIFIED]: putResult.lastModified || Date.now() });

    // 上传后 Berry/Via 桥接写回（先读入变更，再写回；受开关约束）
    // ★ 关键：上传用 flatList 保持纯 Chrome 数据；bridgeList 用于桥接文件写回
    const flatList = MiniSync.merger.chromeTreeToList(tree);

    // 统计：排除根容器与透明节点（桶自身、同名包装）——它们不是内容
    const dataList = flatList.filter(n => !MiniSync.merger.isRootContainer(n) && !n.zoneRoot);
    const totalCount = dataList.length;
    const bmCount = dataList.filter(n => n.url).length;
    const folderCount = totalCount - bmCount;
    console.log(`[sync] ⬆️ 上传完成: ${totalCount} 条数据 (${bmCount} 书签 + ${folderCount} 文件夹)`);

    // 覆盖前如实提醒（不阻断上传）：本机同步文件夹里一条书签都没有、而云端有 ——
    // 用户多半是想先「合并」把云端拉下来，而不是把云端清空。
    if (bmCount === 0 && remoteBookmarkCount > 0) {
      uploadNote += `（注意：本机同步文件夹「${bucketInfo.title}」里没有书签，云端有 ${remoteBookmarkCount} 条；`
        + '本次上传以本机为准，会把云端的书签覆盖掉。若云端有要保留的，请先点「合并」）';
    }

    // ★ 上传语义：桌面为准，覆盖云端 XBEL 和全部端上文件。
    //   Berry/Via/Aira 文件以桌面列表全量重写（Aira snapshot 走重建、
    //   personalization/favorites 的 home 区按桌面对齐——历史残留自动清除）。
    //   ⚠️ 端上尚未拉取到桌面的新增书签会在此覆盖中丢失
    //   ——想保留端上新增，请先点「合并」拉取，再上传。
    try {
      const bridgeOpts = await MiniSync.storage.getLocal(['option_berry_enabled', 'option_via_enabled', 'option_aira_enabled']);
      const berryOn = bridgeOpts.option_berry_enabled === true;
      const viaOn = bridgeOpts.option_via_enabled === true;
      const airaOn = bridgeOpts.option_aira_enabled === true;
      await MiniSync.bridgePatcher.patchBridges(
        { berryList: flatList, viaList: flatList, airaList: flatList },
        { berryOn, viaOn, airaOn, airaRebuild: true, airaHomeAlign: true }
      );
    } catch (e) {
      console.warn('[sync] 桥接覆盖写回失败:', e.message);
    }

    // 记录同步信息（count=纯书签数，与 result.bookmarkCount 同口径）
    await MiniSync.syncInput.recordLastSync(totalCount, bmCount);

    // 更新状态
    await MiniSync.storage.setSyncStatus({ status: SUCCESS });

    // 同步成功后刷新本地快照（供删除监听回溯被删节点 pathKey）
    await MiniSync.syncInput.saveLocalSnapshot();
    await MiniSync.syncInput.saveLocalTreeSnapshot();
    return {
      success: true,
      message: '上传成功' + uploadNote,
      endpointKey: endpointKey,
      count: totalCount,
      bookmarkCount: bmCount,
      bucketId: bucketInfo.id,
      bucketTitle: bucketInfo.title || null,
      // removed 如实反映本次按云端删除记录在本机删掉的条数（不再是恒 0）
      diff: { added: totalCount, removed: deletions.deletedCount }
    };

  } catch (error) {
    console.error('[sync] 上传失败:', error.message);
    await MiniSync.storage.setSyncStatus({ status: FAILED, error: error.message });
    return { success: false, message: `上传失败: ${error.message}` };
  }
}


/**
 * 从云端下载书签并导入（B: WebDAV GET → XBEL JSON → 导入 Chrome）
 *
 * @param {Object} [options]
 * @param {string} [options.endpointKey] - 指定端点 key
 * @returns {Promise<{success, message, importedCount?, conflicts?}>}
 */
function downloadBookmarks(options) {
  // ★ 互斥队列：同 uploadBookmarks（排队而非打断）
  return MiniSync.syncMutex.run(() => doDownloadBookmarks(options));
}

async function doDownloadBookmarks(options) {
  options = options || {};
  // 拿到锁后状态仍是 SYNCING → 必为 SW 崩溃/重启残留，恢复为 IDLE
  const status = await MiniSync.storage.getSyncStatus();
  if (status.status === SYNCING) {
    await MiniSync.storage.setSyncStatus({ status: IDLE });
  }

  try {
    await MiniSync.storage.setSyncStatus({ status: SYNCING, action: 'download' });

    // B: WebDAV GET → XBEL XML 字符串
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

    const content = await MiniSync.webdav.getFile(config.url, config.username, config.password, config.filename);
    if (!content) throw new Error('云端文件为空或不存在');

    // XBEL XML → JSON 中间态
    // ★ 扁平根宿主（手机）在解析云端之前先声明自己的容器名：云端还带着旧版写下的包装
    //   （其他收藏夹/根目录/…）且没有 <flatRootContainer> 元数据时，靠它才能当场拆平，
    //   否则远端指纹比本地多一层 ⇒ 合并认为两边不一致，来回搬运整棵树。
    try {
      const localTree = await MiniSync.syncInput.getChromeTree();
      const c = MiniSync.utils.detectFlatRootChild((localTree[0] && localTree[0].children) || []);
      if (c && c.title) MiniSync.utils.primeDeclaredFlatRootContainer(c.title);
    } catch (e) {
      console.warn('[sync] 读取本机容器名失败（按云端元数据处理）:', e.message);
    }
    const pluginData = MiniSync.xbel.parseXbelFromString(content);
    if (!pluginData) throw new Error('XBEL 文件格式无效');
    if (!pluginData.bookmarks || pluginData.bookmarks.length === 0) throw new Error('云端书签数据为空');

    // ===== 回迁：下载采用「备份 → 增量覆盖」语义（兼容第三方同步器如 floccus）=====
    // 关键改动：不再 clearAllBookmarks() + 全量重建（会令本地节点 id 全部变更，
    //   导致 floccus 误判本地被清空、触发 E029 删除保险删光服务端）。
    //   改为增量导入：复用本地已存在的同名/同 URL 节点 id，仅增删差异，保持本地 id 稳定。
    // 1. 备份当前本地书签（供失败回滚）
    const backupCount = await MiniSync.syncInput.backupLocalTree();

    // 1b. ===== 增量删减：下载也要减量，不是「只加不删」=====
    // 旧实现（mergeMode:false、不传 deletedIds）是纯加法：云端删掉的书签在本机永远留着。
    // 现按「本地 ∪ 云端」墓碑把本机确实已删的节点删掉——判据只有墓碑，不是「云端为准扫荡」：
    // 云端没有、也没有墓碑的节点是本机新增，一条都不动（用户自己的书签不许被下载清掉）。
    // 位置放在备份之后：真出异常时回滚能把它们一起带回来。
    let downloadDeletions = { deletedCount: 0 };
    try {
      downloadDeletions = await MiniSync.syncInput.applyTombstoneDeletions(pluginData);
    } catch (e) {
      console.warn('[sync] 下载前应用云端删除失败（继续按增量导入）:', e.message);
    }

    // 2. 增量导入（B-P2: JSON 中间态 → 导入 Chrome，mergeIntoLocal 复用本地节点）
    let result;
    // 下载路径暂不读回 Berry/Via（入口 pathKey 去重问题待修复，先止血避免数量飙升）
    // 安全默认：下载启用「真正合并」(mergeMode:true) —— 只把云端数据增量落到本地、
    // 复用已有节点 id，但【绝不删除本地独有节点】。这样可避免另一台设备新增、尚未
    // 同步上来的书签被「云端为准」误删（历史上曾出现 c5 文件夹整棵丢失）。
    // 真正需要删除「云端已删」节点的一致性，由「合并同步」承担。
    // 用户指定的「下载写入位置」（设置页下拉；空=自动）。扁平根宿主（雨见/Gecko fork）
    // 根下没有书签栏等分区，按标题匹配必然失败 ⇒ 必须能由用户指名写到哪个节点。
    // 用户指定的「同步文件夹」（设置页下拉；空=自动探测）。这个位置同时是
    // 下载落点与上传来源：桶的子节点全集 = 同步内容，桶外一律不读不写。
    let targetParentId = null;
    let clearLocalFirst = false;
    try {
      const info = await MiniSync.syncInput.resolveSyncBucketSetting();
      targetParentId = info.id;
      const t = await MiniSync.storage.getLocal(['download_clear']);
      clearLocalFirst = !!(t && t.download_clear);
    } catch (e) {
      console.warn('[sync] 解析同步文件夹失败（继续按自动处理）:', e.message);
    }
    try {
      result = await MiniSync.importer.importBookmarksFromData(
        pluginData,
        { mode: DOWNLOAD_MODE, mergeIntoLocal: true, mergeMode: false, skipBerryBridge: true, skipViaBridge: true,
          targetParentId, clearLocalFirst }
      );
    } catch (e) {
      // 4a. 导入异常 → 从备份恢复
      console.error('[sync] 增量导入失败，尝试回滚:', e.message);
      const restored = await MiniSync.syncInput.restoreLocalBackup({ replaceCurrent: true });
      await MiniSync.storage.setSyncStatus({ status: FAILED, error: e.message });
      return {
        success: false,
        message: `下载失败: ${e.message}` + (restored.restored > 0 ? `（已回滚 ${restored.restored} 条本地书签）` : ''),
        restored: restored.restored
      };
    }

    // 4b. 增量模式下，importedCount=0 是正常现象（云端与本地已完全一致），
    //     不应误判为失败。真正的"导入为空"在 parseXbelFromString 阶段已拦截
    //     （云端书签数据为空会抛错进入 4a 回滚）。此处仅做防御性检查：
    //     若导入过程产生了异常冲突数，才视为异常。
    // ★ 真缺陷修复（手机端实测「下载成功但书签栏里没有」）：
    //   processNode 里 create() 抛错会收进 conflicts，这里原来只 console.warn 一句、
    //   对外消息仍是「下载成功」——手机上既看不到 console，界面上没有任何提示，
    //   于是「一条都没写进去」也被显示成成功。冲突必须进 message / 返回值 / 操作记录。
    const failedWrites = (result.conflicts || []).length;
    const conflictSamples = (result.conflicts || []).slice(0, 3).map(c =>
      `${c.type === 'folder' ? '文件夹' : '书签'}「${c.title || '(无标题)'}」：${c.error || '未知原因'}`);
    if (failedWrites > 0) {
      console.warn(`[sync] 下载导入有 ${failedWrites} 条写入失败（本地未被改动，云端数据不会丢）`);
    }
    // 修复动作要如实说给用户听（手机上 console 看不到）：
    //   wrapperUnwrapped>0 ⇒ 展开了几层「同名容器套容器」（嵌套垃圾的来源）
    //   clearedBefore>0   ⇒ 按用户勾选先清空了本地再重建（破坏性，必须说出来）
    const cleanedNotes = [];
    const remoteSpliced = pluginData.wrapperSplicedRemote || 0;
    if (result.clearedBefore > 0) cleanedNotes.push(`已先清空本地 ${result.clearedBefore} 项并按云端重建`);
    if (result.wrapperUnwrapped > 0) cleanedNotes.push(`展开 ${result.wrapperUnwrapped} 层重复的同名文件夹`);
    if (result.wrapperSpliced > 0) cleanedNotes.push(`已拆平本机 ${result.wrapperSpliced} 层「文件夹套文件夹」`);
    if (remoteSpliced > 0) cleanedNotes.push(`云端 ${remoteSpliced} 层重复的同名文件夹已按摊平形态读入`);
    if (result.bucketTitle) cleanedNotes.push(`同步文件夹：${result.bucketTitle}`);
    // 按墓碑删掉的本地节点必须说出来（手机上 console 看不到，不说用户只会发现「书签不见了」）
    if (downloadDeletions.deletedCount > 0) {
      cleanedNotes.push(`按云端的删除记录删掉本机 ${downloadDeletions.deletedCount} 项`);
    }
    // 注意：不再把 importedCount===0 当作失败回滚，否则会误删本地书签。

    // 下载模式不操作 Berry/Via（只有上传覆盖、合并对齐才处理 Berry/Via）

    // 记录云端 lastModified，供下次上传冲突检测使用
    let cloudLastModified = Date.now();
    try {
      const info = await MiniSync.webdav.getFileInfo(config.url, config.username, config.password, config.filename);
      if (info.exists && info.lastModified > 0) cloudLastModified = info.lastModified;
    } catch (e) {
      console.warn('[sync] 读取云端时间戳失败（忽略）:', e.message);
    }
    await MiniSync.storage.setLocal({ [STORAGE_KEYS.CLOUD_LAST_MODIFIED]: cloudLastModified });

    // 统计：总数（书签+文件夹）供控制台日志，书签数供用户操作记录
    const cloudBookmarks = pluginData.bookmarks || [];
    // ★ XBEL 解析后，区域首层子节点的 parentId='root'（表示属于该区域根），
    //   这是正常设计，不能像上传时那样过滤。xbelToJson 已排除 3 个根容器本身。
    const cloudTotal = cloudBookmarks.length;
    const cloudBmCount = cloudBookmarks.filter(n => n.url).length;
    const cloudFolderCount = cloudTotal - cloudBmCount;

    console.log(`[sync] ⬇️ 下载完成: ${cloudTotal} 条数据 (${cloudBmCount} 书签 + ${cloudFolderCount} 文件夹)`);

    // 记录本次同步信息（popup 首页渲染用；count=纯书签数，与 result.bookmarkCount 同口径）
    await MiniSync.syncInput.recordLastSync(cloudTotal, cloudBmCount);

    await MiniSync.storage.setSyncStatus({ status: SUCCESS });

    // 同步成功后刷新本地快照（供删除监听回溯被删节点 pathKey）
    await MiniSync.syncInput.saveLocalSnapshot();
    await MiniSync.syncInput.saveLocalTreeSnapshot();
    const message = failedWrites > 0
      ? `下载完成，但有 ${failedWrites} 条没能写入本地（云端数据未丢）：${conflictSamples.join('；')}`
      : (cleanedNotes.length > 0 ? `下载成功（${cleanedNotes.join('，')}）` : '下载成功');
    // 台账：消息通道坏的宿主（可拓/雨见）也能靠 storage 读到「这次到底写了什么」
    try {
      await MiniSync.storage.setLocal({
        last_write_report: {
          at: Date.now(),
          via: 'download',
          ok: failedWrites === 0,
          importedCount: result.importedCount,
          createdFolderCount: result.createdFolderCount,
          // 两处删除合并计数：墓碑驱动的删除（本函数）+ 导入段自己的删除
          removedCount: (result.removedCount || 0) + downloadDeletions.deletedCount,
          tombstoneRemovedCount: downloadDeletions.deletedCount,
          failedWrites,
          conflictSamples,
          cloudTotal,
          cloudBmCount,
          targets: result.targets || [],
          zoneIds: result.zoneIds || null,
          requestedTargetId: result.requestedTargetId || null,
          flatRootChildId: result.flatRootChildId || null,
          bucketId: result.bucketId || null,
          bucketTitle: result.bucketTitle || null,
          clearLocalFirst: !!result.clearLocalFirst,
          clearedBefore: result.clearedBefore || 0,
          wrapperUnwrapped: result.wrapperUnwrapped || 0,
          wrapperSpliced: result.wrapperSpliced || 0,
          wrapperSpliceFailures: result.wrapperSpliceFailures || [],
          wrapperSplicedRemote: remoteSpliced,
          rootId: result.rootId || null,
          rootChildTitles: result.rootChildTitles || [],
          landedSample: result.landedSample || []
        }
      });
    } catch (e) {
      console.warn('[sync] 写下载台账失败（忽略）:', e.message);
    }
    return {
      success: true,
      message,
      importedCount: result.importedCount,
      totalCount: cloudTotal,
      count: cloudTotal,
      bookmarkCount: cloudBmCount,
      conflicts: result.conflicts,
      conflictCount: failedWrites,
      conflictSamples,
      removedCount: (result.removedCount || 0) + downloadDeletions.deletedCount,
      tombstoneRemovedCount: downloadDeletions.deletedCount,
      wrapperUnwrapped: result.wrapperUnwrapped || 0,
      wrapperSpliced: result.wrapperSpliced || 0,
      targets: result.targets || [],
      diff: { added: result.importedCount, removed: (result.removedCount || 0) + downloadDeletions.deletedCount }
    };

  } catch (error) {
    console.error('[sync] 下载失败:', error.message);
    await MiniSync.storage.setSyncStatus({ status: FAILED, error: error.message });
    return { success: false, message: `下载失败: ${error.message}` };
  }
}

// 合并路径已迁移至 core/sync-merge.js（MiniSync.mergeStrategy.mergeSync）
const mergeSync = MiniSync.mergeStrategy.mergeSync;

return {
  uploadBookmarks,
  downloadBookmarks,
  mergeSync,
  // 透传：供 background.js 直接调用（原 orchestrator 暴露的能力）
  restoreLocalBackup: MiniSync.syncInput.restoreLocalBackup,
  saveLocalSnapshot: MiniSync.syncInput.saveLocalSnapshot
};

})();
