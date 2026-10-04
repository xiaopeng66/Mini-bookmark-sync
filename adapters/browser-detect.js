// browser-detect.js — 浏览器检测与根目录映射
// Chrome/Edge：书签栏+其他书签+移动设备（完整三区）
// Berry：扁平根目录，用虚拟文件夹 __home_folder__ / __mobile_folder__

MiniSync.browserDetect = (function() {

  // 缓存键
  const NON_CHROME_CACHE_KEY = '_is_non_chrome_browser';

/** 检测当前浏览器类型并确定三个根目录的 Chrome ID */
  async function detectBrowserType(rootChildren, browserRootId, mobileFolderOldIds) {
    let bookmarkBarId = null;
    let otherBookmarksId = null;
    let mobileBookmarksId = null;

    // 按标题匹配根目录
    for (const topNode of rootChildren) {
      const title = (topNode.title || '').toLowerCase();
      if (FOLDER_TITLES.bookmarkBar.some(t => t.toLowerCase() === title)) {
        bookmarkBarId = topNode.id;
      } else if (FOLDER_TITLES.otherBookmarks.some(t => t.toLowerCase() === title)) {
        otherBookmarksId = topNode.id;
      } else if (FOLDER_TITLES.mobileBookmarks.some(t => t.toLowerCase() === title)) {
        mobileBookmarksId = topNode.id;
      }
    }

    // 兜底：标题匹配失败时按 Chromium 固定位置取默认值
    if (!bookmarkBarId && rootChildren.length > 0) {
      bookmarkBarId = rootChildren[0].id;
    }
    if (!otherBookmarksId && rootChildren.length > 1) {
      otherBookmarksId = rootChildren[1].id;
    }
    if (!mobileBookmarksId && rootChildren.length > 2) {
      mobileBookmarksId = rootChildren[2].id;
    }

    // ========== 浏览器类型判定 ==========
    // 关键修复：判定必须以「当前真实结构」为准（bookmarkBarId && otherBookmarksId 都存在），
    // 不再让历史缓存的 NON_CHROME_CACHE_KEY 永久锁死 isNonChrome。
    // 旧逻辑：Edge 英文版「其他收藏夹」名为 "Other favorites"，不在 FOLDER_TITLES 中，
    // 导致 otherBookmarksId 匹配失败 → 被判为 nonChrome → 写入缓存 → 之后永远走虚拟文件夹
    // （home 嵌套），与云端 XBEL 的标准 bar 根路径 prefix 错位（ROOT:home vs ROOT:bar），
    // 合并时 pathKey 不匹配 → 误判为新增 → 重复创建文件夹/书签。
    const cachedNonChrome = await chrome.storage.local.get([NON_CHROME_CACHE_KEY]);
    const matchedStandard = !!(bookmarkBarId && otherBookmarksId);
    // 缓存仅作为「曾经确认是 nonChrome」的弱提示；若本次真实结构已是标准三区，则以本次为准并清缓存。
    const isNonChrome = !matchedStandard && !!cachedNonChrome[NON_CHROME_CACHE_KEY];

    if (matchedStandard) {
      // 真实结构已是标准浏览器（Chrome/Edge 等），清除历史 nonChrome 标记，避免锁死
      if (cachedNonChrome[NON_CHROME_CACHE_KEY]) {
        await chrome.storage.local.remove(NON_CHROME_CACHE_KEY);
      }
    } else {
      // 仅在本次真实结构确实非标准时才写缓存（供后续兜底）
      if (!cachedNonChrome[NON_CHROME_CACHE_KEY]) {
        await chrome.storage.local.set({ [NON_CHROME_CACHE_KEY]: true });
      }
    }

    // ========== 根据浏览器类型调整根目录 ==========
    if (isNonChrome) {
      // Berry：书签栏直接使用浏览器根目录
      bookmarkBarId = browserRootId;

      // 移动收藏夹：有就用，没有但云端有 mobile 数据时才创建
      if (!mobileBookmarksId) {
        for (const n of rootChildren) {
          if ((n.title || '').toLowerCase() === '移动收藏夹') {
            mobileBookmarksId = n.id;
            break;
          }
        }
        if (!mobileBookmarksId && mobileFolderOldIds.length > 0) {
          mobileBookmarksId = await _ensureOrCreate(rootChildren, browserRootId, '移动收藏夹');
        }
      }
    } else {
      // Chrome/Edge：其他书签必须存在
      if (!otherBookmarksId) {
        try {
          const created = await new Promise((resolve, reject) => {
            chrome.bookmarks.create({ parentId: browserRootId, title: FOLDER_TITLES.otherBookmarks[0] },
              (r) => chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(r));
          });
          otherBookmarksId = created.id;
        } catch (e) {
          console.error(`[sync] ❌ Chrome/Edge 端创建其他书签失败:`, e.message);
        }
      }
    }

    return {
      isNonChrome,
      bookmarkBarId,
      otherBookmarksId,
      mobileBookmarksId,
      browserRootId
    };
  }

  /**
   * 在根目录下查找或创建文件夹
   */
  async function _ensureOrCreate(rootChildren, browserRootId, desiredTitle) {
    for (const n of rootChildren) {
      if ((n.title || '').toLowerCase() === desiredTitle.toLowerCase()) {
        return n.id;
      }
    }
    try {
      const created = await new Promise((resolve, reject) => {
        chrome.bookmarks.create({ parentId: browserRootId, title: desiredTitle },
          (r) => chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(r));
      });
      return created.id;
    } catch (e) {
      console.error(`[sync] 🍓 创建 "${desiredTitle}" 失败:`, e.message);
      return null;
    }
  }

  // 导出公共 API
  return {
    detectBrowserType,
    NON_CHROME_CACHE_KEY
  };
})();
