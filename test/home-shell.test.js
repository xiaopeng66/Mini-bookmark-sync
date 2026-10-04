// home-shell.test.js — 「移动端主页」空壳问题
//
// 用户看到的现象：其他收藏夹里躺着一个用不上的空「移动端主页」，而且云端也有一份，
// 每次同步都回来。三个成因，本文件逐个钉住：
//   ① 写云端时把本地那个空文件夹当普通文件夹序列化进 other 区；
//   ② 桌面端同步桶 = 其他收藏夹镜像时，同一个 home 文件夹被列表收两遍
//      （一次虚拟 id HOME_FOLDER_ID、一次普通节点）—— 普通那份就是要命的那个；
//   ③ 导入时无条件创建本地 home 文件夹，云端没内容也照建。
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

const HOME_ID = C.HOME_FOLDER_ID;
const HOME_TITLE = (C.FOLDER_TITLES.berryHome && C.FOLDER_TITLES.berryHome[0]) || '移动端主页';

/** 标准宿主（书签栏 + 其他收藏夹）的根节点；home 节点挂在「其他收藏夹」下 */
function desktopRoot(homeChildren) {
  const other = {
    id: '2', title: '其他收藏夹', children: [
      { id: '9', title: '随手记', url: '', children: [{ id: '9a', title: '笔记', url: 'https://n/' }] },
      { id: '7', title: HOME_TITLE, url: '', children: homeChildren || [] }
    ]
  };
  return { id: '0', title: '', children: [
    { id: '1', title: '书签栏', children: [{ id: '10', title: 'A', url: 'https://a/' }] },
    other
  ] };
}

/** 可变的 fake chrome.bookmarks：create 真的插进树、remove 拒绝删非空文件夹（与浏览器一致） */
function makeFakeBookmarks(initialRoot) {
  let root = JSON.parse(JSON.stringify(initialRoot));
  const findNode = (id) => {
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (String(n.id) === String(id)) return n;
      if (n.children) for (const c of n.children) stack.push(c);
    }
    return null;
  };
  const removeFromTree = (node, id) => {
    if (!node || !node.children) return false;
    const i = node.children.findIndex((c) => c && String(c.id) === String(id));
    if (i >= 0) { node.children.splice(i, 1); return true; }
    for (const c of node.children) if (c && c.children && removeFromTree(c, id)) return true;
    return false;
  };
  const api = {
    getTree: (cb) => { const snap = JSON.parse(JSON.stringify(root)); if (cb) cb([snap]); return Promise.resolve([snap]); },
    create: (payload) => {
      const parent = findNode(payload.parentId);
      const node = { id: 'new_' + Math.random().toString(36).slice(2, 8), title: payload.title || '', url: payload.url || '' };
      if (node.url) node.url = payload.url;
      if (!node.url) node.children = [];
      if (parent) { parent.children = parent.children || []; parent.children.push(node); }
      return Promise.resolve({ id: node.id, title: node.title });
    },
    update: () => Promise.resolve(),
    move: () => Promise.resolve(),
    remove: (id) => {
      const node = findNode(id);
      if (node && node.children && node.children.length > 0) {
        return Promise.reject(new Error('Cannot remove non-empty folder'));
      }
      removeFromTree(root, String(id));
      return Promise.resolve();
    },
    removeTree: (id) => { removeFromTree(root, String(id)); return Promise.resolve(); }
  };
  return { api, getRoot: () => root };
}

function titlesIn(node, out) {
  for (const c of (node.children || [])) {
    out.push(c.title);
    titlesIn(c, out);
  }
  return out;
}

/** 装 chrome：bookmarks 用假树；storage 给主页开关的读数（默认三个都关） */
function installChrome(bmApi, switches) {
  global.chrome = {
    bookmarks: bmApi,
    storage: {
      local: {
        get: async (keys) => {
          const ks = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of ks) out[k] = (switches || {})[k];
          return out;
        }
      }
    }
  };
}

beforeEach(() => {
  MiniSync.berry = { mergeBerryData: async (l) => l };
  MiniSync.via = { mergeViaData: async (l) => l };
  MiniSync.aira = { mergeAiraData: async (l) => l };
});
afterEach(() => {
  delete global.chrome;
  if (MiniSync.utils.resetSyncBucketId) MiniSync.utils.resetSyncBucketId();
});

describe('写云端：空的 home 容器不得序列化（桶遍历不许把 home 文件夹收第二遍）', () => {
  test('桌面端桶=其他收藏夹 + 空 home 容器 ⇒ 列表里只有一次（虚拟 id），云端 XML 里没有它', () => {
    MiniSync.utils.setSyncBucketId('2'); // 桶 = 其他收藏夹（桌面 Edge 的镜像配置）
    const list = MiniSync.merger.chromeTreeToList([desktopRoot([])]);

    const homeNodes = list.filter((n) => n.isFolder && MiniSync.constants.FOLDER_TITLES.berryHome
      .some((t) => String(t).toLowerCase() === String(n.title || '').toLowerCase()));
    expect(homeNodes.length).toBe(1);
    expect(homeNodes[0].id).toBe(HOME_ID);
    // 普通桶节点里不许再有「移动端主页」——那一份会被写进 other 区，就是云端的空壳
    expect(list.some((n) => n.id !== HOME_ID && n.title === HOME_TITLE)).toBe(false);

    const xml = MiniSync.xbel.jsonToXbel({ bookmarks: list });
    expect(xml).not.toContain(HOME_TITLE);
    expect(xml).toContain('A'); // 桶内容照旧写出
  });

  test('home 里真有书签 ⇒ 云端只写一个「移动端主页」，书签挂在它下面', () => {
    MiniSync.utils.setSyncBucketId('2');
    const list = MiniSync.merger.chromeTreeToList([desktopRoot([
      { id: '7a', title: '必应', url: 'https://bing.com' },
      { id: '7b', title: '知乎', url: 'https://zhihu.com' }
    ])]);

    const xml = MiniSync.xbel.jsonToXbel({ bookmarks: list });
    expect(xml.split(`<title>${HOME_TITLE}</title>`).length - 1).toBe(1);
    expect(xml).toContain('https://bing.com');
    expect(xml).toContain('https://zhihu.com');

    // 往返解析：home 容器与它的子节点都回来了（且只有一份）
    const back = MiniSync.xbel.xbelToJson(xml);
    expect(back.bookmarks.filter((n) => n.id === HOME_ID).length).toBe(1);
    expect(back.bookmarks.filter((n) => n.parentId === HOME_ID && n.url).length).toBe(2);
  });
});

describe('落本地：导入只在云端真有 home 内容时才建/留 home 文件夹', () => {
  const baseOptions = { targetParentId: '1' };

  test('云端 hove 无内容 + 本地空壳 ⇒ 清掉空壳，且报台账 homeShellRemoved=true', async () => {
    const fake = makeFakeBookmarks(desktopRoot([]));
    installChrome(fake.api);

    const pluginData = { bookmarks: [
      { id: 'nA', title: 'CloudA', url: 'https://a/', isFolder: false, parentId: global.ROOT_ID, source: 'bar', _index: 0 }
    ] };
    const result = await MiniSync.importer.importBookmarksFromData(pluginData, baseOptions);

    expect(result.homeShellRemoved).toBe(true);
    expect(fake.getRoot().children.find((c) => c.id === '2').children.some((c) => c.id === '7')).toBe(false);
  });

  test('云端 home 有内容 + 本地没有该文件夹 ⇒ 创建（不能把 home 书签写丢）', async () => {
    const tree = desktopRoot([]);
    // 本地完全没有 home 文件夹（只留「随手记」）
    tree.children.find((c) => c.id === '2').children = tree.children
      .find((c) => c.id === '2').children.filter((c) => c.id !== '7');
    const fake = makeFakeBookmarks(tree);
    installChrome(fake.api);

    const pluginData = { bookmarks: [
      { id: HOME_ID, title: HOME_TITLE, url: '', isFolder: true, parentId: global.ROOT_ID, source: 'other', _index: 0 },
      { id: 'h1', title: '必应', url: 'https://bing.com', isFolder: false, parentId: HOME_ID, source: 'home', _index: 0 }
    ] };
    const result = await MiniSync.importer.importBookmarksFromData(pluginData, baseOptions);

    expect(result.homeShellRemoved).toBe(false);
    const other = fake.getRoot().children.find((c) => c.id === '2');
    const home = (other.children || []).find((c) => c.title === HOME_TITLE);
    expect(home).toBeTruthy();
    expect(titlesIn(home, [])).toContain('必应');
  });

  test('云端 home 无内容 + 本地也没有该文件夹 ⇒ 不创建（不许凭空造一个空的移动端主页）', async () => {
    const tree = desktopRoot([]);
    tree.children.find((c) => c.id === '2').children = tree.children
      .find((c) => c.id === '2').children.filter((c) => c.id !== '7');
    const fake = makeFakeBookmarks(tree);
    installChrome(fake.api);

    const pluginData = { bookmarks: [
      { id: 'nA', title: 'CloudA', url: 'https://a/', isFolder: false, parentId: global.ROOT_ID, source: 'bar', _index: 0 }
    ] };
    const result = await MiniSync.importer.importBookmarksFromData(pluginData, baseOptions);

    expect(result.homeShellRemoved).toBe(false);
    const other = fake.getRoot().children.find((c) => c.id === '2');
    expect((other.children || []).some((c) => c.title === HOME_TITLE)).toBe(false);
  });

  test('本地 home 里有用户内容 + 云端 home 为空 ⇒ 绝不删（空壳清理只碰空文件夹）', async () => {
    const fake = makeFakeBookmarks(desktopRoot([{ id: '7a', title: '我自己的', url: 'https://mine/' }]));
    installChrome(fake.api);

    const pluginData = { bookmarks: [
      { id: 'nA', title: 'CloudA', url: 'https://a/', isFolder: false, parentId: global.ROOT_ID, source: 'bar', _index: 0 }
    ] };
    const result = await MiniSync.importer.importBookmarksFromData(pluginData, baseOptions);

    expect(result.homeShellRemoved).toBe(false);
    const other = fake.getRoot().children.find((c) => c.id === '2');
    const home = (other.children || []).find((c) => c.id === '7');
    expect(home).toBeTruthy();
    expect(titlesIn(home, [])).toContain('我自己的');
  });

  test('★ 用户开着主页桥接（Berry/Via/Aira 任一）⇒ 空的也绝不删（那是用户明确要的落点）', async () => {
    const fake = makeFakeBookmarks(desktopRoot([]));
    installChrome(fake.api, { option_berry_enabled: true });

    const pluginData = { bookmarks: [
      { id: 'nA', title: 'CloudA', url: 'https://a/', isFolder: false, parentId: global.ROOT_ID, source: 'bar', _index: 0 }
    ] };
    const result = await MiniSync.importer.importBookmarksFromData(pluginData, baseOptions);

    expect(result.homeShellRemoved).toBe(false);
    expect(fake.getRoot().children.find((c) => c.id === '2').children.some((c) => c.id === '7')).toBe(true);
  });

  test('读不到设置（宿主没给 storage）⇒ 保守不删（宁留空文件夹，不删用户的东西）', async () => {
    const fake = makeFakeBookmarks(desktopRoot([]));
    global.chrome = { bookmarks: fake.api }; // 故意不给 storage

    const pluginData = { bookmarks: [
      { id: 'nA', title: 'CloudA', url: 'https://a/', isFolder: false, parentId: global.ROOT_ID, source: 'bar', _index: 0 }
    ] };
    const result = await MiniSync.importer.importBookmarksFromData(pluginData, baseOptions);

    expect(result.homeShellRemoved).toBe(false);
    expect(fake.getRoot().children.find((c) => c.id === '2').children.some((c) => c.id === '7')).toBe(true);
  });
});
