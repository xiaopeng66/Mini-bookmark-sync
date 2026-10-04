// 回归测试：下载（增量覆盖）时，若父文件夹混有「本地独有节点」，
// 应以云端为准：复用本地同名节点 id、按云端 _index 排序，且删除云端没有的本地独有节点。
// 场景：Edge 上传（云端顺序 CloudA,CloudB）、谷歌下载（谷歌本地还有独有的 LocalOnly）。
// 期望最终 = 云端顺序(CloudA,CloudB)，本地独有 LocalOnly 被删除（不再混入谷歌端）。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');

require('./load-source').loadSource();
const MiniSync = global.MiniSync;

// import.js 原本运行在 background.js 的全局作用域（裸 var 共享）。
// vm.runInThisContext 每次调用是独立的全局代码执行，顶层裸 var 不跨调用共享，
// 因此 import.js 的裸 FOLDER_TITLES / ROOT_ID 等常量无法从 constants.js 那次执行继承。
// 解决：把常量声明作为 prelude 拼接到 import.js 代码前，在同一次执行里可见。
const C = MiniSync.constants;
const prelude = `
var ROOT_ID = ${JSON.stringify(C.ROOT_ID)};
var DOWNLOAD_MODE = ${JSON.stringify(C.DOWNLOAD_MODE)};
var FOLDER_TITLES = ${JSON.stringify(C.FOLDER_TITLES)};
var HOME_FOLDER_ID = ${JSON.stringify(C.HOME_FOLDER_ID)};
var MOBILE_FOLDER_ID = ${JSON.stringify(C.MOBILE_FOLDER_ID)};
var OTHER_FOLDER_ID = ${JSON.stringify(C.OTHER_FOLDER_ID)};
`;
// loadSource 的 ORDER 未含 lib/import.js，这里单独加载以挂载 MiniSync.importer
vm.runInThisContext(prelude + '\n' + fs.readFileSync(path.join(ROOT, 'lib/import.js'), 'utf8'), { filename: 'lib/import.js' });

// 可变的 fake chrome.bookmarks：维护内存树并真正执行 move/create，便于断言最终顺序
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
      // Chrome 真实格式：getTree 回调/返回值为根节点数组 [rootNode]
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
    remove: (id) => {
      removeFromTree(root, String(id));
      return Promise.resolve();
    },
    removeTree: (id) => {
      removeFromTree(root, String(id));
      return Promise.resolve();
    },
  };
  return { api, getRoot: () => root };
}

describe('importBookmarksFromData 顺序同步', () => {
  beforeEach(() => {
    // 桥接未在测试中加载，stub 为透传，避免 ReferenceError 中断（真实代码也已 try/catch）
    MiniSync.berry = { mergeBerryData: async (l) => l };
    MiniSync.via = { mergeViaData: async (l) => l };
  });

  test('下载（增量模式）：云端顺序在前，本地独有节点一条都不删（删除只在合并里按墓碑传播）', async () => {
    const ROOT_ID = global.ROOT_ID;
    // 谷歌本地：LocalOnly(独有) 在前，CloudA/CloudB 本地也已存在
    const fake = makeFakeBookmarks({
      id: '0',
      children: [
        { id: '1', title: '书签栏', children: [
          { id: 'L', title: 'LocalOnly', url: '', children: [] },
          { id: 'A', title: 'CloudA', url: 'http://a', children: [] },
          { id: 'B', title: 'CloudB', url: 'http://b', children: [] },
        ]},
      ],
    });
    global.chrome = { bookmarks: fake.api };

    // 云端（Edge 上传）数据：CloudA(_index0), CloudB(_index1)
    const pluginData = {
      bookmarks: [
        { id: 'nA', title: 'CloudA', url: 'http://a', isFolder: false, parentId: ROOT_ID, source: 'bar', _index: 0 },
        { id: 'nB', title: 'CloudB', url: 'http://b', isFolder: false, parentId: ROOT_ID, source: 'bar', _index: 1 },
      ],
    };

    // 与 downloadBookmarks 实际调用一致：mergeMode:false（增量），mergeIntoLocal:true（复用本地 id）
    await MiniSync.importer.importBookmarksFromData(
      pluginData,
      { mode: DOWNLOAD_MODE, mergeMode: false, mergeIntoLocal: true }
    );

    const rootAfter = fake.getRoot();
    const bar = rootAfter.children.find(c => c.id === '1');
    const titles = bar.children.map(c => c.title);
    // 期望：云端两条都在（顺序按云端 _index），本地独有保留 —— 下载不再
    // 「以云端为准」扫荡本地（旧实现把 LocalOnly 直接删掉，正是用户报的「一按下载书签就没了」）
    expect(titles.sort()).toEqual(['CloudA', 'CloudB', 'LocalOnly']);
    expect(titles.indexOf('CloudA')).toBeLessThan(titles.indexOf('CloudB'));
  });

  test('合并 + 云端墓碑：命中墓碑的本地节点被删，其它本地独有保留（双向增量删减）', async () => {
    const ROOT_ID = global.ROOT_ID;
    const fake = makeFakeBookmarks({
      id: '0',
      children: [
        { id: '1', title: '书签栏', children: [
          { id: 'L', title: 'LocalOnly', url: 'http://local', children: [] },
          { id: 'A', title: 'CloudA', url: 'http://a', children: [] },
          { id: 'D', title: 'Deleted', url: 'http://deleted', children: [] },
        ]},
      ],
    });
    global.chrome = { bookmarks: fake.api };

    const pluginData = {
      bookmarks: [
        { id: 'nA', title: 'CloudA', url: 'http://a', isFolder: false, parentId: ROOT_ID, source: 'bar', _index: 0 },
      ],
    };

    const r = await MiniSync.importer.importBookmarksFromData(
      pluginData,
      { mode: DOWNLOAD_MODE, mergeMode: true, mergeIntoLocal: true, deletedIds: ['D'] }
    );

    const bar = fake.getRoot().children.find(c => c.id === '1');
    expect(r.removedCount).toBe(1);
    // fake 的 remove 会在数组里留下空位（真 Chrome 不会），过滤后再断言
    expect(bar.children.filter(Boolean).map(c => c.title).sort()).toEqual(['CloudA', 'LocalOnly']);
  });

  test('真正合并(isTrueMerge)：本地独有节点应保留，不被删除', async () => {
    const ROOT_ID = global.ROOT_ID;
    const fake = makeFakeBookmarks({
      id: '0',
      children: [
        { id: '1', title: '书签栏', children: [
          { id: 'L', title: 'LocalOnly', url: '', children: [] },
          { id: 'A', title: 'CloudA', url: 'http://a', children: [] },
        ]},
      ],
    });
    global.chrome = { bookmarks: fake.api };

    const pluginData = {
      bookmarks: [
        { id: 'nA', title: 'CloudA', url: 'http://a', isFolder: false, parentId: ROOT_ID, source: 'bar', _index: 0 },
      ],
    };

    // 双向合并（mergeMode:true）：保留本地独有，只删云端确实删除的（此处无墓碑）
    await MiniSync.importer.importBookmarksFromData(
      pluginData,
      { mode: DOWNLOAD_MODE, mergeMode: true, mergeIntoLocal: true }
    );

    const bar = fake.getRoot().children.find(c => c.id === '1');
    // 期望：云端顺序在前，本地独有 LocalOnly 保留在末尾（不被删除）
    expect(bar.children.map(c => c.title)).toEqual(['CloudA', 'LocalOnly']);
  });

  // 回归：云端 XBEL 存在多个同名「Berry主页」容器时（历史脏数据/别名标准化所致），
  // 第 1 个容器复用本地文件夹后，第 2..N 个必须复用同一 id（内容并入），
  // 不得在其他收藏夹下新建重复文件夹（此前会出现两个 Berry主页、内容不一致）。
  test('云端多个同名 Berry主页 容器：全部复用同一本地文件夹，不新建重复文件夹', async () => {
    const ROOT_ID = global.ROOT_ID;
    const HOME = global.HOME_FOLDER_ID;
    // 本地：其他收藏夹(id='2')下已有用户原装 Berry主页(id='H')
    const fake = makeFakeBookmarks({
      id: '0',
      children: [
        { id: '1', title: '书签栏', children: [] },
        { id: '2', title: '其他书签', children: [
          { id: 'H', title: 'Berry主页', url: '', children: [
            { id: 'bm1', title: '旧主页书签', url: 'http://old', children: [] },
          ]},
        ]},
      ],
    });
    // fake.create 默认不落树，这里加调用计数以断言「文件夹未重复创建」
    let folderCreateCount = 0;
    const rawCreate = fake.api.create;
    fake.api.create = (detail) => {
      if (detail && !detail.url) folderCreateCount++;
      return rawCreate(detail);
    };
    global.chrome = { bookmarks: fake.api };

    // 云端：其他收藏夹(source='other')下两个同名 HOME 容器，内容不同
    const pluginData = {
      bookmarks: [
        { id: HOME, title: 'Berry主页', url: '', isFolder: true, parentId: ROOT_ID, source: 'other', _index: 0,
          children: [
            { id: 'cA', title: '云端A书签', url: 'http://a', isFolder: false, parentId: HOME, source: 'home', _index: 0 },
          ]},
        { id: HOME, title: 'Berry主页', url: '', isFolder: true, parentId: ROOT_ID, source: 'other', _index: 1,
          children: [
            { id: 'cB', title: '云端B书签', url: 'http://b', isFolder: false, parentId: HOME, source: 'home', _index: 0 },
          ]},
      ],
    };

    await MiniSync.importer.importBookmarksFromData(
      pluginData,
      { mode: DOWNLOAD_MODE, mergeMode: true, mergeIntoLocal: true }
    );

    // 修复前：第 2 个容器 findExistingLocal 落空且无缓存 → create 新文件夹（folderCreateCount=1）
    // 修复后：第 1 个容器复用时登记 createdFolders，第 2 个容器复用同一 id → 不创建
    expect(folderCreateCount).toBe(0);
  });
});

// ==========================================================================
// 导入台账：这次到底想要写进哪个父节点（手机端「下载成功但书签栏里没有」的定性凭据）
//   单同步桶：目标父节点＝唯一那个「同步文件夹」（bucket），由
//   utils.resolveSyncBucket 决定（显式设置 → 扁平容器 → 云端声明的镜像 → 书签栏 → 根下第一个文件夹）。
//   不再有「退到硬编码 id '1'」这一档 —— 那条路径在扁平根宿主上必然写失败，还被显示成「成功」。
// ==========================================================================
describe('导入台账：同步文件夹（bucket）与宿主根形态', () => {
  beforeEach(() => {
    MiniSync.berry = { mergeBerryData: async (l) => l };
    MiniSync.via = { mergeViaData: async (l) => l };
  });

  const ROOT_ID = global.ROOT_ID;
  const oneBookmark = (source) => ({
    bookmarks: [{ id: 'nA', title: 'A', url: 'http://a', isFolder: false, parentId: ROOT_ID, source, _index: 0 }]
  });

  test('标准根节点：桶＝书签栏（真实 id），标签如实', async () => {
    const fake = makeFakeBookmarks({
      id: '0',
      children: [
        { id: '1', title: '书签栏', children: [] },
        { id: '2', title: '其他书签', children: [] },
        { id: '3', title: '移动书签', children: [] },
      ],
    });
    global.chrome = { bookmarks: fake.api };

    const r = await MiniSync.importer.importBookmarksFromData(
      oneBookmark('bar'), { mode: DOWNLOAD_MODE, mergeMode: false, mergeIntoLocal: true }
    );

    expect(r.targets).toEqual([{ source: 'bar', parentId: '1', byUserTarget: false, byBucket: true }]);
    expect(r.bucketId).toBe('1');
    expect(r.bucketTitle).toBe('书签栏');
    expect(r.bucketKind).toBe('zone');
    expect(r.zoneIds).toEqual({ bar: '1', other: '2', mobile: '3' });
    expect(r.rootId).toBe('0');
    expect(r.rootChildTitles).toEqual([
      { id: '1', title: '书签栏' }, { id: '2', title: '其他书签' }, { id: '3', title: '移动书签' },
    ]);
    expect(r.landedSample.length).toBe(1);
    expect(r.landedSample[0].parentId).toBe('1');
  });

  test('扁平根 + 根下唯一文件夹（实测雨见形态）：云端内容直接落进容器，本地书签不删', async () => {
    const fake = makeFakeBookmarks({
      id: '-1',
      children: [{ id: '0', title: '根目录', children: [{ id: 'L', title: '本地书签', url: 'http://local', children: [] }] }],
    });
    const created = [];
    const rawCreate = fake.api.create;
    fake.api.create = (d) => { created.push(d); return rawCreate(d); };
    global.chrome = { bookmarks: fake.api };

    const r = await MiniSync.importer.importBookmarksFromData(
      oneBookmark('bar'), { mode: DOWNLOAD_MODE, mergeMode: false, mergeIntoLocal: true }
    );

    // ★ 不再建「书签栏」承载文件夹：桶内容统一按 bar 区算指纹（桶是透明节点），
    //   所以云端 bar 区的内容可以直接落进容器 —— 承载文件夹正是「书签乱跑」的来源之一。
    expect(created).toEqual([{ parentId: '0', title: 'A', url: 'http://a' }]);
    expect(r.targets).toEqual([{ source: 'bar', parentId: '0', byUserTarget: false, byBucket: true }]);
    expect(r.bucketId).toBe('0');
    expect(r.bucketTitle).toBe('根目录');
    expect(r.bucketKind).toBe('flat');
    expect(r.flatRootChildId).toBe('0');
    expect(r.zoneIds).toEqual({ bar: null, other: null, mobile: null });
    expect(r.rootChildTitles.map(c => c.title)).toEqual(['根目录']);
    const root = fake.getRoot();
    expect(root.children[0].children.some(c => c && c.title === '本地书签')).toBe(true); // 本地独有没被删
  });

  test('用户指定写入位置：压过自动探测，并且不删本地独有节点', async () => {
    const fake = makeFakeBookmarks({
      id: '0',
      children: [
        { id: '1', title: '书签栏', children: [{ id: 'L', title: '本地独有', url: 'http://local', children: [] }] },
        { id: '9', title: '我的收藏', children: [] },
      ],
    });
    const created = [];
    const rawCreate = fake.api.create;
    fake.api.create = (d) => { created.push(d); return rawCreate(d); };
    global.chrome = { bookmarks: fake.api };

    const r = await MiniSync.importer.importBookmarksFromData(
      oneBookmark('bar'), { mode: DOWNLOAD_MODE, mergeMode: false, mergeIntoLocal: true, targetParentId: '9' }
    );

    expect(r.targets).toEqual([{ source: 'bar', parentId: '9', byUserTarget: true, byBucket: true }]);
    expect(r.requestedTargetId).toBe('9');
    expect(r.bucketId).toBe('9');
    expect(r.bucketTitle).toBe('我的收藏');
    expect(created).toEqual([{ parentId: '9', title: 'A', url: 'http://a' }]);
    const bar = fake.getRoot().children.find(c => c.id === '1');
    expect(bar.children.map(c => c.title)).toEqual(['本地独有']); // 指定位置后不许删本地独有
  });

  test('根下多个非标准文件夹：取第一个当桶（不再退硬编码 id 1），其余不碰', async () => {
    const fake = makeFakeBookmarks({
      id: '0',
      children: [
        { id: 'x1', title: '手机书签', children: [] },
        { id: 'x2', title: '阅读列表', children: [{ id: 'r1', title: '待读', url: 'http://later', children: [] }] },
      ],
    });
    global.chrome = { bookmarks: fake.api };

    const r = await MiniSync.importer.importBookmarksFromData(
      oneBookmark('bar'), { mode: DOWNLOAD_MODE, mergeMode: false, mergeIntoLocal: true }
    );

    expect(r.targets).toEqual([{ source: 'bar', parentId: 'x1', byUserTarget: false, byBucket: true }]);
    expect(r.bucketId).toBe('x1');
    expect(r.bucketTitle).toBe('手机书签');
    expect(r.rootChildTitles.map(c => c.title)).toEqual(['手机书签', '阅读列表']);
    // 桶外那个文件夹的内容原样留着
    const x2 = fake.getRoot().children.find(c => c.id === 'x2');
    expect(x2.children.map(c => c.title)).toEqual(['待读']);
  });

  test('写入失败（create 抛错）：收进 conflicts，台账仍报出桶与根形态', async () => {
    const fake = makeFakeBookmarks({ id: '0', children: [{ id: '1', title: '书签栏', children: [] }] });
    const rawCreate = fake.api.create;
    fake.api.create = (detail) => {
      if (detail && detail.url) throw new Error('Not implemented');
      return rawCreate(detail);
    };
    global.chrome = { bookmarks: fake.api };

    const r = await MiniSync.importer.importBookmarksFromData(
      oneBookmark('bar'), { mode: DOWNLOAD_MODE, mergeMode: false, mergeIntoLocal: true }
    );

    expect(r.importedCount).toBe(0);
    expect(r.conflicts.length).toBe(1);
    expect(r.conflicts[0]).toMatchObject({ type: 'bookmark', title: 'A', url: 'http://a' });
    expect(r.conflicts[0].error).toContain('Not implemented');
    // 台账照样给全：写不进去也要能说清「本来要往哪写」
    expect(r.targets[0]).toMatchObject({ source: 'bar', parentId: '1', byBucket: true });
    expect(r.bucketId).toBe('1');
    expect(r.rootChildTitles.map(c => c.title)).toEqual(['书签栏']);
    expect(r.landedSample).toEqual([]);
  });
});
