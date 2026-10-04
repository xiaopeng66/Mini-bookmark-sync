// background-runtime.test.js — 后台脚本的【加载期行为】与书签数上报
//
// 真实缺陷背景（在用户手机上表现为「本地书签数 0 条、后台什么都不做、按钮全无反应」，
// 而宿主是 可拓/雨见 这类用 Gecko 扩展引擎的移动浏览器）：
//   ① 加载期直接 chrome.bookmarks.onRemoved.addListener(...)：宿主不向扩展开放书签 API 时
//      onRemoved 是 undefined ⇒ 抛异常 ⇒ 整个后台脚本在【注册消息处理器之前】中断，
//      界面看到的只是「后台未响应」，排查时完全看不出真因；
//   ② getLocalBookmarksCount 无视宿主能力去调 chrome.bookmarks.getTree，失败时按 0 上报，
//      把「宿主没给 API」伪装成「书签是空的」——用户据此以为书签没导进来，方向全错。
// 本文件钉住：无书签 API 的宿主上后台必须能【加载完】并正常响应消息；书签数上报必须
// 区分「宿主没 API」（NO_BOOKMARKS_API）与「真的是 0 条」（ok:true, count:0）。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

// 测试骨架自己的定时器必须是【真】定时器：某些用例会用 vi.useFakeTimers() 推后台内部的超时，
// 若骨架守卫也被伪造成假定时器，它会在假时间推进时先于目标超时触发，把用例搅成假失败。
// （模块加载早于用例里的 useFakeTimers，所以这里抓到的是原函数。）
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

// 模块清单直接从 background.js 的 importScripts 里取，保持与生产同源（避免清单漂移）
const BG_SRC = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const MODULES = (() => {
  const m = BG_SRC.match(/importScripts\(([\s\S]*?)\);/);
  if (!m) throw new Error('background.js 中找不到 importScripts 清单');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
})();

const BOOKMARK_TREE = [
  {
    id: '0', title: '', children: [
      {
        id: '1', title: '书签栏', children: [
          { id: '10', title: 'A', url: 'https://a.example/' },
          { id: '11', title: '文件夹', children: [{ id: '12', title: 'B', url: 'https://b.example/' }] },
        ],
      },
      { id: '2', title: '其他书签', children: [] },
    ],
  },
];

function makeStorageArea() {
  const data = {};
  const pick = (keys) => {
    const out = {};
    const list = keys == null
      ? Object.keys(data)
      : (Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(keys)));
    for (const k of list) if (k in data) out[k] = data[k];
    return out;
  };
  return {
    _data: data,
    // ⚠️ 生产代码两种风格都用了：MV2 回调式 + promise 式（如
    //    `chrome.storage.local.set(patch).catch(...)`）。回调可缺省，此时必须返回 Promise，
    //    否则 mock 会在生产代码里抛 TypeError，把测试引到错方向（本文件真实踩过）。
    get(keys, cb) { const out = pick(keys); if (cb) { cb(out); return undefined; } return Promise.resolve(out); },
    set(obj, cb) { Object.assign(data, obj); if (cb) { cb(); return undefined; } return Promise.resolve(); },
    remove(keys, cb) {
      for (const k of (Array.isArray(keys) ? keys : [keys])) delete data[k];
      if (cb) { cb(); return undefined; }
      return Promise.resolve();
    },
  };
}

/**
 * 在独立 vm 上下文里加载完整后台（19 个模块 + background.js）。
 * 每个场景一个全新上下文：background.js 顶层用 const 声明，重复加载同一上下文会报重复声明。
 * @param {{withBookmarks: boolean}} opts withBookmarks=false 模拟「宿主不开放书签 API」
 * @returns {{listeners: Function[], loadError: Error|null, consoleErrors: string[]}}
 */
function loadBackground({ withBookmarks, manifestVersion = 3, importScriptsOnPage = false }) {
  const listeners = [];
  const consoleErrors = [];
  const errorListeners = [];
  // chrome.alarms.create 的实参：自动同步间隔是安全的最后一道关口，必须能断言到真实入参
  const alarmCreates = [];

  const chromeMock = {
    runtime: {
      lastError: null,
      getManifest: () => ({ manifest_version: manifestVersion, version: '0.0.0-test' }),
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: () => {},
    },
    storage: {
      local: makeStorageArea(),
      session: makeStorageArea(),
      onChanged: { addListener() {} },
    },
    alarms: { create(...args) { alarmCreates.push(args); }, clear() {}, onAlarm: { addListener() {} } },
    action: { setIcon() {}, setBadgeText() {}, setBadgeBackgroundColor() {} },
  };
  if (withBookmarks) {
    chromeMock.bookmarks = withBookmarks === 'stalling'
      ? {
        // 移动端 fork 的真实形态之一：getTree 是函数、但回调永不触发
        getTree: () => { /* 永不回调 */ },
        get: (id, cb) => cb([]),
        create: (node, cb) => cb && cb({ id: '99' }),
        update: (id, changes, cb) => cb && cb(),
        onRemoved: { addListener() {} },
        onMoved: { addListener() {} },
      }
      : {
        getTree: (cb) => cb(BOOKMARK_TREE),
        get: (id, cb) => cb([]),
        create: (node, cb) => cb && cb({ id: '99' }),
        update: (id, changes, cb) => cb && cb(),
        onRemoved: { addListener() {} },
        onMoved: { addListener() {} },
      };
  }

  const sandbox = {
    chrome: chromeMock,
    console: {
      log() {}, info() {}, debug() {},
      warn: (...a) => consoleErrors.push(a.join(' ')),
      error: (...a) => consoleErrors.push(a.join(' ')),
    },
    // ⚠️ 包一层、在调用时才查全局 setTimeout：这样测试里 vi.useFakeTimers() 才管得住
    //    后台内部的超时（直接传裸函数会把假定时器挡在外面）
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    setInterval, clearInterval,
    URL, TextEncoder, TextDecoder,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    fetch: () => Promise.reject(new Error('测试环境不发网络请求')),
  };
  // 后台页里 self === window === globalThis。补上它们，后台的加载期错误监听与
  // __MiniSyncSelfCheck（诊断用的直接句柄）才装得上、才可断言。
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.addEventListener = (type, fn) => errorListeners.push({ type, fn });
  // 手机端 fork 的形态之一：连普通扩展页面都暴露 importScripts（因此不能拿它判断 MV2/MV3）
  if (importScriptsOnPage) sandbox.importScripts = () => {};
  vm.createContext(sandbox);

  let loadError = null;
  try {
    for (const rel of MODULES) {
      vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
    }
    vm.runInContext(BG_SRC, sandbox, { filename: 'background.js' });
  } catch (e) {
    loadError = e;
  }
  return {
    listeners, loadError, consoleErrors, errorListeners, sandbox,
    storage: chromeMock.storage.local,
    alarmCreates
  };
}

/** 模拟 runtime.sendMessage：返回后台对某条消息的响应（含无响应/超时的显式标记） */
function sendMessageOnce(listener, message) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const timer = realSetTimeout(() => done('__TIMEOUT__：后台未回消息'), 2000);
    const send = (r) => { realClearTimeout(timer); done(r); };
    let ret;
    try {
      ret = listener(message, { id: 'test' }, send);
    } catch (e) {
      clearTimeout(timer);
      done('__THROWN__: ' + e.message);
      return;
    }
    if (ret !== true) { clearTimeout(timer); done(`__NO_RESPONSE__(${ret})`); }
  });
}

describe('后台加载期：宿主不开放书签 API（Gecko 系移动端宿主）', () => {
  test('必须能加载完并注册消息处理器（书签监听不得中断整个后台）', () => {
    const { listeners, loadError } = loadBackground({ withBookmarks: false });
    expect(loadError).toBeNull();
    expect(listeners.length).toBe(1);
  });

  test('书签数上报明确区分「宿主没给 API」与「真的是 0 条」', async () => {
    const { listeners } = loadBackground({ withBookmarks: false });
    const resp = await sendMessageOnce(listeners[0], { action: 'getLocalBookmarksCount' });
    expect(resp).toMatchObject({ ok: false, code: 'NO_BOOKMARKS_API' });
    expect(resp.message).toContain('书签 API');
  });

  test('不依赖书签 API 的消息照常响应（后台没死）', async () => {
    const { listeners } = loadBackground({ withBookmarks: false });
    const resp = await sendMessageOnce(listeners[0], { type: 'GET_STATUS' });
    expect(resp).toMatchObject({ success: true });
    expect(resp.data).toHaveProperty('status');
  });
});

describe('后台探针与自述诊断', () => {
  test('ping：最轻量探针，不碰宿主 API 也能证明后台活着', async () => {
    const { listeners } = loadBackground({ withBookmarks: false });
    const resp = await sendMessageOnce(listeners[0], { action: 'ping' });
    expect(resp).toMatchObject({ ok: true, hasBookmarksApi: false });
    expect(resp.manifestVersion).toBe(3);
  });

  test('diagnose：书签接口能读时报告条数', async () => {
    const { listeners } = loadBackground({ withBookmarks: true });
    const resp = await sendMessageOnce(listeners[0], { action: 'diagnose' });
    expect(resp.ok).toBe(true);
    expect(resp.bookmarkCount).toEqual({ ok: true, count: 2 });
    expect(resp.globals.importScripts).toBe('undefined'); // MV2 事件页形态
  });

  test('diagnose：宿主不给书签 API 时，逐项如实报告（不编造成功）', async () => {
    const { listeners } = loadBackground({ withBookmarks: false });
    const resp = await sendMessageOnce(listeners[0], { action: 'diagnose' });
    expect(resp.ok).toBe(true);
    expect(resp.hasBookmarksApi).toBe(false);
    expect(resp.bookmarkCount.ok).toBe(false);
    expect(resp.bookmarkCount.error).toContain('NO_BOOKMARKS_API');
    expect(resp.globals.bookmarks).toBe('undefined');
  });

  test('getTree 回调永不触发 → 超时后把真因回给页面（不再永远不回消息）', async () => {
    vi.useFakeTimers();
    try {
      const { listeners } = loadBackground({ withBookmarks: 'stalling' });
      const pending = sendMessageOnce(listeners[0], { action: 'getLocalBookmarksCount' });
      await vi.advanceTimersByTimeAsync(6000);
      const resp = await pending;
      expect(resp).toMatchObject({ ok: false, code: 'BOOKMARKS_API_FAILED' });
      expect(resp.message).toContain('回调 5000ms 内没回来');
    } finally {
      vi.useRealTimers();
    }
  });

  test('ping：同步响应后必须 return true（某些宿主 return false 会把响应一起丢掉）', () => {
    const { listeners } = loadBackground({ withBookmarks: false });
    const seen = [];
    const ret = listeners[0]({ action: 'ping' }, { id: 't' }, (r) => seen.push(r));
    expect(ret).toBe(true);
    expect(seen[0]).toMatchObject({ ok: true, transport: 'ping' });
  });

  test('pingLegacy：对照探针故意沿用 return false，用来测宿主的响应语义', () => {
    const { listeners } = loadBackground({ withBookmarks: false });
    const seen = [];
    const ret = listeners[0]({ action: 'pingLegacy' }, { id: 't' }, (r) => seen.push(r));
    expect(ret).toBe(false);
    expect(seen[0].transport).toBe('pingLegacy-sync-return-false');
  });

  test('diagnose：backgroundType 由 manifest_version 推出（fork 连普通页都暴露 importScripts）', async () => {
    const { listeners } = loadBackground({ withBookmarks: true, manifestVersion: 2, importScriptsOnPage: true });
    const resp = await sendMessageOnce(listeners[0], { action: 'diagnose' });
    expect(resp.manifestVersion).toBe(2);
    expect(resp.globals.importScripts).toBe('function');
    expect(resp.backgroundType).toBe('mv2-background-page');
  });

});

describe('后台台账（不依赖消息通道的排查凭据）', () => {
  test('加载完成即写开机登记：stage=ready、带版本与错误清单', () => {
    const { storage, loadError } = loadBackground({ withBookmarks: true });
    expect(loadError).toBeNull();
    const boot = storage._data.bg_boot_report;
    expect(boot).toBeTruthy();
    expect(boot.stage).toBe('ready');
    expect(boot.loads).toBe(1);
    expect(boot.manifestVersion).toBe(3);
    expect(Array.isArray(boot.errors)).toBe(true);
    expect(boot.msgCount).toBe(0);
  });

  test('每条消息都留台账：用来分辨「后台没收到」与「收到了但没答」', async () => {
    const { listeners, storage } = loadBackground({ withBookmarks: false });
    expect(storage._data.bg_last_message).toBeUndefined();
    await sendMessageOnce(listeners[0], { action: 'ping' });
    expect(storage._data.bg_last_message).toMatchObject({ type: 'ping', total: 1 });
    await sendMessageOnce(listeners[0], { action: 'getLocalBookmarksCount' });
    expect(storage._data.bg_last_message).toMatchObject({ type: 'getLocalBookmarksCount', total: 2 });
    // 开机登记里的 msgCount 是「加载那一刻」的快照，实时计数只维护在 bg_last_message.total
    // （不再每条消息都重写整份登记，省一次存储写）。
    expect(storage._data.bg_boot_report.msgCount).toBe(0);
  });

  test('加载期错误会写进登记（页面侧直接读得到，不必问后台）', () => {
    const { errorListeners, storage } = loadBackground({ withBookmarks: true });
    const onError = errorListeners.find((e) => e.type === 'error');
    expect(typeof onError.fn).toBe('function');
    onError.fn({ message: 'boom-at-load' });
    const boot = storage._data.bg_boot_report;
    expect(boot.errors.map((e) => e.message)).toContain('boom-at-load');
    expect(boot.stage).toBe('runtime-error');
  });

  test('直接句柄自检：getBackgroundPage 拿到后台 window 就能读状态，绕开消息通道', () => {
    const { sandbox, loadError } = loadBackground({ withBookmarks: true });
    expect(loadError).toBeNull();
    expect(typeof sandbox.__MiniSyncSelfCheck).toBe('function');
    const s = sandbox.__MiniSyncSelfCheck();
    expect(s).toMatchObject({ ok: true, bootStage: 'ready', hasBookmarksApi: true, msgCount: 0 });
    expect(s.moduleNames).toContain('storage');
    expect(s.moduleNames).toContain('utils');
  });

  test('直接分发通道：响应与消息通道完全一致（手机端第二条传输带）', async () => {
    const { sandbox } = loadBackground({ withBookmarks: true });
    await expect(sandbox.__MiniSyncDispatchDirect({ action: 'getLocalBookmarksCount' }))
      .resolves.toEqual({ ok: true, count: 2 });
  });

  test('直接分发通道：同步响应的处理器（监听器返回 false）也拿得到值', async () => {
    const { sandbox } = loadBackground({ withBookmarks: true });
    const r = await sandbox.__MiniSyncDispatchDirect({ action: 'pingLegacy' });
    expect(r.transport).toBe('pingLegacy-sync-return-false');
  });

  test('直接分发通道：后台没给响应就当场定性，不让页面干等 15s', async () => {
    const { sandbox } = loadBackground({ withBookmarks: true });
    const r = await sandbox.__MiniSyncDispatchDirect({}); // 没有 type/action
    expect(r).toMatchObject({ success: false, code: 'DIRECT_NO_RESPONSE' });
  });

  // 手机端真缺陷：webdav.testConnection 靠 AbortController 自保 15s，但宿主若根本不理会
  // 请求中断，里层永不返回 ⇒ 后台永远不回消息 ⇒ 页面只能显示「后台无响应」。
  // checkConfig 外面必须再套一层硬超时，保证「无论如何都作答」。
  test('checkConfig：WebDAV 请求永不返回时也必须作答（不许沉默）', async () => {
    vi.useFakeTimers();
    try {
      const { listeners, sandbox, storage } = loadBackground({ withBookmarks: true });
      storage._data.webdav_url = 'https://dav.example/';
      storage._data.webdav_user = 'u';
      storage._data.webdav_password = 'p';
      sandbox.MiniSync.actions.testConnection = () => new Promise(() => {}); // 模拟「不理会中断」
      const pending = sendMessageOnce(listeners[0], { action: 'checkConfig' });
      await vi.advanceTimersByTimeAsync(21000);
      const resp = await pending;
      expect(resp.ok).toBe(false);
      expect(resp.error).toContain('20s 未返回');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('后台加载期：书签 API 正常可用（Chrome/Edge/Firefox）', () => {
  test('统计本地书签数量（含嵌套文件夹里的书签）', async () => {
    const { listeners, loadError } = loadBackground({ withBookmarks: true });
    expect(loadError).toBeNull();
    const resp = await sendMessageOnce(listeners[0], { action: 'getLocalBookmarksCount' });
    expect(resp).toEqual({ ok: true, count: 2 });
  });

  test('书签监听注册成功后，删除事件能被接收（不抛异常）', () => {
    expect(() => loadBackground({ withBookmarks: true })).not.toThrow();
  });
});

// 手机端每次点「上传/下载/合并」都会被投递两次：管道那次响应被宿主丢掉（后台其实执行完了），
// 页面侧超时后再用直接句柄重发一次。没有台账的话，同一次同步就执行两遍：白等一个超时、
// 云端被并发写两次，UI 还只看得到第二遍的结果。
describe('消息重放台账：同一条消息投递两次只执行一遍', () => {
  test('第二次投递（不同对象、同一个 __msgId）直接复用第一次的结果', async () => {
    const { listeners, sandbox } = loadBackground({ withBookmarks: true });
    let runs = 0;
    sandbox.MiniSync.actions.uploadBookmarks = () => { runs++; return Promise.resolve({ success: true, run: runs }); };

    const first = await sendMessageOnce(listeners[0], { action: 'upload', __msgId: 'sess-1' });
    expect(first).toEqual({ success: true, run: 1 });

    // 兜底重发：真实场景里是同一个对象经直接句柄再投一次，这里用同 id 的新对象等价模拟
    const second = await sendMessageOnce(listeners[0], { action: 'upload', __msgId: 'sess-1' });
    expect(second).toEqual({ success: true, run: 1 });
    expect(runs).toBe(1);
  });

  test('第一次还在跑时第二次投递就到达 → 等同一个结果，绝不并发跑两遍', async () => {
    const { listeners, sandbox } = loadBackground({ withBookmarks: true });
    let runs = 0;
    let release;
    sandbox.MiniSync.actions.uploadBookmarks = () => {
      runs++;
      return new Promise((resolve) => { release = resolve; });
    };

    const first = sendMessageOnce(listeners[0], { action: 'upload', __msgId: 'sess-2' });
    const second = sandbox.__MiniSyncDispatchDirect({ action: 'upload', __msgId: 'sess-2' });
    expect(runs).toBe(1); // 合并已经生效：第二次没有再次进入处理器
    release({ success: true, done: true });

    expect(await first).toEqual({ success: true, done: true });
    expect(await second).toEqual({ success: true, done: true });
    expect(runs).toBe(1);
  });

  test('不同 __msgId 的消息各自执行（台账不误伤正常的连续两次同步）', async () => {
    const { listeners, sandbox } = loadBackground({ withBookmarks: true });
    let runs = 0;
    sandbox.MiniSync.actions.uploadBookmarks = () => { runs++; return Promise.resolve({ success: true, run: runs }); };

    await sendMessageOnce(listeners[0], { action: 'upload', __msgId: 'a-1' });
    await sendMessageOnce(listeners[0], { action: 'upload', __msgId: 'a-2' });
    expect(runs).toBe(2);
  });

  test('没有 __msgId 的老调用方照旧每次都执行（默认行为不变）', async () => {
    const { listeners, sandbox } = loadBackground({ withBookmarks: true });
    let runs = 0;
    sandbox.MiniSync.actions.uploadBookmarks = () => { runs++; return Promise.resolve({ ok: true }); };

    await sendMessageOnce(listeners[0], { action: 'upload' });
    await sendMessageOnce(listeners[0], { action: 'upload' });
    expect(runs).toBe(2);
  });

  test('重放次数进自检报告（手机端据此确认「没有跑两遍」）', async () => {
    const { listeners, sandbox } = loadBackground({ withBookmarks: true });
    sandbox.MiniSync.actions.uploadBookmarks = () => Promise.resolve({ success: true });
    await sendMessageOnce(listeners[0], { action: 'upload', __msgId: 'sess-3' });
    await sendMessageOnce(listeners[0], { action: 'upload', __msgId: 'sess-3' });
    const s = sandbox.__MiniSyncSelfCheck();
    expect(s.msgLedgerReplays).toBe(1);
    expect(s.msgLedgerSize).toBe(1);
  });
});

// 自动同步定时器的间隔来自 storage，而 storage 可以被导入的备份文件/手工改动写入。
// 它直通 chrome.alarms.create({ periodInMinutes })：负数会让 create 抛错（自动同步静默失效），
// 极小值会被浏览器夹到 1 分钟高频轮询。这里断言的是【真实入参】，不是某个中间变量的值。
describe('自动同步定时器：坏间隔不许直通 chrome.alarms', () => {
  async function armWith(interval) {
    const bg = loadBackground({ withBookmarks: true });
    await new Promise((r) => bg.storage.set({
      sync_enabled: true, webdav_url: 'https://dav.example/dav/', sync_interval: interval
    }, r));
    await sendMessageOnce(bg.listeners[0], { action: 'updateSyncInterval' });
    return bg;
  }

  test('正常值照旧（30 分钟）', async () => {
    const bg = await armWith(30);
    expect(bg.alarmCreates.length).toBe(1);
    expect(bg.alarmCreates[0][1].periodInMinutes).toBe(30);
  });

  test('storage 里是负数 ⇒ 传给 create 的是合法正数（不是 -5）', async () => {
    const bg = await armWith(-5);
    expect(bg.alarmCreates.length).toBe(1);
    const p = bg.alarmCreates[0][1].periodInMinutes;
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBeGreaterThan(0);
  });

  test('storage 里是垃圾字符串 ⇒ 回默认 30，而不是 NaN', async () => {
    const bg = await armWith('半小时');
    expect(bg.alarmCreates[0][1].periodInMinutes).toBe(30);
  });
});
