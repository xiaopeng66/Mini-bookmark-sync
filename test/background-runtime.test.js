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
 * @param {{withBookmarks: boolean, noAlarms?: boolean, initialStorage?: object,
 *          initialAlarms?: object, patch?: Function}} opts
 *        withBookmarks=false 模拟「宿主不开放书签 API」；
 *        noAlarms=true 模拟「宿主没有 alarms API」（可拓/雨见这类 fork 的形态之一）；
 *        initialStorage / initialAlarms 在加载前预置 storage 与定时器（模拟「本会话已建好定时器」）；
 *        patch 在模块加载完、background.js 执行前调用，给用例一个打桩窗口。
 * @returns {{listeners: Function[], loadError: Error|null, consoleErrors: string[]}}
 */
function loadBackground({
  withBookmarks, manifestVersion = 3, importScriptsOnPage = false,
  noAlarms = false, partialAlarms = false, alarmsCreateThrows = false, noAlarmsClear = false,
  initialStorage = null, initialAlarms = null, patch = null
}) {
  const listeners = [];
  const consoleErrors = [];
  const errorListeners = [];
  // chrome.alarms.create 的实参：自动同步间隔是安全的最后一道关口，必须能断言到真实入参
  const alarmCreates = [];
  // ★ 定时器必须是【有状态】的仓库，不能是空操作：
  //   「浏览器重启后 alarms 被清空 ⇒ 自动同步再也不响」这个缺陷，只有 mock 会真的
  //   存/查/清时才暴露得出来（空操作的 clear() 永远看不出定时器丢了）。
  const alarms = new Map();
  const alarmEvents = { cleared: [], onAlarm: [], onStartup: [], onInstalled: [] };

  const chromeMock = {
    runtime: {
      lastError: null,
      getManifest: () => ({ manifest_version: manifestVersion, version: '0.0.0-test' }),
      onInstalled: { addListener: (fn) => alarmEvents.onInstalled.push(fn) },
      onStartup: { addListener: (fn) => alarmEvents.onStartup.push(fn) },
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: () => {},
    },
    storage: {
      local: makeStorageArea(),
      session: makeStorageArea(),
      onChanged: { addListener() {} },
    },
    action: { setIcon() {}, setBadgeText() {}, setBadgeBackgroundColor() {} },
  };
  if (partialAlarms) {
    // 「部分实现」的宿主：有 create/clear，却没有 onAlarm。
    // 光看 create 就断定 API 可用 ⇒ 顶层裸注册 onAlarm 会在加载期抛异常，
    // 后台整段死掉、onMessage 注册不上，表现与「后台没运行」完全一样。
    chromeMock.alarms = {
      create(name, info) {
        alarms.set(name, { periodInMinutes: info && info.periodInMinutes });
        alarmCreates.push([name, info]);
      },
      clear(name) { alarms.delete(name); alarmEvents.cleared.push(name); },
    };
  }
  if (!noAlarms && !partialAlarms) {
    chromeMock.alarms = {
      get(name, cb) {
        const a = alarms.get(name) || null;
        const view = a ? { name, periodInMinutes: a.periodInMinutes } : null;
        if (cb) { cb(view); return undefined; }
        return Promise.resolve(view);
      },
      create(name, info) {
        // 宿主形态之一（手机 fork 上出现过）：create 在、一调就抛。
        // 校准会失败，但【补跑】必须照跑 —— 那是这种宿主上唯一的自动同步路径。
        if (alarmsCreateThrows) throw new Error('宿主拒绝创建定时器');
        alarms.set(name, { periodInMinutes: info && info.periodInMinutes });
        alarmCreates.push([name, info]);
      },
      clear(name) { alarms.delete(name); alarmEvents.cleared.push(name); },
      onAlarm: { addListener: (fn) => alarmEvents.onAlarm.push(fn) },
    };
    // 另一种半实现：有 create/get/onAlarm，唯独没有 clear。
    // 缺 clear 只能退化成「重建时覆盖」，绝不能因此把自动同步整个判死。
    if (noAlarmsClear) delete chromeMock.alarms.clear;
  }
  // 预置状态：必须发生在 background.js 执行【之前】，否则「后台启动时自愈」跑的是空 storage，
  // 用例就变成在测「设完配置之后再校准」，与真实启动时序不符（这类竞态会让断言假通过）。
  if (initialStorage) Object.assign(chromeMock.storage.local._data, initialStorage);
  if (initialAlarms) for (const [k, v] of Object.entries(initialAlarms)) alarms.set(k, v);
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
    if (patch) patch(sandbox);          // 打桩窗口：模块已就绪，background.js 还没跑
    vm.runInContext(BG_SRC, sandbox, { filename: 'background.js' });
  } catch (e) {
    loadError = e;
  }
  return {
    listeners, loadError, consoleErrors, errorListeners, sandbox,
    storage: chromeMock.storage.local,
    alarmCreates, alarms, alarmEvents
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
    expect(resp.bookmarkCount.code).toBe('NO_BOOKMARKS_API');
    expect(resp.bookmarkCount.error).toBe('[redacted error]');
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

// 自动同步定时器的【会话生命周期】。
//
// 真实缺陷（用户手机上：桌面端自动同步正常，手机端从不自动同步，每次都得手动点）：
//   chrome.alarms **不跨浏览器会话保留**（MDN：Alarms do not persist across browser sessions），
//   而本扩展只在 onInstalled（安装/更新）与「保存配置」时建定时器 ⇒ Gecko 系手机宿主每次
//   重启浏览器就丢掉定时器、且再也不会重建，自动同步永久失效；Chrome/Edge 自己会保留 alarms，
//   所以桌面端一直正常 —— 这正是「电脑正常、手机不正常」的来源。
//   原项目只出 Chromium 包，这个缺口一直没暴露；出了 Gecko 包才变成真缺陷。
describe('自动同步定时器：新会话必须重建（Gecko 不跨会话保留 alarms）', () => {
  const ALARM = 'webdav_bookmark_auto_sync';
  const CONFIGURED = { sync_enabled: true, webdav_url: 'https://dav.example/dav/', sync_interval: 30 };
  const flush = () => new Promise((r) => realSetTimeout(r, 5));
  const diagnose = (bg) => sendMessageOnce(bg.listeners[0], { action: 'diagnose' });
  const load = (extra) => loadBackground(Object.assign({ withBookmarks: true, initialStorage: CONFIGURED }, extra));

  test('alarms 为空（=浏览器刚重启）+ 配置在 ⇒ 后台一被唤醒就重建定时器', async () => {
    const bg = load({});
    await flush();                                  // 顶层启动自愈跑完（未触发任何事件）
    expect(bg.alarmCreates.map((c) => c[0])).toContain(ALARM);
    expect(bg.alarmCreates[0][1].periodInMinutes).toBe(30);
  });

  test('onStartup（浏览器启动事件）也要补建 —— 不能只靠安装事件', async () => {
    const bg = load({});
    await flush();
    bg.alarms.clear(ALARM);                         // 模拟定时器在会话切换中丢失
    bg.alarmCreates.length = 0;
    expect(bg.alarmEvents.onStartup.length).toBeGreaterThan(0);
    await bg.alarmEvents.onStartup[0]();
    expect(bg.alarmCreates.map((c) => c[0])).toContain(ALARM);
  });

  test('定时器已在且间隔一致 ⇒ 不得重建、不得清掉（每次唤醒都重建会把倒计时永久重置）', async () => {
    // 本会话已建好定时器（MV3 的 SW 会被反复唤醒，每次唤醒都重建 ⇒ 永远等不到那一轮）
    const bg = load({ initialAlarms: { [ALARM]: { periodInMinutes: 30 } } });
    await flush();
    // 用诊断报告断言自愈逻辑【确实跑过且判定 kept】——只断言 create 次数会被
    // 「代码压根没执行」蒙混过关（这类缺陷最难发现的地方就在这）
    const d = await diagnose(bg);
    expect(d.autoAlarm.last.action).toBe('kept');
    expect(bg.alarmCreates.length).toBe(0);
    expect(bg.alarmEvents.cleared).not.toContain(ALARM);
  });

  test('间隔被改过 ⇒ 必须按新间隔重建（不能留着旧的继续跑）', async () => {
    const bg = load({
      initialStorage: Object.assign({}, CONFIGURED, { sync_interval: 60 }),
      initialAlarms: { [ALARM]: { periodInMinutes: 30 } }
    });
    await flush();
    const d = await diagnose(bg);
    expect(d.autoAlarm.last.action).toBe('recreated');
    expect(bg.alarmCreates[bg.alarmCreates.length - 1][1].periodInMinutes).toBe(60);
  });

  test('自动同步关掉 ⇒ 定时器必须清掉，不得偷偷继续跑', async () => {
    const bg = load({
      initialStorage: Object.assign({}, CONFIGURED, { sync_enabled: false }),
      initialAlarms: { [ALARM]: { periodInMinutes: 30 } }
    });
    await flush();
    expect(bg.alarmEvents.cleared).toContain(ALARM);
    expect(bg.alarms.has(ALARM)).toBe(false);
    expect(bg.alarmCreates.length).toBe(0);
  });

  test('未配置（storage 空）时启动不得建定时器', async () => {
    const bg = loadBackground({ withBookmarks: true });
    await flush();
    expect(bg.alarmCreates.length).toBe(0);
  });

  test('宿主没有 alarms API ⇒ 后台仍要能加载完并注册消息处理器（不许整段死掉）', async () => {
    const bg = load({ noAlarms: true });
    expect(bg.loadError).toBeNull();
    expect(bg.listeners.length).toBe(1);
    const d = await diagnose(bg);
    expect(d.autoAlarm.apiAvailable).toBe(false);
    expect(d.autoAlarm.wanted).toBe(true);          // 配置是要同步的，只是宿主给不了定时器
  });

  test('宿主只实现了一半 alarms（有 create/clear、没有 onAlarm）⇒ 照样不许整段死掉', async () => {
    // 光凭「有 create」就断定 API 可用是不够的：顶层是同步注册 onAlarm 的，
    // 那一下抛异常就再也走不到 onMessage 注册 —— 这正是「后台无响应」的形态。
    const bg = load({ partialAlarms: true });
    expect(bg.loadError).toBeNull();
    expect(bg.listeners.length).toBe(1);
    const d = await diagnose(bg);
    expect(d.autoAlarm.apiAvailable).toBe(false);   // 当作「宿主给不了定时器」，走补跑那条路
    expect(d.autoAlarm.exists).toBe(false);
  });

  test('诊断报告如实报定时器实况（手机上看这一项就能确认修好没有）', async () => {
    const bg = load({});
    await flush();
    const d = await diagnose(bg);
    expect(d.autoAlarm).toMatchObject({ apiAvailable: true, wanted: true, exists: true, periodInMinutes: 30 });
  });
});

// 自动同步的另一半：浏览器关着的时候 alarm 不可能响。用户（尤其手机）一天只开一次浏览器时，
// 靠 alarm 等不到任何一轮 ⇒ 唤醒时必须把错过的那一次补上。
describe('自动同步：唤醒时补上「浏览器关着时错过的那一轮」', () => {
  const CONFIGURED = { sync_enabled: true, webdav_url: 'https://dav.example/dav/', sync_interval: 30 };
  const flush = () => new Promise((r) => realSetTimeout(r, 5));
  const ALARM = 'webdav_bookmark_auto_sync';
  const makeStub = (calls) => (sandbox) => {
    sandbox.MiniSync.actions.mergeSync = (o) => {
      calls.push(o);
      return Promise.resolve({ success: true, message: '补跑成功', stats: { added: 0, removed: 0 } });
    };
  };

  test('已过点 ⇒ 补跑一次（并且把下次时间推到未来）', async () => {
    const calls = [];
    const bg = loadBackground({
      withBookmarks: true,
      initialStorage: Object.assign({}, CONFIGURED, { auto_sync_next_at: Date.now() - 1000 }),
      patch: makeStub(calls)
    });
    await flush();
    expect(calls.length).toBe(1);
    expect(bg.storage._data.auto_sync_next_at).toBeGreaterThan(Date.now());
  });

  test('没到点 ⇒ 不跑', async () => {
    const calls = [];
    loadBackground({
      withBookmarks: true,
      initialStorage: Object.assign({}, CONFIGURED, { auto_sync_next_at: Date.now() + 600000 }),
      patch: makeStub(calls)
    });
    await flush();
    expect(calls.length).toBe(0);
  });

  test('台账缺失（刚升级上来）⇒ 不猜、不跑（绝不因为升级装完就突然同步一次）', async () => {
    const calls = [];
    loadBackground({ withBookmarks: true, initialStorage: Object.assign({}, CONFIGURED), patch: makeStub(calls) });
    await flush();
    expect(calls.length).toBe(0);
  });

  test('上次同步很久以前 ⇒ 按「上次 + 一个间隔」推算出已过点，补跑一次', async () => {
    const calls = [];
    loadBackground({
      withBookmarks: true,
      initialStorage: Object.assign({}, CONFIGURED, { last_sync_at: Date.now() - 2 * 3600 * 1000 }),
      patch: makeStub(calls)
    });
    await flush();
    expect(calls.length).toBe(1);
  });

  test('自动同步关着 / 没配地址 ⇒ 到点也不跑', async () => {
    const calls = [];
    loadBackground({
      withBookmarks: true,
      initialStorage: Object.assign({}, CONFIGURED, { sync_enabled: false, auto_sync_next_at: Date.now() - 1000 }),
      patch: makeStub(calls)
    });
    await flush();
    expect(calls.length).toBe(0);
  });

  test('补跑【开始前】就把下次时间推到未来 ⇒ 并发的第二次唤醒不会把同一轮跑两遍', async () => {
    // 从同步动作【内部】观察 storage：那时「下次时间」必须已经是未来，
    // 否则这个窗口里进来的第二次唤醒（后台顶层与 onStartup 可能同时到）会再跑一遍。
    const seen = [];
    loadBackground({
      withBookmarks: true,
      initialStorage: Object.assign({}, CONFIGURED, { auto_sync_next_at: Date.now() - 1000 }),
      patch: (sandbox) => {
        sandbox.MiniSync.actions.mergeSync = () => {
          seen.push(sandbox.chrome.storage.local._data.auto_sync_next_at);
          return Promise.resolve({ success: true, message: '补跑成功', stats: { added: 0, removed: 0 } });
        };
      }
    });
    await flush();
    expect(seen.length).toBe(1);
    expect(seen[0]).toBeGreaterThan(Date.now());
  });

  test('补跑跑完 ⇒ 定时器仍然挂上（补跑不能把定时器挤掉）', async () => {
    const calls = [];
    const bg = loadBackground({
      withBookmarks: true,
      initialStorage: Object.assign({}, CONFIGURED, { auto_sync_next_at: Date.now() - 1000 }),
      patch: makeStub(calls)
    });
    await flush();
    expect(calls.length).toBe(1);
    expect(bg.alarms.has(ALARM)).toBe(true);
  });
});

// 自动同步的「自撞」：浏览器启动时【顶层启动段】与 onStartup 会同时补跑。
// 用户手机上看到的第 2 个症状就是它：日志里那句「自动同步未完成: 同步进行中，请稍候」
// 让人以为同步失败了，其实同步跑成了，只是被自己的第二趟撞上了同步锁（自旋 8 秒后放弃）。
describe('自动同步：启动时两条补跑路径不许自撞', () => {
  const ALARM = 'webdav_bookmark_auto_sync';
  const CONFIGURED = { sync_enabled: true, webdav_url: 'https://dav.example/dav/', sync_interval: 30 };
  const flush = (ms) => new Promise((r) => realSetTimeout(r, ms || 5));

  test('★ 顶层启动段与 onStartup 同时到 ⇒ 只跑一轮同步（第二趟搭车，不抢锁、不报「进行中」）', async () => {
    let calls = 0;
    const bg = loadBackground({
      withBookmarks: true,
      initialStorage: Object.assign({}, CONFIGURED, { auto_sync_next_at: Date.now() - 1000 }),
      patch: (sandbox) => {
        sandbox.MiniSync.actions.mergeSync = () => {
          calls++;
          // 慢一点：保证第二趟进来时第一趟一定还在途（真实手机上一轮同步是分钟级）
          return new Promise((res) => realSetTimeout(
            () => res({ success: true, message: '补跑成功', stats: { added: 0, removed: 0 } }), 40));
        };
      }
    });
    await flush(10);                                   // 顶层那趟已经进到同步里
    expect(calls).toBe(1);
    const startup = bg.alarmEvents.onStartup[0]();     // 同一时刻的 onStartup 补跑
    await startup;
    await flush(60);
    expect(calls).toBe(1);                             // 只跑了一轮
    expect(bg.consoleErrors.join(' | ')).not.toContain('自动同步未完成');
  });

  // 上面那条先 await 了一拍，那时「把下次时间推到未来」那道写入已经落地，第二趟
  // 自然读到未来时间 —— 挡不住并发也照样绿（真实手机上的时序恰恰相反：两个调用方
  // 都在写入落地之前读到了同一份旧台账，于是各判一次、各调一轮）。这条按真时序
  // 同 tick 触发，把「同一轮错过只许判一次」钉死。
  test('★ 两趟补跑在同一 tick 读到同一份旧台账 ⇒ 仍只判一次、只报一次台账', async () => {
    let calls = 0;
    const bg = loadBackground({
      withBookmarks: true,
      initialStorage: Object.assign({}, CONFIGURED, { auto_sync_next_at: Date.now() - 1000 }),
      patch: (sandbox) => {
        sandbox.MiniSync.actions.mergeSync = () => {
          calls++;
          return new Promise((res) => realSetTimeout(
            () => res({ success: true, message: '补跑成功', stats: { added: 0, removed: 0 } }), 40));
        };
      }
    });
    // 加载段那趟补跑已在途（它的读取与下面两次发生在同一个 tick，都拿到旧台账）
    const p1 = bg.alarmEvents.onStartup[0]();
    const p2 = bg.alarmEvents.onStartup[0]();
    await Promise.all([p1, p2]);
    await flush(60);
    const rep = bg.storage._data.auto_sync_report;
    expect(rep.alarm.catchUpCount).toBe(1);            // 同一轮错过只认一次
    expect(rep.alarm.lastCatchUp.reason).toBe('到点补跑');
    expect(calls).toBe(1);
  });

  test('定时器到点正好撞上补跑 ⇒ 也合流成一轮（alarm 与补跑共用一个在途）', async () => {
    let calls = 0;
    const bg = loadBackground({
      withBookmarks: true,
      initialStorage: Object.assign({}, CONFIGURED, { auto_sync_next_at: Date.now() - 1000 }),
      patch: (sandbox) => {
        sandbox.MiniSync.actions.mergeSync = () => {
          calls++;
          return new Promise((res) => realSetTimeout(
            () => res({ success: true, message: '补跑成功', stats: { added: 0, removed: 0 } }), 40));
        };
      }
    });
    await flush(10);
    expect(calls).toBe(1);
    await bg.alarmEvents.onAlarm[0]({ name: ALARM });   // 到点通知同时进来
    await flush(60);
    expect(calls).toBe(1);
  });

  test('真被并发挡住（SYNC_BUSY）⇒ 不当失败告警（它是正常并发，不是坏消息）', async () => {
    const bg = loadBackground({
      withBookmarks: true,
      initialStorage: Object.assign({}, CONFIGURED, { auto_sync_next_at: Date.now() - 1000 }),
      patch: (sandbox) => {
        sandbox.MiniSync.actions.mergeSync = () => Promise.resolve(
          { success: false, code: 'SYNC_BUSY', message: '同步进行中，请稍候' });
      }
    });
    await flush(10);
    expect(bg.consoleErrors.join(' | ')).not.toContain('自动同步未完成');
  });

  test('真失败（云端不可达等）⇒ 照旧告警（不许被上面那条顺手静音掉）', async () => {
    const bg = loadBackground({
      withBookmarks: true,
      initialStorage: Object.assign({}, CONFIGURED, { auto_sync_next_at: Date.now() - 1000 }),
      patch: (sandbox) => {
        sandbox.MiniSync.actions.mergeSync = () => Promise.resolve(
          { success: false, code: 'WEBDAV_ERROR', message: '云端不可达' });
      }
    });
    await flush(10);
    const logs = bg.consoleErrors.join(' | ');
    expect(logs).toContain('自动同步未完成');
    expect(logs).toContain('云端不可达');
  });
});

// 手机端实测（2026-10-05 用户日志）暴露的最后一个形态：宿主给了 alarms 对象、
// 但调用会抛错，而且消息通道是半死的（ping/diagnose 全「返回空」）。此时
//   · 校准定时器失败若把【补跑】一起带走 ⇒ 这台机器上自动同步彻底没有了；
//   · 页面侧又读不到任何东西 ⇒ 用户只看到「装了新版还是不自动同步」，无从下手。
// 本组同时钉住「修好的行为」与「看得见的证据」两件事。
describe('自动同步：宿主给的是「一调就抛」的 alarms + 消息通道半死', () => {
  const ALARM = 'webdav_bookmark_auto_sync';
  const CONFIGURED = { sync_enabled: true, webdav_url: 'https://dav.example/dav/', sync_interval: 30 };
  const flush = () => new Promise((r) => realSetTimeout(r, 5));
  const makeStub = (calls) => (sandbox) => {
    sandbox.MiniSync.actions.mergeSync = (o) => {
      calls.push(o);
      return Promise.resolve({ success: true, message: '补跑成功', stats: { added: 0, removed: 0 } });
    };
  };

  test('create 抛错 ⇒ 后台照旧加载完、消息处理器照旧注册（不许整段死掉）', () => {
    const bg = loadBackground({
      withBookmarks: true, alarmsCreateThrows: true,
      initialStorage: Object.assign({}, CONFIGURED, { auto_sync_next_at: Date.now() - 1000 })
    });
    expect(bg.loadError).toBeNull();
    expect(bg.listeners.length).toBe(1);
  });

  test('★ create 抛错不得把补跑一起带走（补跑是这类宿主上唯一的自动同步路径）', async () => {
    const calls = [];
    const bg = loadBackground({
      withBookmarks: true, alarmsCreateThrows: true,
      initialStorage: Object.assign({}, CONFIGURED, { auto_sync_next_at: Date.now() - 1000 }),
      patch: makeStub(calls)
    });
    await flush();
    expect(calls.length).toBe(1);                  // 定时器没建成，但这一轮照跑了
    expect(bg.storage._data.auto_sync_next_at).toBeGreaterThan(Date.now());
  });

  test('★ 校准段自己抛错（storage 抖动）也不得把补跑一起带走，台账照样落盘', async () => {
    // 与上一条不同的失败入口：这次不是 alarms 抛错，而是校准最开头那次配置读取 reject
    // （storage 抖动、权限被回收都会这样）。校准与补跑是【两个独立的失败域】——
    // 校准段自己炸了，补跑与台账都必须照跑，否则这台机器上自动同步就彻底没有了。
    const calls = [];
    const bg = loadBackground({
      withBookmarks: true,
      initialStorage: Object.assign({}, CONFIGURED, { auto_sync_next_at: Date.now() - 1000 }),
      patch: (sandbox) => {
        const orig = sandbox.MiniSync.storage.getLocal;
        let injected = false;
        sandbox.MiniSync.storage.getLocal = function (keys) {
          const list = Array.isArray(keys) ? keys : [];
          // 只打校准那一次读取（3 个键、含 sync_interval）——
          // 补跑与台账的读取（5 个键）不许受影响，否则测的就不是失败域隔离了。
          if (!injected && list.length === 3 && list.indexOf('sync_interval') >= 0 && list.indexOf('auto_sync_next_at') < 0) {
            injected = true;
            return Promise.reject(new Error('storage 抖动'));
          }
          return orig.apply(this, arguments);
        };
        sandbox.MiniSync.actions.mergeSync = (o) => {
          calls.push(o);
          return Promise.resolve({ success: true, message: '补跑成功', stats: { added: 0, removed: 0 } });
        };
      }
    });
    await flush();
    expect(calls.length).toBe(1);                    // 补跑照跑
    const rep = bg.storage._data.auto_sync_report;
    expect(rep).toBeTruthy();                        // 台账照落盘
    expect(rep.alarm.catchUpCount).toBe(1);
    expect(rep.alarm.lastError).toContain('ensure:'); // 校准那次失败如实记下
    expect(rep.alarm.lastError).toContain('storage 抖动');
  });

  test('落盘的自动同步台账如实记下「校准失败了，但补跑跑了」', async () => {
    const calls = [];
    const bg = loadBackground({
      withBookmarks: true, alarmsCreateThrows: true,
      initialStorage: Object.assign({}, CONFIGURED, { auto_sync_next_at: Date.now() - 1000 }),
      patch: makeStub(calls)
    });
    await flush();
    const rep = bg.storage._data.auto_sync_report;
    expect(rep).toBeTruthy();
    expect(rep.alarm.action).toBe('error');
    expect(rep.alarm.lastError).toContain('宿主拒绝创建定时器');
    expect(rep.alarm.catchUpCount).toBe(1);
    expect(rep.alarm.lastCatchUp.reason).toBe('到点补跑');
  });

  test('缺 chrome.alarms.clear 的宿主 ⇒ 照样把定时器建起来（不许整个判死）', async () => {
    const bg = loadBackground({
      withBookmarks: true, noAlarmsClear: true,
      initialStorage: Object.assign({}, CONFIGURED),
      initialAlarms: { [ALARM]: { periodInMinutes: 30 } }
    });
    await flush();
    // 间隔一致 ⇒ 走 kept，一个 clear 都不该需要
    expect(bg.storage._data.auto_sync_report.alarm.action).toBe('kept');
    expect(bg.storage._data.auto_sync_report.alarm.apiAvailable).toBe(true);
  });

  test('缺 clear 且间隔不符 ⇒ 退化成「直接覆盖重建」，仍然建得起来', async () => {
    const bg = loadBackground({
      withBookmarks: true, noAlarmsClear: true,
      initialStorage: Object.assign({}, CONFIGURED, { sync_interval: 60 }),
      initialAlarms: { [ALARM]: { periodInMinutes: 30 } }
    });
    await flush();
    expect(bg.alarmCreates[bg.alarmCreates.length - 1][1].periodInMinutes).toBe(60);
    expect(bg.storage._data.auto_sync_report.alarm.action).toBe('recreated');
  });

  test('启动就落盘一份台账（消息通道不通时，这是页面唯一看得见的证据）', async () => {
    const bg = loadBackground({ withBookmarks: true, initialStorage: CONFIGURED });
    await flush();
    const rep = bg.storage._data.auto_sync_report;
    expect(rep).toBeTruthy();
    expect(rep.syncEnabled).toBe(true);
    expect(rep.hasUrl).toBe(true);
    expect(rep.interval).toBe(30);
    expect(rep.alarm.exists).toBe(true);
    expect(rep.at).toBeGreaterThan(Date.now() - 60000);
  });

  test('未配置时也落盘（页面能一眼看出「是配置没开」而不是「坏掉了」）', async () => {
    const bg = loadBackground({ withBookmarks: true });
    await flush();
    expect(bg.storage._data.auto_sync_report).toMatchObject({ syncEnabled: false, hasUrl: false });
  });

  test('alarm 真响过 ⇒ 次数与时刻落盘（「挂上了但从没响」和「根本没挂」必须分得开）', async () => {
    const calls = [];
    const bg = loadBackground({
      withBookmarks: true, initialStorage: CONFIGURED, patch: makeStub(calls)
    });
    await flush();
    expect(bg.storage._data.auto_sync_report.alarm.fireCount).toBe(0);
    expect(bg.alarmEvents.onAlarm.length).toBe(1);
    await bg.alarmEvents.onAlarm[0]({ name: ALARM });
    expect(calls.length).toBe(1);
    const rep = bg.storage._data.auto_sync_report.alarm;
    expect(rep.fireCount).toBe(1);
    expect(rep.lastFireAt).toBeGreaterThan(0);
  });

  test('别的定时器响了不记账、也不跑同步（名字必须认准）', async () => {
    const calls = [];
    const bg = loadBackground({
      withBookmarks: true, initialStorage: CONFIGURED, patch: makeStub(calls)
    });
    await flush();
    await bg.alarmEvents.onAlarm[0]({ name: 'some_other_alarm' });
    expect(calls.length).toBe(0);
    expect(bg.storage._data.auto_sync_report.alarm.fireCount).toBe(0);
  });

  test('补跑「没跑」的理由必须落盘（未开启 / 没台账 / 还没到点 三选一）', async () => {
    const off = loadBackground({
      withBookmarks: true, initialStorage: Object.assign({}, CONFIGURED, { sync_enabled: false })
    });
    await flush();
    expect(off.storage._data.auto_sync_report.alarm.lastCatchUp.reason).toBe('未开启或未配置');

    const noLedger = loadBackground({ withBookmarks: true, initialStorage: CONFIGURED });
    await flush();
    expect(noLedger.storage._data.auto_sync_report.alarm.lastCatchUp.reason).toBe('没有可推算的台账');

    const notYet = loadBackground({
      withBookmarks: true,
      initialStorage: Object.assign({}, CONFIGURED, { auto_sync_next_at: Date.now() + 600000 })
    });
    await flush();
    expect(notYet.storage._data.auto_sync_report.alarm.lastCatchUp.reason).toBe('还没到点');
  });

  test('诊断消息报出 alarms 的方法面（手机 fork 会「对象在、方法缺」）', async () => {
    const bg = loadBackground({ withBookmarks: true, initialStorage: CONFIGURED });
    await flush();
    const d = await sendMessageOnce(bg.listeners[0], { action: 'diagnose' });
    expect(d.autoAlarm.alarmsSurface).toEqual({
      create: true, clear: true, get: true, getAll: false, onAlarm: true
    });
    expect(d.autoAlarm.syncEnabled).toBe(true);
    expect(d.autoAlarm.hasUrl).toBe(true);
  });

  test('后台自述自查（页面用直接句柄读）也带上自动同步这一节', async () => {
    const bg = loadBackground({ withBookmarks: true, alarmsCreateThrows: true, initialStorage: CONFIGURED });
    await flush();
    const self = bg.sandbox.__MiniSyncSelfCheck();
    expect(self.autoSync.hasAlarmsApi).toBe(true);
    expect(self.autoSync.alarmsSurface.create).toBe(true);
    expect(self.autoSync.state.action).toBe('error');
    expect(self.autoSync.state.lastError).toContain('宿主拒绝创建定时器');
  });
});
