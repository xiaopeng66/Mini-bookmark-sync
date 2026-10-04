// edge-adapter.js — Edge 浏览器适配器
// Edge 特殊处理：过滤 managed bookmarks (id=3)、文件夹名称映射、安全清空

MiniSync.edgeAdapter = (function() {
  const edgeAdapter = {
    type: 'edge',

    /**
     * 检测是否为 Edge 浏览器环境
     */
    detect: function () {
      try {
        if (typeof chrome === 'undefined' || typeof chrome.bookmarks === 'undefined') return false;
        if (typeof navigator !== 'undefined' && /Edg\//.test(navigator.userAgent)) return true;
        if (typeof chrome !== 'undefined' && chrome.sidebar) return true;
        return false;
      } catch (_) {
        return false;
      }
    },

    /**
     * 规范化 getTree() 返回值，过滤 managed bookmarks (id=3)
     */
    normalizeTree(rawTree) {
      // 基本防御
      if (!rawTree) {
        console.warn('[Edge] normalizeTree 收到空值');
        return [{ id: '0', type: 'folder', title: '', children: [] }];
      }
      if (!Array.isArray(rawTree)) {
        console.warn('[Edge] normalizeTree 收到非数组:', typeof rawTree);
        try { return [JSON.parse(JSON.stringify(rawTree))]; } catch (_) { return [{ id: '0', type: 'folder', title: '', children: [] }]; }
      }

      const root = rawTree[0];
      if (!root || typeof root !== 'object') {
        console.warn('[Edge] normalizeTree 根节点无效');
        return [{ id: '0', type: 'folder', title: '', children: [] }];
      }

      // Edge 特殊处理：过滤 managed bookmarks (id='3')
      let children = root.children;
      if (Array.isArray(children)) {
        children = children.filter(child => child.id !== '3');
      } else if (!children) {
        children = [];
      }

      // 返回标准化根节点
      return [{
        id: root.id || '0',
        type: 'folder',
        title: root.title || '',
        children: children
      }];
    },

    /**
     * 清空书签时保留 managed bookmarks (id=3)
     */
    async safeClearBookmarks() {
      // ⚠️ getTree() 可能卡住，添加超时保护
      const tree = await Promise.race([
        chrome.bookmarks.getTree(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('edge: safeClear getTree 超时(>10s)')), 10000))
      ]);
      const root = tree[0];

      if (!root?.children) return;

      for (const child of (root.children || []).slice()) {
        // Edge 的 managed bookmarks (id=3) 不能删除
        if (child.id === '3') continue;
        await this._removeRecursive(child);
      }
    },

    /**
     * 递归删除节点（内置根会失败，仅清空内容保留空壳）
     */
    async _removeRecursive(node) {
      if (!node) return;
      try {
        if (node.children) {
          // 复制一份再遍历：删除子节点会改动 node.children，for...of 直接遍历会跳过元素
          for (const child of node.children.slice()) {
            await this._removeRecursive(child);
          }
        }
        if (node.url) {
          await chrome.bookmarks.remove(node.id);
        } else {
          // 尝试删除文件夹自身（内置根会失败，被外层 catch 吞掉，保留空壳）
          await chrome.bookmarks.remove(node.id);
        }
      } catch (e) {
        // 删自身失败（内置根受保护）属正常，内容已清空；其他异常仅告警
        if (!/cannot|managed|protect|Invalid|denied/i.test(e.message || '')) {
          console.warn(`[Mini-Bookmark-Sync] [Edge] 删除节点失败 (${node.title}):`, e.message);
        }
      }
    }
  };

  return edgeAdapter;
})();
