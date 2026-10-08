// cross-device-scenarios.test.js — 跨端操作全链路场景测试
//
// 与 sync-merge.test.js（重 mock 合并引擎）不同，本文件使用【真实】的
// merge / import / xbel / xbel-path / tombstone / storage / sync-input /
// sync-merge / orchestrator 全链路，只 mock 浏览器环境：
//   - chrome.bookmarks：内存书签树（支持 create/move/remove/removeTree/index 语义）
//   - chrome.storage.local：内存 KV
//   - M.webdav：内存云端文件（双设备共享，模拟同一 WebDAV）
// 通过切换 global.chrome 模拟「设备 A / 设备 B」。
// 覆盖：上传、下载、合并、跨端新增/删除/挪位/重命名/内容修改、回滚。

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadSource, ROOT } = require('./load-source');

// ========== 内存 chrome 环境 ==========

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
      // 忠实模拟 Chrome：拒绝移动永久根文件夹（书签栏/其他书签/移动书签）
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
// lib/import.js 不在 load-source 的加载顺序里，单独按同样方式加载
vm.runInThisContext(
  fs.readFileSync(path.join(ROOT, 'lib/import.js'), 'utf8'),
  { filename: 'lib/import.js' }
);
const M = global.MiniSync;
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'lib/webdav.js'), 'utf8'), { filename: 'lib/webdav.js' });
const isStrongETag = M.webdav.isStrongETag;

// 共享云端：双设备看到同一份 WebDAV 文件
const CLOUD_FILE = 'minibookmarks.xbel'; // 与 getWebDAVConfig 的默认文件名一致
const cloud = new Map(); // filename -> { content, etag, lastModified }
let cloudClock = 1000;
M.webdav = {
  isStrongETag,
  getFileVersion: async (u, s, p, f) => (cloud.has(f)
    ? { ...cloud.get(f), exists: true }
    : { exists: false, content: null, etag: null, lastModified: 0 }),
  getFile: async (u, s, p, f) => (cloud.has(f) ? cloud.get(f).content : null),
  putFile: async (u, s, p, f, content, contentType, writeCondition) => {
    const current = cloud.get(f);
    if (!writeCondition || (writeCondition.missing ? !!current : !current || writeCondition.etag !== current.etag)) {
      const error = new Error('云端文件已更改，请重新下载并合并后重试');
      error.code = 'CLOUD_CONFLICT';
      throw error;
    }
    const lastModified = ++cloudClock;
    cloud.set(f, { content, etag: `"v${lastModified}"`, lastModified });
    return { lastModified };
  },
  getFileInfo: async (u, s, p, f) => (cloud.has(f)
    ? { exists: true, lastModified: cloud.get(f).lastModified }
    : { exists: false, lastModified: 0 }),
  checkFileExists: async (f) => cloud.has(f),
};
M.bridgePatcher = { patchBridges: async () => {} };

// 「扁平根容器名」是**模块级**声明（一次解析后全流程共用，见 lib/utils.js）。
// 它是跨流程的持久状态，测试之间必须清掉，否则上一例声明的名字会让本例的
// 标准端把用户自己的同名文件夹当包装摊平（实测：会让 ② 的上传端少写一层）。
beforeEach(() => {
  M.utils.resetDeclaredFlatRootContainer();
});

// 设备切换
const devices = {};
function makeDevice(name, seed) {
  const dev = makeChrome();
  dev.name = name;
  // 种子书签
  for (const node of (seed || [])) {
    dev.tree.children[0].children.push(node); // 全部挂书签栏
  }
  (function reindex(node) {
    dev.byId.set(String(node.id), node);
    (node.children || []).forEach(reindex);
  })(dev.tree);
  // WebDAV 配置（扁平 key，getWebDAVConfig 扁平优先）
  Object.assign(dev.store, {
    webdav_url: 'https://dav.example.com',
    webdav_user: 'u',
    webdav_password: 'p',
    webdav_bookmark_path: '',
  });
  devices[name] = dev;
  return dev;
}
function useDevice(name) {
  global.chrome = devices[name].chromeObj;
}

// 便捷断言辅助
function flatTree(dev) {
  const out = [];
  (function walk(node, parentId) {
    if (!node) return;
    if (node.id !== '0') out.push({ id: String(node.id), parentId: String(parentId), title: node.title || '', url: node.url || '', children: node.children });
    (node.children || []).forEach((c) => walk(c, node.id));
  })(dev.tree, 'root');
  return out;
}
function findUrl(dev, url) { return flatTree(dev).filter((n) => n.url === url); }
function findTitle(dev, title) { return flatTree(dev).filter((n) => n.title === title && !n.url); }

// 往已建好的设备里补节点后重新索引（makeDevice 只索引一次）
function reindexDev(dev) {
  (function idx(node) {
    dev.byId.set(String(node.id), node);
    (node.children || []).forEach(idx);
  })(dev.tree);
  return dev;
}

// 把设备改造成雨见形态：根下只有一个容器文件夹
function flattenDevice(dev, containerTitle, children) {
  for (const id of ['1', '2', '3']) dev.byId.delete(id);
  const container = { id: 'F0', title: containerTitle, parentId: '-1', children: children || [] };
  dev.tree.children = [container];
  (function idx(n) { dev.byId.set(String(n.id), n); (n.children || []).forEach(idx); })(container);
  return container;
}

// 内容指纹集合：滤掉「分区根容器本身」（pk 恰好是 ROOT:bar/other/mobile/home 的节点，
// 它们只是落点不是内容），用来断言「同一批书签在不同形态下指纹相同」。
function contentKeys(list) {
  const out = [];
  for (const pk of M.xbelPath.computeJsonPathKeys(list).values()) {
    if (/^ROOT:(bar|other|mobile|home)$/.test(pk)) continue;
    out.push(pk);
  }
  return out.sort();
}

// 结构快照（标题 + 父子关系 + id），用于断言「第二轮合并是固定点」：
// 只比形状不比 id 会漏掉「删了旧的建了新的」，只比数量会漏掉位置漂移。
function treeShape(dev) {
  return flatTree(dev).map((n) => `${n.parentId}>${n.id}:${n.url ? 'L:' + n.url : 'F:' + n.title}`).sort();
}

// 计算某设备当前树中某节点的 pathKey（供移动意图模拟）
async function pkOfCurrent(dev, nodeId) {
  useDevice(dev.name);
  const tree = await M.syncInput.getChromeTree();
  const pkMap = M.xbelPath.computeJsonPathKeys(M.merger.chromeTreeToList(tree));
  return pkMap.get(String(nodeId));
}

const DA = 1000; // 种子节点统一 dateAdded，保证 addedAt 比较确定性

// ========== 场景用例 ==========

describe('跨端场景（真实 merge/import 引擎 + 双设备共享云端）', () => {
  let A, B;

  beforeEach(() => {
    cloud.clear();
    cloudClock = 1000;
    // A：书签栏 = [百度, 工作[GitHub]]
    A = makeDevice('A', [
      { id: '10', title: '百度', url: 'https://baidu.com', dateAdded: DA, parentId: '1' },
      { id: '11', title: '工作', dateAdded: DA, parentId: '1', children: [
        { id: '110', title: 'GitHub', url: 'https://github.com', dateAdded: DA, parentId: '11' },
      ] },
    ]);
    // B：初始为空
    B = makeDevice('B', []);
  });

  test('S1 上传→下载：B 全量拿到 A 的书签', async () => {
    useDevice('A');
    const up = await M.orchestrator.uploadBookmarks({});
    expect(up.success).toBe(true);
    expect(up.bookmarkCount).toBe(2); // 百度 + GitHub

    useDevice('B');
    const down = await M.orchestrator.downloadBookmarks({});
    expect(down.success).toBe(true);
    expect(findUrl(B, 'https://baidu.com').length).toBe(1);
    expect(findUrl(B, 'https://github.com').length).toBe(1);
    expect(findTitle(B, '工作').length).toBe(1);
  });

  test('S2 跨端新增：B 新增→合并→A 拿到；重复合并不翻倍', async () => {
    const rootLog = [];
    const logRoots = (tag) => {
      rootLog.push(tag + ' A=' + JSON.stringify(A.tree.children.map((c) => c.title)) +
        ' B=' + JSON.stringify(B.tree.children.map((c) => c.title)));
    };
    useDevice('A');
    await M.orchestrator.uploadBookmarks({});
    logRoots('1-upload');

    useDevice('B');
    await M.orchestrator.downloadBookmarks({});
    logRoots('2-download');
    // B 新增书签（模拟用户操作）
    await new Promise((res) => chrome.bookmarks.create(
      { parentId: '1', title: '豆瓣', url: 'https://douban.com' }, res
    ));
    const mr1 = await M.mergeStrategy.mergeSync({});
    expect(mr1.success).toBe(true);
    logRoots('3-Bmerge');

    useDevice('A');
    const mrA = await M.mergeStrategy.mergeSync({});
    expect(mrA.success).toBe(true);
    logRoots('4-Amerge');
    const dumpA = JSON.stringify(flatTree(A).map((n) => (n.url ? 'L:' : 'F:') + (n.title || n.url)));
    expect(findUrl(A, 'https://douban.com').length,
      'rootLog=' + JSON.stringify(rootLog) + ' tree=' + dumpA +
      ' stats=' + JSON.stringify(mrA.stats)).toBe(1);

    // 连续合并不翻倍
    useDevice('B');
    await M.mergeStrategy.mergeSync({});
    const countB = findUrl(B, 'https://douban.com').length;
    expect(countB).toBe(1);
  });

  test('S3 跨端删除：A 删除百度→合并→B 合并后百度消失', async () => {
    useDevice('A');
    await M.orchestrator.uploadBookmarks({});
    // A 删除百度（快照 diff 会自动生成墓碑）
    const baidu = A.byId.get('10');
    A.tree.children[0].children = A.tree.children[0].children.filter((c) => c !== baidu);
    A.byId.delete('10');
    const putLog = [];
    const origPut = M.webdav.putFile;
    M.webdav.putFile = async (...args) => {
      const c = args[4];
      putLog.push({ hasBaiduBookmark: c.includes('href="https://baidu.com"'), hasTs: c.includes('ROOT:bar/L:https://baidu.com') });
      return origPut(...args);
    };
    const mrA = await M.mergeStrategy.mergeSync({});
    M.webdav.putFile = origPut;
    expect(mrA.success).toBe(true);
    const cloudHasBaiduAfterA = cloud.get(CLOUD_FILE) ? cloud.get(CLOUD_FILE).content.includes('href="https://baidu.com"') : 'no-file';
    const aTs = JSON.stringify(A.store.sync_tombstones || []);
    const aSnapLen = (A.store.sync_snapshots && A.store.sync_snapshots.localTree || []).length;

    useDevice('B');
    await M.orchestrator.downloadBookmarks({});
    // 下载是「云端为准」语义：云端已无百度 → B 下载后本地也该被对齐删除
    expect(findUrl(B, 'https://baidu.com').length,
      'B after download: ' + JSON.stringify(flatTree(B).map((n) => (n.url ? 'L:' : 'F:') + (n.title || n.url))) +
      ' cloudHasBaiduBookmark=' + cloudHasBaiduAfterA + ' aTombstones=' + aTs + ' aSnapLen=' + aSnapLen +
      ' putLog=' + JSON.stringify(putLog)).toBe(0);

    useDevice('B');
    await M.orchestrator.downloadBookmarks({});
    // 下载是「云端为准」语义：云端已无百度 → B 下载后本地也该被对齐删除
    expect(findUrl(B, 'https://baidu.com').length,
      'B after download: ' + JSON.stringify(flatTree(B).map((n) => (n.url ? 'L:' : 'F:') + (n.title || n.url))) +
      ' cloudHasBaidu=' + cloudHasBaiduAfterA + ' aTombstones=' + aTs + ' aSnapLen=' + aSnapLen).toBe(0);

    const mrB = await M.mergeStrategy.mergeSync({});
    expect(mrB.success).toBe(true);
    expect(findUrl(B, 'https://baidu.com').length,
      'B after merge: ' + JSON.stringify(flatTree(B).map((n) => (n.url ? 'L:' : 'F:') + (n.title || n.url))) +
      ' cloudHasBaidu=' + (cloud.get(CLOUD_FILE) ? cloud.get(CLOUD_FILE).content.includes('baidu') : 'no-file')).toBe(0); // 合并后删除传播保持生效
    expect(findUrl(B, 'https://github.com').length).toBe(1); // 其他书签不受影响
  });

  test('S4 跨端挪位：B 把 GitHub 从「工作」挪到书签栏根→A 跟随且不重复', async () => {
    useDevice('A');
    await M.orchestrator.uploadBookmarks({});
    useDevice('B');
    await M.orchestrator.downloadBookmarks({});

    // B 挪动 GitHub 到书签栏根（110 在 B 侧 id 已变，按 URL 找）
    const gh = findUrl(B, 'https://github.com')[0];
    const oldPk = await pkOfCurrent(B, gh.id);
    await new Promise((res) => chrome.bookmarks.move(gh.id, { parentId: '1' }, res));
    const newPk = await pkOfCurrent(B, gh.id);
    // 模拟 background onMoved 的移动意图记录（A2 修复依赖）
    const devId = await M.storage.getDeviceId();
    const intents = {};
    intents[oldPk] = { time: Date.now(), deviceId: devId };
    intents[newPk] = { time: Date.now(), deviceId: devId };
    await M.storage.setLocal({ sync_move_intents: intents });

    const mrB = await M.mergeStrategy.mergeSync({});
    expect(mrB.success).toBe(true);

    // 云端：GitHub 在书签栏根，不在「工作」下
    const xbel = cloud.get(CLOUD_FILE).content;
    expect(xbel).toContain('https://github.com');

    useDevice('A');
    const mrA = await M.mergeStrategy.mergeSync({});
    expect(mrA.success).toBe(true);
    // A 跟随移动：GitHub 只有一份，且父文件夹不再是「工作」
    const ghOnA = findUrl(A, 'https://github.com');
    expect(ghOnA.length).toBe(1);
    const gz = findTitle(A, '工作');
    const ghNode = A.byId.get(ghOnA[0].id);
    const parentTitle = (A.byId.get(String(ghNode.parentId)) || {}).title;
    expect(parentTitle,
      'A tree=' + JSON.stringify(flatTree(A).map((n) => (n.url ? 'L:' : 'F:') + (n.title || n.url))) +
      ' stats=' + JSON.stringify(mrA.stats) + ' cz=' + JSON.stringify(mrA.crossZoneDiag) +
      ' cloudHasWork=' + cloud.get(CLOUD_FILE).content.includes('工作')).not.toBe('工作');
    void gz;
  });

  test('S5 跨端重命名：A 把「工作」改名「职场」→B 跟随，GitHub 不丢', async () => {
    useDevice('A');
    await M.orchestrator.uploadBookmarks({});
    useDevice('B');
    await M.orchestrator.downloadBookmarks({});

    useDevice('A');
    const gz = findTitle(A, '工作')[0];
    A.byId.get(gz.id).title = '职场';
    const mrA = await M.mergeStrategy.mergeSync({});
    expect(mrA.success).toBe(true);

    useDevice('B');
    const mrB = await M.mergeStrategy.mergeSync({});
    expect(mrB.success).toBe(true);
    expect(findTitle(B, '职场').length).toBe(1);
    expect(findUrl(B, 'https://github.com').length).toBe(1); // 子书签不丢
  });

  test('S6 跨端内容修改（A1 修复）：A 改 GitHub 标题→云端更新→B 拿到', async () => {
    useDevice('A');
    await M.orchestrator.uploadBookmarks({});
    useDevice('B');
    await M.orchestrator.downloadBookmarks({});

    // A 本地改标题（时间戳不变，等价于真实用户编辑）
    useDevice('A');
    const gh = findUrl(A, 'https://github.com')[0];
    A.byId.get(gh.id).title = 'GitHub 官网';
    const before = cloud.get(CLOUD_FILE).lastModified;
    const mrA = await M.mergeStrategy.mergeSync({});
    expect(mrA.success).toBe(true);
    // ★ A1 修复断言：本地内容修改必须触发云端写回
    expect(cloud.get(CLOUD_FILE).lastModified).toBeGreaterThan(before);
    expect(cloud.get(CLOUD_FILE).content).toContain('GitHub 官网');

    useDevice('B');
    const mrB = await M.mergeStrategy.mergeSync({});
    expect(mrB.success).toBe(true);
    const ghB = findUrl(B, 'https://github.com')[0];
    expect(B.byId.get(ghB.id).title,
      'B tree=' + JSON.stringify(flatTree(B).map((n) => (n.url ? 'L:' : 'F:') + (n.title || n.url))) +
      ' stats=' + JSON.stringify(mrB.stats) + ' cloudTitleOk=' + cloud.get(CLOUD_FILE).content.includes('GitHub 官网')).toBe('GitHub 官网'); // B 跟随内容变更
  });

  test('S7 URL 复用防误删（A4 修复）：云端 URL 在 P1、本地同 URL 在 P2，下载后不丢', async () => {
    useDevice('A');
    await M.orchestrator.uploadBookmarks({});
    useDevice('B');
    await M.orchestrator.downloadBookmarks({});

    // 构造：云端 bar = [P1[dupe], P2[]]，本地 B = [P2[dupe]]
    useDevice('A');
    await new Promise((res) => chrome.bookmarks.create({ parentId: '1', title: 'P1' }, res));
    const p1a = findTitle(A, 'P1')[0];
    await new Promise((res) => chrome.bookmarks.create(
      { parentId: p1a.id, title: '重复书签', url: 'https://dupe.com' }, res
    ));
    await new Promise((res) => chrome.bookmarks.create({ parentId: '1', title: 'P2' }, res));
    // 删除百度，保持云端简单
    const bd = findUrl(A, 'https://baidu.com')[0];
    await new Promise((res) => chrome.bookmarks.remove(bd.id, res));
    const up = await M.orchestrator.uploadBookmarks({ force: true });
    expect(up.success).toBe(true);

    useDevice('B');
    // B 本地已有 dupe（在 P2 下）——先建 P2 与 dupe
    await new Promise((res) => chrome.bookmarks.create({ parentId: '1', title: 'P2' }, res));
    const p2b = findTitle(B, 'P2')[0];
    await new Promise((res) => chrome.bookmarks.create(
      { parentId: p2b.id, title: '重复书签', url: 'https://dupe.com' }, res
    ));
    const down = await M.orchestrator.downloadBookmarks({});
    expect(down.success).toBe(true);
    // Identical URLs under independent folders must not be silently moved or merged.
    const copies = findUrl(B, 'https://dupe.com');
    expect(copies).toHaveLength(2);
    expect(copies.map(n => B.byId.get(n.parentId).title).sort()).toEqual(['P1', 'P2']);
  });

  test('S8 替换式回滚（A5 修复）：清空当前+按备份恢复，无重复', async () => {
    useDevice('A');
    await M.orchestrator.uploadBookmarks({});
    // 制造备份（修复后的 backupLocalTree 自取树）
    const backupWritten = await M.syncInput.backupLocalTree();
    expect(backupWritten).toBe(true);
    const backup = A.store.local_bookmark_backup;
    expect(Array.isArray(backup)).toBe(true);
    const backupUrls = (function collect(n, out) {
      if (n.url) out.push(n.url);
      (n.children || []).forEach((c) => collect(c, out));
      return out;
    })(backup[0], []);

    // 当前树制造脏状态：新增脏文件夹
    await new Promise((res) => chrome.bookmarks.create({ parentId: '1', title: '脏数据' }, res));

    const restored = await M.syncInput.restoreLocalBackup({ replaceCurrent: true });
    expect(restored.ok).toBe(true);
    // 脏数据被清掉
    expect(findTitle(A, '脏数据').length).toBe(0);
    // 备份中的每条 URL 都恰好存在一份（无重复、无丢失）
    for (const url of backupUrls) {
      expect(findUrl(A, url).length).toBe(1);
    }
  });

  test('S9 云端时间戳口径（B3 修复）：合并写回后 lastModified 来自服务器而非本机时钟', async () => {
    useDevice('A');
    await M.orchestrator.uploadBookmarks({});
    useDevice('B');
    await M.orchestrator.downloadBookmarks({});
    useDevice('B');
    // B 端新增触发回写
    await new Promise((res) => chrome.bookmarks.create(
      { parentId: '1', title: '触发回写', url: 'https://trigger.com' }, res
    ));
    await M.mergeStrategy.mergeSync({});
    // storage 里记录的 lastModified 必须等于 mock 云端文件的服务器时间戳
    const seen = await M.storage.getLocal(['cloud_last_modified']);
    const serverTs = cloud.get(CLOUD_FILE).lastModified;
    expect(seen.cloud_last_modified).toBe(serverTs);
  });

  test('云端 GET 后版本变化时，条件合并不得覆盖另一设备的更新', async () => {
    useDevice('A');
    expect((await M.orchestrator.uploadBookmarks({})).success).toBe(true);
    useDevice('B');
    expect((await M.orchestrator.downloadBookmarks({})).success).toBe(true);
    await new Promise((res) => chrome.bookmarks.create(
      { parentId: '1', title: 'B 新增', url: 'https://b-only.example' }, res
    ));
    const originalGetVersion = M.webdav.getFileVersion;
    let newer;
    M.webdav.getFileVersion = async (...args) => {
      const version = await originalGetVersion(...args);
      const content = cloud.get(CLOUD_FILE).content.replace('href="https://baidu.com"',
        'href="https://a-newer.example"');
      const lastModified = ++cloudClock;
      newer = { content, etag: `"v${lastModified}"`, lastModified };
      cloud.set(CLOUD_FILE, newer);
      return version;
    };
    let result;
    try {
      result = await M.mergeStrategy.mergeSync({});
    } finally {
      M.webdav.getFileVersion = originalGetVersion;
    }
    expect(result.success).toBe(false);
    expect(cloud.get(CLOUD_FILE)).toEqual(newer);
  });
});


// ==========================================================================
// 「下载成功但书签栏里没有」——手机端实测症状的根因回归
//
// 机理：import.js 的目标父节点＝ 本区标题命中 → 书签栏标题命中 → 硬编码 id '1'。
//   可拓/雨见这类 Gecko fork 的根节点不按 Chrome 命名（扁平根），三个区都命中不了，
//   于是退到硬编码 '1'：宿主没有 id='1' 时 chrome.bookmarks.create 每条都抛
//   「Parent bookmark folder does not exist」，而旧实现把这 N 条失败收进 conflicts 后
//   只 console.warn，对外仍回 { success:true, message:'下载成功' } —— 手机上既看不到
//   console 也没有任何提示，用户于是看到「下载成功、书签栏空的」。
// 钉住：① 失败条数必须进 message / conflictCount；② 写进 storage 台账（不经过消息通道，
//   消息管道坏的宿主也读得到）；③ 一条都没落地时绝不能声称成功。
// ==========================================================================
describe('下载写入的如实上报与「同步文件夹」落点（手机端「下载成功但看不到」的根因）', () => {
  let src, dst;
  beforeEach(() => {
    cloud.clear();
    cloudClock = 1000;
    src = makeDevice('FORK-src', [{ id: '10', title: '百度', url: 'https://baidu.com', dateAdded: DA, parentId: '1' }]);
    dst = makeDevice('FORK-dst', []);
  });

  test('标准宿主：内容落进同步桶（书签栏），消息报出桶名，台账 ok:true', async () => {
    useDevice(src.name);
    await M.orchestrator.uploadBookmarks({});
    useDevice(dst.name);
    const down = await M.orchestrator.downloadBookmarks({});
    expect(down.success).toBe(true);
    expect(down.message).toContain('同步文件夹');
    expect(down.conflictCount).toBe(0);
    const led = dst.store.last_write_report;
    expect(led.ok).toBe(true);
    expect(led.failedWrites).toBe(0);
    expect(led.bucketId).toBe('1');                        // 自动探测＝书签栏
    expect(led.bucketTitle).toBe('书签栏');
    expect(dst.store.bookmark_target_id).toBe('1');        // 并固化进设置，行为稳定可预期
    expect(led.targets.every(t => t.byBucket === true && t.parentId === '1')).toBe(true);
    expect(led.importedCount).toBeGreaterThan(0);
    expect(led.landedSample.length).toBeGreaterThan(0);
    expect(flatTree(dst).filter(n => n.url === 'https://baidu.com').map(n => n.parentId)).toEqual(['1']);
  });

  test('写入失败（create 抛错）：下载失败、不推进成功基线，云端数据仍在', async () => {
    useDevice(src.name);
    await M.orchestrator.uploadBookmarks({});
    const cloudBefore = cloud.get(CLOUD_FILE).content;
    const etagBefore = cloud.get(CLOUD_FILE).etag;
    useDevice(dst.name);
    dst.chromeObj.bookmarks.create = () => { throw new Error('Parent bookmark folder does not exist'); };

    const down = await M.orchestrator.downloadBookmarks({});
    expect(down.success).toBe(false);
    expect(down.conflictCount).toBeGreaterThan(0);
    expect(down.message).not.toContain('下载成功');
    expect(down.conflicts.some(c => c.error.includes('Parent bookmark folder does not exist'))).toBe(true);
    expect(flatTree(dst).filter(n => n.url).length).toBe(0);
    expect(cloud.get(CLOUD_FILE).content).toBe(cloudBefore);
    expect(cloud.get(CLOUD_FILE).etag).toBe(etagBefore);
    expect(dst.store.last_sync_at).toBeUndefined();
    expect(dst.store.sync_snapshots?.localTree).toBeUndefined();
    expect(dst.store.cloud_last_modified || 0).toBe(0);
  });

  test('合并落盘失败时返回失败，且不以残缺本地树覆盖云端', async () => {
    useDevice(src.name);
    await M.orchestrator.uploadBookmarks({});
    const cloudBefore = cloud.get(CLOUD_FILE).content;
    const etagBefore = cloud.get(CLOUD_FILE).etag;
    useDevice(dst.name);
    dst.chromeObj.bookmarks.create = () => { throw new Error('Parent bookmark folder does not exist'); };

    const mr = await M.mergeStrategy.mergeSync({});
    expect(mr.success).toBe(false);
    expect(mr.conflictCount).toBeGreaterThan(0);
    expect(mr.message).toContain('云端保持不变');
    expect(cloud.get(CLOUD_FILE).content).toBe(cloudBefore);
    expect(cloud.get(CLOUD_FILE).etag).toBe(etagBefore);
    expect(dst.store.last_sync_at).toBeUndefined();
    expect(dst.store.sync_snapshots?.localTree).toBeUndefined();
    expect(flatTree(dst).filter(n => n.url).length).toBe(0);
  });

  test('用户在设置页指定的写入位置必须被下载路径采纳（同步桶就是它）', async () => {
    useDevice(src.name);
    await M.orchestrator.uploadBookmarks({});
    useDevice(dst.name);
    dst.store.bookmark_target_id = '2';                 // 其他书签（若采纳，书签栏应为空）
    const down = await M.orchestrator.downloadBookmarks({});
    expect(down.success).toBe(true);
    const led = dst.store.last_write_report;
    expect(led.bucketId).toBe('2');
    expect(led.requestedTargetId).toBe('2');
    expect(led.targets.every(t => t.parentId === '2' && t.byUserTarget === true)).toBe(true);
    expect(flatTree(dst).filter(n => n.url === 'https://baidu.com').map(n => n.parentId)).toEqual(['2']);
    expect(findUrl(dst, 'https://baidu.com').length).toBe(1);
    expect(flatTree(dst).filter(n => n.parentId === '1').length).toBe(0);   // 书签栏依旧空着
    expect(dst.store.bookmark_target_id).toBe('2');                        // 用户的选择原样保留
  });

  test('扁平根 + 根下唯一文件夹（实测雨见形态）：云端内容直接落进容器，本地书签一条不删', async () => {
    useDevice(src.name);
    await M.orchestrator.uploadBookmarks({});
    useDevice(dst.name);
    // 雨见形态：根 -1「雨见的收藏」下只有一个文件夹 0「根目录」，用户书签都挂在它下面
    for (const id of ['1', '2', '3']) dst.byId.delete(id);
    dst.tree.children = [{ id: '0', title: '根目录', parentId: '-1', children: [
      { id: 'L', title: '手机上的本地书签', url: 'https://local-only.example', parentId: '0' }
    ] }];
    dst.byId.set('0', dst.tree.children[0]);
    dst.byId.set('L', dst.tree.children[0].children[0]);

    const down = await M.orchestrator.downloadBookmarks({});
    expect(down.success).toBe(true);
    expect(down.conflictCount).toBe(0);                    // 容器存在 ⇒ 没有写入失败
    // 单同步桶：云端内容**直接**落进容器（旧版那个「书签栏」承载文件夹已删除 ——
    // 它既是「书签乱跑」的来源，也让云端分区与手机形态互相拉扯）
    expect(down.targets[0]).toMatchObject({ parentId: '0', byBucket: true });
    expect(flatTree(dst).filter(n => n.url === 'https://baidu.com').map(n => n.parentId)).toEqual(['0']);
    // 本地独有书签没被删（下载不再「以云端为准」扫荡；删除只在合并里按墓碑传播）
    expect(flatTree(dst).filter(n => n.url === 'https://local-only.example').length).toBe(1);
    const led = dst.store.last_write_report;
    expect(led.bucketId).toBe('0');
    expect(led.bucketTitle).toBe('根目录');
    expect(led.flatRootChildId).toBe('0');
    expect(led.removedCount).toBe(0);
    expect(led.ok).toBe(true);
  });

  test('根下多个非标准文件夹（用户在设置里看到的那三个「根目录」）：取第一个当同步桶，其余一动不动', async () => {
    useDevice(src.name);
    await M.orchestrator.uploadBookmarks({});

    // 用户实测形态：宿主根下并列好几个自定义文件夹（设置页下拉里就是它们）
    const G = makeDevice('FORK-multi', []);
    for (const id of ['1', '2', '3']) G.byId.delete(id);
    G.tree.children = [
      { id: 'x1', title: '手机书签', children: [
        { id: 'g1', title: '手机本地书签', url: 'https://phone-only.example' }
      ] },
      { id: 'x2', title: '阅读列表', children: [
        { id: 'g2', title: '待读', url: 'https://read-later.example' }
      ] },
    ];
    reindexDev(G);
    useDevice('FORK-multi');

    const down = await M.orchestrator.downloadBookmarks({});
    expect(down.success).toBe(true);
    expect(down.conflictCount).toBe(0);
    // ★ 不再回落到硬编码 id '1'（那条路径在扁平根宿主上必然写失败，还被显示成「成功」）
    expect(down.message).toContain('手机书签');
    expect(flatTree(G).filter(n => n.url === 'https://baidu.com').map(n => n.parentId)).toEqual(['x1']);
    const led = G.store.last_write_report;
    expect(led.bucketId).toBe('x1');
    expect(led.targets.every(t => t.byBucket === true && t.parentId === 'x1')).toBe(true);
    expect(led.ok).toBe(true);
    // 桶之外的那个文件夹：内容原样留着，没被写、没被删
    expect(findUrl(G, 'https://read-later.example').length).toBe(1);
    expect(findUrl(G, 'https://read-later.example').map(n => n.parentId)).toEqual(['x2']);
  });

  test('宿主根下真的一个文件夹都没有：如实报错，不谎报成功', async () => {
    useDevice(src.name);
    await M.orchestrator.uploadBookmarks({});
    useDevice(dst.name);
    for (const id of ['1', '2', '3']) dst.byId.delete(id);
    dst.tree.children = [];
    const down = await M.orchestrator.downloadBookmarks({});
    expect(down.success).toBe(false);
    expect(down.message).toContain('找不到同步文件夹');
  });
});


// ==========================================================================
// 扁平根宿主的「同名容器套容器」（2026-10-04 用户实测：手机上合并几次后
// 出现 根目录 / 根目录 / 根目录，每合并一轮更深一层）
//   机理（读码定性，两端各贡献一半）：
//     ① model/xbel.js 的 chromeToXbel 把这个容器当普通文件夹写进云端「其他」区
//        ⇒ 云端出现一个与容器同名的节点；
//     ② lib/import.js 下载时把云端那个同名节点在容器里新建 ⇒ 容器套容器；
//     ③ 合并还会把带嵌套的本地树回写云端（chromeToXbel），下一轮读到更深的云端 ⇒ 自激。
//   钉住：上传不写容器本身；下载遇到同名容器节点就地展开（不新建）；容器本身永不被删。
// ==========================================================================
describe('扁平根宿主的同名容器嵌套（根目录/根目录 层层套）', () => {
  beforeEach(() => {
    cloud.clear();
    cloudClock = 1000;
  });

  // 把设备改造成雨见形态：根下只有一个容器文件夹（定义在文件顶层，多个 describe 共用）

  test('① 上传：容器本身不进云端（否则下载端就会把同名节点建回来）', async () => {
    const F = makeDevice('FLAT-UP', []);
    flattenDevice(F, '根目录', [
      { id: 'f1', title: '百度', url: 'https://baidu.com', parentId: 'F0' },
      { id: 'f2', title: '学习', parentId: 'F0', children: [
        { id: 'f21', title: 'MDN', url: 'https://mdn.io', parentId: 'f2' },
      ] },
    ]);
    useDevice('FLAT-UP');
    const up = await M.orchestrator.uploadBookmarks({});
    expect(up.success).toBe(true);

    const xbel = cloud.get(CLOUD_FILE).content;
    expect(xbel).not.toContain('<title>根目录</title>');        // 容器本身没被写出去
    const data = M.xbel.xbelToJson(xbel);
    expect(data.bookmarks.map(n => n.title)).not.toContain('根目录');
    expect(data.bookmarks.map(n => n.title)).toEqual(expect.arrayContaining(['百度', '学习', 'MDN']));
    expect(data.bookmarks.filter(n => n.url).length).toBe(2);
  });

  test('⑦ 上传：手机里已经套了两层同名文件夹（用户现状）→ 上传时一并摊平，云端不留嵌套', async () => {
    const F = makeDevice('FLAT-DIRTY', []);
    // 用户实测形态：根目录(F0) / 根目录(A) / 根目录(B) / 真实内容
    flattenDevice(F, '根目录', [
      { id: 'A', title: '根目录', parentId: 'F0', children: [
        { id: 'B', title: '根目录', parentId: 'A', children: [
          { id: 'b1', title: '百度', url: 'https://baidu.com', parentId: 'B' },
        ] },
      ] },
      { id: 'top', title: '手机顶层的书签', url: 'https://phone.example', parentId: 'F0' },
    ]);
    useDevice('FLAT-DIRTY');
    const up = await M.orchestrator.uploadBookmarks({});
    expect(up.success).toBe(true);

    const xbel = cloud.get(CLOUD_FILE).content;
    expect(xbel).not.toContain('<title>根目录</title>');   // 两层包装都没写进云端
    const data = M.xbel.xbelToJson(xbel);
    expect(data.bookmarks.map(n => n.title).filter(t => t === '根目录').length).toBe(0);
    expect(data.bookmarks.map(n => n.title)).toEqual(expect.arrayContaining(['百度', '手机顶层的书签']));
    expect(data.bookmarks.filter(n => n.url).length).toBe(2);
    expect(data.bookmarks.find(n => n.url === 'https://baidu.com')).toBeTruthy();
  });

  test('② 下载：云端已有同名节点（历史脏数据）时按摊平形态读入，不再套一层', async () => {
    // 标准端上传时，它的书签栏里恰好有一个名为「根目录」的文件夹（＝手机回写来的历史脏数据）
    const A = makeDevice('WRAP-SRC', []);
    A.tree.children[0].children.push({ id: 'w1', title: '根目录', parentId: '1', children: [
      { id: 'w11', title: '百度', url: 'https://baidu.com', parentId: 'w1' },
    ] });
    A.byId.set('w1', A.tree.children[0].children[0]);
    A.byId.set('w11', A.tree.children[0].children[0].children[0]);
    useDevice('WRAP-SRC');
    await M.orchestrator.uploadBookmarks({});

    const F = makeDevice('FLAT-DOWN', []);
    flattenDevice(F, '根目录', []);
    useDevice('FLAT-DOWN');
    const down = await M.orchestrator.downloadBookmarks({});
    expect(down.success).toBe(true);

    expect(findTitle(F, '根目录').length).toBe(1);                     // 只有容器本身，没有 根目录/根目录
    // 云端那层同名包装在**解析阶段**就按摊平形态读入了（任一分区顶层的同名文件夹都是
    // 手机容器的镜像）⇒ 书签直接落进容器，不再套一层、也没有「承载文件夹」了。
    const led = F.store.last_write_report;
    expect(led.wrapperSplicedRemote).toBe(1);
    expect(led.flatRootChildId).toBe('F0');
    expect(led.bucketId).toBe('F0');
    expect(led.bucketTitle).toBe('根目录');
    expect(flatTree(F).filter(n => n.url === 'https://baidu.com').map(n => n.parentId)).toEqual(['F0']);
  });

  test('③ 上传后连续下载两轮：容器数恒为 1（修复前每轮 +1 层）', async () => {
    const F = makeDevice('FLAT-TWICE', []);
    flattenDevice(F, '根目录', [
      { id: 't1', title: '百度', url: 'https://baidu.com', parentId: 'F0' },
    ]);
    useDevice('FLAT-TWICE');
    // 第一次：手机自己上传（云端从现在起就是手机的形状）
    await M.orchestrator.uploadBookmarks({});
    expect(findTitle(F, '根目录').length).toBe(1);

    // 之后连续下载两轮，层数不许增长、书签也不许翻倍
    const d1 = await M.orchestrator.downloadBookmarks({});
    const d2 = await M.orchestrator.downloadBookmarks({});
    expect(d1.success).toBe(true);
    expect(d2.success).toBe(true);
    expect(findTitle(F, '根目录').length).toBe(1);
    expect(findUrl(F, 'https://baidu.com').length).toBe(1);
    expect(M.xbel.xbelToJson(cloud.get(CLOUD_FILE).content).bookmarks.map(n => n.title))
      .not.toContain('根目录');
  });

  test('⑥ 合并来回两轮（用户实际做的动作）：容器数恒为 1，内容不翻倍', async () => {
    const A = makeDevice('MERGE-SRC', [
      { id: 'a1', title: '百度', url: 'https://baidu.com', dateAdded: DA, parentId: '1' },
      { id: 'a2', title: '工作', dateAdded: DA, parentId: '1', children: [
        { id: 'a21', title: 'GitHub', url: 'https://github.com', dateAdded: DA, parentId: 'a2' },
      ] },
    ]);
    useDevice('MERGE-SRC');
    await M.orchestrator.uploadBookmarks({});

    const F = makeDevice('MERGE-FLAT', []);
    flattenDevice(F, '根目录', [
      { id: 'm1', title: '手机书签', url: 'https://phone.example', parentId: 'F0' },
    ]);
    useDevice('MERGE-FLAT');
    const r1 = await M.mergeStrategy.mergeSync({});
    const shapeAfterR1 = treeShape(F);
    const r2 = await M.mergeStrategy.mergeSync({});
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);

    expect(findTitle(F, '根目录').length).toBe(1);           // 没有 根目录/根目录
    expect(findUrl(F, 'https://baidu.com').length).toBe(1);  // 合并两轮不翻倍
    expect(findUrl(F, 'https://github.com').length).toBe(1);
    expect(findUrl(F, 'https://phone.example').length).toBe(1); // 手机独有书签保留
    // ★ 单同步桶的关键：云端内容写入「书签栏」区，本机没有分区 ⇒ 但桶里也统一按 bar 区
    //   计算指纹（桶是透明节点）⇒ 位置**真的落住了**（书签就在容器里），第二轮合并
    //   不需要任何「跨分区位置调整」——那套机制连同「书签乱跑」一起删掉了。
    expect(findUrl(F, 'https://baidu.com').map(n => n.parentId)).toEqual(['F0']);
    expect(findUrl(F, 'https://github.com').map(n => n.parentId)).toEqual([String(findTitle(F, '工作')[0].id)]);
    // 第二轮：零搬运（固定点）
    expect(r2.crossZoneDiag.skippedNoParent).toBe(0);
    expect(r2.crossZoneDiag.moves).toBe(0);
    expect(r2.crossZoneDiag.degraded).toBe(0);
    expect(F.store.last_write_report.crossZoneSkipped).toBe(0);
    expect(treeShape(F)).toEqual(shapeAfterR1);
  });

  test('④ 勾选「下载重建」：清空容器内容后按云端重建，嵌套垃圾消失、容器本身保留', async () => {    const A = makeDevice('PRUNE-SRC', [
      { id: 'a1', title: '百度', url: 'https://baidu.com', dateAdded: DA, parentId: '1' },
      { id: 'a2', title: '工作', dateAdded: DA, parentId: '1', children: [
        { id: 'a21', title: 'GitHub', url: 'https://github.com', dateAdded: DA, parentId: 'a2' },
      ] },
    ]);
    useDevice('PRUNE-SRC');
    await M.orchestrator.uploadBookmarks({});

    // 手机上被嵌套污染：容器里既有 百度，又多出一个同名的「根目录」垃圾文件夹
    const F = makeDevice('PRUNE-DST', []);
    flattenDevice(F, '根目录', [
      { id: 'p1', title: '百度', url: 'https://baidu.com', parentId: 'F0' },
      { id: 'p2', title: '根目录', parentId: 'F0', children: [
        { id: 'p21', title: '工作', parentId: 'p2', children: [
          { id: 'p211', title: 'GitHub', url: 'https://github.com', parentId: 'p21' },
        ] },
      ] },
    ]);
    useDevice('PRUNE-DST');
    F.store.download_clear = true;
    const down = await M.orchestrator.downloadBookmarks({});
    expect(down.success).toBe(true);

    expect(findTitle(F, '根目录').length).toBe(1);              // 容器保留，垃圾清掉
    expect(F.tree.children.length).toBe(1);                    // 容器本身没被整棵删掉
    expect(findUrl(F, 'https://baidu.com').length).toBe(1);     // 按云端重建，不重复
    expect(findUrl(F, 'https://github.com').length).toBe(1);
    expect(findTitle(F, '工作').length).toBe(1);
    const led = F.store.last_write_report;
    expect(led.clearLocalFirst).toBe(true);
    expect(led.clearedBefore).toBe(2);                          // 清掉了 百度 + 垃圾文件夹
    expect(down.message).toContain('先清空本地');
  });

  test('⑤ 未勾选（默认）：不删本地独有，但容器套容器的同名包装会被物理拆平', async () => {
    const A = makeDevice('NOPRUNE-SRC', [
      { id: 'a1', title: '百度', url: 'https://baidu.com', dateAdded: DA, parentId: '1' },
    ]);
    useDevice('NOPRUNE-SRC');
    await M.orchestrator.uploadBookmarks({});

    const F = makeDevice('NOPRUNE-DST', []);
    flattenDevice(F, '根目录', [
      { id: 'p1', title: '手机本地书签', url: 'https://phone-only.example', parentId: 'F0' },
      { id: 'p2', title: '根目录', parentId: 'F0', children: [
        { id: 'p21', title: '壳里的书签', url: 'https://in-shell.example', parentId: 'p2' },
      ] },
    ]);
    useDevice('NOPRUNE-DST');
    await M.orchestrator.downloadBookmarks({});

    expect(findUrl(F, 'https://phone-only.example').length).toBe(1); // 本地独有保留
    expect(findUrl(F, 'https://in-shell.example').length).toBe(1);   // 壳里的书签也没丢
    // 同名包装壳被物理拆掉（子节点上提一级，id 不变），容器只剩一个
    expect(findTitle(F, '根目录').length).toBe(1);
    expect(findUrl(F, 'https://in-shell.example').map(n => n.parentId)).toEqual(['F0']);
    expect(findUrl(F, 'https://in-shell.example').map(n => n.id)).toEqual(['p21']); // id 保留 ⇒ 复用/墓碑照旧
    const led = F.store.last_write_report;
    expect(led.wrapperSpliced).toBe(1);
    expect(led.clearLocalFirst).toBe(false);
    expect(led.clearedBefore).toBe(0);
    expect(led.removedCount).toBe(0);
  });

  test('⑥ 标准三区宿主 + 勾选「下载重建」：只清同步桶，桶外（其他书签）的内容一条都不许动', async () => {
    // ★ 历史缺陷：清空段遍历的是**所有根级容器**（书签栏/其他书签/移动书签）并 removeTree
    //   每个子节点 —— 标准宿主上勾一次「下载重建」，用户在「其他书签」里的东西
    //   （同步桶之外、云端没有副本）会被物理删除，不可恢复。
    const A = makeDevice('CLEARSCOPE-SRC', [
      { id: 'a1', title: '云端书', url: 'https://cloud.example', dateAdded: DA, parentId: '1' },
    ]);
    useDevice('CLEARSCOPE-SRC');
    await M.orchestrator.uploadBookmarks({});

    const F = makeDevice('CLEARSCOPE-DST', []);
    // 桶内旧内容（该被清掉）
    F.tree.children[0].children.push({ id: 'b1', title: '桶内旧书', url: 'https://old.example', parentId: '1' });
    // 桶外：其他书签(2) 下一个文件夹 + 书签（必须原样保留）
    F.tree.children[1].children.push({ id: 'u1', title: '我的收藏', parentId: '2', children: [
      { id: 'u2', title: '私人书签', url: 'https://private.example', parentId: 'u1' },
    ] });
    // 桶外：移动设备书签(3) 下一条书签
    F.tree.children[2].children.push({ id: 'v1', title: '手机收藏', url: 'https://mobile.example', parentId: '3' });
    reindexDev(F);
    useDevice('CLEARSCOPE-DST');
    F.store.download_clear = true;

    const down = await M.orchestrator.downloadBookmarks({});
    expect(down.success).toBe(true);

    // 桶内：旧内容被清、云端的进来了
    expect(findUrl(F, 'https://old.example').length).toBe(0);
    expect(findUrl(F, 'https://cloud.example').length).toBe(1);
    // 桶外：一条不少、文件夹本身也在（不是被 removeTree 整棵拔掉）
    expect(findUrl(F, 'https://private.example').length).toBe(1);
    expect(findTitle(F, '我的收藏').length).toBe(1);
    expect(findUrl(F, 'https://mobile.example').length).toBe(1);
    expect(F.store.last_write_report.clearedBefore).toBe(1);   // 只清掉了桶内的那一条
  });
});

// ==========================================================================
// 单同步桶：桌面镜像 ⇄ 手机容器
//   用户口径（2026-10-04）：
//     ① Edge「其他收藏夹」里的其他收藏夹**不要备份**；
//     ② 手机上同步不许漏书签/文件夹、不许乱跑（书签要留在原文件夹里）；
//     ③ 手机端与桌面端都要能**增量增删**（floccus 那样）。
//   模型：本机只有一个「同步文件夹」（桶）参与同步，桶外的一切（其他收藏夹里的
//   其它文件夹、移动收藏夹、根下其它文件夹）**不读、不写、不删**。桶的子节点写入
//   云端「书签栏」区，桶自身不写（它是承载容器，不是用户数据）；桶内容在
//   pathKey 上统一归 ROOT:bar，于是手机容器（F0/学习）与桌面镜像（其他书签/根目录/学习）
//   得到同一个指纹 —— 双向合并才有固定点。
// ==========================================================================
describe('单同步桶：身份归一、桶外永不进出、增量增删', () => {
  beforeEach(() => {
    cloud.clear();
    cloudClock = 1000;
  });

  // 手写一份「旧版云端」XBEL：三区各自的内容原样写下（早前各端把整个三区都写进
  // 云端）。现在的写端只写一个区，所以要测「读入并集」必须自己造文件。
  function legacyCloudXbel(sections, props) {
    const meta = Object.entries(props || {}).map(([k, v]) => `<prop key="${k}">${v}</prop>`).join('');
    const zone = (name, body) => `  <folder>\n    <title>${name}</title>\n${body}  </folder>`;
    const bm = (url, title) => `    <bookmark href="${url}">\n      <title>${title}</title>\n    </bookmark>\n`;
    const folder = (title, body) => `    <folder>\n      <title>${title}</title>\n${body}    </folder>\n`;
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<xbel version="1.0">\n';
    if (meta) xml += `<info><metadata owner="mini-sync">${meta}</metadata></info>\n`;
    xml += zone('书签栏', sections.bar || '') + '\n';
    xml += zone('其他收藏夹', sections.other || '') + '\n';
    xml += zone('移动收藏夹', sections.mobile || '') + '\n';
    xml += '</xbel>\n';
    return { xml, bm, folder };
  }
  function putLegacy(sections, props) {
    const { xml } = legacyCloudXbel(sections, props);
    cloud.set(CLOUD_FILE, { content: xml, etag: '"legacy-2000"', lastModified: 2000 });
    cloudClock = 2000;
  }

  // 桌面 Edge 实测形态：书签栏空着，内容在「其他收藏夹/根目录」这一层手机容器的镜像里
  function deskWithMirror(name, mirrorChildren, extraOther) {
    const D = makeDevice(name, []);
    const other = D.tree.children.find(c => c.id === '2');
    other.children.push({ id: 'd0', title: '根目录', parentId: '2', children: mirrorChildren || [] });
    for (const extra of (extraOther || [])) other.children.push(extra);
    return reindexDev(D);
  }

  test('身份相等（手机）：容器里的书签与云端摊平形态得到同一个 pathKey', async () => {
    const F = makeDevice('ID-FLAT', []);
    flattenDevice(F, '根目录', [
      { id: 'b1', title: '百度', url: 'https://baidu.com', parentId: 'F0' },
      { id: 'b2', title: '学习', parentId: 'F0', children: [
        { id: 'b21', title: 'MDN', url: 'https://mdn.io', parentId: 'b2' },
      ] },
    ]);
    useDevice('ID-FLAT');
    await M.orchestrator.uploadBookmarks({});

    const xbel = cloud.get(CLOUD_FILE).content;
    const localKeys = contentKeys(M.merger.chromeTreeToList(await M.syncInput.getChromeTree()));
    const cloudKeys = contentKeys(M.xbel.xbelToJson(xbel).bookmarks);
    expect(localKeys.length).toBe(3);
    expect(localKeys).toEqual(cloudKeys);                       // ← 双向同步的地基
    expect(localKeys).toContain('ROOT:bar/F:学习/L:https://mdn.io');
    expect(xbel).not.toContain('<title>根目录</title>');         // 容器本身不进云端
    expect(xbel).toContain('flatRootContainer');                 // 但它的名字写进元数据
  });

  test('声明的镜像优先于「书签栏恰好有内容」：桌面书签栏里也有书签时，桶仍是那层镜像（不产生重复）', async () => {
    const F = makeDevice('PRIO-PHONE', []);
    flattenDevice(F, '根目录', [{ id: 'f1', title: '百度', url: 'https://baidu.com', parentId: 'F0' }]);
    useDevice('PRIO-PHONE');
    await M.orchestrator.uploadBookmarks({});

    // 桌面：书签栏里也有用户自己的书签（非空），同时 其他收藏夹/根目录 是手机容器的镜像
    const D = deskWithMirror('PRIO-DESK', [
      { id: 'd1', title: '百度', url: 'https://baidu.com', parentId: 'd0' },
    ]);
    D.tree.children[0].children.push({ id: 'b1', title: '栏内自有', url: 'https://mine.example', parentId: '1' });
    reindexDev(D);
    useDevice('PRIO-DESK');

    const m = await M.mergeStrategy.mergeSync({});
    expect(m.success).toBe(true);
    expect(D.store.last_write_report.bucketId).toBe('d0');
    // ★ 若先认「书签栏非空」，云端那条百度会被再导进书签栏 → 同一批书签两份（用户报的「乱跑」）
    expect(findUrl(D, 'https://baidu.com').length).toBe(1);
    expect(findUrl(D, 'https://baidu.com').map(n => n.parentId)).toEqual(['d0']);
    expect(findUrl(D, 'https://mine.example').map(n => n.parentId)).toEqual(['1']);   // 自己的书签没动
    // 桶外的书签栏内容不进云端（它是本机私有的）
    expect(cloud.get(CLOUD_FILE).content).not.toContain('mine.example');
  });

  test('云端声明若是系统分区名（历史脏数据）：按「没有声明」处理，不把分区名当包装吃掉内容', async () => {
    // 早期构建曾把「书签栏」当容器名写进元数据。当真了会把分区顶层那个同名文件夹
    // 当包装摊平（记一句 wrapperSplicedRemote），用户看到的层级就凭空少了一层。
    putLegacy({
      bar: '    <folder>\n      <title>书签栏</title>\n'
        + '      <bookmark href="https://inner.example">\n        <title>栏内</title>\n      </bookmark>\n'
        + '    </folder>\n',
    }, { flatRootContainer: '书签栏' });

    const P = makeDevice('ZONEDECL-PHONE', []);
    flattenDevice(P, '根目录', []);
    useDevice('ZONEDECL-PHONE');
    const down = await M.orchestrator.downloadBookmarks({});
    expect(down.success).toBe(true);
    // 那份声明被当成「没有声明」⇒ 退回本机容器名，且没有任何东西被当包装摊平
    expect(M.utils.getDeclaredFlatRootContainer()).toBe('根目录');
    expect(P.store.last_write_report.wrapperSplicedRemote).toBe(0);
    // 内容一条不丢（书签直接落进桶 —— 系统名文件夹不会被再套一层）
    expect(findUrl(P, 'https://inner.example').map(n => n.parentId)).toEqual(['F0']);
  });

  test('上传的诚实提醒：云端声明的同步文件夹在本机不存在时，消息直说「以本机为准覆盖云端」', async () => {
    // 手机先建云端（声明 根目录），桌面是一台全新机器：本机没有那层镜像
    const F = makeDevice('NOTE-PHONE', []);
    flattenDevice(F, '根目录', [{ id: 'f1', title: '百度', url: 'https://baidu.com', parentId: 'F0' }]);
    useDevice('NOTE-PHONE');
    await M.orchestrator.uploadBookmarks({});

    const D = makeDevice('NOTE-DESK', [
      { id: 'b1', title: '栏内自有', url: 'https://mine.example', dateAdded: DA, parentId: '1' },
    ]);
    useDevice('NOTE-DESK');
    const up = await M.orchestrator.uploadBookmarks({});
    expect(up.success).toBe(true);
    expect(up.message).toContain('云端的同步文件夹「根目录」在本机不存在');
    expect(up.message).toContain('请先点「合并」');
    expect(up.bucketId).toBe('1');
    // 覆盖前先读云端拿到了声明，但本机没有那个文件夹 ⇒ 按本机的书签栏写
    expect(cloud.get(CLOUD_FILE).content).toContain('mine.example');
  });

  test('上传的诚实提醒：本机桶里没有书签而云端有 —— 说出来会被覆盖掉', async () => {
    const F = makeDevice('NOTE2-PHONE', []);
    flattenDevice(F, '根目录', [{ id: 'f1', title: '百度', url: 'https://baidu.com', parentId: 'F0' }]);
    useDevice('NOTE2-PHONE');
    await M.orchestrator.uploadBookmarks({});

    // 桌面：书签栏空着 + 没有镜像 ⇒ 桶＝书签栏（空），上传会把云端清空
    const D = makeDevice('NOTE2-DESK', []);
    useDevice('NOTE2-DESK');
    const up = await M.orchestrator.uploadBookmarks({});
    expect(up.success).toBe(true);
    expect(up.message).toContain('云端有 1 条');
    expect(up.message).toContain('请先点「合并」');
  });

  test('身份相等（桌面镜像）：其他收藏夹/根目录/… 与云端指纹相同（原地采用，不搬书签）', async () => {
    const F = makeDevice('ID-PHONE', []);
    flattenDevice(F, '根目录', [
      { id: 'p1', title: '百度', url: 'https://baidu.com', parentId: 'F0' },
      { id: 'p2', title: '学习', parentId: 'F0', children: [
        { id: 'p21', title: 'MDN', url: 'https://mdn.io', parentId: 'p2' },
      ] },
    ]);
    useDevice('ID-PHONE');
    await M.orchestrator.uploadBookmarks({});
    const xbel = cloud.get(CLOUD_FILE).content;

    // 桌面：同一批书签在 其他收藏夹/根目录 下（用户 Edge 的实测形态）
    const D = deskWithMirror('ID-DESK', [
      { id: 'd1', title: '百度', url: 'https://baidu.com', parentId: 'd0' },
      { id: 'd2', title: '学习', parentId: 'd0', children: [
        { id: 'd21', title: 'MDN', url: 'https://mdn.io', parentId: 'd2' },
      ] },
    ]);
    useDevice('ID-DESK');
    // 桌面端只能靠云端声明认出自己那层镜像 → 解析云端会写入同一份声明
    // （这里显式写一次，等价于 merge/download 里 parseXbelFromString 的效果）
    M.utils.setDeclaredFlatRootContainer('根目录');

    const localKeys = contentKeys(M.merger.chromeTreeToList(await M.syncInput.getChromeTree()));
    const cloudKeys = contentKeys(M.xbel.xbelToJson(xbel).bookmarks);
    expect(localKeys).toEqual(cloudKeys);
    expect(localKeys).toContain('ROOT:bar/F:学习/L:https://mdn.io');
    expect(M.utils.resolveSyncBucket(D.tree.children, { declaredWrapper: '根目录' }))
      .toMatchObject({ id: 'd0', kind: 'folder' });
  });

  test('桌面上传：本机还留着镜像、云端已声明 → 只写桶内容，云端不留包装、不留私有内容', async () => {
    const F = makeDevice('UP-PHONE', []);
    flattenDevice(F, '根目录', [{ id: 'p1', title: '百度', url: 'https://baidu.com', parentId: 'F0' }]);
    useDevice('UP-PHONE');
    await M.orchestrator.uploadBookmarks({});

    // 桌面：还没合并过，本机原样留着 其他收藏夹/根目录/百度（用户 Edge 的实测形态）
    const D = deskWithMirror('UP-DESK',
      [{ id: 'd1', title: '百度', url: 'https://baidu.com', parentId: 'd0' }],
      [{ id: 'd9', title: '我的收藏', parentId: '2', children: [
        { id: 'd99', title: '淘宝', url: 'https://taobao.com', parentId: 'd9' }] }]);
    useDevice('UP-DESK');
    const up = await M.orchestrator.uploadBookmarks({});

    expect(up.success).toBe(true);
    expect(up.bucketId).toBe('d0');                 // ★ 采用镜像当桶（靠云端声明）
    expect(up.message).not.toContain('注意');        // 没有可警告的事：桶就是云端声明的那个
    const xbel = cloud.get(CLOUD_FILE).content;
    expect(xbel).not.toContain('<title>根目录</title>');   // 镜像层不写进云端
    const data = M.xbel.xbelToJson(xbel);
    expect(data.bookmarks.map(n => n.title)).not.toContain('根目录');
    expect(data.bookmarks.filter(n => n.url === 'https://baidu.com').length).toBe(1);
    expect(xbel).not.toContain('taobao.com');              // ★ 其他收藏夹里的私有内容不备份
    // 桶的 id 固化进设置：下次同步不用再猜
    expect(D.store.bookmark_target_id).toBe('d0');
  });

  test('桌面合并：原地采用镜像当桶，私有文件夹一条不动，第二轮是固定点', async () => {
    const F = makeDevice('MRG-PHONE', []);
    flattenDevice(F, '根目录', [{ id: 'f1', title: '百度', url: 'https://baidu.com', parentId: 'F0' }]);
    useDevice('MRG-PHONE');
    await M.orchestrator.uploadBookmarks({});

    const D = deskWithMirror('MRG-DESK', [
      { id: 'd1', title: '百度', url: 'https://baidu.com', parentId: 'd0' },
      { id: 'd2', title: '学习', parentId: 'd0', children: [
        { id: 'd21', title: 'MDN', url: 'https://mdn.io', parentId: 'd2' }] },
    ], [{ id: 'd9', title: '我的收藏', parentId: '2', children: [
      { id: 'd99', title: '淘宝', url: 'https://taobao.com', parentId: 'd9' }] }]);

    useDevice('MRG-DESK');
    const m1 = await M.mergeStrategy.mergeSync({});
    expect(m1.success).toBe(true);
    expect(m1.message).toContain('同步文件夹：根目录');
    const led = D.store.last_write_report;
    expect(led.bucketId).toBe('d0');
    expect(led.targets.every(t => t.parentId === 'd0')).toBe(true);
    // 镜像原地采用：id 一个都没变，书签没被搬来搬去
    expect(findUrl(D, 'https://baidu.com').map(n => n.id)).toEqual(['d1']);
    expect(findUrl(D, 'https://baidu.com').map(n => n.parentId)).toEqual(['d0']);
    // 桶外的私有文件夹一动不动
    expect(findUrl(D, 'https://taobao.com').length).toBe(1);
    expect(findUrl(D, 'https://taobao.com').map(n => n.parentId)).toEqual(['d9']);
    expect(D.store.bookmark_target_id).toBe('d0');

    const shape1 = treeShape(D);
    const m2 = await M.mergeStrategy.mergeSync({});
    expect(m2.success).toBe(true);
    expect(treeShape(D)).toEqual(shape1);                        // 固定点
    expect(cloud.get(CLOUD_FILE).content).not.toContain('taobao.com');
  });

  test('桶外永不进出：桌面书签栏当桶时，其他收藏夹/我的收藏/淘宝 既不进云端也不进手机', async () => {
    const D = makeDevice('OUT-DESK', [
      { id: 'a1', title: '栏内书签', url: 'https://in-bar.example', dateAdded: DA, parentId: '1' },
    ]);
    const other = D.tree.children.find(c => c.id === '2');
    other.children.push({ id: 'o1', title: '我的收藏', parentId: '2', children: [
      { id: 'o2', title: '淘宝', url: 'https://taobao.com', parentId: 'o1' },
    ] });
    reindexDev(D);
    useDevice('OUT-DESK');
    const up = await M.orchestrator.uploadBookmarks({});
    expect(up.success).toBe(true);
    expect(up.bucketId).toBe('1');                              // 书签栏非空 ⇒ 它才是桶
    const xbel = cloud.get(CLOUD_FILE).content;
    expect(xbel).not.toContain('taobao.com');                   // 云端没有私有内容
    expect(xbel).not.toContain('<title>我的收藏</title>');
    expect(xbel).toContain('in-bar.example');

    // 手机合并：只拿到桶里的那条
    const P = makeDevice('OUT-PHONE', []);
    flattenDevice(P, '根目录', []);
    useDevice('OUT-PHONE');
    const m = await M.mergeStrategy.mergeSync({});
    expect(m.success).toBe(true);
    expect(findUrl(P, 'https://in-bar.example').map(n => n.parentId)).toEqual(['F0']);
    expect(findUrl(P, 'https://taobao.com').length).toBe(0);
    expect(findTitle(P, '我的收藏').length).toBe(0);
    // 桌面上的私有文件夹也原样留着（上传/合并都没碰它）
    useDevice('OUT-DESK');
    expect(findUrl(D, 'https://taobao.com').length).toBe(1);
  });

  test('旧形态云端（三区都有内容、无元数据）：手机并集读入一条不丢，上传后云端归一为一个区', async () => {
    putLegacy({
      bar: '    <bookmark href="https://bar.example">\n      <title>栏内</title>\n    </bookmark>\n',
      other: '    <folder>\n      <title>我的收藏</title>\n      <bookmark href="https://other.example">\n        <title>其他区</title>\n      </bookmark>\n    </folder>\n',
      mobile: '    <bookmark href="https://mob.example">\n      <title>移动区</title>\n    </bookmark>\n',
    });
    const F = makeDevice('UNION-PHONE', []);
    flattenDevice(F, '根目录', []);
    useDevice('UNION-PHONE');
    const down = await M.orchestrator.downloadBookmarks({});
    expect(down.success).toBe(true);

    // 三个区的内容都进了桶 —— 升级不丢书签（旧版更早的云端形态）
    expect(findUrl(F, 'https://bar.example').map(n => n.parentId)).toEqual(['F0']);
    expect(findTitle(F, '我的收藏').length).toBe(1);
    expect(findUrl(F, 'https://other.example').length).toBe(1);
    expect(findUrl(F, 'https://mob.example').length).toBe(1);

    // 写回后云端只剩一个区（书签栏），用户文件夹「我的收藏」作为内容保留
    await M.orchestrator.uploadBookmarks({ force: true });
    const data = M.xbel.xbelToJson(cloud.get(CLOUD_FILE).content);
    const urls = data.bookmarks.filter(n => n.url).map(n => n.url).sort();
    expect(urls).toEqual(['https://bar.example', 'https://mob.example', 'https://other.example']);
    expect(new Set(data.bookmarks.filter(n => n.url).map(n => n.source))).toEqual(new Set(['bar']));
    expect(data.bookmarks.filter(n => !n.url).map(n => n.title)).toEqual(['我的收藏']);
  });

  test('深层同名文件夹不是包装：用户自己建的「根目录」原样保留（只认分区顶层那一层）', async () => {
    // 云端：其他收藏夹/学习/根目录/百度 —— 最外层「学习」是用户文件夹，里面的「根目录」
    // 是用户自己建的（不在分区顶层、也不在包装里）⇒ 必须原样读入，不能被当成容器镜像吃掉。
    putLegacy({
      other: '    <folder>\n      <title>学习</title>\n      <folder>\n        <title>根目录</title>\n'
        + '        <bookmark href="https://baidu.com">\n          <title>百度</title>\n        </bookmark>\n'
        + '      </folder>\n    </folder>\n',
    });
    const F = makeDevice('DEEP-PHONE', []);
    flattenDevice(F, '根目录', []);
    useDevice('DEEP-PHONE');
    const down = await M.orchestrator.downloadBookmarks({});
    expect(down.success).toBe(true);

    // 容器本身 + 用户自己建的那一层 = 两个「根目录」
    expect(findTitle(F, '根目录').length).toBe(2);
    const study = findTitle(F, '学习');
    expect(study.length).toBe(1);
    expect(study.map(n => n.parentId)).toEqual(['F0']);
    expect(findTitle(F, '根目录').map(n => n.parentId)).toContain(String(study[0].id));
    expect(findUrl(F, 'https://baidu.com').map(n => n.parentId))
      .toEqual([String(findTitle(F, '根目录').find(n => String(n.id) !== 'F0').id)]);
  });

  test('spliceWrapperFolders：只拆桶内的同名壳，多层一次拆完、id 全保留、桶外不碰', async () => {
    const F = makeDevice('SPLICE-U', []);
    flattenDevice(F, '根目录', [
      { id: 'A', title: '根目录', parentId: 'F0', children: [
        { id: 'B', title: '根目录', parentId: 'A', children: [
          { id: 'c1', title: '百度', url: 'https://baidu.com', parentId: 'B' },
        ] },
      ] },
      { id: 'top', title: '顶层书签', url: 'https://top.example', parentId: 'F0' },
      { id: 'keep', title: '根目录', parentId: 'F0', children: [
        { id: 'k1', title: '项目', parentId: 'keep', children: [] },
      ] },
    ]);
    useDevice('SPLICE-U');
    const r = await M.importer.spliceWrapperFolders();
    // A、B、keep 三个壳全部拆平（keep 里是用户内容，上提但一个不丢）
    expect(r.spliced).toBe(3);
    expect(r.failures).toEqual([]);
    expect(findTitle(F, '根目录').length).toBe(1);               // 只剩桶自己
    expect(findUrl(F, 'https://baidu.com').map(n => n.id)).toEqual(['c1']);  // id 保留
    expect(findUrl(F, 'https://baidu.com').map(n => n.parentId)).toEqual(['F0']);
    expect(findUrl(F, 'https://top.example').length).toBe(1);
    expect(findTitle(F, '项目').map(n => n.id)).toEqual(['k1']);             // 用户内容没丢
  });

  test('spliceWrapperFolders：桶本身永不被拆，桶外（其他收藏夹）的同名文件夹也不碰', async () => {
    // 标准三区宿主：桶＝书签栏（它非空），其他书签下那个「根目录」在桶外
    const D = makeDevice('SPLICE-STD', [
      { id: 'a1', title: '栏内', url: 'https://in-bar.example', dateAdded: DA, parentId: '1' },
    ]);
    const other = D.tree.children.find(c => c.id === '2');
    other.children.push({ id: 'd0', title: '根目录', parentId: '2', children: [
      { id: 'd1', title: '百度', url: 'https://baidu.com', parentId: 'd0' }] });
    reindexDev(D);
    useDevice('SPLICE-STD');
    // 就算云端声明了「根目录」这个名字（桶是书签栏时它只可能是历史脏数据）
    M.utils.setDeclaredFlatRootContainer('根目录');
    const r = await M.importer.spliceWrapperFolders();
    expect(r.spliced).toBe(0);
    expect(findTitle(D, '根目录').length).toBe(1);              // 桶外的文件夹原样不动
    expect(findUrl(D, 'https://baidu.com').map(n => n.parentId)).toEqual(['d0']);
    expect(findUrl(D, 'https://in-bar.example').length).toBe(1);
  });

  test('spliceWrapperFolders：内容搬不动的壳绝不删（宁留包装不丢书签）', async () => {
    const F = makeDevice('SPLICE-FAIL', []);
    flattenDevice(F, '根目录', [
      { id: 'A', title: '根目录', parentId: 'F0', children: [
        { id: 'd1', title: '百度', url: 'https://baidu.com', parentId: 'A' }] },
    ]);
    useDevice('SPLICE-FAIL');
    // 模拟宿主拒绝搬动壳里的子节点
    const realMove = F.chromeObj.bookmarks.move;
    F.chromeObj.bookmarks.move = (id, info, cb) => {
      if (String(id) === 'd1') throw new Error('模拟：宿主拒绝移动');
      return realMove(id, info, cb);
    };

    const r = await M.importer.spliceWrapperFolders();
    expect(r.spliced).toBe(0);
    // 逐条失败明细 + 壳保留的总结都要有（否则用户只看到「拆失败」不知道书签还在不在）
    expect(r.failures.some(f => /宿主拒绝移动/.test(f.error))).toBe(true);
    expect(r.failures.some(f => /保留该文件夹不动/.test(f.error))).toBe(true);
    expect(findTitle(F, '根目录').length).toBe(2);               // 桶 + 壳
    expect(findUrl(F, 'https://baidu.com').length).toBe(1);      // 书签还在
  });

  test('增量删减（floccus 行为）：两端各自增删，一轮合并后各自收敛', async () => {
    // 桌面：书签栏 = [百度, 工作[GitHub]]
    const A = makeDevice('INC-DESK', [
      { id: '10', title: '百度', url: 'https://baidu.com', dateAdded: DA, parentId: '1' },
      { id: '11', title: '工作', dateAdded: DA, parentId: '1', children: [
        { id: '110', title: 'GitHub', url: 'https://github.com', dateAdded: DA, parentId: '11' }] },
    ]);
    useDevice('INC-DESK');
    await M.orchestrator.uploadBookmarks({});

    // 手机：容器里先有自己的一条，合并后拿到桌面的两条
    const P = makeDevice('INC-PHONE', []);
    flattenDevice(P, '根目录', [{ id: 'p1', title: '知乎', url: 'https://zhihu.com', parentId: 'F0' }]);
    useDevice('INC-PHONE');
    const m1 = await M.mergeStrategy.mergeSync({});
    expect(m1.success).toBe(true);
    expect(findUrl(P, 'https://baidu.com').map(n => n.parentId)).toEqual(['F0']);
    expect(findTitle(P, '工作').map(n => n.parentId)).toEqual(['F0']);
    expect(findUrl(P, 'https://github.com').length).toBe(1);
    expect(findUrl(P, 'https://zhihu.com').length).toBe(1);

    // 手机：删掉百度（用户操作），新增微博
    await new Promise((res) => P.chromeObj.bookmarks.remove(String(findUrl(P, 'https://baidu.com')[0].id), res));
    await new Promise((res) => P.chromeObj.bookmarks.create(
      { parentId: 'F0', title: '微博', url: 'https://weibo.com' }, res));
    useDevice('INC-PHONE');
    const m2 = await M.mergeStrategy.mergeSync({});
    expect(m2.success).toBe(true);
    expect(findUrl(P, 'https://baidu.com').length).toBe(0);     // 自己删的不会自己回来
    expect(findUrl(P, 'https://weibo.com').length).toBe(1);
    expect(findUrl(P, 'https://zhihu.com').length).toBe(1);

    // 桌面：自己删 GitHub、加 B站
    useDevice('INC-DESK');
    await new Promise((res) => A.chromeObj.bookmarks.remove('110', res));
    await new Promise((res) => A.chromeObj.bookmarks.create(
      { parentId: '1', title: 'B站', url: 'https://bilibili.com' }, res));
    const m3 = await M.mergeStrategy.mergeSync({});
    expect(m3.success).toBe(true);
    expect(findUrl(A, 'https://baidu.com').length).toBe(0);     // 手机的删除传播过来了
    expect(findUrl(A, 'https://weibo.com').map(n => n.parentId)).toEqual(['1']); // 手机的新增也在
    expect(findUrl(A, 'https://github.com').length).toBe(0);    // 自己删的没复活
    expect(findUrl(A, 'https://bilibili.com').length).toBe(1);
    expect(findUrl(A, 'https://zhihu.com').length).toBe(1);

    // 手机再合并一轮：桌面的删除与新增都到位；再一轮是固定点（没有来回搬运）
    useDevice('INC-PHONE');
    const m4 = await M.mergeStrategy.mergeSync({});
    expect(m4.success).toBe(true);
    expect(findUrl(P, 'https://github.com').length).toBe(0);
    expect(findUrl(P, 'https://bilibili.com').length).toBe(1);
    expect(findUrl(P, 'https://zhihu.com').length).toBe(1);
    const shape4 = treeShape(P);
    const m5 = await M.mergeStrategy.mergeSync({});
    expect(m5.success).toBe(true);
    expect(treeShape(P)).toEqual(shape4);
  });

  test('下载是纯增量：云端没有的本地书签不会被删（删除只在合并里按墓碑传播）', async () => {
    const A = makeDevice('DL-DESK', [{ id: '10', title: '百度', url: 'https://baidu.com', dateAdded: DA, parentId: '1' }]);
    useDevice('DL-DESK');
    await M.orchestrator.uploadBookmarks({});

    const P = makeDevice('DL-PHONE', []);
    flattenDevice(P, '根目录', [
      { id: 'p1', title: '只在本机的书签', url: 'https://local-only.example', parentId: 'F0' },
    ]);
    useDevice('DL-PHONE');
    const d1 = await M.orchestrator.downloadBookmarks({});
    expect(d1.success).toBe(true);
    expect(findUrl(P, 'https://baidu.com').length).toBe(1);
    // ★ 云端没有它，但下载不许动本地独有节点（旧实现按「云端为准」把它整棵删掉）
    expect(findUrl(P, 'https://local-only.example').length).toBe(1);
    expect(P.store.last_write_report.removedCount).toBe(0);

    // 合并之后仍然在（本地独有会被上传，而不是被删）
    const m = await M.mergeStrategy.mergeSync({});
    expect(m.success).toBe(true);
    expect(findUrl(P, 'https://local-only.example').length).toBe(1);
    expect(cloud.get(CLOUD_FILE).content).toContain('local-only.example');

    // 桌面拿到它，两端一致
    useDevice('DL-DESK');
    await M.mergeStrategy.mergeSync({});
    expect(findUrl(A, 'https://local-only.example').map(n => n.parentId)).toEqual(['1']);
  });

  test('桶内文件夹移动落位：桌面把「工作」从桶根挪进「归档」→ 手机跟随且不重复', async () => {
    const A = makeDevice('MV-DESK', [
      { id: '11', title: '工作', dateAdded: DA, parentId: '1', children: [
        { id: '110', title: 'GitHub', url: 'https://github.com', dateAdded: DA, parentId: '11' }] },
      { id: '12', title: '归档', dateAdded: DA, parentId: '1', children: [] },
    ]);
    useDevice('MV-DESK');
    await M.orchestrator.uploadBookmarks({});

    const P = makeDevice('MV-PHONE', []);
    flattenDevice(P, '根目录', []);
    useDevice('MV-PHONE');
    await M.mergeStrategy.mergeSync({});
    expect(findTitle(P, '工作').map(n => n.parentId)).toEqual(['F0']);

    // 桌面：把「工作」拖进「归档」——并模拟 background onMoved 记下的移动意图
    // （真实扩展里拖动会写 sync_move_intents，合并才知道「本端是发起方」；
    //   缺了它合并会按「接收方跟随云端」把书签挪回原处，也就是用户看到的「乱跑」）
    useDevice('MV-DESK');
    const oldPk = await pkOfCurrent(A, '11');
    await new Promise((res) => A.chromeObj.bookmarks.move('11', { parentId: '12' }, res));
    const newPk = await pkOfCurrent(A, '11');
    const devId = await M.storage.getDeviceId();
    await M.storage.setLocal({ sync_move_intents: {
      [oldPk]: { time: Date.now(), deviceId: devId },
      [newPk]: { time: Date.now(), deviceId: devId }
    } });
    const m = await M.mergeStrategy.mergeSync({});
    expect(m.success).toBe(true);
    expect(findTitle(A, '工作').map(n => n.parentId)).toEqual(['12']);   // 本机已就位（没被挪回桶根）
    expect(findUrl(A, 'https://github.com').length).toBe(1);

    // 手机：位置调整落到位，且没有重复
    useDevice('MV-PHONE');
    const m2 = await M.mergeStrategy.mergeSync({});
    expect(m2.success).toBe(true);
    const arch = findTitle(P, '归档');
    expect(arch.length).toBe(1);
    expect(findTitle(P, '工作').map(n => n.parentId)).toEqual([String(arch[0].id)]);
    expect(findUrl(P, 'https://github.com').length).toBe(1);
  });

  test('桶内用户自建的「书签栏」文件夹不是系统根：它自己要占一段路径（漏文件夹/书签乱跑的另一半）', async () => {
    // 用户口径里的「漏几个文件夹、导致书签乱跑」：pathKey 只按标题跳过系统分区名，
    // 用户在桶里自己建的「书签栏」文件夹会被整棵跳过（没有指纹 ⇒ 合并端看不见它，
    // 它下面的书签还会因为父路径缺失被算成 ROOT:unknown）。判定必须带位置条件。
    const F = makeDevice('ZONENAME-PHONE', []);
    flattenDevice(F, '根目录', [
      { id: 'z1', title: '书签栏', parentId: 'F0', children: [
        { id: 'z2', title: 'MDN', url: 'https://mdn.io', parentId: 'z1' },
      ] },
      { id: 's1', title: '学习', parentId: 'F0', children: [
        { id: 's2', title: '百度', url: 'https://baidu.com', parentId: 's1' },
      ] },
    ]);
    useDevice('ZONENAME-PHONE');
    const keys = contentKeys(M.merger.chromeTreeToList(await M.syncInput.getChromeTree()));
    expect(keys).toContain('ROOT:bar/F:书签栏');                   // 它自己必须有一个指纹
    expect(keys).toContain('ROOT:bar/F:书签栏/L:https://mdn.io');
    expect(keys).toContain('ROOT:bar/F:学习/L:https://baidu.com');
    expect(keys.length).toBe(4);                                   // 两文件夹 + 两书签（桶自身不算内容）
  });

  test('桶内深层的同名文件夹不是透明包装：合并指纹里它自己占一段（否则整棵子树被吃掉 = 书签乱跑）', async () => {
    // 「透明包装」只认桶的直接子层那一层（旧版合并 bug 遗留的 根目录/根目录）。
    // 用户自己在桶里建的深层同名文件夹必须原样保留 —— 否则它的子树会被提到「学习」下。
    const F = makeDevice('DEEPWRAP-PHONE', []);
    flattenDevice(F, '根目录', [
      { id: 'w1', title: '学习', parentId: 'F0', children: [
        { id: 'w2', title: '根目录', parentId: 'w1', children: [
          { id: 'w3', title: '百度', url: 'https://baidu.com', parentId: 'w2' },
        ] },
      ] },
    ]);
    useDevice('DEEPWRAP-PHONE');
    const keys = contentKeys(M.merger.chromeTreeToList(await M.syncInput.getChromeTree()));
    expect(keys).toContain('ROOT:bar/F:学习/F:根目录');
    expect(keys).toContain('ROOT:bar/F:学习/F:根目录/L:https://baidu.com');
    expect(keys).not.toContain('ROOT:bar/F:学习/L:https://baidu.com');
  });

  test('桶恰是系统分区（书签栏）时绝不写「容器名」声明（否则别端会折平分区顶层的同名文件夹）', async () => {
    const D = makeDevice('ZONEBUCKET-DESK', [
      { id: 'a1', title: '栏内', url: 'https://in-bar.example', dateAdded: DA, parentId: '1' },
    ]);
    useDevice('ZONEBUCKET-DESK');
    const up = await M.orchestrator.uploadBookmarks({});
    expect(up.success).toBe(true);
    expect(up.bucketId).toBe('1');
    expect(up.bucketTitle).toBe('书签栏');
    const xbel = cloud.get(CLOUD_FILE).content;
    expect(xbel).toContain('in-bar.example');
    expect(xbel).not.toContain('flatRootContainer');   // 分区名不是容器名，一条声明都不许写
  });
});


// ==========================================================================
// 增量删减三条路径
//   用户口径（2026-10-04 追加）：上传与下载也必须是「增量增删」，不能「不删只加」。
//   两个真缺陷（实测复现后修掉）：
//     bug1 墓碑 TTL 3 天无条件过期 ⇒ 删除没在 3 天内传到位的那台设备，合并时把节点
//          当「本端新增」复活并写回云端（删除被时间抹掉）。
//     bug2 「上传」只写本机墓碑 ⇒ 把云端带来的删除记录整份冲掉，其他端从此学不到；
//          而它自己又把云端已删的节点原样覆盖回去（把删除反推成复活）。
//   钉住：三个按钮都按**同一份**墓碑视图（model/tombstone.js buildTombstoneView）增删。
// ==========================================================================
describe('增量删减：上传 / 下载 / 合并三条路径都传播删除', () => {
  beforeEach(() => {
    cloud.clear();
    cloudClock = 1000;
  });

  const BAIDU_PK = 'ROOT:bar/L:https://baidu.com';

  // 公共装置：手机上传「百度 + MDN」→ 桌面下载拿到两条。
  // 之后手机删百度并合并（云端从此无百度、带墓碑）——这就是「对端已删、本端还有」的状态。
  async function phoneDeletedBaidu() {
    const F = makeDevice('DEL-PHONE', []);
    flattenDevice(F, '根目录', [
      { id: 'p1', title: '百度', url: 'https://baidu.com', parentId: 'F0' },
      { id: 'p2', title: 'MDN', url: 'https://mdn.io', parentId: 'F0' },
    ]);
    useDevice('DEL-PHONE');
    await M.orchestrator.uploadBookmarks({});

    const D = makeDevice('DEL-DESK', []);
    useDevice('DEL-DESK');
    await M.orchestrator.downloadBookmarks({});
    expect(findUrl(D, 'https://baidu.com').length).toBe(1);   // 前置：桌面确实有这条

    useDevice('DEL-PHONE');
    await new Promise((res) => F.chromeObj.bookmarks.remove('p1', res));
    const m = await M.mergeStrategy.mergeSync({});
    expect(m.success).toBe(true);
    const cloudData = M.xbel.xbelToJson(cloud.get(CLOUD_FILE).content);
    expect(cloudData.bookmarks.filter(n => n.url).map(n => n.url)).toEqual(['https://mdn.io']);
    expect(cloudData.tombstones.map(t => t.key)).toContain(BAIDU_PK);   // 墓碑在云端
    return { F, D };
  }

  test('下载：云端删过的，本机跟着删（不再是「只加不删」）', async () => {
    const { D } = await phoneDeletedBaidu();

    useDevice('DEL-DESK');
    const down = await M.orchestrator.downloadBookmarks({});
    expect(down.success).toBe(true);
    expect(findUrl(D, 'https://baidu.com').length).toBe(0);        // ★ 增量「减」落地
    expect(findUrl(D, 'https://mdn.io').length).toBe(1);           // 其余不动
    expect(down.tombstoneRemovedCount).toBe(1);
    expect(down.removedCount).toBe(1);
    expect(down.message).toContain('按云端的删除记录删掉本机 1 项');
    const led = D.store.last_write_report;
    expect(led.ok).toBe(true);
    expect(led.tombstoneRemovedCount).toBe(1);
    expect(led.removedCount).toBe(1);
  });

  test('下载：云端没有、也没有墓碑的本地独有书签一条不删（不是「云端为准扫荡」）', async () => {
    const { D } = await phoneDeletedBaidu();
    // 桌面自己新增一条（云端不知道、也没有任何墓碑）
    await new Promise((res) => D.chromeObj.bookmarks.create(
      { parentId: '1', title: '桌面独有', url: 'https://desk-only.example' }, res));

    useDevice('DEL-DESK');
    const down = await M.orchestrator.downloadBookmarks({});
    expect(findUrl(D, 'https://baidu.com').length).toBe(0);              // 有墓碑的照删
    expect(findUrl(D, 'https://desk-only.example').length).toBe(1);      // 没墓碑的不动
    expect(down.tombstoneRemovedCount).toBe(1);
  });

  test('上传：先把云端删过的从本机删掉，再把并集墓碑写回云端（不再复活、不再冲掉云端墓碑）', async () => {
    const { D } = await phoneDeletedBaidu();

    useDevice('DEL-DESK');
    // force：跳过「云端被别端改过」的确认弹窗（本次就是要覆盖式上传）
    const up = await M.orchestrator.uploadBookmarks({ force: true });
    expect(up.success).toBe(true);
    expect(findUrl(D, 'https://baidu.com').length).toBe(0);        // ★ 本机也跟着删了
    expect(up.diff.removed).toBe(1);
    expect(up.message).toContain('已同时从本机删掉 1 项');

    const xbel = cloud.get(CLOUD_FILE).content;
    const data = M.xbel.xbelToJson(xbel);
    expect(data.bookmarks.filter(n => n.url).map(n => n.url)).toEqual(['https://mdn.io']);
    // ★ bug2：云端带来的删除记录必须原样留在文件里（旧实现写成 tombstones:[] 把它冲掉）
    expect(data.tombstones.map(t => t.key)).toContain(BAIDU_PK);
  });

  test('上传：本机删掉的节点要留下墓碑，否则对端会把它当「云端新增」建回来', async () => {
    // mock 里没有 onRemoved 监听器（真实扩展里靠它写墓碑），删除只能靠上传时的快照回溯捕捉
    const D = makeDevice('UPDEL-DESK', [
      { id: '10', title: '百度', url: 'https://baidu.com', dateAdded: DA, parentId: '1' },
      { id: '11', title: 'MDN', url: 'https://mdn.io', dateAdded: DA, parentId: '1' },
    ]);
    useDevice('UPDEL-DESK');
    await M.orchestrator.uploadBookmarks({});          // 建立「上次同步快照」

    await new Promise((res) => D.chromeObj.bookmarks.remove('10', res));
    const up = await M.orchestrator.uploadBookmarks({});
    expect(up.success).toBe(true);

    const data = M.xbel.xbelToJson(cloud.get(CLOUD_FILE).content);
    expect(data.bookmarks.filter(n => n.url).map(n => n.url)).toEqual(['https://mdn.io']);
    expect(data.tombstones.map(t => t.key)).toContain(BAIDU_PK);   // ★ 删除带墓碑，别端不会复活它
  });

  test('墓碑过期但节点仍在某端 ⇒ 不许丢（丢了就是「时间隧道式复活」）', async () => {
    const { D } = await phoneDeletedBaidu();
    const OLD = Date.now() - 4 * 24 * 60 * 60 * 1000;   // 4 天前 = 超过 TTL

    // ★ 云端那份也要改老。只改本端的话，并集会取云端那条**新鲜**的时间戳，
    //   TTL 分支根本没被走到（本测试曾经就是这样「绿得不是地方」，变异 M88 存活即证）。
    //   真实场景：删除发生在 4 天前，桌面这台一直没同步 ⇒ 两端看到的墓碑都是过期的。
    const cj = M.xbel.xbelToJson(cloud.get(CLOUD_FILE).content);
    cj.tombstones = cj.tombstones.map(t => (t.key === BAIDU_PK ? Object.assign({}, t, { deletedAt: OLD }) : t));
    cloud.set(CLOUD_FILE, { content: M.xbel.jsonToXbel(cj), etag: `"v${++cloudClock}"`, lastModified: cloudClock });
    // 自证装置有效：云端确实带着一条 4 天前的墓碑（格式若变，这里先红，而不是测试悄悄变空）
    const aged = M.xbel.xbelToJson(cloud.get(CLOUD_FILE).content).tombstones.find(t => t.key === BAIDU_PK);
    expect(aged && aged.deletedAt).toBe(OLD);

    useDevice('DEL-DESK');
    D.store.sync_tombstones = [{ key: BAIDU_PK, deletedAt: OLD, deviceId: 'ext_phone' }];
    D.store.cloud_last_modified = 0;                    // 逼它按「云端较新」处理顺序

    const m = await M.mergeStrategy.mergeSync({});
    expect(m.success).toBe(true);
    expect(findUrl(D, 'https://baidu.com').length).toBe(0);   // ★ 删除仍然生效
    const data = M.xbel.xbelToJson(cloud.get(CLOUD_FILE).content);
    expect(data.bookmarks.filter(n => n.url).map(n => n.url)).not.toContain('https://baidu.com');
    expect(data.tombstones.map(t => t.key)).toContain(BAIDU_PK);  // 墓碑保留（还要传给别的端）
  });

  test('墓碑过期且当前两端都没有节点，未知离线设备未确认时仍须保留', async () => {
    const { D } = await phoneDeletedBaidu();
    const OLD = Date.now() - 4 * 24 * 60 * 60 * 1000;

    useDevice('DEL-DESK');
    D.store.sync_tombstones = [{ key: 'ROOT:bar/L:https://gone.example', deletedAt: OLD, deviceId: 'ext_phone' }];

    const m = await M.mergeStrategy.mergeSync({});
    expect(m.success).toBe(true);
    const keys = (D.store.sync_tombstones || []).map(t => t.key);
    expect(keys).toContain('ROOT:bar/L:https://gone.example');
    expect(M.xbel.xbelToJson(cloud.get(CLOUD_FILE).content).tombstones.map(t => t.key))
      .toContain('ROOT:bar/L:https://gone.example');
  });

  test('墓碑只作用于同步桶内：桶外节点即便路径撞上墓碑键也不被删、不上云', async () => {
    // 桌面的桶＝书签栏（非空）；「其他收藏夹/我的收藏/淘宝」在桶外
    const D = makeDevice('OUTDEL-DESK', [
      { id: 'a1', title: '栏内', url: 'https://in-bar.example', dateAdded: DA, parentId: '1' },
    ]);
    const other = D.tree.children.find(c => c.id === '2');
    other.children.push({ id: 'o1', title: '我的收藏', parentId: '2', children: [
      { id: 'o2', title: '淘宝', url: 'https://taobao.com', parentId: 'o1' }] });
    reindexDev(D);
    useDevice('OUTDEL-DESK');
    // 注入一条与桶外节点「同名同路径」的墓碑：桶外节点根本没有 pathKey，
    // 所以它永远不会命中；命中即代表同步范围被撑破了（那才是真事故）。
    D.store.sync_tombstones = [{
      key: 'ROOT:bar/F:我的收藏/L:https://taobao.com',
      deletedAt: Date.now(), deviceId: 'ext_other'
    }];

    const up = await M.orchestrator.uploadBookmarks({});
    expect(up.success).toBe(true);
    expect(findUrl(D, 'https://taobao.com').length).toBe(1);     // 桶外私有内容一动不动
    expect(findUrl(D, 'https://taobao.com').map(n => n.parentId)).toEqual(['o1']);
    // 云端文件里没有桶外内容（墓碑元数据里那句 key 是死键：桶外节点没有 pathKey，
    // 永远匹配不上，断言只看真正的书签数据）
    const data = M.xbel.xbelToJson(cloud.get(CLOUD_FILE).content);
    expect(data.bookmarks.map(n => n.title)).not.toContain('我的收藏');
    expect(data.bookmarks.filter(n => n.url).map(n => n.url)).toEqual(['https://in-bar.example']);
  });

  test('三条路径共用同一份墓碑视图（口径不许分叉）', async () => {
    const { D } = await phoneDeletedBaidu();
    const real = M.tombstone.buildTombstoneView;
    const calls = { upload: 0, download: 0, merge: 0 };
    let tag = '';
    M.tombstone.buildTombstoneView = (opts) => { calls[tag] = (calls[tag] || 0) + 1; return real(opts); };
    try {
      tag = 'upload';
      useDevice('DEL-DESK');
      await M.orchestrator.uploadBookmarks({ force: true });
      tag = 'download';
      await M.orchestrator.downloadBookmarks({});
      tag = 'merge';
      await M.mergeStrategy.mergeSync({});
    } finally {
      M.tombstone.buildTombstoneView = real;
    }
    expect(calls.upload).toBeGreaterThan(0);
    expect(calls.download).toBeGreaterThan(0);
    expect(calls.merge).toBeGreaterThan(0);
    void D;
  });

  test('删了又加回来：本端在上一轮同步之后重新加回的同一路径不受墓碑牵连（不被永久拉黑）', async () => {
    const { D } = await phoneDeletedBaidu();

    // ① 让这条删除在桌面落地（下载 → 本地删掉百度，快照随之不再含百度）
    useDevice('DEL-DESK');
    await M.orchestrator.downloadBookmarks({});
    expect(findUrl(D, 'https://baidu.com').length).toBe(0);
    expect(D.store.sync_tombstones.map(t => t.key)).toContain(BAIDU_PK);   // 删除记录还在

    // ② 用户后悔了，在同一个位置把同一条书签加回来（标题/URL 相同 ⇒ pathKey 相同）
    await new Promise((res) => D.chromeObj.bookmarks.create(
      { parentId: '1', title: '百度', url: 'https://baidu.com' }, res));

    // ③ 再合并：墓碑必须作废（判据=本端上次快照里没有这条，是本端的新动作），
    //    否则「节点还在 ⇒ 墓碑永不过期」会把这条路径永久拉黑。
    const m = await M.mergeStrategy.mergeSync({});
    expect(m.success).toBe(true);
    expect(findUrl(D, 'https://baidu.com').length).toBe(1);                 // ★ 加回来的留下了
    const data = M.xbel.xbelToJson(cloud.get(CLOUD_FILE).content);
    expect(data.bookmarks.filter(n => n.url).map(n => n.url)).toContain('https://baidu.com');
    expect(data.tombstones.map(t => t.key)).not.toContain(BAIDU_PK);        // 墓碑作废，不再拉黑
  });

  test('backfillDeletedTombstones：没有上一次快照时不做任何猜测', async () => {
    const D = makeDevice('BF-DESK', [
      { id: '10', title: '百度', url: 'https://baidu.com', dateAdded: DA, parentId: '1' },
    ]);
    useDevice('BF-DESK');
    delete D.store.sync_snapshots;
    const n = await M.syncInput.backfillDeletedTombstones(
      M.merger.chromeTreeToList(await M.syncInput.getChromeTree())
    );
    expect(n).toBe(0);
    expect(D.store.sync_tombstones || []).toEqual([]);
  });
});

// ===== 跨端「改名 / 删除同时发生」的两条静默失败：全链路回归 =====
// 三者共享同一个失灵模式：**意图算对了，落盘没执行**。
describe('改名与删除的全链路一致性（就地改名 / 删除不被复用吞掉 / 空桶删除）', () => {
  beforeEach(() => {
    cloud.clear();
    cloudClock = 1000;
  });

  // 装置：A 有「百度 + 工作[GitHub]」，B 先完整下载一份
  async function twoDevices() {
    const A2 = makeDevice('REN-A', [
      { id: '10', title: '百度', url: 'https://baidu.com', dateAdded: DA, parentId: '1' },
      { id: '11', title: '工作', dateAdded: DA, parentId: '1', children: [
        { id: '110', title: 'GitHub', url: 'https://github.com', dateAdded: DA, parentId: '11' },
      ] },
    ]);
    useDevice('REN-A');
    await M.orchestrator.uploadBookmarks({});
    const B2 = makeDevice('REN-B', []);
    useDevice('REN-B');
    await M.orchestrator.downloadBookmarks({});
    return { A2, B2 };
  }

  test('云端改名 ⇒ 本端就地改名（保原 id、保子树），不是删旧建新空壳', async () => {
    const { A2, B2 } = await twoDevices();
    const oldFolderId = findTitle(B2, '工作')[0].id;

    // A 把「工作」改名成「8888」后上传（旧路径的墓碑随这次上传一起上云）
    useDevice('REN-A');
    await new Promise((res) => A2.chromeObj.bookmarks.update('11', { title: '8888' }, res));
    await M.orchestrator.uploadBookmarks({});

    // B 在旧名文件夹下新增一个书签（改名后本端还没同步过）
    useDevice('REN-B');
    await new Promise((res) => B2.chromeObj.bookmarks.create(
      { parentId: oldFolderId, title: '新书签', url: 'https://new.example' }, res));

    const m = await M.mergeStrategy.mergeSync({});
    expect(m.success).toBe(true);

    // 旧名消失、新名只有一个，且沿用本端原 id（就地改名，不是删旧建新）
    expect(findTitle(B2, '工作').length).toBe(0);
    expect(findTitle(B2, '8888').length).toBe(1);
    expect(findTitle(B2, '8888')[0].id).toBe(oldFolderId);
    // 子树完整：GitHub 与本端新增的「新书签」都还在这个文件夹下
    const kids = flatTree(B2).filter((n) => n.parentId === oldFolderId).map((n) => n.url);
    expect(kids.sort()).toEqual(['https://github.com', 'https://new.example']);

    // 收敛：A 再合并一轮 —— 新名唯一、新书签到达、旧名不再出现
    useDevice('REN-A');
    await M.mergeStrategy.mergeSync({});
    expect(findTitle(A2, '工作').length).toBe(0);
    expect(findTitle(A2, '8888').length).toBe(1);
    expect(findUrl(A2, 'https://new.example').length).toBe(1);
  });

  test('改名与删除同时发生 ⇒ 删除照样落盘（裁剪不许被「重取树」丢掉，也不许随写回复活）', async () => {
    const { A2, B2 } = await twoDevices();
    const oldFolderId = findTitle(B2, '工作')[0].id;

    // A 先加一条「临时」并同步给 B
    useDevice('REN-A');
    await new Promise((res) => A2.chromeObj.bookmarks.create(
      { parentId: '1', title: '临时', url: 'https://tmp.example' }, res));
    await M.orchestrator.uploadBookmarks({});
    useDevice('REN-B');
    await M.orchestrator.downloadBookmarks({});
    expect(findUrl(B2, 'https://tmp.example').length).toBe(1);

    // A 同时做两件事：改名「工作→8888」+ 删掉「临时」，一次上传
    useDevice('REN-A');
    await new Promise((res) => A2.chromeObj.bookmarks.update('11', { title: '8888' }, res));
    const tmpId = findUrl(A2, 'https://tmp.example')[0].id;
    await new Promise((res) => A2.chromeObj.bookmarks.remove(tmpId, res));
    await M.orchestrator.uploadBookmarks({});

    // B 也在旧名文件夹下新增一个书签（让本轮 renamePairs 非空 = 触发「重取树」那条路径）
    useDevice('REN-B');
    await new Promise((res) => B2.chromeObj.bookmarks.create(
      { parentId: oldFolderId, title: '新书签', url: 'https://new.example' }, res));

    const m = await M.mergeStrategy.mergeSync({});
    expect(m.success).toBe(true);
    expect(findTitle(B2, '8888').length).toBe(1);
    expect(findTitle(B2, '工作').length).toBe(0);
    // ★ 删除必须落盘，且不许随写回把「临时」重新塞回云端
    expect(findUrl(B2, 'https://tmp.example').length).toBe(0);
    const cloudData = M.xbel.xbelToJson(cloud.get(CLOUD_FILE).content);
    expect(cloudData.bookmarks.filter((n) => n.url === 'https://tmp.example').length).toBe(0);
  });

  test('对端把桶删空 + 本端有新子节点 ⇒ 删除落盘，本端不得把那棵子树当「本地独有」重新上传', async () => {
    // ★ 这个用例的桶里**只有**那个文件夹：对端删完它就是「空桶 + 墓碑」，
    //   合并数据因此是空的 —— 正是「导入段早退把删除整个跳过」的复现条件
    //   （若桶里还有别的书签，数据非空就不会早退，缺陷被掩盖）。
    const A3 = makeDevice('REN-A3', [
      { id: '11', title: '工作', dateAdded: DA, parentId: '1', children: [
        { id: '110', title: 'GitHub', url: 'https://github.com', dateAdded: DA, parentId: '11' },
      ] },
    ]);
    useDevice('REN-A3');
    await M.orchestrator.uploadBookmarks({});
    const B3 = makeDevice('REN-B3', []);
    // 桶外（其他书签）放一条用户自己的书签：删除只该作用于被点名的那棵子树
    B3.tree.children[1].children.push({ id: 'out1', title: '私藏', url: 'https://mine.example', parentId: '2' });
    reindexDev(B3);
    useDevice('REN-B3');
    await M.orchestrator.downloadBookmarks({});
    const oldFolderId = findTitle(B3, '工作')[0].id;

    // A 删掉整个「工作」并合并 + 上传（云端从此没有「工作」，只剩墓碑）
    useDevice('REN-A3');
    await new Promise((res) => A3.chromeObj.bookmarks.removeTree('11', res));
    await M.mergeStrategy.mergeSync({});
    await M.orchestrator.uploadBookmarks({});
    const emptyCloud = M.xbel.xbelToJson(cloud.get(CLOUD_FILE).content);
    expect(emptyCloud.bookmarks.filter((n) => n.url || n.isFolder)).toEqual([]);   // 前置：云端桶已空

    // B（离线期间）在「工作」下新增书签
    useDevice('REN-B3');
    await new Promise((res) => B3.chromeObj.bookmarks.create(
      { parentId: oldFolderId, title: '新书签', url: 'https://new.example' }, res));

    const m = await M.mergeStrategy.mergeSync({});
    expect(m.success).toBe(true);
    // 对端的删除是权威：文件夹连同本端新加的子节点一起消失
    expect(findTitle(B3, '工作').length).toBe(0);
    expect(findUrl(B3, 'https://github.com').length).toBe(0);
    expect(findUrl(B3, 'https://new.example').length).toBe(0);
    // 删除只作用于被点名的那棵子树：桶外的「私藏」不受牵连
    expect(findUrl(B3, 'https://mine.example').length).toBe(1);

    // 再合一轮不得复活，云端也不许被重新塞回「工作」
    await M.mergeStrategy.mergeSync({});
    expect(findTitle(B3, '工作').length).toBe(0);
    const cloudData = M.xbel.xbelToJson(cloud.get(CLOUD_FILE).content);
    expect(cloudData.bookmarks.filter((n) => n.title === '工作').length).toBe(0);
    expect(cloudData.bookmarks.filter((n) => n.url === 'https://new.example').length).toBe(0);
  });
});


// ========== 同步的代价：顺序已经对上时，一个 move 都不许再发 ==========
//
// 背景（2026-10-05，用户手机「装了新版反而很卡」的真凶）：
// 落盘后的「按 _index 重排」原先无条件对每个落盘节点 move 一次 —— 245 书签 + 43 文件夹
// 的库每轮 288 次 move，而手机上每次 move 都要落库并通知书签界面。自动同步修好之前
// 手机从不自动跑（那才是当时的 bug），所以没人觉得卡；修好之后每 30 分钟一轮，
// 加上「删一个书签就防抖合并一次」，卡就成了常态。
// 这里把「代价」本身钉成断言：顺序没变的轮次，书签写操作必须是 0。
describe('同步代价：顺序已一致时不得再动书签（手机卡顿的根因）', () => {
  // 复刻用户手机的形态与量级：根下只有一个容器（雨见形态），容器里 N 个文件夹挂书签
  function makePhoneDevice(name, folderCount, perFolder) {
    const dev = makeDevice(name, []);
    const container = flattenDevice(dev, '根目录');
    for (let f = 0; f < folderCount; f++) {
      // ⚠️ 容器 id 是 flattenDevice 给的 'F0'，这里的文件夹 id 必须换前缀，否则撞号
      const folder = { id: 'D' + f, title: '文件夹' + f, parentId: container.id, children: [] };
      container.children.push(folder);
      for (let i = 0; i < perFolder; i++) {
        folder.children.push({
          id: `D${f}-B${i}`, title: `书签${f}-${i}`,
          url: `https://example.com/${f}/${i}`, parentId: folder.id, dateAdded: DA + i
        });
      }
    }
    reindexDev(dev);
    countBookmarkCalls(dev);
    return dev;
  }

  // 给设备的书签 API 记账（同一台只包一次），同步一轮的「代价」就是这里的数字
  function countBookmarkCalls(dev) {
    if (dev.calls) return dev;
    dev.calls = { create: 0, move: 0, remove: 0, removeTree: 0 };
    const api = dev.chromeObj.bookmarks;
    for (const k of Object.keys(dev.calls)) {
      const fn = api[k];
      api[k] = function () { dev.calls[k]++; return fn.apply(this, arguments); };
    }
    return dev;
  }
  function resetCalls(dev) { for (const k of Object.keys(dev.calls)) dev.calls[k] = 0; }

  // 找「装着这批文件夹的那个容器」（跨形态通用：手机上它是「根目录」，桌面上它是镜像层）
  function containerOf(dev) {
    let hit = null;
    (function walk(n) {
      if (hit || !n) return;
      if ((n.children || []).some(c => /^文件夹\d$/.test((c && c.title) || ''))) { hit = n; return; }
      (n.children || []).forEach(walk);
    })(dev.tree);
    return hit;
  }

  test('手机形态：第二轮（无变化）合并的书签写操作必须是 0 次，且树形状是固定点', async () => {
    const PH = makePhoneDevice('COST-PHONE', 6, 4);   // 24 书签 + 6 文件夹 + 1 容器
    useDevice('COST-PHONE');
    expect((await M.orchestrator.uploadBookmarks({})).success).toBe(true);

    const D = countBookmarkCalls(makeDevice('COST-DESK', []));
    useDevice('COST-DESK');
    await M.orchestrator.downloadBookmarks({});
    // 下载台账也要带代价数字：手机端 console 读不到，台账缺字段 = 卡了也看不见
    expect(typeof D.store.last_write_report.movesAttempted).toBe('number');
    expect(typeof D.store.last_write_report.movesSkippedParents).toBe('number');

    // 两端各跑两轮：第一轮把状态推到稳态，第二轮必须完全静默
    for (const name of ['COST-PHONE', 'COST-DESK']) {
      useDevice(name);
      const dev = devices[name];
      expect((await M.mergeStrategy.mergeSync({})).success).toBe(true);
      const shapeBefore = treeShape(dev);
      const orderBefore = containerOf(dev).children.map(c => c.title);
      resetCalls(dev);
      const m = await M.mergeStrategy.mergeSync({});
      expect(m.success).toBe(true);
      expect(dev.calls, name + ' 第二轮不该再动书签').toEqual({ create: 0, move: 0, remove: 0, removeTree: 0 });
      expect(treeShape(dev), name + ' 第二轮树形状必须是固定点').toEqual(shapeBefore);
      // 顺序敏感：treeShape 是排过序的，抓不到「每轮都被重排一遍」这种漂移
      expect(containerOf(dev).children.map(c => c.title), name + ' 第二轮顺序不许漂移')
        .toEqual(orderBefore);
      // 手机端 console 读不到：「本轮 move 几次」必须落进台账，否则卡了也看不见
      const led = dev.store.last_write_report;
      expect(led.movesAttempted, name + ' 台账要如实记下本轮 move 次数').toBe(0);
      expect(led.movesSkippedParents, name + ' 台账要记下顺序已对上、被跳过的父文件夹数').toBeGreaterThan(0);
    }
  });

  test('云端顺序确实更新 ⇒ 必须按云端顺序重排到位（省下的 move 不许省错）', async () => {
    const PH = makePhoneDevice('COST2-PHONE', 3, 3);
    useDevice('COST2-PHONE');
    await M.orchestrator.uploadBookmarks({});

    const D = countBookmarkCalls(makeDevice('COST2-DESK', []));
    useDevice('COST2-DESK');
    await M.orchestrator.downloadBookmarks({});
    await M.mergeStrategy.mergeSync({});

    // 桌面端把容器里第一个文件夹排到最后 ⇒ 云端顺序变了
    const deskContainer = containerOf(D);
    expect(deskContainer).toBeTruthy();
    const firstFolder = deskContainer.children.find(c => /^文件夹\d$/.test(c.title || ''));
    await new Promise((res) => D.chromeObj.bookmarks.move(String(firstFolder.id), { parentId: deskContainer.id, index: 1e9 }, res));
    expect(containerOf(D).children.slice(-1)[0].id).toBe(String(firstFolder.id));   // 前置：桌面确实挪动了
    await M.mergeStrategy.mergeSync({});

    const cloudOrder = M.xbel.xbelToJson(cloud.get(CLOUD_FILE).content)
      .bookmarks.filter(b => b.isFolder && /^文件夹\d$/.test(b.title || '')).map(b => b.title);
    expect(cloudOrder.slice(-1)[0]).toBe('文件夹0');            // 前置：云端顺序确实是挪过的
    // 让「云端比本机上次见到的更新」成立（真实时钟下这由 mtime 决定；
    // 测试装置的 cloudClock 只有千级，够不到 ORDER_TOLERANCE=2000 的判定门槛）
    const cur = cloud.get(CLOUD_FILE);
    cloud.set(CLOUD_FILE, { content: cur.content, etag: `"v${++cloudClock}"`, lastModified: 1e9 });

    useDevice('COST2-PHONE');
    resetCalls(PH);
    const m3 = await M.mergeStrategy.mergeSync({});
    expect(m3.success).toBe(true);
    // 顺序真变了 ⇒ 必须动过书签（绝不许「一律跳过」把顺序同步悄悄关掉）
    expect(PH.calls.move).toBeGreaterThan(0);
    expect(PH.store.last_write_report.movesAttempted).toBeGreaterThan(0);   // 台账不许粉饰成 0
    const phoneOrder = containerOf(PH).children.map(c => c.title).filter(t => /^文件夹\d$/.test(t || ''));
    expect(phoneOrder).toEqual(cloudOrder);
  });
});
