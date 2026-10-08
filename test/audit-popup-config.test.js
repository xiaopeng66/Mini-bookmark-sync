const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash, webcrypto } = require('node:crypto');
const { setImmediate } = require('node:timers');

const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const popup = source('popup.js');
function section(start, end) {
  const a = popup.indexOf(start), b = popup.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error('Popup section not found: ' + start);
  return popup.slice(a, b);
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const baseConfig = () => ({
  webdav_url: 'https://dav.invalid/base', webdav_user: 'alice', webdav_password: 'synthetic-pass',
  webdav_bookmark_path: '/folder', bookmark_target_id: '42', ever_connected: true, last_sync_count: 2,
  webdav_config: { url: 'https://dav.invalid/base', username: 'alice', password: 'synthetic-pass', filename: '/folder/own.xbel' }
});
// Independent digest fixture: this must not be computed by the utility under test.
const originalKey = createHash('sha256').update(JSON.stringify({
  url: 'https://dav.invalid/base', username: 'alice', password: 'synthetic-pass',
  filename: '/folder/own.xbel', bucketId: '42'
})).digest('hex');

function harness(initial = baseConfig()) {
  const state = structuredClone(initial), statuses = [], messages = [], tasks = new Set();
  let listener, response = () => ({ ok: true }), nextRemoval;
  function emit(changes) { if (listener && Object.keys(changes).length) listener(changes, 'local'); }
  const local = {
    get(keys, callback) {
      const result = Object.fromEntries(keys.filter(key => Object.hasOwn(state, key)).map(key => [key, structuredClone(state[key])]));
      if (callback) callback(result);
      return Promise.resolve(result);
    },
    set(patch, callback) {
      const changes = {};
      for (const [key, value] of Object.entries(patch)) {
        if (JSON.stringify(state[key]) !== JSON.stringify(value)) changes[key] = { oldValue: state[key], newValue: value };
        state[key] = structuredClone(value);
      }
      emit(changes);
      if (callback) callback();
      return Promise.resolve();
    },
    remove(keys, callback) {
      const gate = nextRemoval; nextRemoval = undefined;
      const apply = () => {
        const changes = {};
        for (const key of [].concat(keys)) {
          if (Object.hasOwn(state, key)) changes[key] = { oldValue: state[key] };
          delete state[key];
        }
        emit(changes);
        if (callback) callback();
      };
      if (gate) return gate.promise.then(apply);
      apply();
      return Promise.resolve();
    }
  };
  const ctx = {
    console, URL, TextEncoder, crypto: webcrypto, setTimeout, clearTimeout,
    homeView: { classList: { contains: () => false } },
    chrome: { runtime: { lastError: null, async sendMessage(message) {
      if (message.action !== 'checkConfig') throw new Error('Unexpected message: ' + message.action);
      messages.push(structuredClone(message));
      return response(message);
    } }, storage: { local, onChanged: { addListener(fn) { listener = fn; } } } },
    setStatus(text, level) { statuses.push({ text, level }); }, renderProgressLine() {}, renderLastSync() {},
    renderHome: result => !!(result.webdav_url && result.webdav_user && result.webdav_password),
    renderAutoSync() {}, renderBadge() {}, setSyncBtnBusy() {}, startStatusPolling() {},
    syncEndpointsFromCloud() {}, SYNC_ACTION_LABELS: {}
  };
  vm.createContext(ctx);
  for (const file of ['lib/constants.js', 'lib/utils.js', 'core/storage.js']) {
    vm.runInContext(source(file), ctx, { filename: file });
  }
  vm.runInContext(section('const STATUS_PROBE_TTL =', '// 显示/隐藏操作记录行'), ctx, { filename: 'popup.js' });
  vm.runInContext(section('async function loadAll()', '// ========== 配置表单草稿'), ctx, { filename: 'popup.js' });
  vm.runInContext(section('chrome.storage.onChanged.addListener', '// "上次同步"'), ctx, { filename: 'popup.js' });
  // Track real popup entry points; only browser storage/network/DOM are synthetic.
  for (const name of ['loadAll', 'updateHomeStatus']) {
    const real = ctx[name];
    ctx[name] = (...args) => {
      const task = real(...args); tasks.add(task);
      task.then(() => tasks.delete(task), () => tasks.delete(task));
      return task;
    };
  }
  const settle = async () => {
    for (let i = 0; i < 10; i++) {
      await new Promise(setImmediate);
      if (!tasks.size) return;
      await Promise.all([...tasks]);
    }
    throw new Error('Popup did not settle');
  };
  return { state, ctx, statuses, messages, local, settle,
    show: () => ctx.updateHomeStatus(),
    respond(fn) { response = fn; },
    holdNextRemoval() { const gate = deferred(); nextRemoval = gate; return gate; }
  };
}
async function waitFor(predicate) {
  for (let i = 0; i < 1000; i++) {
    if (predicate()) return;
    await new Promise(setImmediate);
  }
  throw new Error('Expected popup event did not occur');
}

afterEach(() => { vi.useRealTimers(); });
beforeEach(() => { vi.useFakeTimers(); });

const configChanges = [
  ['webdav_url', { webdav_url: 'https://other.invalid/base' }],
  ['webdav_user', { webdav_user: 'bob' }],
  ['webdav_password', { webdav_password: 'new-synthetic-pass' }],
  ['webdav_bookmark_path', { webdav_bookmark_path: '/moved' }],
  ['webdav_config', { webdav_config: { ...baseConfig().webdav_config, filename: '/folder/other.xbel' } }],
  ['bookmark_target_id', { bookmark_target_id: '43' }]
];

describe('popup configuration identity integration', () => {
  test('real SYNCING capture survives partial completion and reopened popup', async () => {
    const h = harness();
    await h.ctx.MiniSync.storage.setSyncStatus({ status: 'syncing', action: 'merge' });
    expect(h.state.sync_status_config_key).toBe(originalKey);
    await h.ctx.MiniSync.storage.setSyncStatus({ status: 'partial', partial: true, error: 'Synthetic bridge failed' });
    const reopened = harness(h.state);
    await reopened.show();
    expect(reopened.statuses.at(-1)).toEqual({ text: 'Synthetic bridge failed', level: 'warn' });
    expect(reopened.messages).toHaveLength(0);
  });

  test('midflight configuration switch retains original operation identity and reopened popup probes current target', async () => {
    const h = harness();
    await h.ctx.MiniSync.storage.setSyncStatus({ status: 'syncing', action: 'upload' });
    await h.local.set({ webdav_url: 'https://other.invalid/base', bookmark_target_id: '43' });
    await h.settle();
    await h.ctx.MiniSync.storage.setSyncStatus({ status: 'partial', partial: true, error: 'Old bridge failed' });
    expect(h.state.sync_status_config_key).toBe(originalKey);
    const reopened = harness(h.state);
    await reopened.show();
    expect(reopened.messages).toHaveLength(1);
    expect(reopened.messages[0].webdavUrl).toBe('https://other.invalid/base');
    expect(reopened.statuses.at(-1).level).toBe('ok');
  });

  test.each(['stale', undefined])('reopened partial with %s key permits a current probe', async key => {
    const h = harness({ ...baseConfig(), sync_status: 'partial', sync_status_config_key: key, sync_error: 'Old bridge failed' });
    await h.show();
    expect(h.messages).toHaveLength(1);
    expect(h.statuses.at(-1).level).toBe('ok');
  });

  test.each(configChanges)('%s change invalidates live and persisted success caches', async (key, patch) => {
    const h = harness();
    await h.show();
    expect(h.messages).toHaveLength(1);
    expect(h.state.conn_probe_cache.ok).toBe(true);
    h.respond(() => ({ ok: false }));
    await h.local.set(patch);
    await h.settle();
    expect(h.messages).toHaveLength(2);
    expect(h.statuses.at(-1).text).toBe('配置未就绪');
    expect(h.state.conn_probe_cache).toBeUndefined();
  });

  test.each(configChanges)('%s change refreshes a matching partial warning', async (key, patch) => {
    const h = harness();
    await h.ctx.MiniSync.storage.setSyncStatus({ status: 'syncing', action: 'merge' });
    await h.ctx.MiniSync.storage.setSyncStatus({ status: 'partial', partial: true, error: 'Synthetic bridge failed' });
    await h.show();
    expect(h.statuses.at(-1).level).toBe('warn');
    expect(h.messages).toHaveLength(0);
    await h.local.set(patch);
    await h.settle();
    expect(h.messages).toHaveLength(1);
    expect(h.statuses.at(-1).level).toBe('ok');
  });

  test('persisted probe identity is opaque and includes credentials without plaintext', async () => {
    const h = harness();
    await h.show();
    expect(h.state.conn_probe_cache.key).toBe(originalKey);
    expect(JSON.stringify(h.state.conn_probe_cache)).not.toContain('synthetic-pass');
  });

  test('late old response cannot repaint or repopulate cache while configuration invalidation is pending', async () => {
    const h = harness(), oldResponse = deferred();
    h.respond(() => oldResponse.promise);
    const oldShow = h.show();
    await waitFor(() => h.messages.length === 1);
    const removal = h.holdNextRemoval();
    h.respond(() => ({ ok: false }));
    h.statuses.length = 0;
    await h.local.set({ webdav_password: 'new-synthetic-pass' });
    oldResponse.resolve({ ok: true });
    await oldShow;
    expect(h.statuses.some(status => status.level === 'ok')).toBe(false);
    expect(h.state.conn_probe_cache).toBeUndefined();
    removal.resolve();
    await h.settle();
    expect(h.messages).toHaveLength(2);
    expect(h.statuses.at(-1).text).toBe('配置未就绪');
    expect(h.state.conn_probe_cache).toBeUndefined();
    // The old coalesced request must not seed a success for the new configuration.
    await h.show();
    expect(h.statuses.at(-1).text).toBe('配置未就绪');
  });

  test('superseded asynchronous cache removal does not launch an obsolete refresh', async () => {
    const h = harness();
    await h.show();
    const firstRemoval = h.holdNextRemoval();
    await h.local.set({ webdav_password: 'intermediate-pass' });
    h.respond(() => ({ ok: false }));
    await h.local.set({ webdav_password: 'latest-pass' });
    await h.settle();
    expect(h.messages).toHaveLength(2);
    expect(h.messages.at(-1).webdavPassword).toBe('latest-pass');
    firstRemoval.resolve();
    await h.settle();
    expect(h.messages).toHaveLength(2);
    expect(h.statuses.at(-1).text).toBe('配置未就绪');
  });
});
