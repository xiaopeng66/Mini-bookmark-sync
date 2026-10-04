// permission-gate.test.js — host 权限守门回归测试
//
// 背景（真实缺陷）：requestHostPermission 原先既不读 chrome.runtime.lastError 也没有超时，
// 并且被 ensurePermission 直接调用 —— 而 ensurePermission 运行在 service worker 里，
// chrome.permissions.request() 却需要用户手势（Chromium 源码 permissions_api.cc 的
// kUserGestureRequiredError："This function must be called during a user gesture"；
// 而 runtime.onMessage 派发消息不携带 gesture，message_service.cc 无对应参数）。
// 于是每次打开设置页/弹窗触发的 checkConfig 都在 worker 里发起一次注定失败的申请，
// 表现为「一直在请求 WebDAV 域名访问权限、一直成功不了」，且真实原因被谎报成“用户拒绝”。
//
// 本文件钉住四条不变量：
//   1. worker 侧守门只查询、绝不发起申请（申请必须由扩展页面的用户手势发起）；
//   2. 申请失败时吐出真实原因，回调不触发时超时返回而不是永久挂起；
//   3. 权限接口本身不可用时，守门【降级放行】而不是阻断同步 —— Gecko 系宿主
//      （可拓/雨见这类用 Gecko 扩展引擎的移动浏览器）没有运行时权限弹窗 UI，
//      permissions.* 的回调永不触发，旧写法会让这些宿主永远同步不了；
//   4. requestHostPermission 在调用 permissions.request 之前【不得 await 任何东西】——
//      Gecko 判定的是 isHandlingUserInput，它只在事件处理器同步执行期间为真。

const { loadSource } = require('./load-source');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

loadSource();
vm.runInThisContext(
  fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'sync-actions.js'), 'utf8'),
  { filename: 'lib/sync-actions.js' }
);

const U = global.MiniSync.utils;
const A = global.MiniSync.actions;

const DAV_URL = 'https://dav.jianguoyun.com/dav/';
const DAV_ORIGIN = 'https://dav.jianguoyun.com/*';

// ---- chrome.permissions mock：可编程 + 记录调用次数 ----
let containsCalls = 0;
let requestCalls = 0;
let containsImpl = (opts, cb) => cb(false);
let requestImpl = () => { throw new Error('request 不该被调用'); };

global.chrome = global.chrome || {};
global.chrome.runtime = { lastError: null };
global.chrome.permissions = {
  contains: (opts, cb) => { containsCalls++; containsImpl(opts, cb); },
  request: (opts, cb) => { requestCalls++; requestImpl(opts, cb); },
};

// 真实 Chrome 的 lastError 只在回调执行期间可见
function invokeWithError(cb) {
  global.chrome.runtime.lastError = { message: 'This function must be called during a user gesture' };
  cb(undefined);
  global.chrome.runtime.lastError = null;
}

beforeEach(() => {
  containsCalls = 0;
  requestCalls = 0;
  global.chrome.runtime.lastError = null;
  containsImpl = (opts, cb) => cb(false);
  requestImpl = () => { throw new Error('request 不该被调用'); };
});

describe('worker 侧权限守门 ensurePermission', () => {
  test('未授权时只查询、绝不发起申请（worker 里申请必然失败）', async () => {
    containsImpl = (opts, cb) => cb(false);
    const r = await A.ensurePermission(DAV_URL);
    expect(requestCalls).toBe(0); // ★ 核心不变量：worker 侧绝不发起申请
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NEED_PERMISSION');
    expect(r.error).toContain('dav.jianguoyun.com');
    expect(containsCalls).toBe(1);
  });

  test('已授权时直接放行，同样不发起申请', async () => {
    containsImpl = (opts, cb) => cb(true);
    const r = await A.ensurePermission(DAV_URL);
    expect(r.ok).toBe(true);
    expect(requestCalls).toBe(0);
  });

  test('地址非法时给出明确错误而不是抛异常，也不去查询', async () => {
    const r = await A.ensurePermission('not-a-url');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('PERMISSION_CHECK_FAILED');
    expect(r.error).toContain('无法解析');
    expect(containsCalls).toBe(0);
  });

  test('未配置地址时返回 NO_URL', async () => {
    const r = await A.ensurePermission('');
    expect(r).toEqual({ ok: false, code: 'NO_URL', error: '未配置 WebDAV 地址' });
  });

  // ---- 降级放行：权限接口本身不可用的宿主 ----
  // 真实场景：可拓/雨见等 Gecko 系移动浏览器上没有运行时权限弹窗 UI，
  // chrome.permissions.contains 的回调永不触发（等满 15s 超时）；若据此判「没权限」，
  // 这些宿主就永远同步不了 —— 而它们其实是靠【安装清单里的 host 权限】放行请求的。
  test('权限接口抛错时降级放行（不再阻断同步）', async () => {
    containsImpl = () => { throw new Error('chrome.permissions is undefined'); };
    const r = await A.ensurePermission(DAV_URL);
    expect(r.ok).toBe(true);
    expect(r.degraded).toBe(true);
    expect(r.warning).toContain('chrome.permissions is undefined');
  });

  test('权限接口永不响应（宿主无授权弹窗）时也降级放行', async () => {
    vi.useFakeTimers();
    try {
      containsImpl = () => { /* 永不回调 */ };
      const pending = A.ensurePermission(DAV_URL);
      await vi.advanceTimersByTimeAsync(16000);
      const r = await pending;
      expect(r.ok).toBe(true);
      expect(r.degraded).toBe(true);
      expect(r.warning).toContain('超时');
    } finally {
      vi.useRealTimers();
    }
  });

  test('降级放行不等于无条件放行：接口可用且明确「未授权」时仍然拦下', async () => {
    containsImpl = (opts, cb) => cb(false);
    const r = await A.ensurePermission(DAV_URL);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NEED_PERMISSION');
  });
});

describe('扩展页面侧权限申请 requestHostPermission', () => {
  // ★ 核心不变量（Gecko 系宿主）：request 必须落在用户点击处理器的【同一个同步帧】里。
  //   Gecko 判的是 windowUtils.isHandlingUserInput，只在处理器同步执行期间为真；
  //   旧实现先 `await hasHostPermission()` 再 request，回到处理器时手势窗口已关闭，
  //   直接报 "permissions.request may only be called from a user input handler"。
  //   这里把 contains 设成永不回调：旧实现连 request 都走不到（表现为永久卡在授权中）。
  test('request 必须在同步帧内发起：不 await、不预查 contains', async () => {
    containsImpl = () => { /* 永不回调：一旦被 await，request 就永远发不出去 */ };
    requestImpl = (opts, cb) => cb(true);
    const p = U.requestHostPermission(DAV_URL);
    // 注意：此处不 await —— 直接看同步执行的即时结果
    expect(requestCalls).toBe(1);
    expect(containsCalls).toBe(0);
    await expect(p).resolves.toBe(true);
  });

  test('已授权过时 request 会立即 resolve true（不需要先查询做短路）', async () => {
    // Chromium 语义：已授予的 origin 再次 request 不弹窗、直接 resolve true
    requestImpl = (opts, cb) => cb(true);
    await expect(U.requestHostPermission(DAV_URL)).resolves.toBe(true);
    expect(requestCalls).toBe(1);
  });

  test('用户同意后返回 true', async () => {
    requestImpl = (opts, cb) => cb(true);
    await expect(U.requestHostPermission(DAV_URL)).resolves.toBe(true);
    expect(requestCalls).toBe(1);
  });

  test('申请失败时抛出真实原因（不再谎报“用户拒绝了授权”）', async () => {
    requestImpl = (opts, cb) => invokeWithError(cb);
    await expect(U.requestHostPermission(DAV_URL))
      .rejects.toThrow('This function must be called during a user gesture');
  });

  test('用户拒绝时抛出可读原因并带域名', async () => {
    requestImpl = (opts, cb) => cb(false);
    await expect(U.requestHostPermission(DAV_URL)).rejects.toThrow(/未授权访问 https:\/\/dav\.jianguoyun\.com/);
  });

  test('回调永不触发时超时返回，不能永久挂起', async () => {
    vi.useFakeTimers();
    try {
      requestImpl = () => { /* 故意不回调：模拟权限提示未展示/未结算 */ };
      const pending = U.requestHostPermission(DAV_URL);
      vi.advanceTimersByTime(16000);
      await expect(pending).rejects.toThrow(/超时/);
    } finally {
      vi.useRealTimers();
    }
  });

  test('hasHostPermission 分别报告已授权/未授权，并给出 origin 模式', async () => {
    containsImpl = (opts, cb) => cb(true);
    await expect(U.hasHostPermission(DAV_URL))
      .resolves.toMatchObject({ ok: true, granted: true, origin: DAV_ORIGIN });
    containsImpl = (opts, cb) => cb(false);
    await expect(U.hasHostPermission(DAV_URL))
      .resolves.toMatchObject({ ok: true, granted: false, origin: DAV_ORIGIN });
  });
});
