// sync-input.test.js — 覆盖 core/sync-input.js 的可独立验证纯逻辑
//
// 重点：_treeToFlatList（本地备份回滚用的树拍平）是最容易因结构变化回归的点，
// 它的输出契约被 restoreLocalBackup → importBookmarksFromData 依赖。

const { loadSource } = require('./load-source');
loadSource();
const { _treeToFlatList, _getBrowserType } = global.MiniSync.syncInput;

// chrome 树最小结构：根含书签栏(1)/其他(2)，下挂书签与文件夹
function makeTree() {
  return [{
    id: '0', title: '', children: [
      { id: '1', title: '书签栏', children: [
        { id: '10', title: '百度', url: 'https://baidu.com', dateAdded: 1000 },
        { id: '11', title: '工作', children: [
          { id: '110', title: 'GitHub', url: 'https://github.com', dateAdded: 1100 },
        ]},
      ]},
      { id: '2', title: '其他书签', children: [] },
    ],
  }];
}

describe('syncInput._treeToFlatList — 树拍平契约', () => {
  test('根容器(0)不进扁平列表，但顶层区(1/2)作为文件夹保留', () => {
    const list = _treeToFlatList(makeTree());
    const ids = list.map(n => n.id);
    expect(ids).not.toContain('0');      // 根容器排除
    expect(ids).toContain('1');          // 书签栏作为顶层文件夹保留
    expect(ids).toContain('2');          // 其他书签作为顶层文件夹保留
  });

  test('书签与嵌套文件夹子节点全部展开', () => {
    const list = _treeToFlatList(makeTree());
    const ids = list.map(n => n.id).sort();
    expect(ids).toEqual(['1', '10', '11', '110', '2']);
  });

  test('isFolder 标记正确（有 url 为否，有 children 为是）', () => {
    const list = _treeToFlatList(makeTree());
    const byId = Object.fromEntries(list.map(n => [n.id, n]));
    expect(byId['10'].isFolder).toBe(false);
    expect(byId['11'].isFolder).toBe(true);
    expect(byId['110'].isFolder).toBe(false);
  });

  test('嵌套子节点的 parentId 指向真实父 chrome id', () => {
    const list = _treeToFlatList(makeTree());
    const byId = Object.fromEntries(list.map(n => [n.id, n]));
    expect(byId['110'].parentId).toBe('11');
    expect(byId['10'].parentId).toBe('1');
  });

  test('空树返回空数组', () => {
    expect(_treeToFlatList([])).toEqual([]);
  });
});

describe('syncInput._getBrowserType — UA 识别', () => {
  afterEach(() => {
    vi.unstubAllGlobals(); // 还原 navigator stub，避免影响其它测试
  });

  test('Firefox UA 识别为 firefox', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Firefox/120.0)' });
    expect(_getBrowserType()).toBe('firefox');
  });

  test('Edge UA 识别为 edge', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 Edg/120.0' });
    expect(_getBrowserType()).toBe('edge');
  });

  test('Chrome UA 识别为 chrome', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows) Chrome/120.0' });
    expect(_getBrowserType()).toBe('chrome');
  });

  test('无 navigator 时兜底 chrome（不抛错）', () => {
    vi.stubGlobal('navigator', undefined);
    expect(_getBrowserType()).toBe('chrome');
  });
});
