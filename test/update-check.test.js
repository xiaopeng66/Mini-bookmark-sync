// update-check.test.js — 设置页「版本更新」（2026-10-11 用户诉求：
// 「能不能在手机端的插件中加上自动更新按钮？点击后直接下载最新版安装」）。
//
// 这条功能的价值不在「能查到版本号」，而在【不骗人】：
//   WebExtensions 里没有安装扩展的 API，chrome.runtime.reload() 也只是重载当前这份代码
//   ⇒「点一下自己就装好了」平台做不到。能做的只有：查到最新版本 → 定位【与当前宿主形态
//   对应】的安装包 → 交给宿主浏览器下载并弹安装确认。所以本文件按三层验收：
//     ① 纯逻辑（lib/update.js）：版本比较、产物命名、Atom/API 解析、404 与探测失败的降级；
//     ② 诚实性：describeUpdate 的每个分支都得说人话，且不许出现「已自动更新完成」这类假话；
//     ③ 页面切片：在假 DOM + 假 fetch 里真的把 options.js 的绑定跑一遍（点按钮、点下载）。
//
// 素材来源（都是真数据，不是编的）：
//   · releases.atom 的真实响应（2026-10-11 抓，裁掉了非首个 entry 的部分）；
//   · v2.2.1 发布页的真实资产路径（releases/expanded_assets/v2.2.1 抓到的四条下载地址）。
//   产物命名一旦漂了（比如构建脚本改了前缀），这些用例必须红。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { loadSource } = require('./load-source');
loadSource();
const U = global.MiniSync.update;

const MINUTE = 60 * 1000;

// ===================== ① 纯逻辑 =====================

describe('版本比较', () => {
  test('逐段数字比较，不是字符串比较（2.10.0 > 2.9.9）', () => {
    expect(U.compareVersions('2.2.1', '2.2.2')).toBe(-1);
    expect(U.compareVersions('2.2.2', '2.2.1')).toBe(1);
    expect(U.compareVersions('2.2.2', 'v2.2.2')).toBe(0);
    expect(U.compareVersions('2.10.0', '2.9.9')).toBe(1);
    expect(U.compareVersions('2.2.1.1', '2.2.1')).toBe(1);
  });

  test('常驻变体的 .1 只在【当前就是常驻变体】时剥掉（否则会误报「本机比发布版新」）', () => {
    expect(U.channelVersion('2.2.2.1', 'gecko-mv2-persistent')).toBe('2.2.2');
    expect(U.channelVersion('2.2.2', 'gecko-mv2')).toBe('2.2.2');
    expect(U.channelVersion('2.2.2.1', 'chromium-sideload')).toBe('2.2.2.1');
  });
});

describe('宿主形态 → 安装包', () => {
  test('形态判据全部来自本扩展清单（商店版带 update_url，旁加载/暂存时被 tools 去掉）', () => {
    expect(U.selectHostVariant({ manifest_version: 3, update_url: 'https://x/' })).toBe('store');
    expect(U.selectHostVariant({ manifest_version: 3, background: { service_worker: 'background.js' } }))
      .toBe('chromium-sideload');
    expect(U.selectHostVariant({ manifest_version: 2, background: { persistent: true, scripts: [] } }))
      .toBe('gecko-mv2-persistent');
    expect(U.selectHostVariant({ manifest_version: 2, background: { persistent: false, scripts: [] } }))
      .toBe('gecko-mv2');
  });

  test('★ 产物命名与 v2.2.1 发布页的真实资产路径逐字一致', () => {
    const base = 'https://github.com/xiaopeng66/Mini-bookmark-sync/releases/download/v2.2.1/';
    expect(U.assetName('gecko-mv2-persistent', '2.2.1')).toBe('minibookmark-sync-2.2.1.1-gecko-mv2-persistent.xpi');
    expect(U.assetUrl('gecko-mv2-persistent', '2.2.1')).toBe(base + 'minibookmark-sync-2.2.1.1-gecko-mv2-persistent.xpi');
    expect(U.assetUrl('gecko-mv2', '2.2.1')).toBe(base + 'minibookmark-sync-2.2.1-gecko-mv2.xpi');
    expect(U.assetUrl('chromium-sideload', '2.2.1')).toBe(base + 'minibookmark-sync-2.2.1-chromium-sideload.zip');
    expect(U.assetUrl('store', '2.2.1')).toBe(null);      // 商店版没有手动包
  });

  test('从发布页给的资产清单里挑：先精确名，再按后缀兜底（前缀改了也能命中）', () => {
    const assets = [
      { name: 'minibookmark-sync-2.2.1-chromium-sideload.zip', url: 'u1' },
      { name: 'minibookmark-sync-2.2.1-gecko-mv2.xpi', url: 'u2' },
      { name: 'minibookmark-sync-2.2.1.1-gecko-mv2-persistent.xpi', url: 'u3' },
    ];
    expect(U.pickAsset(assets, 'gecko-mv2-persistent', '2.2.1').url).toBe('u3');
    expect(U.pickAsset(assets, 'gecko-mv2', '2.2.1').url).toBe('u2');   // 不许误配 -persistent
    expect(U.pickAsset(assets, 'chromium-sideload', '2.2.1').url).toBe('u1');
    expect(U.pickAsset([{ name: 'other-name-gecko-mv2.xpi', url: 'u9' }], 'gecko-mv2', '2.2.1').url).toBe('u9');
    expect(U.pickAsset([], 'gecko-mv2', '2.2.1')).toBe(null);
  });
});

describe('发布信息解析', () => {
  // 真实响应节选（releases.atom，2026-10-11 抓；只留首个 entry，其余逐字未改）
  const REAL_ATOM = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xml:lang="en-US">',
    '  <id>tag:github.com,2008:https://github.com/xiaopeng66/Mini-bookmark-sync/releases</id>',
    '  <title>Release notes from Mini-bookmark-sync</title>',
    '  <updated>2026-10-08T12:50:11Z</updated>',
    '  <entry>',
    '    <id>tag:github.com,2008:Repository/1404467440/v2.2.1</id>',
    '    <updated>2026-10-08T13:15:39Z</updated>',
    '    <link rel="alternate" type="text/html" href="https://github.com/xiaopeng66/Mini-bookmark-sync/releases/tag/v2.2.1"/>',
    '    <title>v2.2.1</title>',
    '    <content type="html">&lt;h2&gt;修复&lt;/h2&gt;</content>',
    '  </entry>',
    '</feed>',
  ].join('\n');

  test('★ 真实 Atom 源解析出标签 / 版本 / 发布页地址 / 发布时间', () => {
    const r = U.parseAtomFeed(REAL_ATOM);
    expect(r.tag).toBe('v2.2.1');
    expect(r.version).toBe('2.2.1');
    expect(r.url).toBe('https://github.com/xiaopeng66/Mini-bookmark-sync/releases/tag/v2.2.1');
    expect(r.published).toBe('2026-10-08T13:15:39Z');
  });

  test('空源 / 缺 title 的源不猜版本：<id> 兜底，实在没有就 null', () => {
    expect(U.parseAtomFeed('')).toBe(null);
    expect(U.parseAtomFeed('<feed><entry><id>tag:github.com,2008:Repository/1/v2.2.0</id></entry></feed>').version).toBe('2.2.0');
  });

  test('自定义标题使用 id 标签，跳过 beta，title 只接受完整数字版本', () => {
    expect(U.parseAtomFeed('<feed><entry><id>tag:github.com,2008:Repository/1/v2.2.3</id><title>修复排序问题</title></entry></feed').version).toBe('2.2.3');
    const beta = '<entry><id>tag:github.com,2008:Repository/1/v2.3.0-beta.1</id><title>v2.3.0</title></entry>';
    expect(U.parseAtomFeed('<feed>' + beta + '<entry><title>v2.2.3</title></entry></feed>').version).toBe('2.2.3');
    expect(U.parseAtomFeed('<feed>' + beta + '</feed>')).toBe(null);
    expect(U.parseAtomFeed('<entry><title>新版 2.2.3</title></entry>')).toBe(null);
    expect(U.parseAtomFeed('<entry><title>修复</title><link href="https://github.com/xiaopeng66/Mini-bookmark-sync/releases/tag/v2.2.4"/></entry>').version).toBe('2.2.4');
  });

  test('API 必须有稳定数字 tag_name，拒绝草稿和预发布，不猜 name', () => {
    for (const obj of [{ name: 'v2.2.3' }, { tag_name: 'v2.3.0-beta.1' },
      { tag_name: 'release-2.2.3' }, { tag_name: 'v2.2.3', draft: true },
      { tag_name: 'v2.2.3', prerelease: true }]) expect(U.parseApiRelease(obj)).toBe(null);
  });

  test('发布页和资产链接仅接受本仓库 HTTPS 路径', () => {
    const r = U.parseApiRelease({ tag_name: 'v2.2.3', html_url: 'javascript:alert(1)', assets: [
      { name: 'a.xpi', browser_download_url: 'javascript:alert(1)' },
      { name: 'b.xpi', browser_download_url: 'https://evil.test/a.xpi' },
      { name: 'c.xpi', browser_download_url: 'https://github.com/other/repo/releases/download/v2.2.3/c.xpi' },
      { name: 'dot-gecko-mv2.xpi', browser_download_url: 'https://github.com/xiaopeng66/Mini-bookmark-sync/releases/download/v2.2.3/..' },
      { name: 'encoded-gecko-mv2.xpi', browser_download_url: 'https://github.com/xiaopeng66/Mini-bookmark-sync/releases/download/v2.2.3/%2e%2e' }
    ] });
    expect(r.url).toBe('https://github.com/xiaopeng66/Mini-bookmark-sync/releases/tag/v2.2.3');
    expect(r.assets).toEqual([]);
  });

  test('API JSON：拿到逐资产精确地址，且排除草稿/预发布（/releases/latest 语义）', () => {
    const r = U.parseApiRelease({
      tag_name: 'v2.2.1', html_url: 'https://github.com/x/releases/tag/v2.2.1',
      published_at: '2026-10-08T13:15:39Z',
      assets: [{ name: 'a.xpi', browser_download_url: 'https://github.com/xiaopeng66/Mini-bookmark-sync/releases/download/v2.2.1/a.xpi' }, { name: '', url: 'x' }],
    });
    expect(r.version).toBe('2.2.1');
    expect(r.assets).toEqual([{ name: 'a.xpi', url: 'https://github.com/xiaopeng66/Mini-bookmark-sync/releases/download/v2.2.1/a.xpi' }]);
    expect(U.parseApiRelease({})).toBe(null);
  });
});

describe('checkForUpdate：够不着发布页就说够不着，不给假结论', () => {
  const io = (routes) => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, method: (init && init.method) || 'GET' });
      const hit = routes.find((r) => url.indexOf(r.match) >= 0 && (!r.method || r.method === (init && init.method)));
      if (!hit) throw new Error('Failed to fetch');
      return {
        ok: hit.status >= 200 && hit.status < 400,
        status: hit.status,
        json: async () => JSON.parse(hit.body),
        text: async () => hit.body,
      };
    };
    return { fetchImpl, calls };
  };
  const apiOk = (version, assets) => ({
    match: 'api.github.com', status: 200,
    body: JSON.stringify({ tag_name: 'v' + version, html_url: 'https://github.com/x/releases/tag/v' + version,
                           published_at: '2026-10-08T13:15:39Z', assets: assets || [] }),
  });
  const atomOk = (version) => ({
    match: 'releases.atom', status: 200,
    body: '<feed><entry><title>v' + version + '</title><updated>2026-10-08T13:15:39Z</updated>'
        + '<link rel="alternate" href="https://github.com/x/releases/tag/v' + version + '"/></entry></feed>',
  });
  const json404 = { match: 'api.github.com', status: 403, body: '{"message":"rate limit"}' };

  test('API 通：直接用发布页给的资产地址，不再自己拼、也不发 HEAD', async () => {
    const { fetchImpl, calls } = io([apiOk('2.2.3', [
      { name: 'minibookmark-sync-2.2.3.1-gecko-mv2-persistent.xpi', browser_download_url: 'https://github.com/xiaopeng66/Mini-bookmark-sync/releases/download/v2.2.3/p.xpi' }])]);
    const r = await U.checkForUpdate({ current: '2.2.2.1', variant: 'gecko-mv2-persistent', fetchImpl });
    expect(r).toMatchObject({ ok: true, state: 'newer', latest: '2.2.3', source: 'api',
                              assetUrl: 'https://github.com/xiaopeng66/Mini-bookmark-sync/releases/download/v2.2.3/p.xpi', probe: 'listed' });
    expect(calls.length).toBe(1);
  });

  test('★ API 被限流（403）就退 Atom；地址自己拼，但先 HEAD 探一次', async () => {
    const { fetchImpl, calls } = io([
      json404, atomOk('2.2.3'),
      { match: 'releases/download', method: 'HEAD', status: 200, body: '' }]);
    const r = await U.checkForUpdate({ current: '2.2.2.1', variant: 'gecko-mv2-persistent', fetchImpl });
    expect(r.state).toBe('newer');
    expect(r.source).toBe('atom');
    expect(r.probe).toBe('ok');
    expect(r.assetName).toBe('minibookmark-sync-2.2.3.1-gecko-mv2-persistent.xpi');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'HEAD']);
  });

  test('两个源都够不着 ⇒ ok:false + 两条原始原因 + 发布页兜底（绝不编一个版本号出来）', async () => {
    const { fetchImpl } = io([]);
    const r = await U.checkForUpdate({ current: '2.2.2', variant: 'chromium-sideload', fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('UNREACHABLE');
    expect(r.latest).toBe(null);
    expect(r.error).toContain('releases API');
    expect(r.error).toContain('releases.atom');
    expect(r.releaseUrl).toContain('github.com/xiaopeng66/Mini-bookmark-sync/releases');
  });

  test('★ 安装包探到 404 ⇒ 撤下下载地址（宁可指路发布页，也不给必然失败的按钮）', async () => {
    const { fetchImpl } = io([json404, atomOk('2.2.3'),
                              { match: 'releases/download', method: 'HEAD', status: 404, body: '' }]);
    const r = await U.checkForUpdate({ current: '2.2.2', variant: 'gecko-mv2', fetchImpl });
    expect(r.probe).toBe('missing');
    expect(r.assetUrl).toBe(null);
    expect(r.assetName).toBe('minibookmark-sync-2.2.3-gecko-mv2.xpi');
  });

  test('探测自己失败（不支持 HEAD / 被挡）⇒ 记 unknown 但保留地址，界面如实写「未能预先确认」', async () => {
    const { fetchImpl } = io([json404, atomOk('2.2.3')]);   // releases/download 没有路由 ⇒ 抛错
    const r = await U.checkForUpdate({ current: '2.2.2', variant: 'gecko-mv2', fetchImpl });
    expect(r.probe).toBe('unknown');
    expect(r.assetUrl).toBe('https://github.com/xiaopeng66/Mini-bookmark-sync/releases/download/v2.2.3/minibookmark-sync-2.2.3-gecko-mv2.xpi');
    expect(r.probeNote).toContain('Failed to fetch');
  });

  test('已是最新：不发 HEAD、不给下载地址', async () => {
    const { fetchImpl, calls } = io([apiOk('2.2.2')]);
    const r = await U.checkForUpdate({ current: '2.2.2', variant: 'chromium-sideload', fetchImpl });
    expect(r).toMatchObject({ ok: true, state: 'current', assetUrl: null });
    expect(calls.length).toBe(1);
  });

  test('★ 常驻变体刚更新完（2.2.2.1 vs v2.2.2）必须判「已是最新」，不许说本机比发布版新', async () => {
    const { fetchImpl } = io([apiOk('2.2.2')]);
    const r = await U.checkForUpdate({ current: '2.2.2.1', variant: 'gecko-mv2-persistent', fetchImpl });
    expect(r.state).toBe('current');
  });

  test('本机跑的是开发版（2.3.0 vs v2.2.2）⇒ local-ahead，也不给下载地址', async () => {
    const { fetchImpl } = io([apiOk('2.2.2')]);
    const r = await U.checkForUpdate({ current: '2.3.0', variant: 'chromium-sideload', fetchImpl });
    expect(r.state).toBe('local-ahead');
  });

  test('宿主没有 fetch ⇒ 如实报 NO_FETCH，不抛异常', async () => {
    const r = await U.checkForUpdate({ current: '2.2.2', variant: 'gecko-mv2', fetchImpl: null });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NO_FETCH');
  });

  test.each([true, false])('完整 body 挂起也超时，AbortController 可用=%s', async (withController) => {
    const ctx = { MiniSync: {}, Date, setTimeout, clearTimeout, AbortController: withController ? AbortController : undefined };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lib/update.js'), 'utf8'), ctx);
    const fetchImpl = async () => ({ ok: true, json: () => new Promise(() => {}), text: () => new Promise(() => {}) });
    const result = await Promise.race([
      ctx.MiniSync.update.checkForUpdate({ current: '2.2.2', fetchImpl, timeoutMs: 15 }),
      new Promise((resolve) => setTimeout(() => resolve({ stalled: true }), 100))
    ]);
    expect(result).toMatchObject({ ok: false, code: 'UNREACHABLE' });
    expect(result.error).toMatch(/超时|aborted/);
  });

  test('没有 AbortController 的 headers 挂起也必须返回失败', async () => {
    const ctx = { MiniSync: {}, Date, setTimeout, clearTimeout };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lib/update.js'), 'utf8'), ctx);
    const result = await Promise.race([
      ctx.MiniSync.update.checkForUpdate({ fetchImpl: () => new Promise(() => {}), timeoutMs: 15 }),
      new Promise((resolve) => setTimeout(() => resolve({ stalled: true }), 100))
    ]);
    expect(result).toMatchObject({ ok: false, code: 'UNREACHABLE' });
  });

  test('API、Atom、HEAD 共用整体截止时间，HEAD 不能再等一个完整请求周期', async () => {
    const fetchImpl = async (url, init) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (init.method === 'HEAD') return new Promise(() => {});
      if (url.includes('api.github.com')) return { ok: false, status: 403 };
      return { ok: true, text: async () => '<entry><title>v2.2.3</title></entry>' };
    };
    const result = await Promise.race([
      U.checkForUpdate({ current: '2.2.2', fetchImpl, timeoutMs: 100, overallTimeoutMs: 60 }),
      new Promise((resolve) => setTimeout(() => resolve({ stalled: true }), 110))
    ]);
    expect(result).toMatchObject({ ok: true, state: 'newer', probe: 'unknown' });
    expect(result.probeNote).toMatch(/超时/);
  });

  test('请求挂着不返回 ⇒ 超时中止（手机网络下界面不会永远停在「正在检查」）', async () => {
    const hang = (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
    });
    const r = await U.checkForUpdate({ current: '2.2.2', variant: 'gecko-mv2', fetchImpl: hang, timeoutMs: 20 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('UNREACHABLE');
    expect(r.error).toMatch(/超时|aborted/);
  });
});

describe('结果 → 文案：每个分支都得说人话，且不许假装装好了', () => {
  const newer = { ok: true, state: 'newer', current: '2.2.1.1', channel: '2.2.1', variant: 'gecko-mv2-persistent',
                  tag: 'v2.2.2', latest: '2.2.2', published: '2026-10-11T02:00:00Z', probe: 'ok',
                  assetName: 'minibookmark-sync-2.2.2.1-gecko-mv2-persistent.xpi',
                  assetUrl: 'https://github.com/xiaopeng66/Mini-bookmark-sync/releases/download/v2.2.2/x.xpi',
                  releaseUrl: 'https://github.com/xiaopeng66/Mini-bookmark-sync/releases/tag/v2.2.2' };

  test('★ 有新版本：给出对应安装包 + 明说「安装确认必须你点，扩展没有这个权限」', () => {
    const v = U.describeUpdate(newer);
    expect(v.headline).toContain('v2.2.2');
    expect(v.headline).toContain('2026-10-11');
    expect(v.download.url).toBe(newer.assetUrl);
    expect(v.detail).toContain('minibookmark-sync-2.2.2.1-gecko-mv2-persistent.xpi');
    expect(v.detail).toContain('扩展没有安装扩展的权限');
    expect(v.detail).toContain('宿主支持');
    expect(v.detail).toContain('相同扩展 ID');
    expect(v.detail).toContain('未签名');
    expect(v.detail).not.toContain('装新包会替换旧版');
    expect(v.link.url).toContain('/releases/tag/v2.2.2');
  });

  test('★ 任何分支都不许出现「已自动更新/已安装」这类假话', () => {
    const cases = [
      newer,
      Object.assign({}, newer, { probe: 'unknown', probeNote: 'HTTP 403' }),
      Object.assign({}, newer, { probe: 'missing', assetUrl: null }),
      Object.assign({}, newer, { variant: 'chromium-sideload' }),
      { ok: true, state: 'current', current: '2.2.2', channel: '2.2.2', variant: 'gecko-mv2', tag: 'v2.2.2' },
      { ok: true, state: 'local-ahead', current: '2.3.0', variant: 'chromium-sideload', tag: 'v2.2.2' },
      { ok: false, code: 'UNREACHABLE', error: 'releases API：HTTP 403', releaseUrl: 'https://github.com/xiaopeng66/Mini-bookmark-sync/releases' },
      { ok: false, code: 'NO_FETCH', error: '当前宿主没有 fetch 接口', releaseUrl: 'https://github.com/xiaopeng66/Mini-bookmark-sync/releases' },
      {},
    ];
    for (const c of cases) {
      const v = U.describeUpdate(c);
      const text = [v.headline, v.detail].join(' ');
      expect(text.trim().length).toBeGreaterThan(0);
      expect(v.headline).not.toMatch(/自动更新完成|已经装好|已自动安装|更新成功/);
      expect(U.updateStatusText(c).length).toBeGreaterThan(0);
    }
  });

  test('探不动安装包 ⇒ 照给按钮但写明「未能预先确认」，并留好 404 的后路', () => {
    const v = U.describeUpdate(Object.assign({}, newer, { probe: 'unknown', probeNote: 'HTTP 403' }));
    expect(v.download).toBeTruthy();
    expect(v.detail).toContain('未能预先确认');
    expect(v.detail).toContain('404');
  });

  test('★ 确认没有安装包 ⇒ 不给下载按钮，改指路发布页并写明手机端该选哪个', () => {
    const v = U.describeUpdate(Object.assign({}, newer, { probe: 'missing', assetUrl: null }));
    expect(v.download).toBe(null);
    expect(v.detail).toContain('已确认不存在');
    expect(v.detail).toContain('gecko-mv2-persistent.xpi');
    expect(v.link).toBeTruthy();
  });

  test('商店版：说清由浏览器商店自动更新，不给手动下载按钮', () => {
    const v = U.describeUpdate(Object.assign({}, newer, { variant: 'store', assetUrl: null, probe: 'skipped', assetName: null }));
    expect(v.download).toBe(null);
    expect(v.detail).toContain('商店');
  });

  test('失败分支：原文原因进 detail（不吞错误），并给发布页链接', () => {
    const v = U.describeUpdate({ ok: false, code: 'UNREACHABLE', error: 'releases API：HTTP 403；releases.atom：Failed to fetch',
                                 releaseUrl: 'https://github.com/xiaopeng66/Mini-bookmark-sync/releases' });
    expect(v.tone).toBe('err');
    expect(v.detail).toContain('releases.atom：Failed to fetch');
    expect(v.link.url).toBe('https://github.com/xiaopeng66/Mini-bookmark-sync/releases');
    expect(v.download).toBe(null);
  });
});


// ===================== ③ 页面切片：真跑 options.js 的绑定 =====================

const SRC = fs.readFileSync(path.join(__dirname, '..', 'options.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
const START_ANCHOR = '// ========== 版本更新 ==========';
const END_ANCHOR = '// ========== 初始化 ==========';

function sliceUpdateCode() {
  const start = SRC.indexOf(START_ANCHOR);
  const end = SRC.indexOf(END_ANCHOR);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('options.js 里找不到「版本更新」代码段（锚点漂了：' + START_ANCHOR + ' / ' + END_ANCHOR + '）');
  }
  return SRC.slice(start, end);
}
const UPDATE_CODE = sliceUpdateCode();

const MANIFEST = { version: '2.2.2.1', manifest_version: 2, background: { persistent: true, scripts: [] } };
const LATEST_ATOM = '<feed><entry><title>v2.2.3</title><updated>2026-10-11T02:00:00Z</updated>'
  + '<link rel="alternate" href="https://github.com/xiaopeng66/Mini-bookmark-sync/releases/tag/v2.2.3"/></entry></feed>';

function fakeResponse(status, body) {
  return { ok: status >= 200 && status < 400, status, text: async () => body, json: async () => JSON.parse(body) };
}

function makeHarness({ manifest = MANIFEST, stored, fetchImpl, tabs, opened, permissions, storageGet, storageSet } = {}) {
  const els = {};
  const el = (id) => {
    if (!els[id]) {
      els[id] = {
        id, textContent: '', innerHTML: '', className: '', disabled: false, href: '',
        style: {}, handlers: {},
        addEventListener(ev, fn) { this.handlers[ev] = fn; },
        removeAttribute(name) { if (name === 'href') this.href = ''; },
      };
    }
    return els[id];
  };
  // 静态 HTML 的初始态：下载按钮与发布页那一行都是 display:none（见下面那条用例）
  el('updateDownloadBtn').style.display = 'none';
  el('updateReleaseRow').style.display = 'none';
  el('updateDownloadBtn').href = '#';

  const store = { sets: [], get: stored };
  const calls = { fetch: [], tabs: [], opened: [] };
  const ctx = {
    document: { getElementById: (id) => el(id) },
    chrome: {
      runtime: { getManifest: () => manifest },
      permissions,
      storage: { local: {
        get: storageGet || (async () => (stored ? { update_last_check: stored } : {})),
        set: storageSet || (async (patch) => { store.sets.push(patch); }),
      } },
      tabs: tabs === undefined ? { create: (o) => calls.tabs.push(o.url) } : tabs,
    },
    window: { open: (url) => { calls.opened.push(url); return opened === undefined ? {} : opened; } },
    fetch: async (url, init) => {
      calls.fetch.push({ url, method: (init && init.method) || 'GET' });
      return fetchImpl ? fetchImpl(url, init) : fakeResponse(200, url.indexOf('atom') >= 0 ? LATEST_ATOM : '{}');
    },
    setTimeout, clearTimeout, AbortController, JSON, console, Date,
  };
  vm.createContext(ctx);
  for (const file of ['lib/constants.js', 'lib/utils.js', 'lib/update.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), ctx, { filename: file });
  }
  vm.runInContext(UPDATE_CODE, ctx, { filename: 'options.js#update' });
  return { els, el, calls, store, ctx };
}

const flush = () => new Promise((r) => setImmediate(r));
const clickCheck = async (h) => { const r = h.el('updateCheckBtn').handlers.click(); await flush(); return r; };

describe('设置页「版本更新」卡片', () => {
  test('静态 HTML：卡片、两个动作、发布页兜底链接都在，且下载按钮默认隐藏、脚本顺序正确', () => {
    expect(HTML).toContain('id="updateCard"');
    expect(HTML).toContain('>版本更新<');
    expect(HTML).toContain('class="btn-mini" id="updateCheckBtn"');
    expect(HTML).toMatch(/<a[^>]*id="updateDownloadBtn"[^>]*style="display:none;"/);
    expect(HTML).toContain('id="updateHint"');
    expect(HTML).toContain('id="updateDetail"');
    expect(HTML).toContain('id="updateReleaseLink"');
    expect(HTML).toContain('rel="noopener"');
    // 卡片自身不许写「自动更新好了」这类平台做不到的话
    expect(HTML).not.toMatch(/自动更新完成|已自动安装/);
    // lib/update.js 必须在 options.js 之前加载（否则 MiniSync.update 未定义）
    expect(HTML.indexOf('src="lib/update.js"')).toBeGreaterThan(-1);
    expect(HTML.indexOf('src="lib/update.js"')).toBeLessThan(HTML.indexOf('src="options.js"'));
  });

  test('打开页面：画出当前版本 + 宿主形态；没有历史结果时保持初始提示', async () => {
    const h = makeHarness({ stored: null });
    await h.ctx.initUpdateCard();
    await flush();
    expect(h.el('updateCurrent').textContent).toBe('v2.2.2.1（手机常驻后台变体）');
    expect(h.el('updateHint').textContent).toContain('点「检查更新」');
    expect(h.el('updateDownloadBtn').style.display).toBe('none');
  });

  test('★ 点「检查更新」：真的走网络（API 被限流→退 Atom），结论上色，并记住这次结果', async () => {
    const h = makeHarness({
      fetchImpl: (url, init) => (init && init.method) === 'HEAD'
        ? fakeResponse(200, '')
        : (url.indexOf('api.github.com') >= 0 ? fakeResponse(403, '{"message":"rate limit"}') : fakeResponse(200, LATEST_ATOM)),
    });
    await clickCheck(h);
    await flush();
    expect(h.calls.fetch.length).toBe(3);                      // API → Atom → HEAD 探测
    expect(h.el('updateHint').className).toContain('ok');
    expect(h.el('updateHint').textContent).toContain('v2.2.3');
    expect(h.el('updateDetail').innerHTML).toContain('浏览器弹出安装确认');
    expect(h.el('updateDownloadBtn').style.display).toBe('');
    expect(h.el('updateDownloadBtn').href).toContain('minibookmark-sync-2.2.3.1-gecko-mv2-persistent.xpi');
    expect(h.el('updateReleaseRow').style.display).toBe('');
    expect(h.store.sets.length).toBe(1);
    expect(h.store.sets[0].update_last_check.state).toBe('newer');
    expect(h.el('updateCheckBtn').disabled).toBe(false);        // 跑完必须解禁
  });

  test('下载用原生新窗口链接，tabs Promise 拒绝或 callback lastError 都不拦导航', async () => {
    for (const create of [() => Promise.reject(new Error('host refuses tabs')), () => { throw new Error('lastError'); }]) {
      const h = makeHarness({ tabs: { create } });
      await clickCheck(h);
      let prevented = 0;
      const handler = h.el('updateDownloadBtn').handlers.click;
      if (handler) await handler({ preventDefault: () => { prevented++; } });
      expect(prevented).toBe(0);
      expect(h.calls.opened).toEqual([]);
      expect(h.el('updateDownloadBtn').href).toContain('/releases/download/v2.2.3/');
      const anchor = HTML.match(/<a[^>]*id="updateDownloadBtn"[^>]*>/)[0];
      expect(anchor).toContain('target="_blank"');
      expect(anchor).toContain('rel="noopener"');
    }
  });

  test('存储写入失败如实呈现，本次结论仍显示且按钮恢复', async () => {
    const h = makeHarness({ storageSet: async () => { throw new Error('quota exceeded'); } });
    await clickCheck(h);
    expect(h.el('updateHint').textContent).toContain('v2.2.3');
    expect(h.el('updateDetail').innerHTML).not.toContain('结果已记住');
    expect(h.el('updateDetail').innerHTML).toContain('未能保存');
    expect(h.el('updateDetail').innerHTML).toContain('quota exceeded');
    expect(h.el('updateCheckBtn').disabled).toBe(false);
  });

  test('迟到的缓存读取不能覆盖检查后的新结果', async () => {
    let finishGet;
    const h = makeHarness({ storageGet: () => new Promise((resolve) => { finishGet = resolve; }) });
    const init = h.ctx.initUpdateCard();
    await clickCheck(h);
    finishGet({ update_last_check: { ok: true, state: 'current', current: '2.2.2.1', channel: '2.2.2',
      variant: 'gecko-mv2-persistent', tag: 'v2.2.2' } });
    await init;
    expect(h.el('updateHint').textContent).toContain('v2.2.3');
    expect(h.el('updateDownloadBtn').style.display).toBe('');
  });

  test('商店版 click 内同步请求精确更新权限，不在 await contains 后丢失 user gesture', async () => {
    const requested = [];
    const h = makeHarness({ manifest: { version: '2.2.2', manifest_version: 3, update_url: 'https://store.test/' },
      permissions: { contains: () => new Promise(() => {}), request: (details, cb) => {
        requested.push(details.origins); cb(true);
      } } });
    const clicking = h.el('updateCheckBtn').handlers.click();
    expect(requested).toEqual([['https://api.github.com/*', 'https://github.com/*']]);
    await clicking;
    expect(h.el('updateCheckBtn').disabled).toBe(false);
    expect(h.el('updateHint').textContent).toContain('v2.2.3');
  });

  test('已有 required host 权限的构建包不请求；缺 permissions API 的宿主仍检查', async () => {
    let requested = 0;
    const permissions = { request: () => { requested++; return Promise.resolve(true); } };
    const h = makeHarness({ manifest: { version: '2.2.2', manifest_version: 3, host_permissions: ['*://*/*'] }, permissions });
    await clickCheck(h);
    expect(requested).toBe(0);
    expect(h.el('updateHint').textContent).toContain('v2.2.3');
  });

  test.each(['callback', 'promise'])('拒绝更新权限（%s）不联网且给失败原因，按钮恢复', async (mode) => {
    const h = makeHarness({ permissions: { request: mode === 'callback' ? ((o, cb) => cb(false)) : (() => Promise.resolve(false)) } });
    await clickCheck(h);
    expect(h.calls.fetch).toEqual([]);
    expect(h.el('updateDetail').innerHTML).toContain('未获准');
    expect(h.el('updateCheckBtn').disabled).toBe(false);
  });

  test('缓存的任意 scheme 和外仓库 URL 不成为导航目标', async () => {
    const h = makeHarness({ stored: { ok: true, state: 'newer', current: '2.2.2.1', variant: 'gecko-mv2-persistent',
      tag: 'v2.2.3', assetUrl: 'javascript:alert(1)', releaseUrl: 'https://evil.test/releases' } });
    await h.ctx.initUpdateCard();
    expect(h.el('updateDownloadBtn').style.display).toBe('none');
    expect(h.el('updateReleaseLink').href).toBe('https://github.com/xiaopeng66/Mini-bookmark-sync/releases');
  });

  test('检查失败（两个源都够不着）⇒ 红色结论 + 原文原因 + 发布页链接，没有下载按钮', async () => {
    const h = makeHarness({ fetchImpl: () => { throw new Error('Failed to fetch'); } });
    await clickCheck(h);
    await flush();
    expect(h.el('updateHint').className).toContain('err');
    expect(h.el('updateHint').textContent).toContain('检查失败');
    expect(h.el('updateDetail').innerHTML).toContain('Failed to fetch');
    expect(h.el('updateReleaseRow').style.display).toBe('');
    expect(h.el('updateDownloadBtn').style.display).toBe('none');
    expect(h.store.sets[0].update_last_check.ok).toBe(false);
  });

  test('重开页面恢复上次结果；但本机版本变了就作废（不许停在过期结论上）', async () => {
    const newer = { ok: true, state: 'newer', current: '2.2.2.1', variant: 'gecko-mv2-persistent',
                    tag: 'v2.2.3', channel: '2.2.2', probe: 'ok',
                    assetName: 'minibookmark-sync-2.2.3.1-gecko-mv2-persistent.xpi',
                    assetUrl: 'https://github.com/xiaopeng66/Mini-bookmark-sync/releases/download/v2.2.3/x.xpi', releaseUrl: 'https://github.com/xiaopeng66/Mini-bookmark-sync/releases', checkedAt: Date.now() - 5 * MINUTE };
    const h = makeHarness({ stored: newer });
    await h.ctx.initUpdateCard();
    await flush();
    expect(h.el('updateHint').className).toContain('ok');
    expect(h.el('updateDownloadBtn').style.display).toBe('');
    expect(h.el('updateDetail').innerHTML).toContain('上次检查');
    expect(h.calls.fetch.length).toBe(0);                       // 恢复不该再打网络

    const h2 = makeHarness({ stored: newer, manifest: { version: '2.2.3.1', manifest_version: 2,
                                                        background: { persistent: true, scripts: [] } } });
    await h2.ctx.initUpdateCard();
    await flush();
    expect(h2.el('updateHint').textContent).toContain('点「检查更新」');
    expect(h2.el('updateDownloadBtn').style.display).toBe('none');
  });
});
