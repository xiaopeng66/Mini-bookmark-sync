// 设置页探测性能：短缓存（createTtlProbe）+ 并发合并（createCoalescedFetcher / createCoalescedProbe）。
// 这几个 helper 存在的唯一理由是「少走几趟云端」——手机端每趟都很贵，所以断言必须
// 直接数「真正的探测函数被调用了几次」，而不是只看返回值。
const { loadSource } = require('./load-source');

loadSource();

const {
  createTtlProbe,
  createCoalescedFetcher,
  createCoalescedProbe
} = global.MiniSync.utils;

describe('createTtlProbe：同 key 短缓存', () => {
  test('TTL 内第二次调用不再执行探测函数，直接复用第一次的结果', async () => {
    let now = 1000;
    const p = createTtlProbe(30000, () => now);
    let calls = 0;
    const fn = async () => { calls++; return 'v' + calls; };

    expect(await p.run('k', false, fn)).toBe('v1');
    now = 1000 + 29999; // 还没过期
    expect(await p.run('k', false, fn)).toBe('v1');
    expect(calls).toBe(1);
  });

  test('超出 TTL 后重新探测', async () => {
    let now = 1000;
    const p = createTtlProbe(30000, () => now);
    let calls = 0;
    const fn = async () => { calls++; return calls; };

    expect(await p.run('k', false, fn)).toBe(1);
    now = 1000 + 30000; // 恰好到期
    expect(await p.run('k', false, fn)).toBe(2);
    expect(calls).toBe(2);
  });

  test('force=true 绕过缓存（用户刚改过配置时必须看最新值）', async () => {
    let now = 1000;
    const p = createTtlProbe(30000, () => now);
    let calls = 0;
    const fn = async () => { calls++; return calls; };

    expect(await p.run('k', false, fn)).toBe(1);
    expect(await p.run('k', true, fn)).toBe(2);
    expect(calls).toBe(2);
  });

  test('不同 key 各自独立缓存', async () => {
    let now = 1000;
    const p = createTtlProbe(30000, () => now);
    let calls = 0;
    const fn = async () => { calls++; return calls; };

    expect(await p.run('a', false, fn)).toBe(1);
    expect(await p.run('b', false, fn)).toBe(2);
    expect(await p.run('a', false, fn)).toBe(1);
    expect(calls).toBe(2);
  });

  test('skipCache 判真的瞬时状态不进缓存（「同步进行中」不会粘住 30 秒）', async () => {
    let now = 1000;
    const p = createTtlProbe(30000, () => now);
    let calls = 0;
    const fn = async () => { calls++; return { busy: calls === 1 }; };
    const skip = (v) => !!(v && v.busy);

    expect(await p.run('k', false, fn, skip)).toEqual({ busy: true });
    expect(await p.run('k', false, fn, skip)).toEqual({ busy: false }); // 没吃缓存，重探
    expect(await p.run('k', false, fn, skip)).toEqual({ busy: false }); // 这次是正常值，吃缓存
    expect(calls).toBe(2);
  });

  test('invalidate 清掉指定 key / 全部', async () => {
    let now = 1000;
    const p = createTtlProbe(30000, () => now);
    let calls = 0;
    const fn = async () => { calls++; return calls; };

    await p.run('a', false, fn);
    await p.run('b', false, fn);
    expect(p.size()).toBe(2);
    p.invalidate('a');
    expect(p.size()).toBe(1);
    p.invalidate();
    expect(p.size()).toBe(0);
  });
});

describe('createCoalescedFetcher：并发合并 + 短缓存', () => {
  test('同一时刻的多次调用共用一条请求（3 个开关只打 1 次 getEndpoints）', async () => {
    let calls = 0;
    const fetch = createCoalescedFetcher(
      async () => { calls++; return { ok: true, n: calls }; },
      30000
    );

    const [a, b, c] = await Promise.all([fetch(), fetch(), fetch()]);
    // 合并没生效的话这里会是 3（三次探测各自打一次请求）
    expect(calls).toBe(1);
    expect(a).toEqual({ ok: true, n: 1 });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  test('TTL 窗口内复用已完成的请求', async () => {
    let calls = 0;
    const fetch = createCoalescedFetcher(async () => { calls++; return 'x'; }, 30000);

    expect(await fetch()).toBe('x');
    expect(await fetch()).toBe('x');
    expect(calls).toBe(1);
  });

  test('force=true 强制重新取数', async () => {
    let calls = 0;
    const fetch = createCoalescedFetcher(async () => { calls++; return calls; }, 30000);

    expect(await fetch()).toBe(1);
    expect(await fetch(true)).toBe(2);
    expect(calls).toBe(2);
  });

  test('失败不缓存：一次失败不会让整个 TTL 窗口都拿到坏结果', async () => {
    let calls = 0;
    const fetch = createCoalescedFetcher(async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return 'ok';
    }, 30000);

    await expect(fetch()).rejects.toThrow('boom');
    expect(await fetch()).toBe('ok');
    expect(calls).toBe(2);
  });

  test('空结果（null/undefined）也不缓存', async () => {
    let calls = 0;
    const fetch = createCoalescedFetcher(async () => { calls++; return calls === 1 ? null : 'ok'; }, 30000);

    expect(await fetch()).toBe(null);
    expect(await fetch()).toBe('ok');
    expect(calls).toBe(2);
  });
});

// 弹窗状态栏用的就是这个：既按 key 缓存，又把「同一时刻同一份配置」在途的那趟请求合并掉。
// 它解决的正是用户报的「检查结束又要再检查」——探测成功后写 ever_connected 会触发
// storage.onChanged 再调一次 updateHomeStatus，第二次不该再打一趟网络。
describe('createCoalescedProbe：按 key 缓存 + 在途合并（弹窗连通性探测）', () => {
  test('同一时刻同一 key 的多次调用只发一趟（checkConfig 不会被重复打）', async () => {
    const p = createCoalescedProbe(30000);
    let calls = 0;
    const fn = async () => { calls++; return { ok: true, n: calls }; };

    const [a, b] = await Promise.all([p.run('k', fn), p.run('k', fn)]);
    // 合并没生效的话这里会是 2（「检查结束再检查」就是多出来的那一趟）
    expect(calls).toBe(1);
    expect(a).toEqual({ ok: true, n: 1 });
    expect(b).toEqual(a);
  });

  test('TTL 窗口内复用已完成的探测结果，过期后重探', async () => {
    let now = 1000;
    const p = createCoalescedProbe(30000, () => now);
    let calls = 0;
    const fn = async () => { calls++; return calls; };

    expect(await p.run('k', fn)).toBe(1);
    now = 1000 + 29999; // 还没过期
    expect(await p.run('k', fn)).toBe(1);
    expect(calls).toBe(1);
    now = 1000 + 30000; // 恰好到期
    expect(await p.run('k', fn)).toBe(2);
    expect(calls).toBe(2);
  });

  test('不同 key 各自独立（改过配置就是新 key，立刻重探）', async () => {
    let now = 1000;
    const p = createCoalescedProbe(30000, () => now);
    let calls = 0;
    const fn = async () => { calls++; return calls; };

    const [a, b] = await Promise.all([p.run('a', fn), p.run('b', fn)]);
    expect(calls).toBe(2);
    expect([a, b].sort()).toEqual([1, 2]);
    expect(await p.run('a', fn)).toBe(a); // 各自吃自己的缓存
    expect(calls).toBe(2);
  });

  test('skipCache 判真的瞬时状态不进缓存（「同步进行中」不会粘住 30 秒）', async () => {
    const p = createCoalescedProbe(30000);
    let calls = 0;
    const fn = async () => { calls++; return { busy: calls === 1 }; };
    const skip = (v) => !!(v && v.busy);

    expect(await p.run('k', fn, skip)).toEqual({ busy: true });
    expect(await p.run('k', fn, skip)).toEqual({ busy: false }); // 没吃缓存，重探
    expect(await p.run('k', fn, skip)).toEqual({ busy: false }); // 这次是正常值，吃缓存
    expect(calls).toBe(2);
  });

  test('被拒绝的探测不缓存（后台没起来时不会 30 秒一直显示旧结论）', async () => {
    const p = createCoalescedProbe(30000);
    let calls = 0;
    const fn = async () => { calls++; if (calls === 1) throw new Error('SW 没起来'); return 'ok'; };

    await expect(p.run('k', fn)).rejects.toThrow('SW 没起来');
    expect(await p.run('k', fn)).toBe('ok');
    expect(calls).toBe(2);
  });

  test('被拒绝的在途请求也会被清掉，不会把失败粘在这个 key 上', async () => {
    const p = createCoalescedProbe(30000);
    let calls = 0;
    let rejectFirst;
    const fn = async () => {
      calls++;
      if (calls === 1) return new Promise((_, reject) => { rejectFirst = reject; });
      return 'ok';
    };
    const flush = () => new Promise((r) => setTimeout(r, 0));

    const first = p.run('k', fn);
    const alsoFirst = p.run('k', fn); // 在途，复用同一个 promise（不是各发一趟）
    await flush(); // run 把 fn 放在微任务里，等它真正被调用
    expect(calls).toBe(1);
    rejectFirst(new Error('boom'));
    await expect(first).rejects.toThrow('boom');
    await expect(alsoFirst).rejects.toThrow('boom');
    expect(await p.run('k', fn)).toBe('ok'); // 失败后能重新探测
    expect(calls).toBe(2);
  });

  test('invalidate 清掉指定 key / 全部（用户刚改配置时作废缓存）', async () => {
    const p = createCoalescedProbe(30000);
    let calls = 0;
    const fn = async () => { calls++; return calls; };

    await p.run('a', fn);
    await p.run('b', fn);
    expect(p.size()).toBe(2);
    p.invalidate('a');
    expect(p.size()).toBe(1);
    expect(await p.run('a', fn)).toBe(3); // 被清掉 ⇒ 重探
    p.invalidate();
    expect(p.size()).toBe(0);
  });
});
