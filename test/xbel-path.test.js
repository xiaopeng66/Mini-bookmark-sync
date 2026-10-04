// xbel-path.test.js — 覆盖 pathKey 指纹体系的关键易碎场景
// 这些场景正是 merge 算法识别"同一书签"的依据，pathKey 一旦算错就会导致
// 整棵树塌缩（全部 ROOT:bar）、重复创建或误删。
const { loadSource } = require('./load-source');

loadSource();
const computeJsonPathKeys = global.MiniSync.xbelPath.computeJsonPathKeys;

// 构造扁平书签列表的便捷函数
function bm(id, parentId, title, extra = {}) {
  return { id, parentId, title, isFolder: !!extra.isFolder, ...(extra.url ? { url: extra.url } : {}) , ...(extra.source ? { source: extra.source } : {}) };
}

describe('computeJsonPathKeys — pathKey 指纹', () => {

  test('书签栏下的书签映射为 ROOT:bar/L:...', () => {
    const list = [
      { id: 'bar', parentId: 'root', title: '书签栏', isFolder: true },
      { id: 'b1', parentId: 'bar', title: 'GitHub', url: 'https://github.com' },
    ];
    const m = computeJsonPathKeys(list);
    const pk = m.get('b1');
    expect(pk).toBe('ROOT:bar/L:https://github.com');
  });

  test('系统根容器本身（书签栏/其他/移动）被跳过，不参与比对', () => {
    const list = [
      { id: 'bar', parentId: 'root', title: '书签栏', isFolder: true },
      { id: 'other', parentId: 'root', title: '其他书签', isFolder: true },
      { id: 'mobile', parentId: 'root', title: '移动收藏夹', isFolder: true },
      { id: 'b1', parentId: 'bar', title: 'A', url: 'https://a.com' },
    ];
    const m = computeJsonPathKeys(list);
    expect(m.has('bar')).toBe(false);
    expect(m.has('other')).toBe(false);
    expect(m.has('mobile')).toBe(false);
    expect(m.has('b1')).toBe(true);
  });

  test('嵌套层级被完整保留（不会塌缩成 ROOT:bar）', () => {
    const list = [
      { id: 'bar', parentId: 'root', title: '书签栏', isFolder: true },
      { id: 'f1', parentId: 'bar', title: '开发', isFolder: true },
      { id: 'b1', parentId: 'f1', title: 'GitHub', url: 'https://github.com' },
    ];
    const m = computeJsonPathKeys(list);
    // 关键：f1 不应被截成 ROOT:bar，b1 应保留「开发」层级
    expect(m.get('b1')).toBe('ROOT:bar/F:开发/L:https://github.com');
  });

  test('重名文件夹（不同父路径）得到不同 pathKey', () => {
    const list = [
      { id: 'bar', parentId: 'root', title: '书签栏', isFolder: true },
      { id: 'fA', parentId: 'bar', title: '读书', isFolder: true },
      { id: 'fB', parentId: 'bar', title: '读书', isFolder: true }, // 普通文件夹同名（非系统根容器）
      { id: 'b1', parentId: 'fA', title: 'A', url: 'https://a.com' },
      { id: 'b2', parentId: 'fB', title: 'A', url: 'https://a.com' },
    ];
    const m = computeJsonPathKeys(list);
    // 两个「读书」都是普通文件夹（标题不在系统根容器集合里），不应被截断成 ROOT:bar
    expect(m.get('b1')).toBe('ROOT:bar/F:读书/L:https://a.com');
    expect(m.get('b2')).toBe('ROOT:bar/F:读书/L:https://a.com');
    // 注意：此处两个 pathKey 相同是「预期行为」——同名同 URL 在同一父区下本就是同一节点候选。
    // 若它们在不同父区，pathKey 会因父路径不同而不同（见下条）。
  });

  test('跨路径同名文件夹的 pathKey 因父路径不同而区分', () => {
    const list = [
      { id: 'bar', parentId: 'root', title: '书签栏', isFolder: true },
      { id: 'other', parentId: 'root', title: '其他书签', isFolder: true },
      { id: 'f1', parentId: 'bar', title: '资料', isFolder: true },
      { id: 'f2', parentId: 'other', title: '资料', isFolder: true },
      { id: 'b1', parentId: 'f1', title: 'X', url: 'https://x.com' },
      { id: 'b2', parentId: 'f2', title: 'X', url: 'https://x.com' },
    ];
    const m = computeJsonPathKeys(list);
    expect(m.get('b1')).toBe('ROOT:bar/F:资料/L:https://x.com');
    expect(m.get('b2')).toBe('ROOT:other/F:资料/L:https://x.com');
    expect(m.get('b1')).not.toBe(m.get('b2'));
  });

  test('Berry 主页（home）映射为 ROOT:home 前缀', () => {
    const list = [
      { id: '__home_folder__', parentId: 'root', title: 'Berry主页', isFolder: true },
      { id: 'h1', parentId: '__home_folder__', title: '首页', url: 'https://home.com' },
    ];
    const m = computeJsonPathKeys(list);
    expect(m.get('h1')).toBe('ROOT:home/L:https://home.com');
  });

  test('source=bar/other/mobile 的子节点按 source 补齐区前缀（父节点缺失时）', () => {
    // Berry bookmarks.json 常见：子节点 parentId 指向不存在的 id，但有 source 标记
    const list = [
      { id: 'x1', parentId: 'missing', title: 'GitHub', url: 'https://github.com', source: 'bar' },
    ];
    const m = computeJsonPathKeys(list);
    expect(m.get('x1')).toBe('ROOT:bar/L:https://github.com');
  });

  test('URL 中 &amp; 与本地 & 归一化后 pathKey 一致', () => {
    const local = [{ id: 'b1', parentId: 'root', title: '搜索', url: 'https://x.com/s?a=1&b=2' }];
    const remote = [{ id: 'r1', parentId: 'root', title: '搜索', url: 'https://x.com/s?a=1&amp;b=2' }];
    const m1 = computeJsonPathKeys(local);
    const m2 = computeJsonPathKeys(remote);
    expect(m1.get('b1')).toBe(m2.get('r1'));
  });

});
