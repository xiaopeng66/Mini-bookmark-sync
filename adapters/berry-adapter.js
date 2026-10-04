// adapters/berry-adapter.js - Berry 浏览器桥接逻辑
// 负责：读写 bookmarks.json、继承图标、顺序同步、id 映射

// Berry 文件字段兼容：新版用 data，旧版/外部格式可能用 bookmarks
function getBerryList(berryData) {
  if (!berryData) return null;
  if (Array.isArray(berryData.data)) return berryData.data;
  if (Array.isArray(berryData.bookmarks)) return berryData.bookmarks;
  return null;
}

// ========== Berry 桥接：将变更 patch 进 bookmarks.json ==========
// 以 Berry 数据为基底，只做节点增删，保留 Berry 的 favicon/color/customIcon
// 关键：新增节点的 parentId 需要从 Chrome id 映射到 Berry id（通过 pathKey 桥接）
async function patchBerryFile(mergedList) {
  let berryData;
  try {
    berryData = await downloadBerryBookmarks();
  } catch (e) {
    console.warn('[sync] 🍓 Berry 桥接：下载失败，跳过', e.message);
    return;
  }
  if (berryData && !getBerryList(berryData)) {
    console.warn('[sync] 🍓 Berry 文件格式无法识别（无 data/bookmarks 数组），本轮按合并结果重建');
  }
  // 文件不存在（或格式无法识别）时按空列表处理，走下方统一写回路径。
  // ★ 不能在这里另起一段「创建新文件」的简化逻辑：早期该分支把 home 节点
  //   （__home_folder__ 容器及其子节点）整批过滤掉，导致首次同步时桌面主页书签
  //   永远写不进 Berry（要等第二轮走正常写回才补上）。home 现在是一等公民，
  //   必须与正常写回完全同口径。
  const berryList = getBerryList(berryData) || [];

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
  try {
    await uploadBerryBookmarks(updatedBerryData);
    console.log(`[sync] 🍓 Berry 回写完成: ${zoneSummary(finalBerryList)}`);
  } catch (e) {
    console.warn('[sync] 🍓 Berry 桥接：上传失败', e.message);
  }
}

// 从 Berry 文件读取变更并合并：继承图标 + 合并新增节点 + 决定顺序
async function mergeBerryData(currentList, preferLocalOrder = false, tombstoneKeys = null) {
  let berryData;
  try {
    berryData = await downloadBerryBookmarks();
  } catch (e) {
    return currentList;
  }
  const berryList = getBerryList(berryData);
  if (!berryList || berryList.length === 0) {
    return currentList;
  }

  // 补 source：旧版可能没有，按 parentId 推断
  for (const n of berryList) {
    if (n.source) continue;
    if (n.parentId === HOME_FOLDER_ID) n.source = 'home';
    else if (n.parentId === MOBILE_FOLDER_ID) n.source = 'mobile';
    else if (n.parentId === OTHER_FOLDER_ID) n.source = 'other';
    else if (n.parentId === ROOT_ID) n.source = 'bar';
  }

  const berryPathKeys = computePathKeys(berryList);
  const currentPKs = computePathKeys(currentList);

  // 建立 pathKey 映射
  const berryByPK = new Map();
  for (const n of berryList) {
    const pk = berryPathKeys.get(n.id);
    if (pk) berryByPK.set(pk, n);
  }
  const currentPKSet = new Set(currentPKs.values());

  // 1. 从 Berry 继承图标到当前节点
  let enrichedCurrent = currentList.map(n => {
    const pk = currentPKs.get(n.id);
    if (!pk) return n;
    const berryNode = berryByPK.get(pk);
    if (berryNode) {
      const copy = { ...n };
      if (berryNode.favicon && !copy.favicon) copy.favicon = berryNode.favicon;
      if (berryNode.color && !copy.color) copy.color = berryNode.color;
      if (berryNode.customIcon && !copy.customIcon) copy.customIcon = berryNode.customIcon;
      return copy;
    }
    return n;
  });

  // 2. 找出 Berry 中有但当前列表没有的节点（Berry 新增的）
  function getParentPath(pk) {
    if (!pk) return '';
    const lastSlash = pk.lastIndexOf('/');
    return lastSlash > 0 ? pk.substring(0, lastSlash) : pk;
  }
  const currentDupIndex = new Map();
  for (const n of currentList) {
    const pk = currentPKs.get(n.id);
    const parentPath = getParentPath(pk);
    // 对文件夹：目录层级 + F:标题
    // 对书签：目录层级 + L:标题 + URL
    const key = n.isFolder
      ? `${parentPath}/F:${n.title}`
      : `${parentPath}/L:${n.title}:${(n.url || '').replace(/&amp;/g, '&')}`;
    if (!currentDupIndex.has(key)) currentDupIndex.set(key, n.id);
  }
  // ★ URL 精确匹配集（fallback，覆盖 parentPath 不一致但实际是同一书签的场景）
  const localUrlSet = new Set(
    currentList.filter(n => !n.isFolder && n.url).map(n => n.url.replace(/&amp;/g, '&').replace(/\/$/, ''))
  );
  // ★ 文件夹标题集（fallback，覆盖 parentPath 不一致但实际是同一文件夹的场景）
  const localFolderTitles = new Set(
    currentList.filter(n => n.isFolder).map(n => n.title)
  );

  let dedupByPath = 0, dedupByUrl = 0;
  const berryNew = berryList.filter(n => {
    const pk = berryPathKeys.get(n.id);
    if (!pk || currentPKSet.has(pk)) return false;
    // 被 tombstone 标记删除的不当作新增
    if (tombstoneKeys && tombstoneKeys.has(pk)) return false;
    // 补充去重：目录 + 标题 + URL 相同则视为重复
    const parentPath = getParentPath(pk);
    const dupKey = n.isFolder
      ? `${parentPath}/F:${n.title}`
      : `${parentPath}/L:${n.title}:${(n.url || '').replace(/&amp;/g, '&')}`;
    if (currentDupIndex.has(dupKey)) { dedupByPath++; return false; }
    // URL 精确匹配 fallback
    if (!n.isFolder && n.url) {
      const normalizedUrl = n.url.replace(/&amp;/g, '&').replace(/\/$/, '');
      if (localUrlSet.has(normalizedUrl)) { dedupByUrl++; return false; }
    }
    // 文件夹标题 fallback：本地已有同名文件夹 → 视为重复
    if (n.isFolder && n.title && localFolderTitles.has(n.title)) return false;
    return true;
  });

  // 3. Berry 删除检测：快照中有但现在没有 → Berry 端删除 → 移除
  const berryPKSet = new Set(berryPathKeys.values());
  // 对方节点的 URL / 文件夹标题集合：用于识别「父改名/移动导致 pathKey 变了，但并非真删」
  const berryUrlSet = new Set(
    berryList.filter(n => !n.isFolder && n.url).map(n => n.url.replace(/&amp;/g, '&').replace(/\/$/, ''))
  );
  const berryFolderTitles = new Set(
    berryList.filter(n => n.isFolder).map(n => n.title)
  );
  const berrySnapshotData = (await chrome.storage.local.get(['berry_pathkey_snapshot']))['berry_pathkey_snapshot'] || [];
  const berrySnapshotSet = new Set(berrySnapshotData);
  let berryDeletedCount = 0;
  if (berrySnapshotSet.size > 0) {
    // 从结果中过滤掉 Berry 删除的节点
    const beforeLen = enrichedCurrent.length;
    const filteredCurrent = enrichedCurrent.filter(n => {
      const pk = currentPKs.get(n.id);
      if (!pk) return true;
      // Berry 快照中有但现在没有 → 疑似 Berry 删了
      if (berrySnapshotSet.has(pk) && !berryPKSet.has(pk)) {
        // 改名/移动兜底：URL（书签）或标题（文件夹）仍存在于对方 → 只是路径变了，不是真删
        if (!n.isFolder && n.url) {
          const u = n.url.replace(/&amp;/g, '&').replace(/\/$/, '');
          if (berryUrlSet.has(u)) return true;
        }
        if (n.isFolder && n.title && berryFolderTitles.has(n.title)) return true;
        berryDeletedCount++;
        return false;
      }
      return true;
    });
    if (berryDeletedCount > 0) {
      enrichedCurrent = filteredCurrent;
    }
  }

  // 保存 Berry pathKey 快照（用于下次检测删除）
  await chrome.storage.local.set({ 'berry_pathkey_snapshot': [...berryPKSet] });

  // 4. （已移除）原「Berry 主页权威过滤」：将不在 Berry 文件中的桌面 home 节点从合并列表移除。
  // 删除原因：Berry 的 bookmarks.json 本身不含 home 节点（主页数据在手机端自管），
  // berryPKSet 永远没有 home 的 pathKey，导致该过滤恒等于「全量清空桌面 home」。
  // 清空后的列表传给 mergeViaData/mergeAiraData 时，favorites.txt / personalization 里
  // 同样的 home 书签因去重基线缺失被误判为「主页新增」重新注入，一来一回把同一批
  // 书签复制成两份（手机端 Berry主页 出现成对重复）。
  // home 节点现在完整保留在合并列表中：Berry 回写时由 patchBerryFile 跳过（不写入
  // bookmarks.json），Via favorites / Aira personalization 的去重基线恢复正常。
  let homeDeletedCount = 0;

  // 5. 决定顺序
  const pluginLastMod = (await chrome.storage.local.get([STORAGE_KEYS.CLOUD_LAST_MODIFIED]))[STORAGE_KEYS.CLOUD_LAST_MODIFIED] || 0;
  const berryLastMod = berryData.lastModified || 0;
  const useBerryOrder = !preferLocalOrder && berryLastMod > pluginLastMod;

  // 映射 Berry parentId → currentList 中对应节点的 ID
  function mapBerryParentId(bn) {
    const parentPK = berryPathKeys.get(bn.parentId);
    if (parentPK) {
      const currentParent = enrichedCurrent.find(n => currentPKs.get(n.id) === parentPK);
      if (currentParent) {
        return { ...bn, parentId: currentParent.id };
      }
    }
    return bn;
  }

  if (useBerryOrder) {
    // Berry 更新 → 按 Berry 顺序排列，Chrome 独有的追加末尾
    const result = [];
    const usedPKs = new Set();
    for (const bn of berryList) {
      const bpk = berryPathKeys.get(bn.id);
      if (!bpk) continue;
      // 找当前列表中对应的节点（已继承图标）
      const localNode = enrichedCurrent.find(n => currentPKs.get(n.id) === bpk);
      if (localNode) {
        result.push(localNode);
        usedPKs.add(bpk);
      } else {
        // Berry 有但本地（按 pk）没有 → 先按「目录+标题+URL」去重，
        // 防止 pathKey 口径变更（如 ROOT:other/F:Berry主页 → ROOT:home）导致
        // Berry 存储里的旧 pk 与本地新 pk 不匹配、被误判为「新增」而重复追加。
        const parentPath = getParentPath(bpk);
        const dupKey = bn.isFolder
          ? `${parentPath}/F:${bn.title}`
          : `${parentPath}/L:${bn.title}:${(bn.url || '').replace(/&amp;/g, '&')}`;
        if (currentDupIndex.has(dupKey)) {
          continue;
        }
        result.push(mapBerryParentId(bn));
        usedPKs.add(bpk);
      }
    }
    // Chrome 独有的追加末尾
    for (const n of enrichedCurrent) {
      const pk = currentPKs.get(n.id);
      if (pk && !usedPKs.has(pk)) {
        result.push(n);
      }
    }
    // ★ 重编 _index 为同父内序号：本分支按 Berry 顺序重排了数组，但节点上的
    //   _index 仍是本地树旧序/云端旧值——落盘（import.js）的 landed 重排按
    //   _index 排序，不重编的话顺序会被打回（表现为「一端调整子文件夹内顺序，
    //   另一端合并后顺序不变」）。
    const sibCounter = new Map();
    for (const n of result) {
      const key = n.parentId || '__root__';
      const idx = sibCounter.get(key) || 0;
      n._index = idx;
      sibCounter.set(key, idx + 1);
    }
    console.log(`[sync] 🍓 Berry 处理完成: ${zoneSummary(result)}`);
    return result;
  } else {
    // Chrome 顺序：当前列表 + Berry 新增追加末尾
    const mappedBerryNew = berryNew.map(mapBerryParentId);
    const result = [...enrichedCurrent, ...mappedBerryNew];
    // Berry 新增节点无 _index → 补到同父已有节点之后（否则落盘重排按 _index||0
    // 会把它们挪到同父最前）。已有节点的 _index 保持（本地序或云端覆盖序）。
    MiniSync.utils.fillMissingSiblingIndex(result);
    console.log(`[sync] 🍓 Berry 处理完成: ${zoneSummary(result)}`);
    return result;
  }
}

// 挂载到 MiniSync，供 sync-orchestrator 在合并阶段调用
MiniSync.berry = {
  mergeBerryData,
  patchBerryFile
};
