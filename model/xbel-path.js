// xbel-path.js — XBEL 节点路径指纹工具
// 从扁平 JSON 计算 pathKey（与原 computePathKeys 兼容）

MiniSync.xbelPath = (function() {

/** 从扁平 JSON 书签列表计算 pathKey（原 computePathKeys 的代理） */
function computeJsonPathKeys(bookmarks, legacyFolderKeys = false) {
  const map = new Map();
  const byId = new Map();
  // 预置虚拟根节点，确保 parentId 指向它们的子节点能正确解析
  byId.set(ROOT_ID, { id: ROOT_ID, title: '', parentId: null, isFolder: true });
  byId.set(HOME_FOLDER_ID, { id: HOME_FOLDER_ID, title: '移动端主页', parentId: ROOT_ID, isFolder: true });
  byId.set(MOBILE_FOLDER_ID, { id: MOBILE_FOLDER_ID, title: '移动收藏夹', parentId: ROOT_ID, isFolder: true });
  // other 区虚拟容器：Berry 端 __other_folder__ 子树的 pathKey 前缀解析为 ROOT:other，
  // 与 Chrome「其他书签」区对齐（与 __mobile_folder__ 的机制对称）
  byId.set(OTHER_FOLDER_ID, { id: OTHER_FOLDER_ID, title: '其他收藏夹', parentId: ROOT_ID, isFolder: true });
  const inputIds = new Set();
  let duplicateIds = false;
  for (const n of bookmarks) {
    if (inputIds.has(n.id)) duplicateIds = true;
    inputIds.add(n.id);
    byId.set(n.id, n);
  }
  const pathCache = new Map();
  const cycleCache = new Map();
  const sysRootTitles = new Set([
    ...FOLDER_TITLES.bookmarkBar, ...FOLDER_TITLES.otherBookmarks, ...FOLDER_TITLES.mobileBookmarks
  ]);
  function hasCycle(node) {
    const visiting = new Set();
    const traversed = [];
    let cyclic = false;
    for (let cur = node; cur && cur.id !== ROOT_ID; cur = byId.get(cur.parentId)) {
      if (!duplicateIds && cycleCache.has(cur)) { cyclic = cycleCache.get(cur); break; }
      if (visiting.has(cur.id)) { cyclic = true; break; }
      visiting.add(cur.id);
      traversed.push(cur);
    }
    // Duplicate IDs historically use the final occurrence as parent, but the
    // current occurrence as child; that exceptional traversal is not cacheable.
    if (!duplicateIds) for (const n of traversed) cycleCache.set(n, cyclic);
    return cyclic;
  }

  // 识别标准浏览器默认文件夹来源（bar/other/mobile/home），避免多系统文件夹
  // 拍扁到同一个 ROOT 导致 pathKey 冲突。
  function detectFolderSource(title) {
    const t = (title || '').toLowerCase();
    if (FOLDER_TITLES.bookmarkBar.some(x => x.toLowerCase() === t)) return 'bar';
    if (FOLDER_TITLES.otherBookmarks.some(x => x.toLowerCase() === t)) return 'other';
    if (FOLDER_TITLES.mobileBookmarks.some(x => x.toLowerCase() === t)) return 'mobile';
    if (FOLDER_TITLES.berryHome.some(x => x.toLowerCase() === t)) return 'home';
    return null;
  }

  // URL 段：内部数据（本地 Chrome 与 XBEL 解析结果）现在都已是「解码一次的普通字符串」，
  // 这里只做归一化（去尾斜杠、规范化 host）。此前额外做 `&amp;`→`&` 解码，是
  // 「同一 URL 被多重解释」的一半来源（审计 2026-10-11 复现 urlEntity/url-entity-wrong-reuse）。
  function urlSeg(url) {
    return MiniSync.xbel.normalizeUrl(url);
  }

  // Reserve a distinct type marker only for slash-bearing titles. Ordinary
  // folder names (including literal %2F) and every URL key remain byte-identical.
  // Snapshots store titles and recompute keys; legacy tombstones are migrated
  // separately with tree evidence, never by blindly decoding percent strings.
  function folderSegment(value) {
    const s = String(value == null ? '' : value);
    if (legacyFolderKeys) return 'F:' + s.replace(/\//g, '%2F');
    return s.includes('/') ? 'F~:' + s.replace(/%/g, '%25').replace(/\//g, '%2F') : 'F:' + s;
  }

  function buildPath(node) {
    if (pathCache.has(node)) return pathCache.get(node);
    const value = buildUncachedPath(node);
    pathCache.set(node, value);
    return value;
  }

  function buildUncachedPath(node) {
    // 根节点统一映射到 ROOT
    if (node.id === ROOT_ID) return 'ROOT';

    // 防环：若沿父链回到已访问节点，说明存在循环 parentId（如覆盖版上传的畸形数据），
    // 直接截断返回，避免无限递归卡死整个同步流程（表现为“同步进行中，请稍候”锁不释放）。
    if (hasCycle(node)) return 'ROOT:cyclic';

    // Berry 主页虚拟容器 → ROOT:home（唯一化，避免与其它根冲突）
    if (node.id === HOME_FOLDER_ID) return 'ROOT:home';

    // 扁平根宿主的「透明节点」（zoneRoot）：宿主的书签容器（雨见/可拓上根下唯一的那个
    // 文件夹）、套在它里面的同名包装（合并 bug 留下的 根目录/根目录/…）、以及同步桶
    // 自身，都不产生路径段——它们不是用户数据。统一归 ROOT:bar（桶内容只走
    // 一个区）：于是同一个书签在手机形态（容器/学习）与桌面形态（书签栏/学习、
    // 其他收藏夹/根目录/学习）下得到同一个 pathKey，双向合并才不会来回搬。
    // zoneRoot 由各列表生产者（chromeTreeToList / xbelToJson）按结构标出。
    if (node.zoneRoot) return 'ROOT:' + (node.source || 'bar');

    // 系统根容器（bar/other/mobile）本身按 source 前缀返回；
    // Berry主页容器本身（id===HOME_FOLDER_ID）已由上方第 39 行返回 ROOT:home。
    // ★ 关键修复：只有【直接挂在虚拟根下的根容器本身】（parentId===ROOT_ID）才在此处截断，
    //   否则所有带 source 的子节点（书签栏下的任意层文件夹/书签）都会被错误截成 ROOT:source，
    //   丢失嵌套层级，导致整棵树的 pathKey 全部塌缩（如全部变成 ROOT:bar），
    //   合并算法因此判定本地=云端、任何拖动/重排/增删都检测不到。
    //   根容器下的子节点交给下方 50-72 行的正常递归（parentPath + '/' + seg）拼接出完整层级。
    const folderSource = (node.source && node.source !== 'home') ? node.source : detectFolderSource(node.title);
    // 根容器（书签栏/其他书签/移动书签）判定：
    // 必须同时满足 1) 标题匹配系统根容器名称；2) 直接挂在虚拟根下（parentId 为空、'0' 或 === ROOT_ID）。
    // 只判 parentId 会误把普通 folder（如「读书」）也截断成 ROOT:bar，造成 pathKey 冲突。
    // 兼容 null/'0' 是为了处理：云端 XBEL 解码后根容器 parentId 常为 null，
    // 或被污染的旧版数据里 parentId 是 Chrome 真实 browser root id '0'。
    const isRootContainer = sysRootTitles.has(node.title) &&
                           (!node.parentId || node.parentId === ROOT_ID || String(node.parentId) === '0');
    if (folderSource && isRootContainer && node.id !== HOME_FOLDER_ID) {
      return folderSource === 'home' ? 'ROOT:home' : `ROOT:${folderSource}`;
    }

    const seg = node.isFolder ? folderSegment(node.title) : `L:${urlSeg(node.url)}`;
    const parent = byId.get(node.parentId);
    if (!parent) {
      // 父节点缺失时（典型如 Berry bookmarks.json 没有根容器条目，子节点 parentId 指向一个不存在的 id），
      // 如果节点自身 source 明确（bar/other/mobile），直接按 source 补齐区前缀，避免错判成 ROOT:unknown
      // 导致与 Chrome/Via 的 ROOT:bar/* 路径无法匹配，从而重复创建。
      if (node.source && node.source !== 'home') {
        return `ROOT:${node.source}/${seg}`;
      }
      // 远程 XBEL 没有系统根容器节点、子节点直接挂在 ROOT_ID 下且无 source 时兜底
      if (node.parentId === ROOT_ID && node.source && node.source !== 'home') {
        return `ROOT:${node.source}`;
      }
      return 'ROOT:unknown';
    }

    let parentPath = buildPath(parent);
    // 远程子节点直接挂在 ROOT_ID 下时，按 source 映射到 ROOT:bar/other/mobile
    if (parent.id === ROOT_ID && node.source && node.source !== 'home') {
      parentPath = `ROOT:${node.source}`;
    }

    return parentPath + '/' + seg;
  }

  for (const n of bookmarks) {
    // 只跳过**真正的根容器本身**（本地 Chrome 树里会 push 书签栏/其他书签/移动书签，
    // 远程 XBEL 不生成它们），以及被生产者标为透明层（zoneRoot）的节点。
    // ★ 旧实现只按标题跳过任意层级的同名节点 —— 用户自己在同步桶里建的「书签栏」/
    //   移动书签」文件夹会被整棵跳过：没有 pathKey ⇒ 合并端看不见它，它下面的书签
    //   还会因父路径缺失被判成 ROOT:unknown（表现为「漏几个文件夹」「书签乱跑」）。
    //   判定必须带位置条件（父为空/虚拟根/Chrome 根 '0'）。
    // ★ 位置条件还不够（2026-10-11 审计）：用户在桶里自建的「其他书签」同样满足
    //   「挂在虚拟根下 + 标题命中系统名」，于是被当成系统容器吃掉，层级与内容失真。
    //   真正的系统容器由**生产者显式声明 source**（Via/Berry 适配器推入的 other/mobile
    //   容器；xbelToJson 产出的桶内容 source 一律归一为 'bar'）。因此：
    //     · 生产者没声明 source（老测试/旧数据）→ 沿用标题判定，保持向后兼容；
    //     · 声明了 source 但与标题推断不一致 → 是用户自建的同名文件夹，不当容器。
    const isVirtualRootChild = !n.parentId || n.parentId === ROOT_ID || String(n.parentId) === '0';
    const titleZone = detectFolderSource(n.title);
    const sourceAgrees = !n.source || n.source === titleZone;
    const isZoneRootNode = n.zoneRoot || (!!titleZone && isVirtualRootChild && sourceAgrees);
    if (isZoneRootNode) continue;

    map.set(n.id, buildPath(n));
  }

  return map;
}

/** Evidence-only translation of pre-disambiguation folder keys. No URL decoding. */
function legacyKeyResolver(lists) {
  const aliases = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    const current = computeJsonPathKeys(list);
    const legacy = computeJsonPathKeys(list, true);
    for (const [id, oldPk] of legacy) {
      if (!aliases.has(oldPk)) aliases.set(oldPk, new Set());
      aliases.get(oldPk).add(current.get(id));
    }
  }
  return key => {
    const targets = aliases.get(key);
    if (!targets) return key; // No evidence: retain the literal key, never decode it.
    return targets.size === 1 ? [...targets][0] : null; // ambiguous deletion: preserve
  };
}

/** 将 XBEL 路径指纹转换为纯字符串数组 */
function toPathKeyArray(bookmarks) {
  const map = computeJsonPathKeys(bookmarks);
  const arr = [];
  for (const pk of map.values()) {
    arr.push(pk);
  }
  return arr;
}

return {
  computeJsonPathKeys,
  legacyKeyResolver,
  computePathKeys: computeJsonPathKeys
};

})();

// 向后兼容：Berry/Via 适配器内部裸调用 computePathKeys
function computePathKeys(bookmarks) {
  return MiniSync.xbelPath.computeJsonPathKeys(bookmarks);
}
