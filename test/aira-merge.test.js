// aira-merge.test.js — 复现并守护「合并时文件夹改名/移动不丢失」的删除检测兜底逻辑
//
// 场景：本地有文件夹「工作」，Aira 端把它改名为「我的工作」（pathKey 变了但标题不同）。
// 合并时删除检测应识别「只是改名，不是真删」，保留本地文件夹。
// 这守护的是 aira-adapter.js 删除检测段里的「文件夹标题兜底」：
//   if (n.isFolder && n.title && airaFolderTitles.has(n.title)) return true;
// 该兜底若被删除，改名文件夹会被误判为 Aira 端删除而丢失。

const { loadSource } = require('./load-source');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

loadSource();

// 加载 aira-adapter，但把两个真实 download 函数替换成 stub，避免访问 WebDAV 卡死
const airaPath = path.resolve(__dirname, '..', 'adapters/aira-adapter.js');
let airaSrc = fs.readFileSync(airaPath, 'utf8');
airaSrc = airaSrc.replace(
  /async function downloadAiraBookmarks\(\)\s*\{[\s\S]*?\n\}/,
  'async function downloadAiraBookmarks() { return global.__airaBookmarksStub(); }'
);
airaSrc = airaSrc.replace(
  /async function downloadAiraPersonalization\(\)\s*\{[\s\S]*?\n\}/,
  'async function downloadAiraPersonalization() { return global.__airaPersStub(); }'
);
airaSrc = airaSrc.replace(
  /async function uploadAiraBookmarks\(snapshot\)\s*\{[\s\S]*?\n\}/,
  'async function uploadAiraBookmarks(snapshot) { global.__airaUploadCaptured = snapshot; return Promise.resolve(); }'
);
// 其余依赖（getWebDAVConfig 等）在不用到时不会触发
vm.runInThisContext(airaSrc, { filename: 'adapters/aira-adapter.js' });

const M = global.MiniSync;
const ROOT_ID = global.ROOT_ID;

// ---- chrome.storage.local 内存 stub ----
const mem = new Map();
global.chrome = global.chrome || {};
global.chrome.storage = global.chrome.storage || {};
global.chrome.storage.local = {
  get: (keys) => {
    const out = {};
    const ks = Array.isArray(keys) ? keys : [keys];
    for (const k of ks) out[k] = mem.has(k) ? mem.get(k) : undefined;
    return Promise.resolve(out);
  },
  set: (obj) => { for (const k in obj) mem.set(k, obj[k]); return Promise.resolve(); },
};

// ---- Aira 文件 stub：父「资料」(bkf_cat) 下子「前端」(bkf_fe)，模拟"父改名"场景 ----
// 本地树里父叫「资料」(与 Aira 同 pk)，子叫「前端」。合并时若 Aira 把父改名「技术」，
// 子「前端」的 pathKey 会变（父路径不同），触发删除检测；文件夹标题兜底应救回「前端」。
global.__airaBookmarksStub = makeAiraSnapshot;
global.__airaPersStub = () => null;
function makeAiraSnapshot(parentTitle = '资料', childTitle = '前端') {
  return {
    snapshot: {
      bookmarkFolders: [
        { id: 'bkf_root', type: 'bookmark-folder', parentId: null, title: 'browser_root_toolbar' },
        { id: 'bkf_cat', type: 'bookmark-folder', parentId: 'bkf_root', title: parentTitle },
      ],
      bookmarkItems: [
        { id: 'bkf_fe', type: 'bookmark-item', parentId: 'bkf_cat', title: childTitle, url: 'https://frontend.dev' },
      ],
      bookmarkOrders: [
        { type: 'bookmark-order', parentId: 'bkf_root', ids: ['bkf_cat'] },
        { type: 'bookmark-order', parentId: 'bkf_cat', ids: ['bkf_fe'] },
      ],
      tombstones: [],
    },
  };
}

// 本地树：书签栏(1) > 资料(11) > 前端(111)。与 Aira pk 对齐（父标题同为「资料」）
function localTree() {
  return [
    { id: '1', title: '书签栏', isFolder: true, parentId: ROOT_ID, source: 'bar' },
    { id: '11', title: '资料', isFolder: true, parentId: '1', source: 'bar' },
    { id: '111', title: '前端', url: 'https://frontend.dev', isFolder: false, parentId: '11', source: 'bar' },
  ];
}

// 预置「上一次合并写回的 Aira 端 pathKey 快照」，含 前端 的旧 pk（父未改名时）
function seedSnapshot() {
  mem.set('aira_pathkey_snapshot', ['ROOT:bar/F:资料/L:https://frontend.dev']);
}

test('合并：父文件夹改名(子标题不变)时，子文件夹/书签不被误删（文件夹标题兜底救回）', async () => {
  mem.clear();
  seedSnapshot();
  // Aira 端父「资料」已改名「技术」→ Aira pk 集合不再含 ROOT:bar/F:资料/...
  global.__airaBookmarksStub = () => makeAiraSnapshot('技术', '前端');
  const r = await M.aira.mergeAiraData(localTree());
  // 本地「前端」(111) 应保留（兜底命中标题「前端」）
  const fe = r.find(n => n.id === '111');
  expect(fe).toBeDefined();
  expect(fe.title).toBe('前端');
});

test('合并：Aira 端真删文件夹时，本地对应节点被移除', async () => {
  mem.clear();
  seedSnapshot();
  // Aira 文件里「资料」整个没了（真删）→ 前端 也不在 Aira 端，且标题也不在 Aira 端
  global.__airaBookmarksStub = () => ({
    snapshot: {
      bookmarkFolders: [
        { id: 'bkf_root', type: 'bookmark-folder', parentId: null, title: 'browser_root_toolbar' },
      ],
      bookmarkItems: [],
      bookmarkOrders: [],
      tombstones: [],
    },
  });
  const r = await M.aira.mergeAiraData(localTree());
  const fe = r.find(n => n.id === '111');
  expect(fe).toBeUndefined(); // 真删 → 移除
});

test('合并：连续两次合并，Aira 独有书签不重复翻倍', async () => {
  mem.clear();
  // Aira 文件含一个本地没有的书签「独家」(bkf_uniq)，挂在书签栏下
  global.__airaBookmarksStub = () => ({
    snapshot: {
      bookmarkFolders: [
        { id: 'bkf_root', type: 'bookmark-folder', parentId: null, title: 'browser_root_toolbar' },
      ],
      bookmarkItems: [
        { id: 'bkf_uniq', type: 'bookmark-item', parentId: 'bkf_root', title: '独家', url: 'https://uniq.dev' },
      ],
      bookmarkOrders: [
        { type: 'bookmark-order', parentId: 'bkf_root', ids: ['bkf_uniq'] },
      ],
      tombstones: [],
    },
  });
  // 本地树：书签栏(1) > 资料(11) > 前端(111)
  const r1 = await M.aira.mergeAiraData(localTree());
  const count1 = r1.length;
  // 模拟落盘：第二次合并的输入是第一次的结果（本地已含「独家」）
  const r2 = await M.aira.mergeAiraData(r1.map(n => ({ ...n })));
  const count2 = r2.length;
  // 不应翻倍：第二次只是在已有基础上合并，数量应稳定（至多 +0，因为「独家」已存在）
  expect(count2).toBe(count1);
  // 且「独家」只应出现一次
  const uniqCount = r2.filter(n => n.title === '独家').length;
  expect(uniqCount).toBe(1);
});

test('写回：patchAiraFile 对同一份 mergedList 连续写回，节点数不膨胀', async () => {
  mem.clear();
  // Aira 端已有一份快照：根 + 工具箱(已有本地文件夹的镜像)
  const initial = {
    deviceId: 'test-device-123',
    snapshot: {
      bookmarkFolders: [
        { id: 'bkf_root', type: 'bookmark-folder', parentId: null, title: 'browser_root_toolbar' },
        { id: 'bkf_toolbox', type: 'bookmark-folder', parentId: 'bkf_root', title: '工具箱' },
      ],
      bookmarkItems: [
        { id: 'bkm_exist', type: 'bookmark-item', parentId: 'bkf_toolbox', title: '已有书签', url: 'https://exist.dev' },
      ],
      bookmarkOrders: [
        { type: 'bookmark-order', parentId: 'bkf_root', ids: ['bkf_toolbox'] },
        { type: 'bookmark-order', parentId: 'bkf_toolbox', ids: ['bkm_exist'] },
      ],
      tombstones: [],
    },
  };
  global.__airaBookmarksStub = () => initial;
  global.__airaUploadCaptured = null;

  // 本地 mergedList：工具箱(Chrome 本地 id=11) + 新书签
  const mergedList = [
    { id: '1', title: '书签栏', isFolder: true, parentId: ROOT_ID, source: 'bar' },
    { id: '11', title: '工具箱', isFolder: true, parentId: '1', source: 'bar' },
    { id: '111', title: '已有书签', url: 'https://exist.dev', isFolder: false, parentId: '11', source: 'bar' },
    { id: '112', title: '新书签', url: 'https://new.dev', isFolder: false, parentId: '11', source: 'bar' },
  ];

  // 第一次写回：应只新增「新书签」
  await M.aira.patchAiraFile(mergedList);
  const snap1 = global.__airaUploadCaptured;
  const count1 = (snap1.snapshot.bookmarkFolders.length + snap1.snapshot.bookmarkItems.length);
  const newItem1 = snap1.snapshot.bookmarkItems.find(i => i.title === '新书签');
  expect(newItem1).toBeDefined();

  // 第二次写回：模拟手机端把第一次写回的快照再下载回来，对同一份 mergedList 再写回
  global.__airaBookmarksStub = () => JSON.parse(JSON.stringify(snap1));
  await M.aira.patchAiraFile(mergedList);
  const snap2 = global.__airaUploadCaptured;
  const count2 = (snap2.snapshot.bookmarkFolders.length + snap2.snapshot.bookmarkItems.length);

  // 节点总数不应增长（新书签已存在，不应再建）
  expect(count2).toBe(count1);
  expect(snap2.snapshot.bookmarkItems.filter(i => i.title === '新书签').length).toBe(1);
});
