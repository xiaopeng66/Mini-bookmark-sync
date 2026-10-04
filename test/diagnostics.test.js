// diagnostics.test.js — 「后台响应说人话」+ 一键诊断
//
// 背景（真实缺陷，手机端 Gecko 宿主上暴露）：
//   设置页显示「本地书签数 --（后台未响应）」、弹窗显示「连接失败（SW 未就绪，请重试）」，
//   两句话都指向「后台没运行」，但后台其实在跑 —— 后台已经回过
//   {success:false, message:'<真因>'}（例如书签接口读失败），是页面把原文丢掉了。
//   移动端宿主千奇百怪，一旦把真因藏起来，排查方向就会一路错到底。
//
// 本文件钉住三条不变量：
//   1. 后台给的原文必须显示出来（有 message/error 就绝不显示成「未响应」）；
//   2. 「后台没响应」与「后台报错」必须是两句话；
//   3. collectDiagnostics 逐项带原始报错，且 getTree 回调不触发时按超时定性。

const { loadSource } = require('./load-source');

loadSource();
const U = global.MiniSync.utils;

function makeChrome({ bookmarks, sendMessage, store, getBackgroundPage } = {}) {
  const storage = Object.assign({}, store);
  global.chrome = {
    runtime: {
      id: 'test-ext-id',
      lastError: null,
      getManifest: () => ({
        manifest_version: 2, version: '2.1.0',
        permissions: ['bookmarks', 'storage', 'alarms']
      }),
      sendMessage: sendMessage || (() => Promise.resolve({ ok: true })),
      getBackgroundPage
    },
    bookmarks,
    permissions: undefined,
    storage: {
      local: {
        get: (keys, cb) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (k in storage) out[k] = storage[k];
          cb(out);
        },
        set: (o, cb) => { Object.assign(storage, o); cb && cb(); }
      }
    },
    alarms: undefined,
    action: undefined,
    browserAction: undefined
  };
  return global.chrome;
}

afterEach(() => {
  vi.useRealTimers();
  delete global.chrome;
  // 传输状态是模块级的（preferDirect / 耗时留痕），不 reset 会污染后面的用例
  if (U.resetTransportState) U.resetTransportState();
});

describe('describeBookmarkCount：把后台响应翻译成一行结论', () => {
  test('后台报了真因 → 显示原文，绝不显示成「未响应」', () => {
    const r = U.describeBookmarkCount({ ok: false, code: 'BOOKMARKS_API_FAILED', message: 'bookmarks.getTree 报错：x' });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('bookmarks.getTree 报错：x');
    expect(r.text).not.toContain('未响应');
  });

  test('宿主不给书签 API → 明确说「不可用」', () => {
    const r = U.describeBookmarkCount({ ok: false, code: 'NO_BOOKMARKS_API', message: '...' });
    expect(r.text).toBe('不可用（该浏览器未开放书签 API）');
  });

  test('有数量 → N 条', () => {
    expect(U.describeBookmarkCount({ ok: true, count: 0 })).toEqual({ ok: true, text: '0 条' });
    expect(U.describeBookmarkCount({ ok: true, count: 12 }).text).toBe('12 条');
  });

  test('确实没有响应（undefined）→ 才说「无响应」，且与「报错」措辞不同', () => {
    const none = U.describeBookmarkCount(undefined);
    const err = U.describeBookmarkCount({ message: 'boom' });
    expect(none.text).toContain('无响应');
    expect(err.text).toContain('后台报错：boom');
    expect(none.text).not.toBe(err.text);
  });

  test('调用方的 noResponse 哨兵 → 说「无响应」，不能把自己的内部值当成后台的回应', () => {
    const r = U.describeBookmarkCount({ noResponse: true });
    expect(r.text).toContain('后台无响应');
    expect(r.text).not.toContain('无法识别的响应');
    expect(r.text).not.toContain('noResponse');
  });

  test('回 ok 但没带数量 → 说「响应残缺」，也是真因而非含糊话', () => {
    const r = U.describeBookmarkCount({ ok: true });
    expect(r.text).toContain('响应残缺');
  });

  test('响应形状不认识 → 把原始内容带出来', () => {
    const r = U.describeBookmarkCount({ weird: 1 });
    expect(r.text).toContain('无法识别的响应');
    expect(r.text).toContain('weird');
  });
});

describe('describeMessageFailure：连接/同步失败的真因', () => {
  test('有 message/error 就显示原文', () => {
    expect(U.describeMessageFailure({ success: false, message: 'PROPFIND 404' })).toBe('PROPFIND 404');
    expect(U.describeMessageFailure({ error: '鉴权失败' })).toBe('鉴权失败');
  });

  test('没有响应才说「后台无响应」，并解释含义', () => {
    const t = U.describeMessageFailure(undefined);
    expect(t).toContain('后台无响应');
    expect(t).toContain('后台未运行');
  });

  test('形状不认识 → 带出原始内容而不是含糊其辞', () => {
    expect(U.describeMessageFailure({ success: false })).toContain('无法识别的响应');
  });
});

describe('collectDiagnostics：逐项探测并保留原始报错', () => {
  test('书签接口可读 → 报告实际条数（含嵌套）', async () => {
    makeChrome({
      bookmarks: {
        getTree: (cb) => cb([{ id: '0', children: [
          { id: '1', url: 'https://a/' },
          { id: '2', children: [{ id: '3', url: 'https://b/' }] }
        ] }])
      },
      sendMessage: (msg) => Promise.resolve(msg.action === 'ping' ? { ok: true, version: '2.1.0' } : { ok: true })
    });
    const rep = await U.collectDiagnostics({ messageTimeoutMs: 100 });
    expect(rep.bookmarksProbe).toMatchObject({ ok: true, count: 2 });
    expect(rep.background.ok).toBe(true);
    expect(rep.extensionVersion).toBe('2.1.0');
    expect(rep.apis.bookmarks).toBe('object');
  });

  test('宿主没有书签 API → 明确写清「本页没有 chrome.bookmarks.getTree」', async () => {
    makeChrome({ bookmarks: undefined });
    const rep = await U.collectDiagnostics({ messageTimeoutMs: 100 });
    expect(rep.bookmarksProbe.ok).toBe(false);
    expect(rep.bookmarksProbe.reason).toContain('本页没有 chrome.bookmarks.getTree');
  });

  test('getTree 是函数但回调永不触发 → 按超时定性（这是移动端 fork 的真实形态之一）', async () => {
    vi.useFakeTimers();
    makeChrome({ bookmarks: { getTree: () => { /* 永不回调 */ } } });
    const p = U.collectDiagnostics({ bookmarksTimeoutMs: 4000, messageTimeoutMs: 1000 });
    // 两个探针都要 getTree（① 条数、⑦ 书签树），各自按同一个 bookmarksTimeoutMs 超时 ⇒ 推进两轮
    await vi.advanceTimersByTimeAsync(4100);
    await vi.advanceTimersByTimeAsync(4100);
    const rep = await p;
    expect(rep.bookmarksProbe.ok).toBe(false);
    expect(rep.bookmarksProbe.reason).toContain('回调 4000ms 内没回来');
    expect(rep.bookmarkTreeProbe.ok).toBe(false);
    expect(rep.bookmarkTreeProbe.reason).toContain('4000ms 内没回来');
  });

  test('getTree 抛异常 / 回非数组 → 都带原始文本', async () => {
    makeChrome({ bookmarks: { getTree: () => { throw new Error('Not implemented'); } } });
    let rep = await U.collectDiagnostics({ messageTimeoutMs: 100 });
    expect(rep.bookmarksProbe.reason).toContain('Not implemented');

    makeChrome({ bookmarks: { getTree: (cb) => cb({ notAnArray: true }) } });
    rep = await U.collectDiagnostics({ messageTimeoutMs: 100 });
    expect(rep.bookmarksProbe.reason).toContain('不是数组');
  });

  test('后台不回 ping → 报告写「无响应」而不是编一个成功', async () => {
    vi.useFakeTimers();
    makeChrome({
      bookmarks: { getTree: (cb) => cb([]) },
      sendMessage: () => new Promise(() => {}) // 永不 resolve
    });
    const p = U.collectDiagnostics({ messageTimeoutMs: 3000, bookmarksTimeoutMs: 1000 });
    // 一次性推得足够远：ping 与 diagnose 两段超时是【前后依次】创建的，
    // 只推到第一段会在第二段上挂住（本测试第一版就是这个错）。
    await vi.advanceTimersByTimeAsync(20000);
    const rep = await p;
    expect(rep.background.ok).toBe(false);
    expect(rep.background.reason).toContain('无响应');
    expect(rep.backgroundSelfCheck.reason).toContain('无响应');
  });

  test('sendMessage 抛异常（接收端不存在）→ 原样带出', async () => {
    makeChrome({
      bookmarks: { getTree: (cb) => cb([]) },
      sendMessage: () => { throw new Error('Could not establish connection. Receiving end does not exist.'); }
    });
    const rep = await U.collectDiagnostics({ messageTimeoutMs: 100 });
    expect(rep.background.ok).toBe(false);
    expect(rep.background.reason).toContain('Receiving end does not exist');
  });

  // 手机端实测：消息通道通了、但响应值是空的（宿主没把响应传回来）。
  // 这时报告必须把「消息没被应答」这件事留下来 —— 尤其不能被 JSON.stringify 整键丢掉。
  test('响应为空 → 定性为「消息没被应答」，且 diagnose 的空响应也要在报告里留下一项', async () => {
    makeChrome({
      bookmarks: { getTree: (cb) => cb([]) },
      sendMessage: () => Promise.resolve(undefined)
    });
    const rep = await U.collectDiagnostics({ messageTimeoutMs: 100 });
    expect(rep.background.ok).toBe(false);
    expect(rep.background.reason).toContain('消息没被应答');
    expect(rep.backgroundSelfCheck).toBeDefined();
    expect(rep.backgroundSelfCheck.ok).toBe(false);
    expect(rep.backgroundSelfCheck.reason).toContain('返回空');
    expect(JSON.parse(JSON.stringify(rep)).backgroundSelfCheck).toBeDefined();
  });

  test('对照探针：只有 pingLegacy 没响应 → 定性为「return false 丢响应」', async () => {
    makeChrome({
      bookmarks: { getTree: (cb) => cb([]) },
      sendMessage: (msg) => {
        if (msg.action === 'pingLegacy') return Promise.resolve(undefined);
        if (msg.action === 'ping') return Promise.resolve({ ok: true, transport: 'ping' });
        return Promise.resolve({ ok: true });
      }
    });
    const rep = await U.collectDiagnostics({ messageTimeoutMs: 100 });
    expect(rep.background.ok).toBe(true);
    expect(rep.backgroundLegacyPing.ok).toBe(false);
    expect(rep.backgroundLegacyPing.reason).toContain('return false');
  });

  test('getBackgroundPage 拿到后台 window → 直接读状态，完全绕开消息通道', async () => {
    makeChrome({
      bookmarks: { getTree: (cb) => cb([]) },
      sendMessage: () => Promise.resolve(undefined), // 消息通道坏掉也能诊断
      getBackgroundPage: (cb) => cb({
        location: { href: 'moz-extension://x/background.html' },
        MiniSync: { utils: {}, storage: {} },
        _bgErrors: [{ kind: 'error', message: 'boom' }],
        __MiniSyncSelfCheck: () => ({ ok: true, bootStage: 'ready', moduleNames: ['utils', 'storage'] })
      })
    });
    const rep = await U.collectDiagnostics({ messageTimeoutMs: 100 });
    expect(rep.backgroundPage.ok).toBe(true);
    expect(rep.backgroundPage.hasMiniSync).toBe(true);
    expect(rep.backgroundPage.selfCheck.bootStage).toBe('ready');
    expect(rep.backgroundPage.bgErrors[0].message).toBe('boom');
  });

  test('getBackgroundPage 回空 → 明说后台页不存在（不是含糊的「未响应」）', async () => {
    makeChrome({
      bookmarks: { getTree: (cb) => cb([]) },
      sendMessage: () => Promise.resolve(undefined),
      getBackgroundPage: (cb) => cb(null)
    });
    const rep = await U.collectDiagnostics({ messageTimeoutMs: 100 });
    expect(rep.backgroundPage.ok).toBe(false);
    expect(rep.backgroundPage.reason).toContain('后台页不存在');
  });

  test('宿主没有 getBackgroundPage（MV3）→ 如实说本宿主取不到直接句柄', async () => {
    makeChrome({ bookmarks: { getTree: (cb) => cb([]) } });
    const rep = await U.collectDiagnostics({ messageTimeoutMs: 100 });
    expect(rep.backgroundPage.ok).toBe(false);
    expect(rep.backgroundPage.reason).toContain('没有 runtime.getBackgroundPage');
  });

  test('台账为空 → 直接断言「后台脚本从未执行过」（这是最强的一条定性）', async () => {
    makeChrome({ bookmarks: { getTree: (cb) => cb([]) }, sendMessage: () => Promise.resolve(undefined) });
    const rep = await U.collectDiagnostics({ messageTimeoutMs: 100 });
    expect(rep.backgroundLedger.ok).toBe(true);
    expect(rep.backgroundLedger.bootReport).toBeNull();
    expect(rep.backgroundLedger.note).toContain('从未执行过');
  });

  test('台账有登记 → 报告 stage / 加载次数 / 最近收到的消息', async () => {
    makeChrome({
      bookmarks: { getTree: (cb) => cb([]) },
      store: {
        bg_boot_report: { at: 1700000000000, stage: 'ready', loads: 2, version: '2.1.0' },
        bg_last_message: { type: 'ping', at: 1700000000001, total: 3 }
      }
    });
    const rep = await U.collectDiagnostics({ messageTimeoutMs: 100 });
    expect(rep.backgroundLedger.bootReport.stage).toBe('ready');
    expect(rep.backgroundLedger.note).toContain('第 2 次加载');
    expect(rep.backgroundLedger.lastMessage).toMatchObject({ type: 'ping', total: 3 });
  });
});

describe('第二条传输带：消息管道不走，就走直接句柄', () => {
  test('消息管道有响应 → 不碰兜底（桌面端行为不变）', async () => {
    let directCalls = 0;
    makeChrome({
      bookmarks: { getTree: (cb) => cb([]) },
      sendMessage: () => Promise.resolve({ ok: true, from: 'message' }),
      getBackgroundPage: (cb) => { directCalls++; cb(null); }
    });
    const r = await U.sendMessageToBackground({ action: 'ping' }, { timeoutMs: 200 });
    expect(r).toEqual({ ok: true, from: 'message' });
    expect(directCalls).toBe(0);
    expect(U.getTransportState().last).toBe('message');
  });

  test('消息管道回空响应 → 自动走直接句柄（手机端的关键兜底）', async () => {
    makeChrome({
      bookmarks: { getTree: (cb) => cb([]) },
      sendMessage: () => Promise.resolve(undefined),
      getBackgroundPage: (cb) => cb({
        __MiniSyncDispatchDirect: (m) => Promise.resolve({ ok: true, from: 'direct', got: m.action })
      })
    });
    const r = await U.sendMessageToBackground({ action: 'getLocalBookmarksCount' }, { timeoutMs: 200 });
    expect(r).toEqual({ ok: true, from: 'direct', got: 'getLocalBookmarksCount' });
    expect(U.getTransportState().last).toBe('direct-handle');
  });

  test('消息管道抛异常 → 兜底成功就以兜底为准', async () => {
    makeChrome({
      bookmarks: { getTree: (cb) => cb([]) },
      sendMessage: () => { throw new Error('Receiving end does not exist'); },
      getBackgroundPage: (cb) => cb({ __MiniSyncDispatchDirect: () => Promise.resolve({ ok: true, from: 'direct' }) })
    });
    const r = await U.sendMessageToBackground({ action: 'ping' }, { timeoutMs: 200 });
    expect(r).toMatchObject({ ok: true, from: 'direct' });
  });

  test('两条路都失败 → 抛回原始错误（桌面端语义逐字不变）', async () => {
    makeChrome({
      bookmarks: { getTree: (cb) => cb([]) },
      sendMessage: () => { throw new Error('Receiving end does not exist'); },
      getBackgroundPage: (cb) => cb(null)
    });
    await expect(U.sendMessageToBackground({ action: 'ping' }, { timeoutMs: 200 }))
      .rejects.toThrow('Receiving end does not exist');
  });

  test('两条路都没响应（空响应 + 没有后台页）→ 返回 undefined（UI 仍显示「后台无响应」）', async () => {
    makeChrome({
      bookmarks: { getTree: (cb) => cb([]) },
      sendMessage: () => Promise.resolve(undefined),
      getBackgroundPage: (cb) => cb(null)
    });
    await expect(U.sendMessageToBackground({ action: 'ping' }, { timeoutMs: 200 })).resolves.toBeUndefined();
  });

  test('installSendMessageFallback：promise 与 callback 两种调用点都自动获得兜底', async () => {
    makeChrome({
      bookmarks: { getTree: (cb) => cb([]) },
      sendMessage: () => Promise.resolve(undefined),
      getBackgroundPage: (cb) => cb({
        __MiniSyncDispatchDirect: (m) => Promise.resolve({ ok: true, from: 'direct', got: m.action })
      })
    });
    expect(U.installSendMessageFallback()).toBe('active');
    expect(typeof chrome.runtime.sendMessage.__minisyncOrig).toBe('function'); // 原函数留住（诊断要用）
    expect(await chrome.runtime.sendMessage({ action: 'ping' })).toMatchObject({ ok: true, from: 'direct' });
    const viaCallback = await new Promise((res) => { chrome.runtime.sendMessage({ action: 'getStatus' }, res); });
    expect(viaCallback).toMatchObject({ ok: true, from: 'direct', got: 'getStatus' });
    expect(U.installSendMessageFallback()).toBe('already-installed'); // 幂等
  });

  test('打过补丁后 helper 仍调原函数：不「自己兜自己」递归（实测会爆栈 RangeError）', async () => {
    let origCalls = 0;
    makeChrome({
      bookmarks: { getTree: (cb) => cb([]) },
      sendMessage: () => { origCalls++; return Promise.resolve({ ok: true, from: 'message' }); },
      getBackgroundPage: (cb) => cb(null)
    });
    U.installSendMessageFallback();
    const r = await U.sendMessageToBackground({ action: 'ping' }, { timeoutMs: 200 });
    expect(r).toMatchObject({ ok: true, from: 'message' });
    expect(origCalls).toBe(1); // 只调了一次原函数 ⇒ 没有递归
    expect(U.getTransportState().last).toBe('message');
  });

  // 手机端真缺陷（真机实测）：「连接状态」显示「后台无响应：消息没有回来」，
  // 而真相是——后台正在答，只是那次是真实 WebDAV 检测（>5s），被我自己的兜底超时掐断了。
  // 兜底（直接句柄）必须给足时间，绝不能与消息管道共用一个很小的超时。
  test('慢响应不能被当成「没响应」：直接句柄按 directTimeoutMs 给足时间', async () => {
    makeChrome({
      bookmarks: { getTree: (cb) => cb([]) },
      sendMessage: () => Promise.resolve(undefined), // 管道丢响应
      getBackgroundPage: (cb) => cb({
        __MiniSyncDispatchDirect: () => new Promise((r) => setTimeout(() => r({ ok: true, slow: true }), 150))
      })
    });
    const r = await U.sendMessageToBackground({ action: 'checkConfig' }, { timeoutMs: 50, directTimeoutMs: 600 });
    expect(r).toEqual({ ok: true, slow: true });
    expect(U.getTransportState()).toMatchObject({ last: 'direct-handle', lastError: null });
  });

  test('兜底确实超时 → 把原因留在传输状态里（不再只剩一句「后台无响应」）', async () => {
    makeChrome({
      bookmarks: { getTree: (cb) => cb([]) },
      sendMessage: () => Promise.resolve(undefined),
      getBackgroundPage: (cb) => cb({ __MiniSyncDispatchDirect: () => new Promise(() => {}) })
    });
    await expect(U.sendMessageToBackground({ action: 'ping' }, { timeoutMs: 50, directTimeoutMs: 120 }))
      .resolves.toBeUndefined();
    expect(U.getTransportState().last).toBe('none');
    expect(U.getTransportState().lastError).toContain('直接句柄 120ms 内没回');
  });

  test('诊断报告带「兜底传输带实测」与补丁状态（这一项直接回答手机能不能同步）', async () => {
    makeChrome({
      bookmarks: { getTree: (cb) => cb([]) },
      sendMessage: () => Promise.resolve(undefined), // 原始管道坏
      getBackgroundPage: (cb) => cb({ __MiniSyncDispatchDirect: () => Promise.resolve({ ok: true, from: 'direct' }) })
    });
    const rep = await U.collectDiagnostics({ messageTimeoutMs: 100 });
    expect(rep.background.ok).toBe(false);          // 原始管道如实报坏
    expect(rep.sendMessageFallback.ok).toBe(true);  // 兜底那条例通
    expect(rep.sendMessageFallback.response.from).toBe('direct');
    expect(rep.transport.last).toBe('direct-handle');
  });
});

// 手机端的核心浪费：消息送到了、后台也执行完了，只是响应被宿主丢掉 —— 页面白等一个 8 秒超时，
// 然后走直连把同一次同步【又执行一遍】。这里钉住三条：幂等标签、记住「管道不回话」、耗时留痕。
describe('传输带提速：幂等标签 / 记住坏管道 / 每条消息耗时留痕', () => {
  test('同一次调用的管道与直连两次投递带同一个 __msgId（后台靠它去重）', async () => {
    const seen = [];
    makeChrome({
      bookmarks: { getTree: (cb) => cb([]) },
      sendMessage: (m) => { seen.push(m.__msgId); return Promise.resolve(undefined); },
      getBackgroundPage: (cb) => cb({
        __MiniSyncDispatchDirect: (m) => { seen.push(m.__msgId); return Promise.resolve({ ok: true }); }
      })
    });
    await U.sendMessageToBackground({ action: 'upload' }, { timeoutMs: 50 });
    expect(seen.length).toBe(2);
    expect(seen[0]).toBeTruthy();
    expect(seen[0]).toBe(seen[1]); // 同一个 id ⇒ 后台知道这是同一条消息的第二次投递
  });

  test('★ 复用同一个消息对象连发两次 ⇒ 两次各自编号（否则第二次会被后台当重发回放，静默不执行）', async () => {
    const seen = [];
    makeChrome({
      bookmarks: { getTree: (cb) => cb([]) },
      sendMessage: (m) => { seen.push(m.__msgId); return Promise.resolve({ ok: true }); }
    });
    const msg = { action: 'upload' };            // 模块级常量那种用法
    await U.sendMessageToBackground(msg, { timeoutMs: 50 });
    await U.sendMessageToBackground(msg, { timeoutMs: 50 });
    expect(seen.length).toBe(2);
    expect(seen[0]).toBeTruthy();
    expect(seen[1]).toBeTruthy();
    expect(seen[0]).not.toBe(seen[1]);
  });

  test('管道丢响应而直连可用 → 记住结论，后续消息直接走直连（不再每条白等一个超时）', async () => {
    let pipelineCalls = 0;
    let directCalls = 0;
    makeChrome({
      bookmarks: { getTree: (cb) => cb([]) },
      sendMessage: () => { pipelineCalls++; return Promise.resolve(undefined); },
      getBackgroundPage: (cb) => { directCalls++; cb({ __MiniSyncDispatchDirect: () => Promise.resolve({ ok: true }) }); }
    });
    await U.sendMessageToBackground({ action: 'a' }, { timeoutMs: 50 });
    expect(U.getTransportState().preferDirect).toBe(true);

    await U.sendMessageToBackground({ action: 'b' }, { timeoutMs: 50 });
    expect(pipelineCalls).toBe(1); // 第二条根本没碰消息管道
    expect(directCalls).toBe(2);
    expect(U.getTransportState().last).toBe('direct-handle');
  });

  test('forceMessage=true 时不抄近路（仍按管道→兜底的原顺序走）', async () => {
    let pipelineCalls = 0;
    makeChrome({
      bookmarks: { getTree: (cb) => cb([]) },
      sendMessage: () => { pipelineCalls++; return Promise.resolve(undefined); }, // 管道坏
      getBackgroundPage: (cb) => cb({ __MiniSyncDispatchDirect: () => Promise.resolve({ ok: true, from: 'direct' }) })
    });
    // 先制造「管道已确认坏」的记忆
    await U.sendMessageToBackground({ action: 'a' }, { timeoutMs: 50 });
    expect(U.getTransportState().preferDirect).toBe(true);

    await U.sendMessageToBackground({ action: 'b' }, { timeoutMs: 50, forceMessage: true });
    expect(pipelineCalls).toBe(2); // 没有走「直连优先」的近路
  });

  test('每条消息都留痕：路径 + 耗时（诊断报告里能直接看到慢在哪一步）', async () => {
    makeChrome({ bookmarks: { getTree: (cb) => cb([]) }, sendMessage: () => Promise.resolve({ ok: true }) });
    await U.sendMessageToBackground({ action: 'ping' }, { timeoutMs: 50 });
    const st = U.getTransportState();
    expect(st.recent.length).toBe(1);
    expect(st.recent[0]).toMatchObject({ action: 'ping', path: 'message' });
    expect(typeof st.recent[0].ms).toBe('number');
    expect(typeof st.recent[0].at).toBe('number');

    const rep = await U.collectDiagnostics({ messageTimeoutMs: 100 });
    expect(rep.transport.recent.length).toBeGreaterThan(0);
    expect(rep.transport.preferDirect).toBe(false);
  });

  test('传输日志只留最近若干条（不随使用时长无限膨胀）', async () => {
    makeChrome({ bookmarks: { getTree: (cb) => cb([]) }, sendMessage: () => Promise.resolve({ ok: true }) });
    for (let i = 0; i < 20; i++) {
      await U.sendMessageToBackground({ action: 'ping' + i }, { timeoutMs: 50 });
    }
    const st = U.getTransportState();
    expect(st.recent.length).toBeLessThanOrEqual(12);
    expect(st.recent[st.recent.length - 1].action).toBe('ping19'); // 最新的一定在
  });
});

// 「下载显示成功但书签栏里没有」必须能分辨两种可能：写错节点 / 宿主没落盘。
describe('书签树探针：同步到底写进了哪个节点', () => {
  test('报出根节点下每个子节点的 id/标题/顺序/条数，并给出 import 的命中口径', async () => {
    makeChrome({
      bookmarks: {
        getTree: (cb) => cb([{ id: '0', title: '', children: [
          { id: '1', title: '书签栏', children: [{ id: '10', title: 'A', url: 'https://a/' }] },
          { id: '2', title: '其他书签', children: [] }
        ] }])
      },
      sendMessage: () => Promise.resolve(undefined),
      getBackgroundPage: (cb) => cb(null)
    });
    const rep = await U.collectDiagnostics({ messageTimeoutMs: 100 });
    expect(rep.bookmarkTreeProbe.ok).toBe(true);
    expect(rep.bookmarkTreeProbe.childCount).toBe(2);
    expect(rep.bookmarkTreeProbe.children[0]).toMatchObject({ index: 0, id: '1', title: '书签栏', urlCount: 1 });
    expect(rep.bookmarkTreeProbe.zoneByTitle).toEqual({ bar: '1', other: '2', mobile: null });
    expect(rep.bookmarkTreeProbe.zoneByPosition).toEqual({ first: '1', second: '2', third: null });
  });

  test('标题对不上时，能一眼看出「import 会退到硬编码 id 1」这件事', async () => {
    makeChrome({
      bookmarks: {
        getTree: (cb) => cb([{ id: 'root', title: '', children: [
          { id: 'x1', title: '手机书签', children: [{ id: 'x9', title: 'B', url: 'https://b/' }] }
        ] }])
      },
      sendMessage: () => Promise.resolve(undefined),
      getBackgroundPage: (cb) => cb(null)
    });
    const rep = await U.collectDiagnostics({ messageTimeoutMs: 100 });
    expect(rep.bookmarkTreeProbe.zoneByTitle).toEqual({ bar: null, other: null, mobile: null });
    expect(rep.bookmarkTreeProbe.zoneByPosition.first).toBe('x1');
    expect(rep.bookmarkTreeProbe.children[0].urlCount).toBe(1);
    expect(rep.bookmarkTreeProbe.note).toContain('宿主没落盘');
  });

  test('本页拿不到 FOLDER_TITLES 时如实标注「命中口径不可信」（避免把常量没加载误读成标题对不上）', async () => {
    const saved = global.FOLDER_TITLES;
    global.FOLDER_TITLES = {}; // 模拟 constants.js 没加载
    try {
      makeChrome({
        bookmarks: { getTree: (cb) => cb([{ id: '0', title: '', children: [{ id: '1', title: '书签栏', children: [] }] }]) },
        sendMessage: () => Promise.resolve(undefined),
        getBackgroundPage: (cb) => cb(null)
      });
      const rep = await U.collectDiagnostics({ messageTimeoutMs: 100 });
      expect(rep.bookmarkTreeProbe.titlesAvailable).toBe(false);
      expect(rep.bookmarkTreeProbe.zoneByTitle).toEqual({ bar: null, other: null, mobile: null });
      expect(rep.bookmarkTreeProbe.note).toContain('不可信');
    } finally {
      global.FOLDER_TITLES = saved;
    }
  });

  test('探针只读：不调用任何写入类书签 API', async () => {
    const calls = [];
    makeChrome({
      bookmarks: {
        getTree: (cb) => cb([{ id: '0', title: '', children: [{ id: '1', title: '书签栏' }] }]),
        create: () => { calls.push('create'); },
        remove: () => { calls.push('remove'); },
        removeTree: () => { calls.push('removeTree'); },
        update: () => { calls.push('update'); },
        move: () => { calls.push('move'); }
      },
      sendMessage: () => Promise.resolve(undefined),
      getBackgroundPage: (cb) => cb(null)
    });
    await U.collectDiagnostics({ messageTimeoutMs: 100 });
    expect(calls).toEqual([]);
  });
});


// 「下载显示成功但书签栏里没有」：落盘台账是唯一不经过消息通道的证据。
describe('落盘台账：上次下载/合并到底写了什么', () => {
  test('没有台账 → 如实说「还没下载/合并过」，不编造', async () => {
    makeChrome({ bookmarks: { getTree: (cb) => cb([]) }, sendMessage: () => Promise.resolve(undefined) });
    const rep = await U.collectDiagnostics({ messageTimeoutMs: 100 });
    expect(rep.downloadLedger.ok).toBe(true);
    expect(rep.downloadLedger.report).toBeNull();
    expect(rep.downloadLedger.note).toContain('还没有下载/合并过');
  });

  test('有写入失败 → 台账里能读到失败条数、原因、目标父节点与宿主根命名', async () => {
    makeChrome({
      bookmarks: { getTree: (cb) => cb([]) },
      sendMessage: () => Promise.resolve(undefined),
      store: {
        last_write_report: {
          at: 1700000000000, via: 'download', ok: false, importedCount: 0, removedCount: 0,
          failedWrites: 244,
          conflictSamples: ['书签「百度」：Parent bookmark folder does not exist'],
          targets: [{ source: 'bar', parentId: 'x1', byUserTarget: false, byBucket: true }],
          bucketId: 'x1', bucketTitle: '手机书签',
          zoneIds: { bar: null, other: null, mobile: null },
          rootChildTitles: [{ id: 'x1', title: '手机书签' }]
        }
      }
    });
    const rep = await U.collectDiagnostics({ messageTimeoutMs: 100 });
    expect(rep.downloadLedger.report.failedWrites).toBe(244);
    expect(rep.downloadLedger.report.bucketId).toBe('x1');
    expect(rep.downloadLedger.report.targets[0].byBucket).toBe(true);
    expect(rep.downloadLedger.note).toContain('244 条写入失败');
    expect(rep.downloadLedger.note).toContain('Parent bookmark folder does not exist');
  });

  test('合并写的台账带 via=merge，措辞要跟着变（不能一律说「下载」）', async () => {
    makeChrome({
      bookmarks: { getTree: (cb) => cb([]) },
      sendMessage: () => Promise.resolve(undefined),
      store: { last_write_report: { at: 1, via: 'merge', ok: true, importedCount: 5, removedCount: 1, failedWrites: 0 } }
    });
    const rep = await U.collectDiagnostics({ messageTimeoutMs: 100 });
    expect(rep.downloadLedger.note).toContain('上次合并');
    expect(rep.downloadLedger.note).toContain('新增 5');
  });
});


// 手机端「下载成功但书签栏空的」直接来自这条状态行的措辞：success=true 但有写入失败时
// 绝不允许报绿。逻辑单源在 MiniSync.utils.describeActionStatus（popup 只是渲染）。
describe('同步动作状态行：写入失败不许报成绿色成功', () => {
  const label = { successTag: '下载成功', failPrefix: '下载失败：' };

  test('零失败 + success → 绿色，用后台文案', () => {
    expect(U.describeActionStatus({ success: true, message: '下载成功', conflictCount: 0 }, label))
      .toEqual({ text: '下载成功', level: 'ok' });
  });

  test('有写入失败（success 仍为 true）→ 红色，并显示「N 条没能写入」', () => {
    const r = U.describeActionStatus(
      { success: true, message: '下载完成，但有 244 条没能写入本地（云端数据未丢）：书签「A」：Parent bookmark folder does not exist', conflictCount: 244 },
      label
    );
    expect(r.level).toBe('err');
    expect(r.text).toContain('244 条没能写入本地');
  });

  test('success 但没带 message → 退回动作的 successTag（不留空状态行）', () => {
    expect(U.describeActionStatus({ success: true }, label)).toEqual({ text: '下载成功', level: 'ok' });
  });

  test('SYNC_BUSY → 红色「同步进行中」，不写成「下载失败」', () => {
    const r = U.describeActionStatus({ success: false, code: 'SYNC_BUSY', message: '同步进行中，请稍候' }, label);
    expect(r.level).toBe('err');
    expect(r.text).toBe('同步进行中，请稍候');
  });

  test('真失败 → 走 failPrefix + 后台原文', () => {
    expect(U.describeActionStatus({ success: false, message: 'PROPFIND 404' }, label))
      .toEqual({ text: '下载失败：PROPFIND 404', level: 'err' });
  });
});

// 「下载写入位置」选择器的纯逻辑（手机端扁平根宿主必须让用户指位置）
describe('下载写入位置：候选项与说明', () => {
  const tree = [{ id: '-1', title: '雨见的收藏', children: [
    { id: '0', title: '根目录', children: [
      { id: 'a', title: 'A', url: 'https://a/' },
      { id: 'b', title: 'B', children: [{ id: 'c', title: 'C', url: 'https://c/' }] }
    ] }
  ] }];

  test('候选项＝整棵树的文件夹（带书签数），书签节点不进列表', () => {
    const opts = U.buildTargetOptions([{ id: '0', children: [
      { id: '1', title: '书签栏', children: [{ id: 'x', title: 'X', url: 'https://x/' }] },
      { id: 'y', title: '直接挂在根上的书签', url: 'https://y/' }
    ] }]);
    expect(opts).toEqual([{ value: '1', label: '书签栏（1 个书签）', path: '书签栏', depth: 0 }]);
  });

  test('嵌套文件夹也要列出来（宿主把书签放在深层时用户得能选到），带路径与层级', () => {
    const opts = U.buildTargetOptions([{ id: '0', children: [
      { id: '1', title: '书签栏', children: [
        { id: '11', title: '工作', children: [{ id: 'x', title: 'X', url: 'https://x/' }] },
        { id: '12', title: '生活', children: [
          { id: '121', title: '菜谱', children: [{ id: 'y', title: 'Y', url: 'https://y/' }] }
        ] }
      ] }
    ] }]);
    expect(opts.map(o => o.value)).toEqual(['1', '11', '12', '121']);
    expect(opts.map(o => o.depth)).toEqual([0, 1, 1, 2]);
    expect(opts.find(o => o.value === '121').path).toBe('书签栏 / 生活 / 菜谱');
    expect(opts.find(o => o.value === '11').label).toBe('　工作（1 个书签）');
  });

  test('选了嵌套文件夹：说明给出完整路径，且不能被误报成「已失效」', () => {
    const tree = [{ id: '0', children: [
      { id: '1', title: '书签栏', children: [{ id: '11', title: '工作', children: [] }] }
    ] }];
    const d = U.describeTargetValue('11', tree);
    expect(d.missing).toBeUndefined();
    expect(d.label).toBe('书签栏 / 工作');
    expect(d.detail).toContain('书签栏 / 工作');
  });

  test('自动：根下唯一文件夹时说明会指名道姓（用户能看懂会写到哪里）', () => {
    const d = U.describeTargetValue('', tree);
    expect(d.value).toBe('');
    expect(d.detail).toContain('根目录');
    expect(d.missing).toBeUndefined();
  });

  test('自动：标准三分区时说明按分区写', () => {
    const d = U.describeTargetValue('', [{ id: '0', children: [
      { id: '1', title: '书签栏', children: [] },
      { id: '2', title: '其他书签', children: [] }
    ] }]);
    expect(d.detail).toContain('分区');
  });

  test('指定了位置：说明写到哪儿', () => {
    const d = U.describeTargetValue('0', tree);
    expect(d.label).toBe('根目录');
    expect(d.detail).toContain('根目录');
  });

  test('指定位置已失效（树里找不到）→ missing，必须说出来（不许静默变自动）', () => {
    const d = U.describeTargetValue('zzz', tree);
    expect(d.missing).toBe(true);
    expect(d.detail).toContain('找不到');
  });
});

