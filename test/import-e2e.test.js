// 端到端回归：模拟「Edge 上传（特定顺序）→ 谷歌下载」整条数据链，
// 验证谷歌本地顺序与 Edge 一致（含混排的文件夹与书签、以及谷歌本地独有节点）。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');

require('./load-source').loadSource();
const MiniSync = global.MiniSync;

const C = MiniSync.constants;
const prelude = `
var ROOT_ID = ${JSON.stringify(C.ROOT_ID)};
var DOWNLOAD_MODE = ${JSON.stringify(C.DOWNLOAD_MODE)};
var FOLDER_TITLES = ${JSON.stringify(C.FOLDER_TITLES)};
var HOME_FOLDER_ID = ${JSON.stringify(C.HOME_FOLDER_ID)};
var MOBILE_FOLDER_ID = ${JSON.stringify(C.MOBILE_FOLDER_ID)};
var OTHER_FOLDER_ID = ${JSON.stringify(C.OTHER_FOLDER_ID)};
`;
vm.runInThisContext(prelude + '\n' + fs.readFileSync(path.join(ROOT, 'lib/import.js'), 'utf8'), { filename: 'lib/import.js' });

function makeFakeBookmarks(initialRoot) {
  let root = JSON.parse(JSON.stringify(initialRoot));
  function findNode(id) {
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (String(n.id) === String(id)) return n;
      if (n.children) for (const c of n.children) stack.push(c);
    }
    return null;
  }
  function findParent(id) {
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (n.children) {
        for (const c of n.children) if (String(c.id) === String(id)) return n;
        for (const c of n.children) stack.push(c);
      }
    }
    return null;
  }
  function removeFromTree(node, id) {
    if (!node || !node.children) return;
    const i = node.children.findIndex(c => c && String(c.id) === id);
    if (i >= 0) { node.children.splice(i, 1); return; }
    for (const c of node.children) if (c && c.children) removeFromTree(c, id);
  }
  const api = {
    getTree: (cb) => {
      const snap = JSON.parse(JSON.stringify(root));
      if (typeof cb === 'function') cb([snap]);
      return Promise.resolve([snap]);
    },
    create: () => Promise.resolve({ id: 'new_' + Math.random().toString(36).slice(2, 8) }),
    move: (id, { parentId, index }) => {
      const node = findNode(id);
      const oldParent = node ? findParent(id) : null;
      if (oldParent && oldParent.children) {
        const i = oldParent.children.findIndex(c => String(c.id) === String(id));
        if (i >= 0) oldParent.children.splice(i, 1);
      }
      const parent = findNode(parentId);
      if (parent) {
        if (!parent.children) parent.children = [];
        let idx = index;
        if (idx == null || idx > parent.children.length) idx = parent.children.length;
        if (idx < 0) idx = 0;
        parent.children.splice(idx, 0, node);
      }
      return Promise.resolve({ id });
    },
    remove: (id) => { removeFromTree(root, String(id)); return Promise.resolve(); },
    removeTree: (id) => { removeFromTree(root, String(id)); return Promise.resolve(); },
  };
  return { api, getRoot: () => root };
}

describe('下载顺序 端到端（chromeToXbel → parseXbelFromString → import）', () => {
  beforeEach(() => {
    MiniSync.berry = { mergeBerryData: async (l) => l };
    MiniSync.via = { mergeViaData: async (l) => l };
  });

  test('Edge 上传顺序 [FolderX,BookmarkA,FolderY,BookmarkB]，谷歌下载（增量）后顺序一致、本地独有保留', async () => {
    // 1) Edge 本地树（特定顺序）
    const edgeTree = [{ id: '0', children: [
      { id: '1', title: '书签栏', children: [
        { id: 'fx', title: 'FolderX', children: [{ id: 'a', title: 'A', url: 'http://a' }] },
        { id: 'ba', title: 'BookmarkA', url: 'http://a2' },
        { id: 'fy', title: 'FolderY', children: [{ id: 'b', title: 'B', url: 'http://b' }] },
        { id: 'bb', title: 'BookmarkB', url: 'http://b2' },
      ]},
      { id: '2', title: '其他收藏夹', children: [] },
    ]}];

    // 2) Edge 上传：生成 XBEL
    const xbel = MiniSync.xbel.chromeToXbel(edgeTree, { version: '1.0', deviceId: 'edge' });
    // 3) 谷歌下载：解析 XBEL
    const pluginData = MiniSync.xbel.parseXbelFromString(xbel);

    // 4) 谷歌本地（不同顺序 + 一个独有节点 LocalOnly）
    const fake = makeFakeBookmarks({ id: '0', children: [
      { id: '1', title: '书签栏', children: [
        { id: 'bb', title: 'BookmarkB', url: 'http://b2' },
        { id: 'L', title: 'LocalOnly', url: '' },
        { id: 'fx', title: 'FolderX', children: [{ id: 'a', title: 'A', url: 'http://a' }] },
        { id: 'ba', title: 'BookmarkA', url: 'http://a2' },
        { id: 'fy', title: 'FolderY', children: [{ id: 'b', title: 'B', url: 'http://b' }] },
      ]},
      { id: '2', title: '其他收藏夹', children: [] },
    ]});
    global.chrome = { bookmarks: fake.api };

    // 5) 谷歌下载导入（与 downloadBookmarks 一致的 options：增量）
    await MiniSync.importer.importBookmarksFromData(
      pluginData,
      { mode: DOWNLOAD_MODE, mergeIntoLocal: true, mergeMode: false, skipBerryBridge: true, skipViaBridge: true }
    );

    const bar = fake.getRoot().children.find(c => c.id === '1');
    const titles = bar.children.filter(Boolean).map(c => c.title);
    // 云端那四条之间的相对顺序与云端一致（本地独有节点保留在原地，可能夹在中间 ——
    // 这是「增量」语义的必然结果：不删本地节点，就只能让它在自己原来的槽位上）
    const cloudOrder = titles.filter(t => t !== 'LocalOnly');
    expect(cloudOrder).toEqual(['FolderX', 'BookmarkA', 'FolderY', 'BookmarkB']);
    expect(titles).toContain('LocalOnly');
  });
});
