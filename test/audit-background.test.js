const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const source = name => fs.readFileSync(path.join(ROOT, name), 'utf8');

function moveRuntime(withRemoved = true) {
  const oldTree = [
    { id: 'a', parentId: 'root', title: 'A', isFolder: true, source: 'bar' },
    { id: 'b', parentId: 'root', title: 'B', isFolder: true, source: 'bar' },
    { id: 'f', parentId: 'a', title: 'Folder', isFolder: true, source: 'bar' },
    { id: 'n', parentId: 'f', title: 'Link', url: 'https://example.invalid/', source: 'bar' }
  ];
  const current = JSON.parse(JSON.stringify(oldTree));
  current[2].parentId = 'b';
  const state = { sync_snapshots: { localTree: oldTree }, sync_tombstones: [
    { key: 'ROOT:bar/F:A/F:Folder/L:https://example.invalid/' },
    { key: 'ROOT:bar/F:B/F:Folder/L:https://example.invalid/' },
    { key: 'ROOT:bar/L:https://unrelated.invalid/' }
  ] };
  let moved;
  const ctx = { console, HAS_BOOKMARKS_API: true, SYNCING: 'syncing', Date, Set, Map,
    STORAGE_KEYS: { TOMBSTONES: 'sync_tombstones', SNAPSHOTS: 'sync_snapshots' },
    chrome: { bookmarks: { onMoved: { addListener(fn) { moved = fn; } },
      ...(withRemoved ? { onRemoved: { addListener() {} } } : {}),
      getTree(cb) { cb([{ id: '0', children: [] }]); }
    } },
    MiniSync: { storage: {
      async getSyncStatus() { return { status: 'idle' }; },
      async getLocal() { return state; },
      async setLocal(data) { Object.assign(state, data); },
      async getDeviceId() { return 'device'; }
    }, orchestrator: { async saveLocalSnapshot() {}, async getChromeTree() { return []; } },
    utils: {}, syncInput: { async getChromeTree() { return []; } },
    merger: { chromeTreeToList() { return current; } }, xbel: { chromeTreeToList() { return current; } } },
    handleBookmarkRemoved() {}, setTimeout, clearTimeout
  };
  vm.createContext(ctx);
  vm.runInContext(source('lib/constants.js'), ctx);
  vm.runInContext(source('model/xbel-path.js'), ctx);
  ctx.MiniSync.xbel = { normalizeUrl: u => u, chromeTreeToList: () => current };
  const bg = source('background.js');
  vm.runInContext(bg.slice(bg.indexOf('if (HAS_BOOKMARKS_API && chrome.bookmarks.onRemoved'), bg.indexOf('// ====== 工具栏图标状态徽章')), ctx);
  return { ctx, state, oldTree: JSON.parse(JSON.stringify(oldTree)), getMoved: () => moved };
}

describe('audit background movement', () => {
  test('standard moveInfo records both paths of every descendant without changing successful baseline', async () => {
    const r = moveRuntime();
    r.getMoved()('f', { parentId: 'b', oldParentId: 'a', index: 0, oldIndex: 0 });
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(Object.keys(r.state.sync_move_intents || {})).toEqual(expect.arrayContaining([
      'ROOT:bar/F:A/F:Folder', 'ROOT:bar/F:B/F:Folder',
      'ROOT:bar/F:A/F:Folder/L:https://example.invalid/',
      'ROOT:bar/F:B/F:Folder/L:https://example.invalid/'
    ]));
    expect(r.state.sync_snapshots.localTree).toEqual(r.oldTree);
    expect(r.state.sync_tombstones).toEqual([{ key: 'ROOT:bar/L:https://unrelated.invalid/' }]);
  });
  test('movement is registered when host has no onRemoved event', () => {
    expect(typeof moveRuntime(false).getMoved()).toBe('function');
  });
});

describe('audit action partial logs', () => {
  test.each(['uploadBookmarks', 'downloadBookmarks', 'mergeSync'])('%s preserves per-file partial result in persistent ledger', async method => {
    const state = {};
    const result = { success: true, partial: true, message: 'Main committed; bridge failed', bookmarkCount: 2,
      stats: {}, bridgeResults: { berry: { status: 'failed', error: 'HTTP 503' } } };
    const ctx = { console, Date, setTimeout, MiniSync: {
      storage: { async getLocal() { return state; }, async setLocal(data) { Object.assign(state, data); },
        async getWebdavConfig() { return { url: 'https://dav.invalid/' }; } },
      utils: { async hasHostPermission() { return { ok: true, granted: true }; } },
      orchestrator: { [method]: async () => result }
    } };
    vm.createContext(ctx);
    vm.runInContext(source('lib/sync-actions.js'), ctx);
    const actual = await ctx.MiniSync.actions[method]({});
    expect(actual.partial).toBe(true);
    expect(state.sync_log[0]).toMatchObject({ partial: true, bridgeResults: result.bridgeResults, message: result.message });
  });
});

test('startup restores the actual saved backup and preserves it when recovery has conflicts', async () => {
  const state = { local_bookmark_backup: [{ id: '0', children: [] }] };
  let restores = 0;
  const ctx = { console, MiniSync: { storage: {
    async getLocal(keys) { return Object.fromEntries(keys.filter(k => k in state).map(k => [k, state[k]])); },
    async removeLocal(keys) { keys.forEach(k => delete state[k]); }
  }, orchestrator: { async restoreLocalBackup() { restores++; return { ok: false, restored: 1, conflicts: ['failure'] }; } } },
    async countLocalBookmarks() { return 0; } };
  vm.createContext(ctx);
  vm.runInContext(source('lib/constants.js'), ctx);
  const bg = source('background.js');
  vm.runInContext(bg.slice(bg.indexOf('async function startupRecovery()'), bg.indexOf('// 初始化', bg.indexOf('async function startupRecovery()'))), ctx);
  await ctx.startupRecovery();
  expect(restores).toBe(1);
  expect(state.local_bookmark_backup).toBeDefined();
});

function backgroundMessageCase(action, extras = {}) {
  const ctx = { URL, setTimeout, clearTimeout, chrome: { runtime: { id: 'test', getManifest() { return { version: '2.2.0', manifest_version: 3 }; } } },
    MiniSync: { storage: { async getLocal() { return { webdav_url: 'https://user:password@dav.invalid/path?token=secret#private' }; } },
      utils: { async hasHostPermission() { return { ok: true }; } },
      orchestrator: { async restoreLocalBackup() { return { ok: false, restored: 1, conflicts: ['failed'] }; } } },
    async countLocalBookmarks() { return 0; }, async describeAutoAlarm() { return {}; },
    _bgBoot: { stage: 'ready', loads: [] }, _bgMsgCount: 0, _bgLastMessage: null,
    _bgErrors: [{ message: 'password secret private bookmark' }], HAS_BOOKMARKS_API: true,
    ...extras };
  vm.createContext(ctx);
  vm.runInContext(source('lib/utils.js'), ctx);
  const bg = source('background.js');
  const start = bg.indexOf("case '" + action + "':");
  const end = bg.indexOf('\n    case ', start + 6);
  vm.runInContext('async function invoke() { let output; const sendResponse = value => { output = value; }; let work; const handleAsyncResponse = (send, fn) => { work = fn().then(send); }; (() => { switch (' + JSON.stringify(action) + ') {' + bg.slice(start, end) + '} })(); await work; return output; }', ctx);
  return ctx;
}

test('background diagnostics sanitize credential-bearing URLs and raw module errors at the message boundary', async () => {
  const result = await backgroundMessageCase('diagnose').invoke();
  expect(result.webdavUrl).toBe('https://dav.invalid/path');
  expect(JSON.stringify(result)).not.toMatch(/password|secret|private bookmark|user:/);
});

test('backup restoration with conflicts is reported as failure even after some entries restored', async () => {
  const result = await backgroundMessageCase('restoreFromBackup').invoke();
  expect(result.success).toBe(false);
  expect(result.restored).toBe(1);
  expect(result.conflicts).toEqual(['failed']);
});

test('popup missing-response ledger recovery retains a partial warning and per-file results', async () => {
  const statuses = [];
  const recovered = { success: true, partial: true, message: 'Bridge failed',
    bridgeResults: { berry: { status: 'failed' } }, bookmarkCount: 2 };
  const ctx = { URL, setTimeout, clearTimeout, console, chrome: { runtime: { async sendMessage() {} } },
    setStatus() {}, renderProgressLine() {}, applySyncResult(action, label, status, result) { statuses.push({ status, result }); } };
  vm.createContext(ctx);
  vm.runInContext(source('lib/utils.js'), ctx);
  const popup = source('popup.js');
  vm.runInContext(popup.slice(popup.indexOf('const SYNC_ACTION_LABELS ='), popup.indexOf('// 同步结果落地：状态行')), ctx);
  ctx.recoverSyncResultFromLedger = async () => recovered;
  await ctx.runSyncAction('merge');
  expect(statuses[0].status.level).toBe('warn');
  expect(statuses[0].status.text).toContain('Bridge failed');
  expect(statuses[0].result.bridgeResults).toEqual(recovered.bridgeResults);
});

test('reopened popup retains persisted bridge partial warning instead of painting connection success', async () => {
  const statuses = [];
  let probes = 0;
  const state = { webdav_url: 'https://dav.invalid/', webdav_user: 'u', webdav_password: 'p',
    last_sync_count: 2, sync_status: 'partial', sync_error: 'Bridge failed', sync_partial: true,
    sync_bridge_results: { berry: { status: 'failed' } }, sync_status_config_key: 'current' };
  const ctx = { homeView: { classList: { contains() { return false; } } }, CONN_CACHE_STORAGE_KEY: 'cache',
    chrome: { storage: { local: { async get() { return state; }, async set() {} } },
      runtime: { async sendMessage() { probes++; return { ok: true }; } } },
    setStatus(text, level) { statuses.push({ text, level }); }, renderProgressLine() {},
    statusProbeKey() { return 'key'; }, _statusProbe: { async run(key, fn) { return fn(); } },
    MiniSync: { utils: { pickConnStatus() { return { text: 'Connected', level: 'ok' }; },
      async raceHardTimeout(p) { return p; }, async syncStatusConfigKey() { return 'current'; }, connCacheFromResult() { return null; } } },
    CONN_PROBE_HARD_MS: 1, renderBusySync() {} };
  vm.createContext(ctx);
  const popup = source('popup.js');
  vm.runInContext(popup.slice(popup.indexOf('async function updateHomeStatus()'), popup.indexOf('// 显示/隐藏操作记录行')), ctx);
  await ctx.updateHomeStatus();
  expect(statuses.at(-1)).toEqual({ text: 'Bridge failed', level: 'warn' });
  expect(probes).toBe(0);
});

function popupSaveRuntime(folder = '/custom') {
  const state = { webdav_config: { url: 'https://dav.invalid/', username: 'u', password: 'p', filename: '/custom/own.xbel' },
    webdav_url: 'https://dav.invalid/', webdav_user: 'u', webdav_password: 'p', webdav_bookmark_path: '/custom' };
  const fields = { webdav_url: { value: 'https://dav.invalid/' }, webdav_user: { value: 'u' },
    webdav_password: { value: 'p' }, webdav_path: { value: folder } };
  const ctx = { URL, console, DEFAULT_FILENAME: 'minibookmarks.xbel', LEGACY_DEFAULT_FILENAME: 'bookmarks.xbel',
    chrome: { storage: { local: { async get() { return state; }, async set(patch) { Object.assign(state, patch); }, async remove() {} } },
      runtime: { async sendMessage() {} } }, saveBtn: {}, document: { getElementById(id) { return fields[id]; } },
    syncEnabledCb: { checked: true }, intervalSelect: { value: '30' }, syncTypeSelect: { value: 'merge' },
    sanitizeFolderPathInput(value) { return { path: value, corrected: false }; }, setConfigStatus() {},
    async clearDraft() {}, updateDirtyUI() {}, _statusProbe: { invalidate() {} }, CONN_CACHE_STORAGE_KEY: 'cache',
    setTimeout() {}, showHome() {}, savedBaseline: null };
  vm.createContext(ctx);
  vm.runInContext(source('lib/utils.js'), ctx);
  ctx.MiniSync.utils.requestHostPermission = async () => true;
  const popup = source('popup.js');
  vm.runInContext(popup.slice(popup.indexOf('saveBtn.onclick ='), popup.indexOf('clearConfigBtn.onclick =')), ctx);
  return { state, save: () => ctx.saveBtn.onclick() };
}

test.each(['/custom', '/moved'])('popup save preserves custom basename in folder %s', async folder => {
  const r = popupSaveRuntime(folder);
  await r.save();
  expect(r.state.webdav_config.filename).toBe(folder + '/own.xbel');
  expect(r.state.webdav_bookmark_path).toBe(folder);
});

test.each(['old-target', undefined])('popup probes current configuration instead of stale partial key %s', async oldKey => {
  const statuses = [];
  let probes = 0;
  const ctx = { URL, homeView: { classList: { contains() { return false; } } }, CONN_CACHE_STORAGE_KEY: 'cache',
    chrome: { storage: { local: { async get() { return { webdav_url: 'https://new.invalid/', webdav_user: 'u',
      webdav_password: 'p', sync_status: 'partial', sync_error: 'Old bridge failed', sync_status_config_key: oldKey }; }, async set() {} } },
      runtime: { async sendMessage() { probes++; return { ok: true }; } } },
    setStatus(text, level) { statuses.push({ text, level }); }, renderProgressLine() {}, statusProbeKey() { return 'new'; },
    _statusProbe: { async run(key, fn) { return fn(); } }, CONN_PROBE_HARD_MS: 1, renderBusySync() {} };
  vm.createContext(ctx);
  vm.runInContext(source('lib/utils.js'), ctx);
  Object.assign(ctx.MiniSync.utils, { async syncStatusConfigKey() { return 'current'; }, pickConnStatus() { return { text: 'Checking' }; },
    async raceHardTimeout(p) { return p; }, connCacheFromResult() { return null; } });
  const popup = source('popup.js');
  vm.runInContext(popup.slice(popup.indexOf('async function updateHomeStatus()'), popup.indexOf('// 显示/隐藏操作记录行')), ctx);
  await ctx.updateHomeStatus();
  expect(probes).toBe(1);
  expect(statuses.at(-1).level).toBe('ok');
  expect(statuses.at(-1).text).not.toContain('Old bridge');
});

test('popup polling displays partial completion as warning, not full success', async () => {
  let tick;
  const statuses = [];
  const ctx = { statusPollTimer: null, setInterval(fn) { tick = fn; return 1; }, clearInterval() {},
    chrome: { runtime: { async sendMessage() { return { data: { status: 'partial', lastSyncTime: 100, error: 'Bridge failed' } }; } },
      storage: { local: { async get() { return { last_sync_count: 2 }; } } } },
    setSyncBtnBusy() {}, setStatus(text, level) { statuses.push({ text, level }); },
    renderLastSync() {}, renderProgressLine() {}, updateHomeStatus() {},
    SYNC_ACTION_LABELS: { merge: { successTag: 'Complete', failPrefix: 'Failed:' } }
  };
  vm.createContext(ctx);
  const popup = source('popup.js');
  vm.runInContext(popup.slice(popup.indexOf('const STATUS_POLL_MAX_TICKS'), popup.indexOf('// ★ 连通性探测')), ctx);
  ctx.startStatusPolling('merge', 100);
  await tick();
  expect(statuses.at(-1).level).toBe('warn');
  expect(statuses.at(-1).text).toContain('Bridge failed');
});
