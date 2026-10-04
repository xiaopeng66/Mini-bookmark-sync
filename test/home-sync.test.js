// home-sync.test.js — 主页数据链端到端回归测试
//
// 权威映射（用户定义）：
//   谷歌/Edge「其他(收藏夹)书签 → Berry主页」
//     = Berry bookmarks.json 的 __home_folder__ 区
//     = Via favorites.txt
//     = Aira personalization 的 home_shortcuts
//
// 覆盖场景：
//   1. 上传覆盖：桌面 home → 三端文件全部对齐
//   2. 手机端新增（Berry __home_folder__ 加书签）→ 合并吸收 → 三端一致
//   3. 手机端删除 → 删除传播 → 三端一致

const { loadSource } = require('./load-source');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

loadSource();
for (const f of ['berry-adapter.js', 'via-adapter.js', 'aira-adapter.js']) {
  vm.runInThisContext(
    fs.readFileSync(path.resolve(__dirname, '..', 'adapters', f), 'utf8'),
    { filename: 'adapters/' + f }
  );
}

const M = global.MiniSync;
const HOME_FOLDER_ID = global.HOME_FOLDER_ID;
const ROOT_ID = global.ROOT_ID;
const OTHER_FOLDER_ID = global.OTHER_FOLDER_ID;
const MOBILE_FOLDER_ID = global.MOBILE_FOLDER_ID;

// ---- chrome.storage.local 内存 mock（兼容回调/Promise 两种风格）----
const mem = new Map();
global.chrome = global.chrome || {};
global.chrome.storage = global.chrome.storage || {};
global.chrome.storage.local = {
  get: (keys, cb) => {
    const out = {};
    const ks = Array.isArray(keys) ? keys : [keys];
    for (const k of ks) out[k] = mem.has(k) ? mem.get(k) : undefined;
    if (typeof cb === 'function') { cb(out); return undefined; }
    return Promise.resolve(out);
  },
  set: (obj, cb) => {
    for (const k in obj) mem.set(k, obj[k]);
    if (typeof cb === 'function') cb();
    return Promise.resolve();
  },
  remove: (keys, cb) => {
    const ks = Array.isArray(keys) ? keys : [keys];
    ks.forEach(k => mem.delete(k));
    if (typeof cb === 'function') cb();
    return Promise.resolve();
  },
};
global.chrome.runtime = global.chrome.runtime || {};
global.chrome.runtime.getPlatformInfo = (cb) => {
  const info = { os: 'win', arch: 'x64' };
  if (typeof cb === 'function') { cb(info); return undefined; }
  return Promise.resolve(info);
};

// ---- 桥接 IO mock ----
let berryFileData = null;          // Berry bookmarks.json（对象）
let viaFavTxt = '';                // Via favorites.txt（文本）
let viaHtmlTxt = '';               // Via bookmarks.html（文本）
let airaSnapObj = null;            // Aira g3 snapshot（对象）
let airaPersObj = null;            // Aira g2 personalization（对象）

global.downloadBerryBookmarks = async () => berryFileData;
global.uploadBerryBookmarks = async (d) => { berryFileData = d; };
global.downloadViaBookmarks = async () => (viaHtmlTxt || null);
global.uploadViaHtml = async (h) => { viaHtmlTxt = h; };
global.downloadViaFavorites = async () => (viaFavTxt || null);
global.uploadViaFavorites = async (t) => { viaFavTxt = t; };
global.downloadAiraBookmarks = async () => airaSnapObj;
global.uploadAiraBookmarks = async (s) => { airaSnapObj = s; };
global.downloadAiraPersonalization = async () => airaPersObj;
global.uploadAiraPersonalization = async (s) => { airaPersObj = s; };

// ---- 桌面 Chrome 树（含 Berry主页 区 2 条）----
function deskTree() {
  return {
    id: '0', children: [
      { id: '1', title: '书签栏', children: [
        { id: 'b1', title: 'GitHub', url: 'https://github.com' },
      ]},
      { id: '2', title: '其他书签', children: [
        { id: 'o1', title: '读书', children: [
          { id: 'o2', title: '豆瓣', url: 'https://douban.com' },
        ]},
      ]},
      { id: '3', title: '移动设备书签', children: [] },
      { id: 'h0', title: 'Berry主页', children: [
        { id: 'h1', title: '必应', url: 'https://bing.com' },
        { id: 'h2', title: '知乎', url: 'https://zhihu.com' },
      ]},
    ],
  };
}

function flatListOf(tree) {
  return M.merger.chromeTreeToList([tree]);
}

function homeTitlesOf(list) {
  return list.filter(n => n.source === 'home' && !n.isFolder && n.url).map(n => n.title).sort();
}

// Berry 文件中的主页书签标题
function berryHomeTitles() {
  const d = (berryFileData && berryFileData.data) || [];
  return d.filter(n => n.parentId === HOME_FOLDER_ID && !n.isFolder && n.url).map(n => n.title).sort();
}
// Via favorites.txt 中的主页书签标题（内联 JSONL 解析）
function viaHomeTitles() {
  const list = (viaFavTxt || '').split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter(Boolean);
  return list.filter(n => !n.isFolder && n.url).map(n => n.title).sort();
}
// Aira personalization 中的主页书签标题
function airaHomeTitles() {
  const scs = (airaPersObj && airaPersObj.sections && airaPersObj.sections.home_shortcuts &&
    airaPersObj.sections.home_shortcuts.payload.shortcuts) || [];
  return scs.filter(s => s.url).map(s => s.title).sort();
}

// 手机端「已上传」的初始 g3 snapshot（最小结构，含移动端 deviceId 与规范根容器）——
// 模拟真实环境：WebDAV 上必有手机端先上传的文件（缺失时桌面按死锁保护不创建）
function seedAiraSnap() {
  const nowIso = new Date().toISOString();
  const dev = 'aira-sync-source-testdev';
  return {
    version: 2,
    deviceId: dev,
    createdAt: nowIso,
    snapshot: {
      meta: { version: 2, deviceId: dev, generatedAt: nowIso },
      bookmarkFolders: [
        { id: 'browser_root_toolbar', type: 'bookmark-folder', parentId: null, title: '书签栏', createdAt: '2024-03-09T17:00:00.000Z', updatedAt: '2024-03-09T17:00:00.000Z', updatedBy: 'browser-shell-seed', revision: 2 },
        { id: 'browser_root_other', type: 'bookmark-folder', parentId: null, title: '其他书签', createdAt: '2024-03-09T18:00:00.000Z', updatedAt: '2024-03-09T18:00:00.000Z', updatedBy: 'browser-shell-seed', revision: 2 },
      ],
      bookmarkItems: [],
      bookmarkOrders: [
        { type: 'bookmark-order', parentId: null, ids: ['browser_root_toolbar', 'browser_root_other'], updatedAt: nowIso, updatedBy: 'browser-shell-seed', revision: 2 },
      ],
      tombstones: [],
    },
  };
}

beforeEach(() => {
  mem.clear();
  berryFileData = null;
  uploadBerry = undefined;
  viaFavTxt = '';
  viaHtmlTxt = '';
  airaSnapObj = seedAiraSnap(); // 模拟手机端已上传初始文件
  airaPersObj = null;           // personalization 缺失 → 走种子创建路径
});

// 全局 uploadBerry 引用（berry-merge.test.js 同款用法：上传捕获）
let uploadBerry;

describe('主页数据链 — 桌面 → Berry/Via/Aira 三端覆盖', () => {
  test('上传覆盖：桌面 home 2 条 → Berry __home_folder__ / Via favorites / Aira personalization 全部对齐', async () => {
    const flat = flatListOf(deskTree());

    // 三端覆盖写回
    await M.berry.patchBerryFile(flat);
    await M.via.patchViaFile(flat);
    await M.aira.patchAiraFile(flat, { rebuild: true });
    await M.aira.patchAiraPersonalization(flat, { align: true });

    // Berry：__home_folder__ 区含 2 条主页书签
    expect(berryHomeTitles()).toEqual(['必应', '知乎']);

    // Via：favorites.txt 含 2 条
    expect(viaHomeTitles()).toEqual(['必应', '知乎']);

    // Aira：personalization shortcuts 含 2 条（种子创建：g3 先建立，personalization 随后对齐）
    expect(airaHomeTitles()).toEqual(['必应', '知乎']);
  });

  test('上传幂等：重复覆盖不产生重复条目', async () => {
    mem.clear();
    const flat = flatListOf(deskTree());
    await M.berry.patchBerryFile(flat);
    await M.via.patchViaFile(flat);
    await M.aira.patchAiraFile(flat, { rebuild: true });
    await M.aira.patchAiraPersonalization(flat, { align: true });

    // 再来一轮
    await M.berry.patchBerryFile(flat);
    await M.via.patchViaFile(flat);
    await M.aira.patchAiraFile(flat, { rebuild: true });
    await M.aira.patchAiraPersonalization(flat, { align: true });

    expect(berryHomeTitles()).toEqual(['必应', '知乎']);
    expect(viaHomeTitles()).toEqual(['必应', '知乎']);
    expect(airaHomeTitles()).toEqual(['必应', '知乎']);
    expect(berryFileData.data.filter(n => n.title === '必应').length).toBe(1);
    expect(viaHomeTitles().filter(t => t === '必应').length).toBe(1);
    expect(airaHomeTitles().filter(t => t === '必应').length).toBe(1);
  });
});

describe('主页数据链 — 手机端新增合并传播', () => {
  test('手机 Berry 主页加书签 → 合并吸收桌面 → 再覆盖写回三端一致', async () => {
    mem.clear();
    // 初始：桌面 2 条已覆盖到三端
    const flat = flatListOf(deskTree());
    berryFileData = { schemaVersion: 2, deviceId: 'berry-dev', timestamp: 1, data: [
      { id: '501', title: 'GitHub', url: 'https://github.com', isFolder: false, parentId: '1' },
    ]};
    await M.berry.patchBerryFile(flat);
    await M.via.patchViaFile(flat);
    await M.aira.patchAiraFile(flat, { rebuild: true });
    await M.aira.patchAiraPersonalization(flat, { align: true });

    // 手机 Berry 主页新增「豆瓣主页」
    berryFileData.data.push({
      id: '99001', title: '豆瓣主页', url: 'https://douban.com/home',
      isFolder: false, parentId: HOME_FOLDER_ID,
    });

    // 合并吸收（端上新增 → 桌面列表）
    const merged = await M.berry.mergeBerryData(flat, false, null);
    const injected = merged.filter(n => n.source === 'home' && n.title === '豆瓣主页');
    expect(injected.length).toBe(1);

    // 覆盖写回三端
    await M.berry.patchBerryFile(merged);
    await M.via.patchViaFile(merged);
    await M.aira.patchAiraFile(merged, { rebuild: true });
    await M.aira.patchAiraPersonalization(merged, { align: true });

    expect(berryHomeTitles()).toEqual(['必应', '知乎', '豆瓣主页'].sort());
    expect(viaHomeTitles()).toContain('豆瓣主页');
    expect(airaHomeTitles()).toContain('豆瓣主页');
  });
});

describe('主页数据链 — 手机端删除传播', () => {
  test('手机删主页书签 → 合并传播桌面 → 覆盖写回三端移除', async () => {
    mem.clear();
    // 初始：桌面 2 条覆盖到三端（Berry 文件含手机端写的 2 条）
    const flat = flatListOf(deskTree());
    berryFileData = { schemaVersion: 2, deviceId: 'berry-dev', timestamp: 1, data: [
      { id: '501', title: 'GitHub', url: 'https://github.com', isFolder: false, parentId: '1' },
      { id: '700', title: '必应', url: 'https://bing.com', isFolder: false, parentId: HOME_FOLDER_ID },
      { id: '701', title: '知乎', url: 'https://zhihu.com', isFolder: false, parentId: HOME_FOLDER_ID },
    ]};
    // 第一轮 merge 建立快照基准
    await M.berry.mergeBerryData(flat, false, null);
    await M.berry.patchBerryFile(flat);
    await M.via.patchViaFile(flat);
    await M.aira.patchAiraFile(flat, { rebuild: true });
    await M.aira.patchAiraPersonalization(flat, { align: true });

    // 手机删除「知乎」
    berryFileData.data = berryFileData.data.filter(n => n.id !== '701');

    // 合并：删除传播到桌面列表
    const merged = await M.berry.mergeBerryData(flat, false, null);
    const zhihuNodes = merged.filter(n => n.source === 'home' && n.title === '知乎');
    expect(zhihuNodes.length).toBe(0);

    // 覆盖写回：三端「知乎」全部移除
    await M.berry.patchBerryFile(merged);
    await M.via.patchViaFile(merged);
    await M.aira.patchAiraFile(merged, { rebuild: true });
    await M.aira.patchAiraPersonalization(merged, { align: true });

    expect(berryHomeTitles()).not.toContain('知乎');
    expect(airaHomeTitles()).not.toContain('知乎');
    // Via favorites.txt 全量重写后不含知乎
    expect(viaHomeTitles()).not.toContain('知乎');
    // 桌面保留的：必应
    expect(berryHomeTitles()).toContain('必应');
  });
});
