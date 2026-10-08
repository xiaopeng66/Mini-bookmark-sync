const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const options = fs.readFileSync(path.join(root, 'options.js'), 'utf8');
function section(start, end) {
  const a = options.indexOf(start), b = options.indexOf(end, a + start.length);
  if (a < 0 || b <= a) throw new Error('Options section not found: ' + start);
  return options.slice(a, b);
}
function harness(initial = {}) {
  const store = { ...initial }, elements = new Map(), messages = [], prompts = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      id, textContent: '', innerHTML: '', value: '', files: [], style: {}, handlers: {},
      classList: { flags: new Set(), add(x) { this.flags.add(x); }, remove(x) { this.flags.delete(x); }, contains(x) { return this.flags.has(x); }, toggle(x, force) { const on = force === undefined ? !this.flags.has(x) : !!force; if (on) this.flags.add(x); else this.flags.delete(x); return on; } },
      addEventListener(k, fn) { this.handlers[k] = fn; }, appendChild() {}
    });
    return elements.get(id);
  };
  const chrome = {
    runtime: { lastError: null, sendMessage: async m => { messages.push(m); return { exists: true, folderExists: true }; } },
    storage: { local: {
      get(keys, cb) { const result = {}; for (const key of keys) if (Object.hasOwn(store, key)) result[key] = store[key]; if (cb) cb(result); return Promise.resolve(result); },
      set(patch, cb) { Object.assign(store, patch); if (cb) cb(); return Promise.resolve(); },
      remove(key) { delete store[key]; return Promise.resolve(); }
    } }
  };
  const ctx = {
    chrome, console, URL, crypto: webcrypto, TextEncoder, setTimeout: () => 0, clearTimeout: () => {},
    document: { getElementById: element, createElement: () => ({}) },
    window: { confirm(text) { prompts.push(text); return true; } },
    location: { reload() {} },
    cachedProbe: async (key, force, fn) => fn(),
    normalizeBookmarkPath: p => p.startsWith('/') ? p : '/' + p,
    PLUGIN_FILE: 'minibookmarks.xbel', AIRA_FILE: 'snapshot.json',
    listWebDAVFolders: async () => ['/new'],
    setBackupResult(text) { element('backupResult').textContent = text; }
  };
  vm.createContext(ctx);
  for (const file of ['lib/constants.js', 'lib/utils.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), ctx, { filename: file });
  }
  return { ctx, store, element, messages, prompts, chrome, run: code => vm.runInContext(code, ctx, { filename: 'options.js' }) };
}
const backup = config => JSON.stringify({ app: 'minibookmark-sync', kind: 'config-backup', version: 1, config });

describe('settings audit regressions', () => {
  test('partial import to a different origin clears absent credentials, pauses sync, and previews target', async () => {
    const h = harness({ webdav_url: 'https://old.invalid/dav', webdav_user: 'old-user', webdav_password: 'old-secret', sync_enabled: true,
      webdav_config: { url: 'https://old.invalid/dav', username: 'old-user', password: 'old-secret', filename: '/custom/data.xbel' } });
    h.run(section("document.getElementById('importConfigFile')?.addEventListener", '// ========== 初始化'));
    await h.element('importConfigFile').handlers.change({ target: { files: [{ text: async () => backup({ webdav_url: 'https://new.invalid/dav', sync_enabled: true }) }] } });
    expect(h.store.webdav_user).toBe('');
    expect(h.store.webdav_password).toBe('');
    expect(h.store.sync_enabled).toBe(false);
    expect(h.prompts[0]).toContain('old.invalid');
    expect(h.prompts[0]).toContain('new.invalid');
    expect(h.prompts[0]).toMatch(/凭据|密码/);
    expect((await h.ctx.MiniSync.utils.getWebDAVConfig()).password).toBe('');
    expect(h.messages.some(m => m.action === 'updateSyncInterval')).toBe(true);
  });

  test('changing account without supplied password does not reuse old password', () => {
    const h = harness();
    const result = h.ctx.MiniSync.utils.prepareConfigImport({ webdav_user: 'new-user', sync_enabled: true },
      { webdav_url: 'https://same.invalid/dav', webdav_user: 'old-user', webdav_password: 'old-secret', sync_enabled: true });
    expect(result.patch.webdav_password).toBe('');
    expect(result.patch.sync_enabled).toBe(false);
  });

  test('flat folder picker and shared reader agree on custom basename and explicit empty fields', async () => {
    const h = harness({ webdav_url: 'https://dav.invalid', webdav_user: 'u', webdav_password: '', webdav_bookmark_path: '/old',
      webdav_config: { url: 'https://dav.invalid', username: 'u', password: 'stale-secret', filename: '/old/custom.xbel' } });
    h.run(section('function initFolderPicker(opts)', '// ========== Berry 文件夹选择器'));
    const opts = { pathEl: h.element('path'), selectWrap: h.element('wrap'), selectEl: h.element('select'),
      btn: h.element('button'), storageKey: 'webdav_bookmark_path', defaultPath: '/minibookmark' };
    h.ctx.initFolderPicker(opts);
    await opts.btn.handlers.click(); opts.selectEl.value = '/new'; await opts.btn.handlers.click();
    const resolved = await h.ctx.MiniSync.utils.getWebDAVConfig();
    expect(resolved.filename).toBe('/new/custom.xbel');
    expect(h.store.webdav_config.filename).toBe('/new/custom.xbel');
    expect(resolved.password).toBe('');
    expect(h.store.webdav_config.password).toBe('');
    expect(h.messages.some(m => m.action === 'setEndpointFolder')).toBe(false);
  });

  test('main cloud probe targets the configured custom basename', async () => {
    const h = harness({ webdav_config: { url: 'https://dav.invalid', username: 'u', password: 'p', filename: '/custom/own.xbel' } });
    h.run(section('async function readWebDAVConfig()', '// ========== 配置 Keys'));
    h.run(section('async function checkCloudStatus(force)', '// Berry 文件状态'));
    await h.ctx.checkCloudStatus(true);
    expect(h.messages.some(m => m.action === 'checkFileExists' && m.path === '/custom' && m.file === 'own.xbel')).toBe(true);
  });

  test('settings overview displays the resolved nested main folder', async () => {
    const h = harness({ webdav_config: { url: 'https://dav.invalid', username: 'u', password: 'p', filename: '/custom/own.xbel' } });
    h.run(section('async function readWebDAVConfig()', '// ========== 配置 Keys'));
    Object.assign(h.ctx, {
      DEVICE_ID_KEY: 'sync_device_id', desktopSwitch: null,
      setText() {}, updateAutoSyncOverview() {}, initAppPasswordToggle() {},
      queryBookmarkCountWithRetry: async () => ({ count: 0 }),
      checkConnection: async () => {}, checkCloudStatus: async () => {}, loadLastAction: async () => {},
      checkBerryFile: async () => {}, checkViaFile: async () => {}, checkAiraFile: async () => {}
    });
    h.run(section('async function loadPage()', 'function initAppPasswordToggle(password)'));
    await h.ctx.loadPage();
    expect(h.element('chromeFolder').textContent).toBe('/custom');
  });

  test('diagnostic handler never renders or copies a thrown raw secret', async () => {
    const h = harness();
    h.ctx.navigator = {};
    h.ctx.MiniSync.utils.collectDiagnostics = async () => { throw new Error('GET https://u:pw@dav.invalid/?token=secret#frag failed'); };
    h.run(section('const diagHintDefault', '// 「授权域名访问」按钮'));
    await h.element('diagBtn').handlers.click();
    const text = h.element('diagOut').textContent;
    expect(text).toContain('诊断本身出错');
    expect(text).not.toMatch(/u:pw|token=secret|#frag|failed/);
  });

  test('Aira offline probe preserves enabled preference and leading-slash custom path', async () => {
    const h = harness({ option_aira_enabled: true, aira_folder_path: '/custom/g3/bookmarks' });
    h.run(section('async function checkAiraFile(force)', '// 最近一次操作'));
    h.chrome.runtime.sendMessage = async m => { h.messages.push(m); throw Error('offline'); };
    await h.ctx.checkAiraFile(true);
    expect(h.store.option_aira_enabled).toBe(true);
    expect(h.store.aira_folder_path).toBe('/custom/g3/bookmarks');
    h.chrome.runtime.sendMessage = async m => { h.messages.push(m); return { exists: true, folderExists: true }; };
    await h.ctx.checkAiraFile(true);
    expect(h.store.option_aira_enabled).toBe(true);
    expect(h.messages.some(m => m.path === '/custom/g3/bookmarks')).toBe(true);
    expect(h.messages.some(m => m.path === '/custom/g2/personalization')).toBe(true);
  });

  test('diagnostics omit bookmark samples and sanitize nested URLs and error strings', async () => {
    const h = harness({ last_write_report: { failedWrites: 1, conflictSamples: ['Private title https://private.invalid/?token=sample-secret'] },
      auto_sync_report: { at: Date.now(), alarm: { lastError: 'GET https://user:password@dav.invalid/file?token=error-secret#frag failed' } } });
    h.chrome.bookmarks = { getTree: cb => cb([{ id: '0', children: [{ id: '2', title: 'Secret folder', children: [{ title: 'Private title', url: 'https://private.invalid/?token=sample-secret' }] }] }]) };
    h.chrome.runtime.sendMessage = async m => m.action === 'diagnose'
      ? { ok: true, webdavUrl: 'https://user:password@dav.invalid/file?token=raw-secret#frag', error: 'login password failed' }
      : { ok: true };
    const rep = await h.ctx.MiniSync.utils.collectDiagnostics({ messageTimeoutMs: 30 });
    const printed = JSON.stringify(rep);
    for (const secret of ['Private title', 'Secret folder', 'sample-secret', 'raw-secret', 'error-secret', 'password', '#frag']) {
      expect(printed).not.toContain(secret);
    }
    expect(rep.bookmarkTreeProbe.children[0].urlCount).toBe(1);
    expect(rep.bookmarkTreeProbe.children[0].sample).toBeUndefined();
    expect(rep.backgroundSelfCheck.webdavUrl).toContain('dav.invalid');
  });

  test('device ID generation is single-flight and rejects storage write failure', async () => {
    const h = harness();
    const pending = [];
    h.chrome.storage.local.set = (v, cb) => { pending.push({ v, cb }); };
    const first = h.ctx.MiniSync.utils.generateDeviceId();
    const second = h.ctx.MiniSync.utils.getDeviceId();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(pending.length).toBeGreaterThan(0);
    for (let i = 0; i < pending.length; i++) {
      Object.assign(h.store, pending[i].v);
      pending[i].cb();
      await Promise.resolve();
    }
    const [a, b] = await Promise.all([first, second]);
    expect(pending).toHaveLength(1);
    expect(a).toBe(b);
    expect(typeof h.store.sync_device_id).toBe('string');
    expect(h.store.sync_device_id).toBe(a);

    delete h.store.sync_device_id;
    h.chrome.storage.local.set = (v, cb) => { h.chrome.runtime.lastError = { message: 'quota' }; cb(); h.chrome.runtime.lastError = null; };
    await expect(h.ctx.MiniSync.utils.generateDeviceId()).rejects.toThrow('quota');
  });

  test('explicit empty imported fields override stale nested values without changing custom basename', () => {
    const h = harness();
    const current = { webdav_config: { url: 'https://old.invalid', username: 'old', password: 'old-secret', filename: '/old/custom.xbel' } };
    const result = h.ctx.MiniSync.utils.prepareConfigImport({ webdav_url: '', webdav_user: '', webdav_password: '', webdav_bookmark_path: '' }, current);
    expect(result.patch).toMatchObject({ webdav_url: '', webdav_user: '', webdav_password: '', webdav_bookmark_path: '', sync_enabled: false });
    expect(result.patch.webdav_config).toMatchObject({ url: '', username: '', password: '', filename: 'custom.xbel' });
  });

  test('same-target import retains existing credentials, and an account switch cannot inherit a password', async () => {
    const h = harness({ webdav_url: 'https://same.invalid/dav', webdav_user: 'old', webdav_password: 'old-secret', sync_enabled: true,
      webdav_config: { url: 'https://same.invalid/dav', username: 'old', password: 'old-secret', filename: '/old/custom.xbel' } });
    const same = h.ctx.MiniSync.utils.prepareConfigImport({ sync_interval: 60 }, h.store);
    expect(same.patch.webdav_password).toBe('old-secret');
    expect(same.patch.sync_enabled).toBeUndefined();
    const switched = h.ctx.MiniSync.utils.prepareConfigImport({ webdav_user: 'new' }, h.store);
    expect(switched.patch.webdav_password).toBe('');
    expect(switched.patch.sync_enabled).toBe(false);
    expect(switched.patch.webdav_config.password).toBe('');
  });

  test('nested-only custom filename survives settings reader normalization', async () => {
    const h = harness({ webdav_config: { url: 'https://same.invalid/dav', username: 'u', password: 'p', filename: '/custom/book.xbel' } });
    h.run(section('async function readWebDAVConfig()', '// ========== 配置 Keys'));
    expect((await h.ctx.readWebDAVConfig()).path).toBe('/custom');
    expect(h.store.webdav_config.filename).toBe('/custom/book.xbel');
    expect(h.store.webdav_bookmark_path).toBe('/custom');
  });

  test('diagnostic sanitizer removes ledger titles and URL-bearing error strings recursively', () => {
    const h = harness();
    const input = { bucketTitle: 'Private folder', rootChildTitles: [{ id: '1', title: 'Private child' }],
      bgErrors: [{ message: 'GET https://u:pw@host.invalid/path?token=abc#frag failed' }],
      webdavUrl: 'https://u:pw@host.invalid/path?token=abc#frag', count: 2 };
    const result = h.ctx.MiniSync.utils.sanitizeDiagnosticValue(input);
    const printed = JSON.stringify(result);
    expect(printed).not.toMatch(/Private|u:pw|token=abc|#frag/);
    expect(result.webdavUrl).toContain('host.invalid/path');
    expect(result.count).toBe(2);
  });

  test('diagnostic sanitizer does not retain arbitrary raw exception reasons', () => {
    const h = harness();
    const result = h.ctx.MiniSync.utils.sanitizeDiagnosticValue({ ok: false,
      reason: 'ping 抛异常：GET https://user:pw@dav.invalid/data?token=abc#frag failed',
      error: 'private credential denied' });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('ping 抛异常');
    expect(JSON.stringify(result)).not.toMatch(/user:pw|token=abc|#frag|private credential|failed/);
  });

  test('non-array bookmark callbacks cannot place raw nodes in the copyable report', async () => {
    const h = harness();
    h.chrome.bookmarks = { getTree: cb => cb({ title: 'Private folder', url: 'https://u:pw@private.invalid/?token=raw#frag' }) };
    h.chrome.runtime.sendMessage = async () => ({ ok: true });
    const report = await h.ctx.MiniSync.utils.collectDiagnostics({ messageTimeoutMs: 30 });
    expect(report.bookmarksProbe.ok).toBe(false);
    expect(report.bookmarksProbe.reason).toContain('不是数组');
    expect(report.bookmarkTreeProbe.ok).toBe(false);
    expect(report.bookmarkTreeProbe.reason).toContain('没给根节点');
    expect(JSON.stringify(report)).not.toMatch(/Private folder|private.invalid|u:pw|token=raw|#frag/);
  });

  test('unknown nested reasons are anonymous while known probe codes remain useful', () => {
    const h = harness();
    const result = h.ctx.MiniSync.utils.sanitizeDiagnosticValue({ backgroundSelfCheck: {
      ok: false, reason: 'secret tenant key 123', detail: { reason: 'bookmarks: Private folder' }
    }, bookmarksProbe: { ok: false, reason: '本页没有 chrome.bookmarks.getTree' } });
    expect(JSON.stringify(result)).not.toMatch(/secret tenant|Private folder/);
    expect(result.bookmarksProbe.reason).toContain('本页没有 chrome.bookmarks.getTree');
  });

  test('failed device ID read rejects and permits a later retry', async () => {
    const h = harness();
    const original = h.chrome.storage.local.get;
    h.chrome.storage.local.get = (_, cb) => {
      h.chrome.runtime.lastError = { message: 'read quota' }; cb({}); h.chrome.runtime.lastError = null;
    };
    await expect(h.ctx.MiniSync.utils.getDeviceId()).rejects.toThrow('read quota');
    h.chrome.storage.local.get = original;
    const id = await h.ctx.MiniSync.utils.generateDeviceId();
    expect(typeof id).toBe('string');
    expect(h.store.sync_device_id).toBe(id);
  });

  test('ledger recovery preserves partial result metadata', () => {
    const h = harness();
    const bridges = [{ key: 'via', success: false }];
    const result = h.ctx.MiniSync.utils.pickSyncLogRecord([
      { action: '上传', time: 10000, success: true, partial: true, conflictCount: 2, bridgeResults: bridges, message: 'Main saved' }
    ], '上传', 10000);
    expect(result).toMatchObject({ success: true, partial: true, conflictCount: 2, bridgeResults: bridges, fromLedger: true });
  });

  test('sync status key is opaque SHA-256 and changes for each relationship field', async () => {
    const h = harness();
    const base = { webdav_url: 'https://dav.invalid/base', webdav_user: 'alice', webdav_password: 'secret-pass',
      webdav_bookmark_path: '/folder', webdav_config: { filename: '/folder/custom.xbel' }, bookmark_target_id: '42' };
    const key = await h.ctx.MiniSync.utils.syncStatusConfigKey(base);
    const expected = createHash('sha256').update(JSON.stringify({ url: base.webdav_url, username: 'alice',
      password: 'secret-pass', filename: '/folder/custom.xbel', bucketId: '42' })).digest('hex');
    expect(key).toBe(expected);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    for (const change of [
      { webdav_url: 'https://other.invalid/base' },
      { webdav_user: 'bob' },
      { webdav_password: 'another-secret' },
      { webdav_config: { filename: '/folder/other.xbel' } },
      { bookmark_target_id: '43' }
    ]) {
      expect(await h.ctx.MiniSync.utils.syncStatusConfigKey({ ...base, ...change })).not.toBe(key);
    }
    expect(JSON.stringify(h.store)).not.toContain('secret-pass');
  });

  test('sync status key agrees on equivalent resolved config and honors explicit empty fields', async () => {
    const h = harness();
    const nested = { webdav_config: { url: 'https://dav.invalid/base', username: 'alice',
      password: 'secret-pass', filename: '/folder/custom.xbel' }, bookmark_target_id: 42 };
    const flat = { ...nested, webdav_url: 'https://dav.invalid/base', webdav_user: 'alice',
      webdav_password: 'secret-pass', webdav_bookmark_path: '/folder', bookmark_target_id: '42' };
    const moved = { ...flat, webdav_bookmark_path: '/moved' };
    const nestedKey = await h.ctx.MiniSync.utils.syncStatusConfigKey(nested);
    expect(await h.ctx.MiniSync.utils.syncStatusConfigKey(flat)).toBe(nestedKey);
    expect(await h.ctx.MiniSync.utils.syncStatusConfigKey(moved)).not.toBe(nestedKey);
    expect(await h.ctx.MiniSync.utils.syncStatusConfigKey({ ...flat, webdav_password: '' })).not.toBe(nestedKey);
    expect(await h.ctx.MiniSync.utils.syncStatusConfigKey({ ...flat, webdav_user: '' })).not.toBe(nestedKey);
    expect(await h.ctx.MiniSync.utils.syncStatusConfigKey({ ...flat, webdav_url: '' })).not.toBe(nestedKey);
    expect(await h.ctx.MiniSync.utils.syncStatusConfigKey({ ...flat, webdav_bookmark_path: '' })).not.toBe(nestedKey);
  });

  test('partial result uses warning status and preserves useful message', () => {
    const h = harness();
    expect(h.ctx.MiniSync.utils.describeActionStatus({ success: true, partial: true, message: 'Main saved; bridge failed' }).level).toBe('warn');
    expect(h.ctx.MiniSync.utils.describeActionStatus({ success: true, conflictCount: 1, message: 'One conflict' }).text).toBe('One conflict');
  });
});
