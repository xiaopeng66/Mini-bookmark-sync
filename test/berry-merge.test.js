// berry-merge.test.js — 守护 Berry 桥接「其他收藏夹（other 区）」的双向流转
//
// 场景一（写回 patchBerryFile）：Chrome「其他书签」子树应挂到 Berry 虚拟容器 __other_folder__ 下，
//   「移动书签」子树挂 __mobile_folder__（修复此前 parentId 指向 Chrome 根容器 id 而悬空成孤儿的问题），
//   Berry主页（source='home'）与系统根容器本身不写入 Berry 文件。
// 场景二（读入 mergeBerryData）：Berry 文件 __other_folder__ 子树应注入合并列表，source='other'，
//   且 pathKey 与 Chrome 端口径对齐（ROOT:other/...），保证不重复创建。

const { loadSource } = require('./load-source');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

loadSource();

// 加载 berry-adapter（依赖全局 computePathKeys / HOME_FOLDER_ID 等，loadSource 已就绪）
vm.runInThisContext(
  fs.readFileSync(path.resolve(__dirname, '..', 'adapters/berry-adapter.js'), 'utf8'),
  { filename: 'adapters/berry-adapter.js' }
);

const M = global.MiniSync;
const ROOT_ID = global.ROOT_ID;
const OTHER_FOLDER_ID = global.OTHER_FOLDER_ID;
const MOBILE_FOLDER_ID = global.MOBILE_FOLDER_ID;
const HOME_FOLDER_ID = global.HOME_FOLDER_ID;

// ---- chrome.storage.local 内存 stub（兼容回调与 Promise 两种调用风格）----
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
};
// generateDeviceId 依赖 chrome.runtime.getPlatformInfo
global.chrome.runtime = global.chrome.runtime || {};
global.chrome.runtime.getPlatformInfo = (cb) => {
  const info = { os: 'win', arch: 'x64', nacl_arch: 'x86-64' };
  if (typeof cb === 'function') { cb(info); return undefined; }
  return Promise.resolve(info);
};

// ---- WebDAV 读写 stub（覆盖 utils.js 的真实实现，避免网络访问）----
let berryFileData = null;
let uploadCaptured = null;
global.downloadBerryBookmarks = async () => berryFileData;
global.uploadBerryBookmarks = async (data) => { uploadCaptured = data; };

// Chrome 端扁平列表（chromeTreeToList 的典型输出形态）：
// 书签栏 > GitHub；其他书签 > 读书 > 豆瓣；其他书签 > Berry主页 > 必应；移动 > 手机书签A
function chromeFlatList() {
  return [
    { id: '1', title: '书签栏', isFolder: true, parentId: ROOT_ID, source: 'bar' },
    { id: '111', title: 'GitHub', url: 'https://github.com', isFolder: false, parentId: '1', source: 'bar' },
    { id: '2', title: '其他书签', isFolder: true, parentId: ROOT_ID, source: 'other' },
    { id: '21', title: '读书', isFolder: true, parentId: '2', source: 'other' },
    { id: '211', title: '豆瓣', url: 'https://douban.com', isFolder: false, parentId: '21', source: 'other' },
    { id: HOME_FOLDER_ID, title: 'Berry主页', isFolder: true, parentId: ROOT_ID, source: 'other' },
    { id: 'h1', title: '必应', url: 'https://bing.com', isFolder: false, parentId: HOME_FOLDER_ID, source: 'home' },
    { id: '3', title: '移动设备书签', isFolder: true, parentId: ROOT_ID, source: 'mobile' },
    { id: '31', title: '手机书签A', url: 'https://m.a.com', isFolder: false, parentId: '3', source: 'mobile' },
  ];
}

// Berry 文件：仅 bar 区已有 GitHub（id=501，带 favicon 验证继承）
function berryFileWithBarOnly() {
  return {
    schemaVersion: 2,
    deviceId: 'berry-dev',
    timestamp: 1,
    lastModified: 0,
    data: [
      { id: '501', title: 'GitHub', url: 'https://github.com', isFolder: false, parentId: 'root', source: 'bar', favicon: 'github.png' },
    ],
  };
}

describe('patchBerryFile — other/mobile 子树挂载到虚拟容器', () => {
  test('Chrome other 子树写入 __other_folder__，mobile 子树写入 __mobile_folder__', async () => {
    mem.clear();
    berryFileData = berryFileWithBarOnly();
    uploadCaptured = null;

    await M.berry.patchBerryFile(chromeFlatList());

    expect(uploadCaptured).not.toBeNull();
    const data = uploadCaptured.data;
    const byTitle = (t) => data.find(n => n.title === t);

    // other 新增节点挂到 __other_folder__
    const dushu = byTitle('读书');
    expect(dushu).toBeDefined();
    expect(dushu.parentId).toBe(OTHER_FOLDER_ID);

    // 嵌套子书签挂到「读书」的新 Berry id（数字字符串）
    const dou = byTitle('豆瓣');
    expect(dou).toBeDefined();
    expect(dou.parentId).toBe(dushu.id);
    expect(dou.parentId).not.toBe('21'); // 不再是 Chrome 体系 id

    // mobile 新增节点挂到 __mobile_folder__（修复孤儿问题）
    const mob = byTitle('手机书签A');
    expect(mob).toBeDefined();
    expect(mob.parentId).toBe(MOBILE_FOLDER_ID);

    // ★ 主页（home）节点正常写入 __home_folder__ 区（Berry 端原生结构，实测支持）
    const bing = byTitle('必应');
    expect(bing).toBeDefined();
    expect(bing.parentId).toBe(HOME_FOLDER_ID);

    // HOME 容器本体也写入（Berry 文件主页区的挂载点，手机端原版文件必含）
    expect(data.some(n => n.id === HOME_FOLDER_ID && n.isFolder)).toBe(true);

    // 系统根容器本身不写入 Berry 文件（虚拟容器只是 parentId 引用）
    expect(data.some(n => n.id === '2' && n.title === '其他书签')).toBe(false);
    expect(data.some(n => n.id === '3' && n.title === '移动设备书签')).toBe(false);

    // 已有节点保留 Berry 原 id 与图标
    const gh = byTitle('GitHub');
    expect(gh.id).toBe('501');
    expect(gh.favicon).toBe('github.png');
  });
});

describe('mergeBerryData — Berry __other_folder__ 子树注入与 pathKey 对齐', () => {
  test('Berry 端 other 新增节点注入列表，source=other 且 pk 对齐 ROOT:other', async () => {
    mem.clear();
    // Chrome 现状：只有书签栏的 GitHub（other 区为空）
    const currentList = [
      { id: '1', title: '书签栏', isFolder: true, parentId: ROOT_ID, source: 'bar' },
      { id: '111', title: 'GitHub', url: 'https://github.com', isFolder: false, parentId: '1', source: 'bar' },
    ];
    // Berry 文件：GitHub + __other_folder__ 下的 读书/豆瓣（模拟 Berry 端新加）
    berryFileData = {
      schemaVersion: 2,
      deviceId: 'berry-dev',
      timestamp: 1,
      lastModified: 0,
      data: [
        { id: '501', title: 'GitHub', url: 'https://github.com', isFolder: false, parentId: 'root', source: 'bar' },
        { id: '601', title: '读书', isFolder: true, parentId: OTHER_FOLDER_ID },
        { id: '611', title: '豆瓣', url: 'https://douban.com', isFolder: false, parentId: '601' },
      ],
    };

    const result = await M.berry.mergeBerryData(currentList, false, null);

    const dushu = result.find(n => n.title === '读书');
    const dou = result.find(n => n.title === '豆瓣');
    expect(dushu).toBeDefined();
    expect(dou).toBeDefined();
    // 直接挂在 __other_folder__ 下的节点补 source=other
    //（嵌套子节点不补 source，区归属由父链的 pathKey 表达，与 mobile 现状一致）
    expect(dushu.source).toBe('other');
    // 挂载点保持虚拟容器 id（由 import 的 resolveParentId 落盘到 Chrome 其他书签）
    expect(dushu.parentId).toBe(OTHER_FOLDER_ID);
    // 豆瓣跟随 Berry 端父节点 id
    expect(dou.parentId).toBe('601');

    // ★ 关键对齐断言：注入节点的 pathKey 与 Chrome 端口径一致（ROOT:other/...）
    const pks = M.xbelPath.computeJsonPathKeys(result);
    expect(pks.get(dushu.id)).toBe('ROOT:other/F:读书');
    expect(pks.get(dou.id)).toBe('ROOT:other/F:读书/L:https://douban.com');

    // 已有节点不重复注入
    expect(result.filter(n => n.title === 'GitHub').length).toBe(1);
  });

  test('Chrome other 区已有同 pathKey 节点时，Berry 端不重复注入', async () => {
    mem.clear();
    const currentList = [
      { id: '1', title: '书签栏', isFolder: true, parentId: ROOT_ID, source: 'bar' },
      { id: '2', title: '其他书签', isFolder: true, parentId: ROOT_ID, source: 'other' },
      { id: '21', title: '读书', isFolder: true, parentId: '2', source: 'other' },
    ];
    berryFileData = {
      schemaVersion: 2,
      deviceId: 'berry-dev',
      timestamp: 1,
      lastModified: 0,
      data: [
        { id: '601', title: '读书', isFolder: true, parentId: OTHER_FOLDER_ID },
      ],
    };

    const result = await M.berry.mergeBerryData(currentList, false, null);
    // Chrome 已有 其他书签/读书（pk=ROOT:other/F:读书），Berry 端同 pk 节点不重复注入
    expect(result.filter(n => n.title === '读书').length).toBe(1);
  });
});
