// order-only-reorder.test.js — 「同一文件夹内纯换序」跨端同步回归
//
// 用户报障：只把同一个文件夹里的书签换个顺序（不增、不删、不改内容），同步不能
// 正确传播 —— 换序的那台机器自己会看到顺序被云端旧顺序盖回去，另一端也拿不到新顺序。
//
// 根因在「顺序冲突判据」：旧实现用「云端文件 mtime 与本机上次同步记录的时间戳」比大小
// 来决定顺序以谁为准（core/sync-merge.js useRemoteOrder）。真实环境里只要别的端在本机
// 上次同步之后写过云端（自动同步每 30 分钟一轮，「云端比本机记录新」几乎是常态），
// 本机刚拖好的顺序就会被判成「云端更新」而整段丢弃。
// 正确判据是快照三方比较（与内容变更同一套）：base=上次同步快照，
//   本地顺序 ≠ base → 本机是改动方 → 本机顺序胜（写回云端）；
//   本地顺序 == base 而云端 ≠ base → 云端是改动方 → 本端跟随云端顺序。
//
// 本文件用真实 merge/import/xbel/sync-merge 全链路 + 双设备共享云端（时间戳按真实量级
// 递进，避免测试时钟过小把 ORDER_TOLERANCE=2000 的判定门槛遮过去）。

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadSource, ROOT } = require('./load-source');

// ========== 内存 chrome 环境（与 cross-device-scenarios.test.js 同构）==========
function makeChrome() {
  const tree = {
    id: '0', title: '', children: [
      { id: '1', title: '书签栏', children: [] },
      { id: '2', title: '其他书签', children: [] },
      { id: '3', title: '移动设备书签', children: [] },
    ],
  };
  const store = {};
  const byId = new Map();
  let idSeq = 100;

  function index(node) {
    if (!node) return;
    byId.set(String(node.id), node);
    (node.children || []).forEach(index);
  }
  index(tree);

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function detach(id) {
    const node = byId.get(String(id));
    if (!node) return null;
    const parent = byId.get(String(node.parentId));
    if (parent && parent.children) parent.children = parent.children.filter(c => c !== node);
    return node;
  }
  function unindex(node) {
    byId.delete(String(node.id));
    (node.children || []).forEach(unindex);
  }

  const bookmarks = {
    getTree: (cb) => {
      const t = clone([tree]);
      if (typeof cb === 'function') cb(t);
      return Promise.resolve(t);
    },
    create(info, cb) {
      const parent = byId.get(String(info.parentId));
      if (!parent) throw new Error('Parent bookmark folder does not exist');
      const node = {
        id: String(++idSeq),
        parentId: String(info.parentId),
        title: info.title || '',
        dateAdded: Date.now(),
      };
      if (info.url) node.url = info.url;
      (parent.children = parent.children || []).push(node);
      byId.set(node.id, node);
      const r = clone(node);
      if (typeof cb === 'function') cb(r);
      return Promise.resolve(r);
    },
    move(id, info, cb) {
      if (['1', '2', '3'].includes(String(id))) {
        throw new Error("Can't move the root bookmark folder");
      }
      const node = detach(id);
      if (!node) throw new Error('Cannot find bookmark for id ' + id);
      const parent = byId.get(String(info.parentId));
      if (!parent) throw new Error('Parent bookmark folder does not exist');
      parent.children = parent.children || [];
      const idx = (typeof info.index === 'number' && info.index >= 0)
        ? Math.min(info.index, parent.children.length)
        : parent.children.length;
      parent.children.splice(idx, 0, node);
      node.parentId = String(info.parentId);
      const r = clone(node);
      if (typeof cb === 'function') cb(r);
      return Promise.resolve(r);
    },
    remove(id, cb) {
      if (['1', '2', '3'].includes(String(id))) throw new Error("Can't remove the root bookmark folder");
      detach(id);
      byId.delete(String(id));
      if (typeof cb === 'function') cb();
      return Promise.resolve();
    },
    removeTree(id, cb) {
      if (['1', '2', '3'].includes(String(id))) throw new Error("Can't remove the root bookmark folder");
      const node = detach(id);
      if (node) unindex(node);
      if (typeof cb === 'function') cb();
      return Promise.resolve();
    },
    update(id, changes, cb) {
      const node = byId.get(String(id));
      if (node) {
        if (changes && changes.title !== undefined) node.title = changes.title;
        if (changes && changes.url !== undefined) node.url = changes.url;
      }
      const r = node ? clone(node) : {};
      if (typeof cb === 'function') cb(r);
      return Promise.resolve(r);
    },
  };

  const chromeObj = {
    runtime: {},
    bookmarks,
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
            if (k in store) out[k] = clone(store[k]);
          });
          if (typeof cb === 'function') cb(out);
          return Promise.resolve(out);
        },
        set(data, cb) {
          Object.assign(store, clone(data));
          if (typeof cb === 'function') cb();
          return Promise.resolve();
        },
        remove(keys, cb) {
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete store[k]);
          if (typeof cb === 'function') cb();
          return Promise.resolve();
        },
      },
    },
  };
  return { chromeObj, tree, store, byId, clone };
}

// ========== 测试装置 ==========
global.chrome = global.chrome || {};
global.chrome.runtime = global.chrome.runtime || {};
loadSource();
vm.runInThisContext(
  fs.readFileSync(path.join(ROOT, 'lib/import.js'), 'utf8'),
  { filename: 'lib/import.js' }
);
const M = global.MiniSync;
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'lib/webdav.js'), 'utf8'), { filename: 'lib/webdav.js' });

// 共享云端：双设备看到同一份 WebDAV 文件。
// ★ 时间戳按【真实量级】递进：每次写入相当于「几分钟之后」。测试时钟若只有千级，
//   ORDER_TOLERANCE=2000 的判定门槛会把「云端确实比本机记录新」这个真实常态遮掉，
//   复现不出生产环境的失败。这里以 Date.now() 为基准、每次写入 +5 分钟。
const CLOUD_FILE = 'minibookmarks.xbel';
const cloud = new Map();
const MINUTE = 60 * 1000;
let cloudClock = Date.now();
function nextCloudTime() { cloudClock += 5 * MINUTE; return cloudClock; }

M.webdav = {
  isStrongETag: M.webdav.isStrongETag,
  versionWriteCondition: M.webdav.versionWriteCondition,
  describeWriteProtection: M.webdav.describeWriteProtection,
  writeProtectionNote: M.webdav.writeProtectionNote,
  getFileVersion: async (u, s, p, f) => {
    if (!cloud.has(f)) return { exists: false, content: null, etag: null, lastModified: 0, serverModified: 0 };
    const cur = cloud.get(f);
    // GET 拿到的 lastModified 就是文件自身的写入时间（服务器 Last-Modified 语义）
    return { exists: true, content: cur.content, etag: cur.etag, lastModified: cur.lastModified, serverModified: cur.lastModified };
  },
  getFile: async (u, s, p, f) => (cloud.has(f) ? cloud.get(f).content : null),
  putFile: async (u, s, p, f, content, contentType, writeCondition) => {
    const current = cloud.get(f);
    if (!writeCondition || (writeCondition.missing ? !!current
      : writeCondition.etag ? (!current || writeCondition.etag !== current.etag)
        : writeCondition.since ? (!current || current.lastModified > writeCondition.since) : false)) {
      const error = new Error('云端文件已更改，请重新下载并合并后重试');
      error.code = 'CLOUD_CONFLICT';
      throw error;
    }
    const lastModified = nextCloudTime();
    cloud.set(f, { content, etag: `"v${lastModified}"`, lastModified });
    return { lastModified, serverModified: lastModified, protection: M.webdav.describeWriteProtection(writeCondition) };
  },
  getFileInfo: async (u, s, p, f) => (cloud.has(f)
    ? { exists: true, lastModified: cloud.get(f).lastModified }
    : { exists: false, lastModified: 0 }),
  checkFileExists: async (f) => cloud.has(f),
};
M.bridgePatcher = { patchBridges: async () => {} };

beforeEach(() => {
  M.utils.resetDeclaredFlatRootContainer();
});

const devices = {};
function makeDevice(name) {
  const dev = makeChrome();
  dev.name = name;
  Object.assign(dev.store, {
    webdav_url: 'https://dav.example.com',
    webdav_user: 'u',
    webdav_password: 'p',
    webdav_bookmark_path: '',
  });
  devices[name] = dev;
  return dev;
}
function useDevice(name) { global.chrome = devices[name].chromeObj; }

// 目标文件夹（同步桶内的「工作」）的子节点标题序列
function orderOf(dev, folderTitle) {
  let hit = null;
  (function walk(n) {
    if (hit || !n) return;
    if (!n.url && (n.title || '') === folderTitle) { hit = n; return; }
    (n.children || []).forEach(walk);
  })(dev.tree);
  return hit ? hit.children.map(c => c.title || c.url || '') : null;
}
function folderOf(dev, folderTitle) {
  let hit = null;
  (function walk(n) {
    if (hit || !n) return;
    if (!n.url && (n.title || '') === folderTitle) { hit = n; return; }
    (n.children || []).forEach(walk);
  })(dev.tree);
  return hit;
}
// 云端文件里「工作」文件夹的子节点顺序（经 XBEL 解析，即真正上云的那份顺序）
function cloudOrder(folderTitle) {
  const entry = cloud.get(CLOUD_FILE);
  if (!entry) return null;
  const data = M.xbel.xbelToJson(entry.content);
  const folder = data.bookmarks.find(b => b.isFolder && (b.title || '') === folderTitle);
  if (!folder) return null;
  return data.bookmarks
    .filter(b => String(b.parentId) === String(folder.id))
    .sort((a, b) => (a._index || 0) - (b._index || 0))
    .map(b => b.title || b.url || '');
}
function cloudTime() { return cloud.has(CLOUD_FILE) ? cloud.get(CLOUD_FILE).lastModified : 0; }
function seedWork(dev, idPrefix) {
  const folder = { id: idPrefix + 'F', title: '工作', parentId: '1', children: [] };
  ['甲', '乙', '丙'].forEach((t, i) => {
    folder.children.push({
      id: `${idPrefix}A${i}`, title: t, url: `https://example.com/${idPrefix}/${i}`,
      parentId: folder.id, dateAdded: 1000,
    });
  });
  dev.tree.children[0].children.push(folder);
  (function idx(n) { dev.byId.set(String(n.id), n); (n.children || []).forEach(idx); })(folder);
  return folder;
}
const DA = 1000;

// 直接往设备本地树加节点（模拟用户在本机新建），id 显式给出。
// ⚠️ 用例里的 id 故意用高位数值：跨端合并会把「对端独有节点」按它自己的 chrome id 追加
//    进落盘数据，两端 id 空间若意外重叠（都是 100 起的自增），会撞出无关的 id 冲突，
//    掩盖本文件要测的顺序行为（撞号本身另有专门用例 ④）。
function addLocalNode(dev, node) {
  dev.tree.children[0].children.push(node);
  (function idx(n) { dev.byId.set(String(n.id), n); (n.children || []).forEach(idx); })(node);
  return node;
}

describe('纯换序（同文件夹内不增不删不改内容）跨端同步', () => {
  let A, B;

  // 装置：A 建库并上云，B 下载一份 → 两端同序 [甲,乙,丙]
  async function setup() {
    cloud.clear();
    cloudClock = Date.now();
    A = makeDevice('A');
    B = makeDevice('B');
    seedWork(A, 'a');
    useDevice('A');
    const up = await M.orchestrator.uploadBookmarks({});
    expect(up.success, 'A 上传失败: ' + JSON.stringify(up).slice(0, 300)).toBe(true);
    useDevice('B');
    const down = await M.orchestrator.downloadBookmarks({});
    expect(down.success, 'B 下载失败: ' + JSON.stringify(down).slice(0, 300)).toBe(true);
    expect(orderOf(B, '工作'), '前置：两端起始顺序一致').toEqual(['甲', '乙', '丙']);
  }

  test('① 本端换序后合并：本地新顺序必须保住并上云（不许被云端旧顺序回退）', async () => {
    await setup();

    // B 把「丙」拖到最前 → [丙,甲,乙]
    const workB = folderOf(B, '工作');
    await new Promise(res => B.chromeObj.bookmarks.move(String(workB.children[2].id), { parentId: workB.id, index: 0 }, res));
    expect(orderOf(B, '工作')).toEqual(['丙', '甲', '乙']);

    // 期间另一台设备（A）同步过一轮：云端文件比 B 本机记录的更新（真实环境的常态）
    useDevice('A');
    addLocalNode(A, { id: '9001', title: '新增', url: 'https://new.example', parentId: '1', dateAdded: DA });
    expect((await M.mergeStrategy.mergeSync({})).success).toBe(true);
    expect(cloudTime(), '前置：云端确实被 A 写过（比 B 上次记录新）').toBeGreaterThan(B.store.cloud_last_modified);

    // B 合并：本机刚拖的顺序是唯一改动，必须以本机为准写回云端
    useDevice('B');
    const mr = await M.mergeStrategy.mergeSync({});
    expect(mr.success).toBe(true);
    expect(orderOf(B, '工作'), 'B 本地顺序被云端旧顺序回退了').toEqual(['丙', '甲', '乙']);
    expect(cloudOrder('工作'), 'B 的新顺序没有写回云端').toEqual(['丙', '甲', '乙']);

    // 顺序传播到 A（接收端跟随云端新顺序）
    useDevice('A');
    expect((await M.mergeStrategy.mergeSync({})).success).toBe(true);
    expect(orderOf(A, '工作'), 'A 没有跟随云端新顺序').toEqual(['丙', '甲', '乙']);
  });

  test('② 对端换序 → 本端跟随，且两端第二轮是固定点（不回摆）', async () => {
    await setup();

    // A 换序：[丙,甲,乙]
    const workA = folderOf(A, '工作');
    await new Promise(res => A.chromeObj.bookmarks.move(String(workA.children[2].id), { parentId: workA.id, index: 0 }, res));
    useDevice('A');
    expect((await M.mergeStrategy.mergeSync({})).success).toBe(true);
    expect(orderOf(A, '工作')).toEqual(['丙', '甲', '乙']);
    expect(cloudOrder('工作'), 'A 的换序没有上云').toEqual(['丙', '甲', '乙']);

    // B 合并且本机没有任何改动 → 必须跟随云端新顺序
    useDevice('B');
    expect((await M.mergeStrategy.mergeSync({})).success).toBe(true);
    expect(orderOf(B, '工作'), 'B 没有跟随云端新顺序').toEqual(['丙', '甲', '乙']);

    // 固定点：两边再各合并一轮，顺序不许回摆
    useDevice('A');
    await M.mergeStrategy.mergeSync({});
    expect(orderOf(A, '工作')).toEqual(['丙', '甲', '乙']);
    useDevice('B');
    await M.mergeStrategy.mergeSync({});
    expect(orderOf(B, '工作')).toEqual(['丙', '甲', '乙']);
    expect(cloudOrder('工作')).toEqual(['丙', '甲', '乙']);
  });

  test('③ 两端都换序（真冲突）→ 结果确定且两端一致（不来回拉扯）', async () => {
    await setup();

    // A 把甲挪到末尾 → [乙,丙,甲]；B 把丙挪到最前 → [丙,甲,乙]
    const workA = folderOf(A, '工作');
    await new Promise(res => A.chromeObj.bookmarks.move(String(workA.children[0].id), { parentId: workA.id, index: 1e9 }, res));
    useDevice('A');
    await M.mergeStrategy.mergeSync({});

    const workB = folderOf(B, '工作');
    await new Promise(res => B.chromeObj.bookmarks.move(String(workB.children[2].id), { parentId: workB.id, index: 0 }, res));
    useDevice('B');
    const mrB = await M.mergeStrategy.mergeSync({});
    expect(mrB.success).toBe(true);

    // 不管谁赢，收敛后两端必须一致（本轮端顺序 == 云端顺序）
    const afterB = orderOf(B, '工作');
    expect(cloudOrder('工作'), '合并后云端顺序与端上一致').toEqual(afterB);

    useDevice('A');
    await M.mergeStrategy.mergeSync({});
    expect(orderOf(A, '工作')).toEqual(afterB);

    // 再各跑一轮：固定点，不回摆
    useDevice('B');
    await M.mergeStrategy.mergeSync({});
    expect(orderOf(B, '工作')).toEqual(afterB);
    useDevice('A');
    await M.mergeStrategy.mergeSync({});
    expect(orderOf(A, '工作')).toEqual(afterB);
    expect(cloudOrder('工作')).toEqual(afterB);
  });

  // 背景：合并会把「云端独有节点」按【它自己的 chrome id】追加进落盘数据。两端 id 空间
  // 天然重叠（都是小整数自增），远程 id 撞上某个本地 id 时，落盘引擎的 nodeMap 会丢掉
  // 先写入的那一条：被顶掉那支的子节点全挂到错误对象上、整支被静默跳过（既不参与复用
  // 也不参与重排），反被当成「本地独有」挪到父文件夹末尾 —— 顺序被搅乱、新内容还可能
  // 被重复创建一份。这条用例把「撞号不许吞子树」钉住。
  test('④ 云端独有节点的 id 与本端节点撞号：子树不许被吞、不许重复', async () => {
    await setup();
    const workIdB = String(folderOf(B, '工作').id);
    const jiaIdB = folderOf(B, '工作').children[0].id; // B 端「甲」的 chrome id

    // A 端新建一个文件夹「新夹」（故意用与 B 端「甲」相同的 id）+ 里面一个书签
    useDevice('A');
    addLocalNode(A, {
      id: String(jiaIdB), title: '新夹', parentId: '1', dateAdded: DA, children: [
        { id: '9002', title: '新书签', url: 'https://brand.example', parentId: String(jiaIdB), dateAdded: DA },
      ],
    });
    expect((await M.mergeStrategy.mergeSync({})).success).toBe(true);
    expect(cloudOrder('新夹'), '前置：A 的新夹已上云').toEqual(['新书签']);

    // B 合并：必须拿到「新夹」及其内容，且本端「工作」原封不动（顺序与条数都不许变）
    useDevice('B');
    const mr = await M.mergeStrategy.mergeSync({});
    expect(mr.success).toBe(true);
    expect(orderOf(B, '工作'), 'B 的「工作」被撞号吞掉了子树/顺序').toEqual(['甲', '乙', '丙']);
    const hit = folderOf(B, '新夹');
    expect(hit, 'B 没拿到云端的「新夹」').toBeTruthy();
    expect(hit.children.map(c => c.title), '「新夹」的内容没落盘').toEqual(['新书签']);
    expect(workIdB).toBe(String(folderOf(B, '工作').id)); // 父文件夹 id 未变（复用而非重建）
    expect(String(hit.id)).not.toBe(String(workIdB));      // 新夹是独立节点，没顶掉本端「工作」
    // 端到端：这条书签在 B 上只能有一份（撞号曾被判成「新建一份 + 原件当本地独有」）
    const urls = [];
    (function walk(n) { if (n.url) urls.push(n.url); (n.children || []).forEach(walk); })(B.tree);
    expect(urls.filter(u => u === 'https://brand.example').length, '新书签重复落盘').toBe(1);
    expect(urls.filter(u => u === 'https://example.com/a/0').length, '原「甲」被复制').toBe(1);
  });
});

describe('非空主页与同步桶顶层独立换序', () => {
  const bucketOrder = ['工作', '第二夹', '第三夹'];
  const movedBucketOrder = ['第三夹', '工作', '第二夹'];
  const homeOrder = ['主页甲', '主页乙', '主页丙'];
  const movedHomeOrder = ['主页丙', '主页甲', '主页乙'];
  let A, B;

  async function setup() {
    M.utils.setSyncBucketId('');
    cloud.clear();
    cloudClock = Date.now();
    A = makeDevice('A');
    B = makeDevice('B');
    seedWork(A, 'a');
    addLocalNode(A, { id: '700', title: '第二夹', parentId: '1', children: [] });
    addLocalNode(A, { id: '701', title: '第三夹', parentId: '1', children: [] });
    const home = { id: '500', title: '移动端主页', parentId: '2', children: [] };
    homeOrder.forEach((title, i) => home.children.push({
      id: String(501 + i), title, url: `https://home.example/${i}`, parentId: home.id,
    }));
    A.tree.children[1].children.push(home);
    A.byId.set(home.id, home);
    home.children.forEach(node => A.byId.set(node.id, node));
    useDevice('A');
    expect((await M.orchestrator.uploadBookmarks({})).success).toBe(true);
    useDevice('B');
    expect((await M.orchestrator.downloadBookmarks({})).success).toBe(true);
    expect(orderOf(B, '书签栏')).toEqual(bucketOrder);
    expect(orderOf(B, '移动端主页')).toEqual(homeOrder);
  }

  async function reorder(dev, title) {
    const folder = folderOf(dev, title);
    await dev.chromeObj.bookmarks.move(folder.children[2].id, { parentId: folder.id, index: 0 });
  }

  function expectOrders(dev, bucket, home) {
    expect(orderOf(dev, '书签栏')).toEqual(bucket);
    expect(orderOf(dev, '移动端主页')).toEqual(home);
  }

  function expectCloudOrders(bucket, home) {
    const data = M.xbel.xbelToJson(cloud.get(CLOUD_FILE).content);
    expect(data.bookmarks.filter(node => node.parentId === ROOT_ID && node.id !== HOME_FOLDER_ID)
      .sort((a, b) => a._index - b._index).map(node => node.title)).toEqual(bucket);
    expect(cloudOrder('移动端主页')).toEqual(home);
  }

  test.each(['书签栏', '移动端主页'])('%s 本地换序：云端较新也必须保留并传播', async title => {
    await setup();
    await reorder(B, title);
    useDevice('A');
    const work = folderOf(A, '工作');
    const addition = { id: '9001', title: '新增', url: 'https://new.example', parentId: work.id };
    work.children.push(addition);
    A.byId.set(addition.id, addition);
    expect((await M.mergeStrategy.mergeSync({})).success).toBe(true);
    expect(cloudTime()).toBeGreaterThan(B.store.cloud_last_modified + 2000);

    const bucket = title === '书签栏' ? movedBucketOrder : bucketOrder;
    const home = title === '移动端主页' ? movedHomeOrder : homeOrder;
    useDevice('B');
    expect((await M.mergeStrategy.mergeSync({})).success).toBe(true);
    expectOrders(B, bucket, home);
    expectCloudOrders(bucket, home);
    useDevice('A');
    expect((await M.mergeStrategy.mergeSync({})).success).toBe(true);
    expectOrders(A, bucket, home);
  });

  test.each(['书签栏', '移动端主页'])('%s 对端换序：时间戳兜底偏本地也必须跟随', async title => {
    await setup();
    await reorder(A, title);
    useDevice('A');
    expect((await M.orchestrator.uploadBookmarks({})).success).toBe(true);
    // 顺序归属必须由快照决定，不能靠较新的云端时间蒙混过关。
    B.store.cloud_last_modified = cloudTime();
    useDevice('B');
    expect((await M.mergeStrategy.mergeSync({})).success).toBe(true);
    const bucket = title === '书签栏' ? movedBucketOrder : bucketOrder;
    const home = title === '移动端主页' ? movedHomeOrder : homeOrder;
    expectOrders(B, bucket, home);
    expectCloudOrders(bucket, home);
    useDevice('A');
    expect((await M.mergeStrategy.mergeSync({})).success).toBe(true);
    expectOrders(A, bucket, home);
    useDevice('B');
    expect((await M.mergeStrategy.mergeSync({})).success).toBe(true);
    expectOrders(B, bucket, home);
  });

  test.each(['书签栏', '移动端主页'])('本地调整 %s、对端调整另一容器：分别保留两处换序', async localTitle => {
    await setup();
    await reorder(B, localTitle);
    await reorder(A, localTitle === '书签栏' ? '移动端主页' : '书签栏');
    useDevice('A');
    expect((await M.orchestrator.uploadBookmarks({})).success).toBe(true);
    useDevice('B');
    expect((await M.mergeStrategy.mergeSync({})).success).toBe(true);
    expectOrders(B, movedBucketOrder, movedHomeOrder);
    expectCloudOrders(movedBucketOrder, movedHomeOrder);
    useDevice('A');
    expect((await M.mergeStrategy.mergeSync({})).success).toBe(true);
    expectOrders(A, movedBucketOrder, movedHomeOrder);
  });
});
