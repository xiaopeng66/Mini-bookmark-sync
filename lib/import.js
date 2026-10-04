// lib/import.js — 书签导入（云端格式 → Chrome）
// B-P2 路径：XBEL XML → xbelToJson() → JSON 中间态 → 导入 Chrome

MiniSync.importer = (function() {

/**
 * 读取 Chrome 书签树（带 10s 超时保护；成功后清理定时器，不留悬挂计时器）
 */
function getTreeWithTimeout(timeoutMs) {
  const ms = timeoutMs || 10000;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('无法读取本地书签'));
    }, ms);
    try {
      chrome.bookmarks.getTree((tree) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // lastError 访问需判空守卫：测试环境的 chrome mock 可能只有 bookmarks，
        // 没有 chrome.runtime（此时按成功处理）
        try {
          const err = (typeof chrome !== 'undefined' && chrome.runtime) ? chrome.runtime.lastError : null;
          if (err) reject(new Error(err.message));
          else resolve(tree);
        } catch (_) { resolve(tree); }
      });
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    }
  });
}

/**
 * ★ 物理拆平「容器镜像包装」。
 *
 * 包装 = 标题等于「扁平根容器名」、且位于分区层（扁平根宿主＝容器里；标准三区＝书签栏/
 * 其他书签/移动书签下）的文件夹。它有两类来源：
 *   ① 手机（雨见/可拓）早期版本每合并/下载一轮就往容器里套一层同名文件夹
 *      （根目录/根目录/根目录…），用户的 272 条书签被折进中间那几层；
 *   ② 桌面 Edge 把手机的整桶书签导入到「其他收藏夹」时留下的 其他收藏夹/根目录 镜像。
 *
 * 为什么必须**物理**拆：指纹透明化（pathKey 不产生容器段）只让 identity 对得上，导入的
 * 「复用本地节点」却是在真实 Chrome 结构里按目标父节点找同名/同 URL 节点的 —— 内容嵌在
 * 包装里就找不到 ⇒ 会在上一级再建一份（书签翻倍），旧包装又因「不动本地独有」留着。
 *
 * 拆法：壳里的内容用 chrome.bookmarks.move 上提到分区层（id 全部保留，于是复用、墓碑、
 * 顺序全部照旧），壳确实空了才 removeTree；搬不动/还有内容就原样保留并记入 failures。
 * 只用 getTree + move + removeTree（真宿主与测试 mock 都稳定支持），不依赖 getChildren/get。
 *
 * @returns {Promise<{spliced:number, failures:Array<{id,title,error}>}>}
 */
async function spliceWrapperFolders() {
  const failures = [];
  let spliced = 0;
  const MAX_PASS = 20; // 嵌套层数上限（历史最深实测 3 层；上限只是防空转/防环）

  for (let pass = 0; pass < MAX_PASS; pass++) {
    const tree = await getTreeWithTimeout();
    const root = tree && tree[0];
    if (!root) break;
    const rootKids = root.children || [];
    const container = (MiniSync.utils && MiniSync.utils.detectFlatRootChild)
      ? MiniSync.utils.detectFlatRootChild(rootKids) : null;

    // 包装名：扁平根宿主＝容器名（结构性事实）；标准三区＝云端声明的名字
    // （没有声明就说明对端没有容器，本机也不可能存在镜像包装 ⇒ 什么都不动）。
    const declared = (MiniSync.utils && MiniSync.utils.getDeclaredFlatRootContainer)
      ? String(MiniSync.utils.getDeclaredFlatRootContainer() || '') : '';

    // ★ 拆壳只在【同步桶**内部**】进行。桶自己本来就叫这个名字
    //   （手机容器「根目录」、桌面镜像「其他收藏夹/根目录」）—— 它是同步内容的落点，
    //   绝不是「包装壳」，拆掉它等于把用户的同步文件夹端走（实测：桌面下载时
    //   旧实现把镜像壳拆平、内容提到「其他收藏夹」层，与用户自己的文件夹混在一起，
    //   同时桶被判定成空的书签栏 ⇒ 同一批书签在别的文件夹里复制一份）。
    const bucket = (MiniSync.utils && MiniSync.utils.resolveSyncBucket)
      ? MiniSync.utils.resolveSyncBucket(rootKids, {
          bucketId: MiniSync.utils.getSyncBucketId ? MiniSync.utils.getSyncBucketId() : '',
          declaredWrapper: declared
        })
      : null;
    if (!bucket) break;
    const bucketNode = (function find(nodes, id) {
      for (const n of (nodes || [])) {
        if (!n || n.url) continue;
        if (String(n.id) === String(id)) return n;
        const hit = find(n.children, id);
        if (hit) return hit;
      }
      return null;
    })(rootKids, bucket.id);
    if (!bucketNode) break;

    const wrapperTitle = String(bucket.title || '') || declared;
    if (!wrapperTitle) break;

    // 只找桶的直接子层里的同名壳（旧版每合并一轮套一层 根目录/根目录）；
    // 更深处的同名文件夹是用户自己建的，不动。
    const shell = (bucketNode.children || []).find(c => c && !c.url && String(c.title || '') === wrapperTitle);
    if (!shell) break; // 没有包装壳 ⇒ 干净
    const shellParent = bucketNode;

    // 把壳的内容整体上提到分区层父节点（保留 id 与相对顺序）
    const inner = shell.children || [];
    for (let i = 0; i < inner.length; i++) {
      try {
        await chrome.bookmarks.move(String(inner[i].id), { parentId: String(shellParent.id), index: i });
      } catch (e) {
        failures.push({ id: String(inner[i].id), title: inner[i].title || '', error: e.message });
      }
    }

    // 再读一次树确认壳真的空了 —— 搬不动的（宿主拒绝/内容仍在内）就保留不删，
    // 绝不为了「拆干净」把用户书签连带删掉（旧版跨区移动就是这样清空容器的）。
    const after = await getTreeWithTimeout();
    let shellAfter = null;
    (function find(n) {
      if (shellAfter || !n || !n.children) return;
      for (const c of n.children) {
        if (String(c.id) === String(shell.id)) { shellAfter = c; return; }
        find(c);
        if (shellAfter) return;
      }
    })(after[0]);
    if (!shellAfter) break; // 已被处理掉（或树变了），交给下一轮
    const left = (shellAfter.children || []).length;
    if (left > 0) {
      failures.push({ id: String(shell.id), title: shellAfter.title || '', error: `仍有 ${left} 个子节点未能上提，保留该文件夹不动` });
      break;
    }
    try {
      await chrome.bookmarks.removeTree(String(shell.id));
      spliced++;
    } catch (e) {
      failures.push({ id: String(shell.id), title: shellAfter.title || '', error: e.message });
      break;
    }
  }

  return { spliced, failures };
}

/**
 * 用户是否在用「主页」功能（Berry / Via / Aira 任一桥接开关开着）。
 * 用来判定一个空的「移动端主页」是历史遗留空壳（可以清）还是用户要的落点（必须留）。
 * @returns {Promise<boolean|null>} null = 判不了（没 storage / 读失败）⇒ 调用方按「不删」处理
 */
async function readHomeBridgeInUse() {
  const keys = ['option_berry_enabled', 'option_via_enabled', 'option_aira_enabled'];
  try {
    if (!(typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local
        && typeof chrome.storage.local.get === 'function')) return null;
    const r = await chrome.storage.local.get(keys);
    if (!r) return null;
    return keys.some(k => !!r[k]);
  } catch (e) {
    console.warn('[import] 读取主页开关失败（按「用户在用」处理，不清理）:', e.message);
    return null;
  }
}

/**
 * 从插件数据对象导入书签到 Chrome（JSON 中间态 → Chrome API）
 */
async function importBookmarksFromData(pluginData, options) {
  const deleteIds = (options && options.deletedIds) ? new Set(options.deletedIds.map(String)) : null;
  // ★ 「空数据 + 有待删节点」绝不能早退：对端把桶删空时合并数据就是空的，早退会让
  //   删除完全不生效（本地旧内容留着，下一轮又被当本地独有重新上传 = 删除被反转成复活）。
  const hasPendingDeletes = !!(options && options.mergeMode) && !!(deleteIds && deleteIds.size > 0);
  if ((!pluginData || !Array.isArray(pluginData.bookmarks) || pluginData.bookmarks.length === 0) && !hasPendingDeletes) {
    return {
      importedCount: 0, createdFolderCount: 0, removedCount: 0, totalCount: 0, conflicts: [],
      targets: [], rootId: null, rootChildTitles: [], zoneIds: { bar: null, other: null, mobile: null }, landedSample: []
    };
  }
  // 注意：pluginData.bookmarks 可能是空数组（只删不建），下面一律按空列表处理。
  if (!pluginData) pluginData = { bookmarks: [] };
  if (!Array.isArray(pluginData.bookmarks)) pluginData = { ...pluginData, bookmarks: [] };

  const mode = (options && options.mode) || DOWNLOAD_MODE;
  const skipBerry = !!(options && options.skipBerryBridge);
  const skipVia = !!(options && options.skipViaBridge);

  let bookmarkList = pluginData.bookmarks;

  // 注：曾有「墓碑预清理」防线（按 pathKey 逐层标题匹配删除本地节点），
  // 但其查找根全部用了虚拟 id（__home_folder__ 等），chrome.bookmarks.getChildren
  // 必然失败，从未生效过，已移除。删除传播由两条活路径承担：
  //   ① 合并：merge.js classifyNodes 标记 localDeleted → sync-merge 落盘前裁剪
  //   ② 下载：云端为准，leftover 对齐删除（见文件末尾智能覆盖段）

  // ====== 阶段 1: Berry 桥接 ======
  if (!skipBerry) {
    try {
      bookmarkList = await mergeBerryData(bookmarkList, false);
    } catch (e) {
      console.warn('[import] Berry 桥接失败:', e.message);
    }
  }

  // ====== 阶段 2: Via 桥接 ======
  if (!skipVia) {
    try {
      bookmarkList = await mergeViaData(bookmarkList);
    } catch (e) {
      console.warn('[import] Via 桥接失败:', e.message);
    }
  }

  // ====== 阶段 3: 构建树结构并导入 ======
  const nodeMap = new Map();
  const rootNodes = [];

  for (const item of bookmarkList) {
    const node = {
      id: item.id,
      title: item.title || '',
      url: item.url || '',
      isFolder: !!item.isFolder,
      parentId: item.parentId || ROOT_ID,
      source: item.source || '',
      addedAt: item.addedAt || Date.now(),
      color: item.color || null,
      favicon: item.favicon || null,
      customIcon: item.customIcon || null,
      _otherIndex: typeof item._otherIndex === 'number' ? item._otherIndex : -1,
      _index: typeof item._index === 'number' ? item._index : -1,
      children: []
    };
    nodeMap.set(node.id, node);
    if (node.parentId === ROOT_ID) rootNodes.push(node);
  }

  // 建立父子关系
  for (const node of nodeMap.values()) {
    if (node.parentId !== ROOT_ID && nodeMap.has(node.parentId)) {
      nodeMap.get(node.parentId).children.push(node);
    } else if (node.parentId !== ROOT_ID && !rootNodes.includes(node)) {
      rootNodes.push(node);
    }
  }

  // 按 _index 排序子节点
  function sortChildren(parentNode) {
    parentNode.children.sort((a, b) => (a._index || 0) - (b._index || 0));
    for (const child of parentNode.children) sortChildren(child);
  }
  for (const rn of rootNodes) sortChildren(rn);

  // ====== 阶段 4: 写入 Chrome ======
  const conflicts = [];
  let importedCount = 0; // 只统计有 url 的书签（与上传/合并口径一致）
  let createdFolderCount = 0; // 统计新建的空/非空文件夹，便于诊断
  let urlDupSkipped = 0; // 全局 URL 重复被复用（未新建）的数量，用于诊断历史重复规模
  const createdFolders = new Map(); // "parentId::title" → chromeId，防止重复创建
  const landed = []; // 已落盘节点 {id, parentId, _index}，用于末尾按 _index 重排顺序

  // 注意：不再跳过空文件夹（用户会主动创建空文件夹占位/待分类）

  // 防御性：云端/输入数据可能把「书签栏/其他书签/移动书签」系统根容器本身也作为一个 folder
  // 节点传进来（常见于被污染的旧数据）。若直接导入，会在 Chrome 里创建一个同名的嵌套子文件夹。
  // 这里判断一个节点是否为系统根容器：标题匹配系统区名。
  const sysRootTitles = new Set([
    ...FOLDER_TITLES.bookmarkBar,
    ...FOLDER_TITLES.otherBookmarks,
    ...FOLDER_TITLES.mobileBookmarks,
  ]);
  function isSystemRootContainer(node) {
    return node.isFolder && sysRootTitles.has((node.title || '').trim());
  }

  // 增量模式（下载默认开启）：保留本地已存在节点的浏览器 id，避免第三方同步器误判
  const isMergeMode = mode === DOWNLOAD_MODE || (options && options.mergeIntoLocal);
  // 真正「合并」模式（双向同步）：保留本地独有节点，只删除云端确实删除的（deleteIds），
  // 绝不因「合并数据里没有」就删除本地移动/新增的文件夹（否则会造成 c5 这类移动文件夹整棵丢失）。
  const isTrueMerge = !!(options && options.mergeMode);
  // deleteIds 已在函数开头算好（早退判定要用）

  // 构建「父id::标题」→ 本地 chrome 子节点 的索引，供增量复用
  // localChildrenMap: parentChromeId -> [{id,title,url}]
  const localChildrenMap = new Map();
  // 全局 URL 索引：decoded url -> chromeId（首个出现），用于全局去重兜底，
  // 避免「同 URL 不同路径」的书签被当成不同节点重复创建（历史重复书签的根源）。
  const globalUrlMap = new Map();
  async function buildLocalIndex() {
    if (!isMergeMode) return;
    const tree = await getTreeWithTimeout();
    // 递归收集所有文件夹的直属子节点
    function collect(node) {
      if (!node.children) return;
      const arr = node.children.map(c => ({
        id: c.id,
        title: c.title || '',
        url: c.url || '',
        _parentId: node.id
      }));
      localChildrenMap.set(node.id, arr);
      for (const c of node.children) {
        if (c.url) {
          const du = decodeHtmlEntities(c.url);
          if (du && !globalUrlMap.has(du)) globalUrlMap.set(du, c.id);
        }
        collect(c);
      }
    }
    function findById(node, id) {
      if (!node) return null;
      if (String(node.id) === String(id)) return node;
      for (const c of (node.children || [])) {
        const hit = findById(c, id);
        if (hit) return hit;
      }
      return null;
    }
    // ★ 单同步桶：索引只覆盖【桶子树】+【Berry 主页子树】。
    //   删除段的「本地独有」判据只能在索引里找候选 ⇒ 桶外的一切（用户放在「其他收藏夹」
    //   里的自己的文件夹、移动收藏夹）永远不会被删。这正是复现里「桌面一按下载就把用户
    //   自己的『我的收藏』整棵 removeTree 掉」的根因（旧实现从根节点 collect 了全树）。
    const indexRoots = [];
    if (bucketId) {
      const b = findById(tree[0], bucketId);
      if (b) indexRoots.push(b);
    }
    if (realBerryHomeId) {
      const h = findById(tree[0], realBerryHomeId);
      if (h) indexRoots.push(h);
    }
    for (const r of indexRoots) collect(r);
  }

  // 解码 HTML 实体（如 &amp; -> &），用于对比 XBEL 中的 URL 与本地 Chrome URL
  function decodeHtmlEntities(str) {
    if (!str) return str;
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  // 在父节点下查找同名（文件夹按标题、书签按标题+url）的本地已存在子节点
  function findExistingLocal(parentChromeId, node) {
    const arr = localChildrenMap.get(parentChromeId);
    if (!arr) return null;
    if (node.url) {
      const decodedUrl = decodeHtmlEntities(node.url);
      return arr.find(c => {
        if (!c.url) return false;
        return decodeHtmlEntities(c.url) === decodedUrl && (c.title || '') === (node.title || '');
      }) || null;
    }
    return arr.find(c => !c.url && (c.title || '') === (node.title || '')) || null;
  }

  // 虚拟容器 id（HOME_FOLDER_ID / MOBILE_FOLDER_ID / OTHER_FOLDER_ID）反向解析：pathKey 体系用虚拟 id 对齐
  // 跨端 pk，但 chrome.bookmarks.create/move 不认虚拟 id。这里还原为真实文件夹 id。
  const resolveParentId = (id) => {
    if (id == null) return id;
    if (id === HOME_FOLDER_ID && realBerryHomeId) return realBerryHomeId;
    if (id === MOBILE_FOLDER_ID && mobileFolder) return String(mobileFolder.id);
    if (id === OTHER_FOLDER_ID && otherFolder) return String(otherFolder.id);
    return id;
  };

  let wrapperUnwrapped = 0; // 展开掉的自名包装容器数（诊断用）

  async function processNode(node, parentId) {
    // 解析虚拟容器 id（跨区移动时 parentId 可能为 __home_folder__/__mobile_folder__）
    parentId = resolveParentId(parentId);

    if (node.isFolder) {
      // 注意：保留空文件夹（不跳过），使其能在本地重建，实现跨端同步。
      try {
        let newId;
        // 增量模式：优先复用本地已存在的同名文件夹，保留其 id
        const existing = isMergeMode ? findExistingLocal(parentId, node) : null;
        if (existing) {
          newId = existing.id;
          // ★ 复用同样要登记 createdFolders：云端 XBEL 若存在多个同名容器
          //   （chromeToXbel 会把其他收藏夹下命中 berryHome 别名的文件夹统一
          //   改名「Berry主页」写入云端，历史脏数据可含 2 个以上同名 folder），
          //   第 1 个容器复用后 findExistingLocal 已将本地同名项 splice 清空，
          //   第 2..N 个容器若查不到缓存就会走 create —— 同父级出现重复文件夹
          //   （实测「其他收藏夹下两个 Berry主页、内容不一致」）。
          //   登记后第 2..N 个容器复用同一真实 id，其内容并入同一文件夹。
          createdFolders.set(parentId + '::' + node.title, newId);
          // 从索引中移除，标记已复用（避免被当作「需删除」）
          const arr = localChildrenMap.get(parentId);
          const idx = arr ? arr.indexOf(existing) : -1;
          if (idx >= 0) arr.splice(idx, 1);
        } else {
          const dedupeKey = parentId + '::' + node.title;
          if (createdFolders.has(dedupeKey)) {
            newId = createdFolders.get(dedupeKey);
          } else {
            const result = await chrome.bookmarks.create({
              parentId: parentId,
              title: node.title
            });
            newId = result.id;
            createdFolders.set(dedupeKey, newId);
            createdFolderCount++;
          }
        }
        nodeMap.set('_new_' + node.id, { id: newId });
        landed.push({ id: newId, parentId, _index: node._index || 0 });
        for (const child of node.children) await processNode(child, newId);
      } catch (e) {
        conflicts.push({ type: 'folder', title: node.title, error: e.message });
      }
    } else if (node.url) {
      try {
        // XBEL 中的 URL 可能包含 HTML 实体（如 &amp;），导入前解码为原始 URL
        node.url = decodeHtmlEntities(node.url);

        // 增量模式：本地已存在同 url+标题 的书签则跳过（不重复创建，保留原 id）
        const existing = isMergeMode ? findExistingLocal(parentId, node) : null;
        if (existing) {
          nodeMap.set('_new_' + node.id, { id: existing.id });
          // 从本地索引中移除，避免被当作「需删除」的本地独有节点
          const arr = localChildrenMap.get(parentId);
          const idx = arr ? arr.indexOf(existing) : -1;
          if (idx >= 0) arr.splice(idx, 1);
          landed.push({ id: existing.id, parentId, _index: node._index || 0 });
          return;
        }
        // 全局 URL 兜底：Chrome 任意位置已存在相同 URL 的书签 → 复用，不重复创建
        const gId = globalUrlMap.get(node.url);
        if (gId) {
          nodeMap.set('_new_' + node.id, { id: gId });
          // ★ 必须同时从删除索引移除：leftover 删除段以 localChildrenMap 为准，
          //   不移除的话该节点会被当「本地独有」删掉——刚被云端复用即被删（数据丢失）
          for (const arr of localChildrenMap.values()) {
            const ii = arr.findIndex(c => c.id === gId);
            if (ii >= 0) { arr.splice(ii, 1); break; }
          }
          landed.push({ id: gId, parentId, _index: node._index || 0 });
          urlDupSkipped++;
          return;
        }
        const created = await chrome.bookmarks.create({
          parentId: parentId,
          title: node.title,
          url: node.url
        });
        landed.push({ id: created.id, parentId, _index: node._index || 0 });
        importedCount++;
      } catch (e) {
        conflicts.push({ type: 'bookmark', title: node.title, url: node.url, error: e.message });
      }
    }
  }

  // 获取 Chrome 根节点 ID（与 orchestrator.getChromeTree 一致）
  let chromeTree = await getTreeWithTimeout();

  // ★ 物理拆平「容器套容器」（扁平根宿主的历史垃圾：根目录/根目录/根目录…）。
  //   只做指纹透明化（pathKey 归一）解决不了这个：processNode 的 findExistingLocal
  //   只在**目标容器的直属子节点**里找，嵌在包装壳里的同一个书签找不到 ⇒ 新建一份，
  //   而旧的那份在真正合并模式下（不动本地独有节点）留在原地 ⇒ 书签翻倍。
  //   所以导入前先在文件系统层面把壳拆掉：子节点上提一级（chrome.bookmarks.move
  //   保留 id ⇒ 后续复用/墓碑匹配照常）、确实空了才删壳（绝不连带带走内容）。
  let wrapperSpliced = 0;
  const wrapperSpliceFailures = [];
  try {
    const sp = await spliceWrapperFolders();
    wrapperSpliced = sp.spliced;
    for (const f of sp.failures) wrapperSpliceFailures.push(f);
  } catch (e) {
    console.warn(`[import] 拆平同名包装失败（继续导入）: ${e.message}`);
  }
  if (wrapperSpliced > 0) {
    console.log(`[import] 已拆平 ${wrapperSpliced} 层重复的同名文件夹（子节点已上提，id 未变）`);
    // 结构变了 ⇒ 重新拉树：后面所有「分区命中 / 扁平根容器 / 先清空 / 建索引」都基于新结构，
    // 否则先清空段拿着旧快照会漏掉刚上提上来的子节点。
    chromeTree = await getTreeWithTimeout();
  }
  if (wrapperSpliceFailures.length > 0) {
    console.warn(`[import] 有 ${wrapperSpliceFailures.length} 处同名包装未能拆平（已原样保留）`);
  }

  const chromeRoot = chromeTree[0];
  const barFolder = chromeRoot.children.find(c =>
    FOLDER_TITLES.bookmarkBar.some(t => t.toLowerCase() === (c.title || '').toLowerCase())
  );
  const otherFolder = chromeRoot.children.find(c =>
    FOLDER_TITLES.otherBookmarks.some(t => t.toLowerCase() === (c.title || '').toLowerCase())
  );
  const mobileFolder = chromeRoot.children.find(c =>
    FOLDER_TITLES.mobileBookmarks.some(t => t.toLowerCase() === (c.title || '').toLowerCase())
  );

  const folderMap = {};
  if (barFolder) folderMap['bar'] = String(barFolder.id);
  if (otherFolder) folderMap['other'] = String(otherFolder.id);
  if (mobileFolder) folderMap['mobile'] = String(mobileFolder.id);

  // ===== 单同步桶（sync bucket）：本轮所有落盘都写进**一个**文件夹 =====
  // bucket = 用户指定的「同步文件夹」（options.targetParentId，或模块级设置）或自动探测：
  //   扁平根宿主 ⇒ 容器（雨见的「根目录」）；标准宿主 ⇒ 书签栏，或云端声明过名字的本机镜像
  //   （桌面 Edge 现状：其他收藏夹/根目录）。规则单源在 utils.resolveSyncBucket。
  // 桶以外的一切 —— 「其他收藏夹」里的其它文件夹、移动收藏夹、根下其它文件夹 ——
  // **不写、不读、不删**。用户要求的「其他收藏夹不要备份」由此结构性保证：
  // 同步范围本身只有一个文件夹，不需要再猜哪个名字是用户数据、哪个是本程序的残迹。
  const requestedTargetId = (options && options.targetParentId) ? String(options.targetParentId) : null;
  const rootChildren = chromeRoot.children || [];
  const clearLocalFirst = !!(options && options.clearLocalFirst);
  const bucket = MiniSync.utils.resolveSyncBucket(rootChildren, {
    bucketId: requestedTargetId || (MiniSync.utils.getSyncBucketId ? MiniSync.utils.getSyncBucketId() : ''),
    declaredWrapper: MiniSync.utils.getDeclaredFlatRootContainer ? MiniSync.utils.getDeclaredFlatRootContainer() : ''
  });
  const bucketId = bucket ? String(bucket.id) : null;
  const bucketTitle = bucket ? String(bucket.title || '') : '';
  const bucketKind = bucket ? bucket.kind : null;
  // 诊断字段（台账/消息用）：扁平根宿主那个唯一容器（雨见/可拓的「根目录」）
  const flatRootChild = MiniSync.utils.detectFlatRootChild(rootChildren);
  if (!bucketId) {
    // 不猜：找不到任何可写文件夹就如实中止（调用方会回滚并报错），
    // 绝不回落到硬编码 '1' —— 那条路径在扁平根宿主上必然写失败，还曾被显示成「成功」。
    throw new Error('找不到可写入的根文件夹（宿主根下没有任何文件夹）');
  }
  // 桶里若还有旧版留下的同名包装（根目录/根目录…，且云端没声明名字所以没被解析端拆掉），
  // 写盘时就地摊平：子节点上提一级、不新建同名文件夹。判据只看桶的直接子层（链式继续），
  // 不跨普通文件夹 —— 用户自己在「学习」下建的同名文件夹原样保留。
  const wrapperNames = new Set([bucketTitle, MiniSync.utils.getDeclaredFlatRootContainer ? MiniSync.utils.getDeclaredFlatRootContainer() : ''].filter(Boolean));
  async function writeBucketChild(node) {
    if (node && node.isFolder && wrapperNames.size > 0
        && wrapperNames.has(String(node.title || ''))) {
      wrapperUnwrapped++;
      for (const child of (node.children || [])) await writeBucketChild(child);
      return;
    }
    await processNode(node, bucketId);
  }

  // Berry主页真实 id 解析（标准 Chrome/Edge 上 home 区节点 parentId 是虚拟 HOME_FOLDER_ID）。
  // ★ 只在云端 home 区**真的有内容**时才落地本地这个文件夹：
  //   历史版本会在云端写下一条空的「移动端主页」容器，本地跟着建一个空的，两边互相制造空壳，
  //   用户看到的就是「其他收藏夹里躺着一个用不上的空文件夹」。没有内容就不建、也不留。
  const homeContentCount = (pluginData.bookmarks || [])
    .filter(n => n && String(n.parentId) === String(HOME_FOLDER_ID)).length;
  const cloudHasHomeContent = homeContentCount > 0;
  let homeShellRemoved = false;

  const realBerryHomeNode = otherFolder && (otherFolder.children || []).find(c =>
    !c.url && FOLDER_TITLES.berryHome.some(t => String(t).toLowerCase() === String(c.title || '').toLowerCase())
  );
  let realBerryHomeId = realBerryHomeNode ? String(realBerryHomeNode.id) : null;
  if (realBerryHomeNode) {
    // ★ 标准名迁移（改名「移动端主页」的配套）：命中别名的旧容器（'Berry主页' 等）
    //   就地改名为标准名，使后续 processNode 的按标题复用能命中旧容器——
    //   否则落盘数据（chromeToXbel 用新标准名命名 home 容器）与本地铁名对不上，
    //   会新建第二个容器（旧容器空壳 + home 数据分裂）。
    const stdTitle = (FOLDER_TITLES.berryHome && FOLDER_TITLES.berryHome[0]) || '移动端主页';
    if (String(realBerryHomeNode.title || '') !== stdTitle) {
      try {
        await chrome.bookmarks.update(String(realBerryHomeNode.id), { title: stdTitle });
        realBerryHomeNode.title = stdTitle; // 同步内存对象，buildLocalIndex 索引到新名
      } catch (e) {
        console.warn(`[import] home 容器改名迁移失败（忽略）: ${e.message}`);
      }
    }
  }
  // 空壳清理的前置条件：**用户没有在用主页功能**。
  // 用户打开 Berry/Via/Aira 任一个桥接开关时，扩展会（也应该）就地建出这个「移动端主页」——
  // 那是用户明确要的，之后它暂时为空也正常。只有三个桥接全没开时才敢认定「历史遗留的空壳」。
  // 读不到设置（宿主没给 storage / 读取失败）一律**不删**：宁留一个空文件夹，不删用户的东西。
  const homeBridgeInUse = await readHomeBridgeInUse();

  if (!realBerryHomeId && otherFolder && cloudHasHomeContent) { // MUT
    try {
      const created = await chrome.bookmarks.create({
        parentId: String(otherFolder.id),
        title: (FOLDER_TITLES.berryHome && FOLDER_TITLES.berryHome[0]) || 'Berry主页'
      });
      realBerryHomeId = String(created.id);
    } catch (e) {
      console.warn(`[import] 创建 Berry主页失败: ${e.message}`);
    }
  } else if (realBerryHomeId && !cloudHasHomeContent && homeBridgeInUse === false
             && (realBerryHomeNode.children || []).length === 0) {
    // ★ 空壳清理：本地这个 home 文件夹一条内容都没有、云端 home 区也空、三个主页桥接都没开
    //   ⇒ 是历史遗留的空壳。用 remove（不是 removeTree）：浏览器会拒绝删除非空文件夹，
    //   是最后一道物理保险；删完把 id 置空，后面的索引/台账按「没有这个文件夹」处理。
    try {
      await chrome.bookmarks.remove(String(realBerryHomeId));
      homeShellRemoved = true;
      realBerryHomeId = null;
    } catch (e) {
      console.warn(`[import] 清理空的移动端主页失败（已保留）: ${e.message}`);
    }
  }

  // 系统默认文件夹 id 集合，智能覆盖时不可删除。
  // ★ 根下的**每个直接子节点**都要保护：扁平根宿主（手机）的唯一容器「根目录」不在
  //   上面三个系统名里，若只保护系统名，删除段会把整个容器连同全部书签 removeTree 掉
  //   （"本地独有"判定在扁平根上必然把容器本身也算进去）。
  // ★ realBerryHomeId 也要保护：home 容器是本次导入刚建的（在 buildLocalIndex 之前），
  //   它必然出现在删除索引里且永远匹配不到云端节点，不保护就会被「建了又删」。
  const systemFolderIds = new Set([
    String(chromeRoot.id),
    String(barFolder ? barFolder.id : '1'),
    String(otherFolder ? otherFolder.id : '2'),
    String(mobileFolder ? mobileFolder.id : '3'),
    ...rootChildren.filter(c => c && !c.url).map(c => String(c.id))
  ]);
  if (realBerryHomeId) systemFolderIds.add(String(realBerryHomeId));

  // ★ 先清空本地再重建（用户勾选时才走）：只清**本次会写入的目标** —— 同步桶的内容，
  //   以及 Berry 主页文件夹的内容；容器本身一律保留（书签栏/其他书签/移动书签/宿主的
  //   根容器都是宿主永久节点，删不得）。这是扁平根宿主上清理「同名容器层层嵌套」的确定性
  //   手段：清空后没有可复用的旧节点，云端内容被原样重建，不存在「删掉父节点连带删掉
  //   刚复用的书签」这类增量删除的坑。
  //   ⚠️ 历史实现遍历的是**所有根级容器**（rootChildren）并 removeTree 每个子节点 ——
  //   标准三区宿主上勾一次「下载重建」会把「其他书签」「移动设备书签」里的内容（同步桶
  //   之外、云端没有副本的用户数据）连同「移动端主页」文件夹本身一起物理删除，不可恢复。
  //   同步范围本身只有一个桶，清空范围就必须与写入范围一致：只清桶 + home 的内容。
  const findFolderDeep = (node, idStr) => {
    if (!node || node.url) return null;
    if (String(node.id) === idStr) return node;
    for (const c of (node.children || [])) {
      const hit = findFolderDeep(c, idStr);
      if (hit) return hit;
    }
    return null;
  };
  let clearedBefore = 0;
  if (clearLocalFirst) {
    const clearTargets = [];
    if (bucketId) clearTargets.push(String(bucketId));
    if (realBerryHomeId && String(realBerryHomeId) !== String(bucketId)) {
      clearTargets.push(String(realBerryHomeId));
    }
    const targetIdSet = new Set(clearTargets);
    for (const targetId of clearTargets) {
      const target = findFolderDeep(chromeRoot, targetId);
      if (!target) continue;
      for (const child of (target.children || [])) {
        // 清桶时跳过 home 文件夹本身（它是另一个清空目标，内容单独清；桶内嵌套 home 的
        // 扁平根宿主上，直接 removeTree 会把 home 容器连根拔掉，后续 home 写入就落空了）
        if (targetId === String(bucketId) && targetIdSet.has(String(child.id))) continue;
        if (String(child.id) === targetId) continue;
        try {
          await chrome.bookmarks.removeTree(String(child.id));
          clearedBefore++;
        } catch (e) {
          console.warn(`[import] 清空 "${child.title || child.id}" 失败（继续）: ${e.message}`);
        }
      }
    }
  }

  // 增量模式：先建立本地索引，再导入（复用已存在节点 id）。
  // ⚠️ 必须在清空之后建索引：否则索引里留着已经删掉的节点，删除段会再删一次。
  if (isMergeMode) {
    await buildLocalIndex();
  }

  // ===== 删除先行（墓碑驱动）=====
  // 墓碑点名的本地节点（merge.js 的 localDeletedIds）必须在**写入/复用阶段之前**删掉。
  // 写入阶段的「复用已有节点」会把命中删除的节点从删除索引里 splice 出去（那是它的正常
  // 职责——避免把刚复用的节点当本地独有删掉），于是等末尾的删除段再来找就永远找不到：
  // 实测「改名/移动与删除同时发生」时删除静默失效，被删节点还会随写回重新上云。
  // 删完重建索引，让后续复用/重排基于删除后的真实树。
  let removedCount = 0;
  if (isTrueMerge && deleteIds && deleteIds.size > 0) {
    const earlyTargets = [];
    const parentOf = new Map(); // childId -> parentId（判定「祖先已在删除名单」用）
    for (const [parentId, arr] of localChildrenMap) {
      for (const child of arr) {
        parentOf.set(String(child.id), String(parentId));
        if (deleteIds.has(String(child.id))) earlyTargets.push(child);
      }
    }
    // 祖先也在删除名单里的节点不单独删（removeTree 会连子树一起删，单独删会重复计数/失败）
    const targetIdSet = new Set(earlyTargets.map(c => String(c.id)));
    const underDeletedAncestor = (id) => {
      let p = parentOf.get(id);
      for (let guard = 0; p && guard < 500; guard++) {
        if (targetIdSet.has(p)) return true;
        p = parentOf.get(p);
      }
      return false;
    };
    for (const child of earlyTargets) {
      // 系统根容器（书签栏/其他书签/移动书签/桶）永不删除
      if (systemFolderIds.has(String(child.id))) continue;
      if (underDeletedAncestor(String(child.id))) continue;
      try {
        if (child.url) {
          await chrome.bookmarks.remove(String(child.id));
        } else {
          await chrome.bookmarks.removeTree(String(child.id));
        }
        removedCount++;
      } catch (e) {
        // 删除失败通常是节点已被浏览器内部移除，无需向用户展示
      }
    }
    if (removedCount > 0) {
      localChildrenMap.clear();
      globalUrlMap.clear();
      await buildLocalIndex();
    }
  }

  // 诊断台账：本轮到底把内容写进了哪个文件夹（手机端 console 读不到，全靠它）
  const targetPlan = (rootNodes || []).map(n => ({
    source: n.source || null,
    parentId: String(n.source === 'home' ? (realBerryHomeId || bucketId) : bucketId),
    byUserTarget: !!requestedTargetId,
    byBucket: !!bucketId
  }));

  for (const rootNode of rootNodes) {
    // Berry 主页（独立功能，自家 home 区）：不是同步桶内容，照旧落到 home 容器下。
    if (String(rootNode.id) === String(HOME_FOLDER_ID)) {
      const homeTarget = realBerryHomeId || bucketId;
      if (!rootNode.children || rootNode.children.length === 0) continue;
      for (const child of rootNode.children) await processNode(child, homeTarget);
      continue;
    }
    // 防御性跳过：如果 rootNode 本身就是「书签栏/其他书签/移动书签」系统根容器，
    // 不能把它再作为子文件夹导入到桶下，否则会产生嵌套的系统文件夹。
    // 这种污染常见于旧数据/其他端错误上传，这里只导入它的真实 children。
    if (isSystemRootContainer(rootNode)) {
      if (rootNode.children && rootNode.children.length) {
        for (const child of rootNode.children) await writeBucketChild(child);
      }
      continue;
    }
    // rootNodes 是 xbelToJson 给出的桶顶层节点（parentId=ROOT_ID）。顶层文件夹/书签
    // 本身就要落盘（旧逻辑只处理 children 会漏掉顶层节点，书签就"不见了"）。
    await writeBucketChild(rootNode);
  }

  // 删除：只认「云端确实删除」（墓碑 deleteIds）。下载/合并都不再「以云端为准删本地独有」——
  // 那是复现里「手机一按下载，桌面用户自己的文件夹整棵消失」的直接原因。
  // 双向增量删减（floccus 行为）走合并：merge.js 把命中云端墓碑的本地节点标进
  // localDeletedIds，由**上面「删除先行」段**按 id 删除，两端因此保持一致。
  // 这里保留一次兜底扫描（正常情况已无可删项：索引在删除后已重建）。
  // 要清理本地多出来的东西，用合并（它会先上传本地独有、再按云端墓碑删）或「先清空再重建」开关。
  const leftover = [];
  if (isTrueMerge && deleteIds && deleteIds.size > 0) {
    // 双向合并（墓碑驱动）：只删除「云端确实删除」的（deleteIds 来自墓碑）。
    // 本地独有节点保留 —— 它们会被合并引擎上传，另一端随后也拿到，这就是 floccus 的
    // 增量增删语义：两端各自增、各自删，都在下一轮合并收敛。绝不「以云端为准」扫荡。
    for (const [, arr] of localChildrenMap) {
      for (const child of arr) {
        if (deleteIds.has(String(child.id))) leftover.push(child);
      }
    }
    const deletable = leftover.filter(child => !systemFolderIds.has(String(child.id)));
    for (const child of deletable) {
      try {
        if (child.url) {
          await chrome.bookmarks.remove(String(child.id));
        } else {
          await chrome.bookmarks.removeTree(String(child.id));
        }
        removedCount++;
      } catch (e) {
        // 删除失败通常是节点已被浏览器内部移除，无需向用户展示
        // console.warn(`[import] 删除失败 "${child.title}" id=${child.id}: ${e.message}`);
      }
    }
  }

  // ★ 重排阶段的 move 失败必须能被报出来（历史实现只自增一个没人读的计数器 ⇒
  //   「顺序没同步」却报成功，台账里也看不到）。计数在下面两段重排里累加，随返回值
  //   交给调用方（buildMergeMessage 会据此如实提示「N 处顺序没落到位」）。
  let reorderMoveFailed = 0;

  // 双向合并时本地独有节点会被保留，需要把它们移到父文件夹末尾，避免被云端节点的
  // 绝对 _index 重排挤错位。下载（非真合并）不保本地独有，整段跳过。
  if (isMergeMode && isTrueMerge && localChildrenMap && localChildrenMap.size > 0) {
    const localByParent = new Map();
    for (const [parentChromeId, arr] of localChildrenMap) {
      // 仅保留「未被云端复用」的本地独有节点（processNode 复用时已 splice 移除）
      if (!arr.length) continue;
      if (!localByParent.has(parentChromeId)) localByParent.set(parentChromeId, []);
      for (const item of arr) localByParent.get(parentChromeId).push(item.id);
    }
    for (const [parentId, ids] of localByParent) {
      // 从后往前 move 到末尾（index 设极大值，Chrome 会 clamp 到末位），
      // 保证本地独有节点之间相对顺序不变。
      // ★ 跳过系统根容器（书签栏/其他书签/移动书签）与桶自身：它们不是内容，
      //   真实 Chrome 拒绝移动永久根（API 抛错被静默吞掉）侥幸无害，但 Edge 等
      //   浏览器行为不保证，必须显式排除。
      for (let i = ids.length - 1; i >= 0; i--) {
        if (systemFolderIds.has(String(ids[i]))) continue;
        try {
          await chrome.bookmarks.move(String(ids[i]), { parentId: String(parentId), index: 1e9 });
        } catch (e) {
          // 单个失败不阻断其余重排，但要计数（见上），不能静默
          reorderMoveFailed++;
        }
      }
    }
  }

  // 按 _index 重排，使云端顺序同步到本地（从后往前 move）
  if (isMergeMode && landed.length > 0) {
    const byParent = new Map();
    for (const item of landed) {
      if (!byParent.has(item.parentId)) byParent.set(item.parentId, []);
      byParent.get(item.parentId).push(item);
    }
    let movedCount = 0;
    for (const [parentId, items] of byParent) {
      items.sort((a, b) => (a._index || 0) - (b._index || 0));
      // 必须从后往前 move：先定位大 index 节点，才不会破坏小 index 位置。
      for (let i = items.length - 1; i >= 0; i--) {
        try {
          await chrome.bookmarks.move(String(items[i].id), { parentId: String(parentId), index: i });
          movedCount++;
        } catch (e) {
          // 单个失败不阻断其余重排，但要计数并如实上报（见 reorderMoveFailed 的说明）
          reorderMoveFailed++;
        }
      }
    }
  }

  return {
    importedCount, createdFolderCount, removedCount, urlDupSkipped,
    totalCount: importedCount + removedCount, conflicts,
    // 诊断台账（手机端排查「写进去了但看不到」用）：写到哪些父节点 + 宿主根节点长什么样
    targets: targetPlan,
    rootId: String(chromeRoot.id),
    rootChildTitles: (chromeRoot.children || []).map(c => ({ id: String(c.id), title: c.title || '' })),
    zoneIds: {
      bar: barFolder ? String(barFolder.id) : null,
      other: otherFolder ? String(otherFolder.id) : null,
      mobile: mobileFolder ? String(mobileFolder.id) : null
    },
    requestedTargetId,
    // 单同步桶：本次到底写进了哪个文件夹（一切非 home 内容都落在这里）
    bucketId,
    bucketTitle,
    bucketKind,
    flatRootChildId: flatRootChild ? String(flatRootChild.id) : null,
    clearLocalFirst,
    clearedBefore,
    // 重排阶段 move 失败数（>0 时调用方必须如实提示「顺序没落到位」，不许静默报成功）
    moveFailed: reorderMoveFailed,
    wrapperUnwrapped,
    wrapperSpliced,
    wrapperSpliceFailures,
    // 本轮是否清掉了一个空的「移动端主页」空壳（没清就是 0，台账里如实可见）
    homeShellRemoved,
    landedSample: landed.slice(0, 5).map(x => ({ id: String(x.id), parentId: String(x.parentId) }))
  };
}

/**
 * 将 Chrome 书签树转换为虚拟文件夹结构（Berry 扁平根目录支持）
 * Berry 根目录是扁平结构，转换为标准虚拟文件夹：root → __home_folder__ + __mobile_folder__
 */
function buildLocalTreeWithVirtualFolders(rawTree) {
  // 防御性检查：确保 rawTree 是可迭代的
  let bookmarksTree;
  try {
    if (!rawTree) {
      bookmarksTree = [];
    } else if (Array.isArray(rawTree)) {
      if (rawTree.length > 0 && rawTree[0] && typeof rawTree[0] === 'object' && rawTree[0].children) {
        // chrome.bookmarks.getTree() 格式: [{ children: [...], id: "0", ... }]
        bookmarksTree = rawTree[0].children;
      } else if (rawTree.length > 0 && rawTree[0] && rawTree[0].type === 'folder') {
        // 已经是节点数组（如 Berry 格式）
        bookmarksTree = rawTree;
      } else {
        bookmarksTree = [...rawTree];  // 确保是真正的数组
      }
    } else if (typeof rawTree === 'object' && rawTree.children) {
      // 单个根节点对象（某些浏览器变体）
      bookmarksTree = rawTree.children;
    } else {
      bookmarksTree = [];
    }
  } catch (e) {
    bookmarksTree = [];
  }

  // 最终确保是可迭代数组
  if (!Array.isArray(bookmarksTree)) {
    try { bookmarksTree = Array.from(bookmarksTree); } catch (_) { bookmarksTree = []; }
  }

  // 将 Chrome 原始格式转换为内部格式（添加 type 字段）
  bookmarksTree = bookmarksTree.map(node => normalizeNode(node)).filter(Boolean);

  const now = new Date().toISOString();
  const rootId = ROOT_ID;
  const homeId = HOME_FOLDER_ID;
  const mobileId = MOBILE_FOLDER_ID;
  const titles = FOLDER_TITLES;

  /**
   * 将 Chrome 原始节点转换为内部格式（添加 type 字段）
   */
  function normalizeNode(node) {
    if (!node) return null;
    const hasUrl = !!node.url;
    return {
      type: hasUrl ? 'bookmark' : 'folder',
      id: node.id || '',
      title: node.title || (hasUrl ? node.url : ''),
      url: node.url || '',
      added: node.dateAdded ? new Date(node.dateAdded).toISOString() : new Date().toISOString(),
      modified: node.dateAdded ? new Date(node.dateAdded).toISOString() : '',
      icon: '',
      children: node.children ? node.children.map(normalizeNode).filter(Boolean) : undefined
    };
  }

  function findOrCreateFolder(parent, targetTitles, fallbackId, fallbackTitle) {
    for (const child of (parent.children || [])) {
      if (child.type !== 'folder') continue;
      if (targetTitles.includes(child.title)) return child;
    }
    const folder = { type: 'folder', id: fallbackId, title: fallbackTitle || targetTitles[0], added: now, modified: now, children: [] };
    if (!parent.children) parent.children = [];
    parent.children.unshift(folder);
    return folder;
  }

  const virtualRoot = { type: 'folder', id: rootId, title: '', added: now, modified: now, children: [] };
  const homeFolder = findOrCreateFolder(virtualRoot, titles.berryHome, homeId, titles.berryHome[0]);
  const barFolder = findOrCreateFolder(homeFolder, titles.bookmarkBar, '1', titles.bookmarkBar[0]);
  const otherFolder = findOrCreateFolder(homeFolder, titles.otherBookmarks, '2', titles.otherBookmarks[0]);
  const mobileFolder = findOrCreateFolder(virtualRoot, titles.mobileBookmarks, mobileId, titles.mobileBookmarks[0]);

  function classifyChildren(node) {
    if (!node.children) return;
    const bookmarkBarChildren = []; const otherChildren = []; const mobileChildren = [];
    for (const child of node.children) {
      if (child.type === 'bookmark' || child.type === 'separator') {
        bookmarkBarChildren.push(child);
      } else if (child.type === 'folder') {
        if (child.id === mobileId || titles.mobileBookmarks.includes(child.title)) {
          mobileChildren.push(child);
        } else {
          bookmarkBarChildren.push(child);
        }
      }
    }
    barFolder.children.push(...bookmarkBarChildren);
    otherFolder.children.push(...otherChildren);
    mobileFolder.children.push(...mobileChildren);
    node.children = [];
  }

  for (const node of (bookmarksTree || [])) {
    if (node.id === rootId) { classifyChildren(node); continue; }
    if (node.id === mobileId) { mobileFolder.children.push(...(node.children || [])); continue; }
    const isMobile = node.type === 'folder' && (node.id === mobileId || titles.mobileBookmarks.includes(node.title));
    if (isMobile) { mobileFolder.children.push(node); continue; }
    barFolder.children.push(node);
  }

  if (barFolder.children.length === 0) delete barFolder.children;
  if (otherFolder.children.length === 0) delete otherFolder.children;
  if (mobileFolder.children.length === 0) delete mobileFolder.children;
  if (homeFolder.children.length === 0) delete homeFolder.children;
  if (virtualRoot.children.length === 0) delete virtualRoot.children;
  return virtualRoot;
}

return {
  importBookmarksFromData,
  buildLocalTreeWithVirtualFolders,
  // 供单测/诊断直接驱动「拆平同名包装」（不改 chrome 之外的任何状态）
  spliceWrapperFolders
};

})();
