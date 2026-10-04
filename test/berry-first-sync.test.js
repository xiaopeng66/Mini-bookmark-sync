// berry-first-sync.test.js — Berry「首次同步」（云端 bookmarks.json 尚不存在）回归测试
//
// 背景：patchBerryFile 曾对「文件不存在」走一段独立的简化分支，把 home 节点整批过滤掉，
// 导致首次同步时桌面主页书签永远写不进 Berry（要等第二轮才补上）。
// 该分支移除后，新建文件改由统一写回路径生成，随之暴露两个必须钉住的性质：
//   1. 新分配的纯数字 id 不得与 Chromium 系统根容器 id（'1'/'2'/'3'）撞号；
//      撞号会让书签栏首个书签变成 id='1' 且 parentId='1' 的自引用节点，
//      computePathKeys 沿父链判成 'ROOT:cyclic'，下一轮无法匹配 → id 被重分配。
//   2. 已存在书签的 Berry id 在后续同步中必须保持稳定（手机端 favicon/顺序挂在 id 上）。

const { loadSource } = require('./load-source');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

loadSource();
vm.runInThisContext(
  fs.readFileSync(path.resolve(__dirname, '..', 'adapters', 'berry-adapter.js'), 'utf8'),
  { filename: 'adapters/berry-adapter.js' }
);

const M = global.MiniSync;
const HOME_FOLDER_ID = global.HOME_FOLDER_ID;
const ROOT_ID = global.ROOT_ID;
const CHROME_ROOT_IDS = ['1', '2', '3'];

// ---- chrome.storage.local 内存 mock（回调/Promise 双兼容）----
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
    (Array.isArray(keys) ? keys : [keys]).forEach(k => mem.delete(k));
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

// ---- Berry 桥接 IO mock ----
let berryFileData = null;
global.downloadBerryBookmarks = async () => berryFileData;
global.uploadBerryBookmarks = async (d) => { berryFileData = d; };

// ---- 桌面树：书签栏 1 条 + 其他书签 1 条 + Berry主页 2 条 ----
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

const flat = () => M.merger.chromeTreeToList([deskTree()]);
const homeTitles = () => (berryFileData.data || [])
  .filter(n => n.parentId === HOME_FOLDER_ID && !n.isFolder && n.url)
  .map(n => n.title).sort();

beforeEach(() => {
  mem.clear();
  berryFileData = null;
});

describe('Berry 首次同步（云端文件不存在）', () => {
  test('写出 __home_folder__ 容器与桌面主页书签，而不是把它们丢掉', async () => {
    await M.berry.patchBerryFile(flat());

    expect(berryFileData).not.toBeNull();
    const container = berryFileData.data.find(n => n.id === HOME_FOLDER_ID);
    expect(container).toBeTruthy();
    expect(container.isFolder).toBe(true);
    expect(container.parentId).toBe(ROOT_ID);
    expect(homeTitles()).toEqual(['必应', '知乎']);
  });

  test('新分配的 id 不与系统根 id 撞号，且不存在自引用节点', async () => {
    await M.berry.patchBerryFile(flat());

    const data = berryFileData.data;
    // 无节点 id 落在 Chromium 系统根 id 上
    const collided = data.filter(n => CHROME_ROOT_IDS.includes(String(n.id)));
    expect(collided.map(n => n.title)).toEqual([]);
    // 无节点自己指向自己（自引用会让 pathKey 变 'ROOT:cyclic'，后续永远匹配不上）
    const selfRef = data.filter(n => String(n.id) === String(n.parentId));
    expect(selfRef.map(n => n.title)).toEqual([]);
    // 书签栏子节点的 parentId 仍指向 Chromium 书签栏根 id
    const gh = data.find(n => n.title === 'GitHub');
    expect(gh.parentId).toBe('1');
    expect(gh.id).not.toBe('1');
  });

  test('重复同步保持 id 稳定（不因撞号被重分配）', async () => {
    await M.berry.patchBerryFile(flat());
    const idOf = (title) => (berryFileData.data.find(n => n.title === title) || {}).id;

    const firstGithub = idOf('GitHub');
    const firstBing = idOf('必应');

    await M.berry.patchBerryFile(flat());

    expect(idOf('GitHub')).toBe(firstGithub);
    expect(idOf('必应')).toBe(firstBing);
    expect(homeTitles()).toEqual(['必应', '知乎']);
    // 不产生重复条目
    expect(berryFileData.data.filter(n => n.title === 'GitHub').length).toBe(1);
  });
});
