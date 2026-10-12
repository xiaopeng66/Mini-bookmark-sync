const { makeDevice, response, clone } = require('./helpers/audit-harness.cjs');
const devices = [];
const tick = () => new Promise(resolve => setImmediate(resolve));
async function drain() { for (let i = 0; i < 120; i++) await Promise.resolve(); }
async function until(predicate) {
  for (let i = 0; i < 3000; i++) { if (predicate()) return; await tick(); }
  expect(predicate(), 'asynchronous operation reached its expected boundary').toBe(true);
}
async function finishAction(d, pending) {
  await until(() => pending.settled || [...d.timers.values()].some(t => t.at === d.state.now + 1000));
  await d.advance(1000);
  await until(() => pending.settled);
}
function watch(promise) {
  const result = { settled: false };
  result.promise = Promise.resolve(promise).then(value => { result.settled = true; result.value = value; }, error => { result.settled = true; result.error = error; });
  return result;
}
function device(name) {
  const d = makeDevice(name);
  let sequence = 0;
  const timers = new Map();
  d.timers = timers;
  d.sandbox.setTimeout = (fn, ms = 0) => { const id = ++sequence; timers.set(id, { fn, at: d.state.now + ms }); return id; };
  d.sandbox.clearTimeout = id => timers.delete(id);
  d.advance = async ms => {
    const target = d.state.now + ms;
    for (let i = 0; i < 1000; i++) {
      const next = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) { d.state.now = target; await drain(); return; }
      const [id, timer] = next;
      d.state.now = timer.at; timers.delete(id); timer.fn(); await drain(); await tick();
    }
    throw new Error('Manual timer budget exceeded');
  };
  const close = d.close;
  d.close = () => { timers.clear(); close(); };
  devices.push(d);
  return d;
}
afterEach(() => { for (const d of devices.splice(0)) d.close(); });
const xbel = (name, url) => `<xbel><folder><title>书签栏</title><bookmark href="${url}"><title>${name}</title></bookmark></folder></xbel>`;
async function fixture(name) {
  const d = device(name);
  await d.add('1', 'Keep', 'https://keep.invalid/');
  d.cloud.put(d.mainUrl, xbel('Keep', 'https://keep.invalid/'));
  return d;
}

for (const action of ['uploadBookmarks', 'downloadBookmarks', 'mergeSync']) {
  test.each(['get503', 'getReject', ...(action === 'downloadBookmarks' ? [] : ['put503'])])(`${action} retries a transient %s only after safe failure`, async fault => {
    const d = await fixture('transient-' + action + '-' + fault);
    if (action === 'mergeSync' && fault === 'put503') await d.add('1', 'New', 'https://new.invalid/');
    let failed = false, requests = 0;
    d.cloud.hook = req => {
      if (req.url !== d.mainUrl || req.method !== (fault === 'put503' ? 'PUT' : 'GET')) return null;
      requests++;
      if (failed) return null;
      failed = true;
      if (fault === 'getReject') throw new TypeError('Synthetic transient disconnect');
      return response(503, 'Temporarily unavailable');
    };
    const pending = watch(d.M.actions[action]({}));
    await finishAction(d, pending);
    expect(pending.settled).toBe(true);
    expect(pending.error).toBeUndefined();
    expect(pending.value.success).toBe(true);
    expect(requests).toBe(2);
    expect(d.state.store.sync_log).toHaveLength(1);
    expect(d.state.store.sync_lock_at).toBe(0);
  });
}

test.each([401, 412, 202, 207])('upload does not retry semantic or unconfirmed PUT response %s', async status => {
  const d = await fixture('no-retry-' + status);
  let requests = 0;
  d.cloud.hook = req => {
    if (req.url !== d.mainUrl || req.method !== 'PUT') return null;
    requests++; return response(status, 'Not a confirmed commit');
  };
  const pending = watch(d.M.actions.uploadBookmarks({}));
  await finishAction(d, pending);
  expect(pending.settled).toBe(true);
  expect(pending.value.success).toBe(false);
  expect(requests).toBe(1);
});

test('failed rollback prevents retry of a transient write rejection', async () => {
  const d = await fixture('no-retry-unresolved');
  await d.M.orchestrator.uploadBookmarks({});
  const removed = await d.add('1', 'Delete on cloud', 'https://remove.invalid/');
  await d.M.orchestrator.uploadBookmarks({});
  const parsed = d.M.xbel.parseXbelFromString(d.cloud.files.get(d.mainUrl).content);
  parsed.tombstones = [{ key: 'ROOT:bar/L:https://remove.invalid', deletedAt: d.state.now + 1000, deviceId: 'peer' }];
  parsed.bookmarks = parsed.bookmarks.filter(n => n.url !== removed.url);
  d.cloud.put(d.mainUrl, d.M.xbel.jsonToXbel(parsed));
  d.state.failCreates = info => info.url === removed.url;
  let writes = 0;
  d.cloud.hook = req => req.url === d.mainUrl && req.method === 'PUT' ? (writes++, response(503, 'Unavailable')) : null;
  const pending = watch(d.M.actions.uploadBookmarks({ force: true }));
  await finishAction(d, pending);
  expect(pending.settled).toBe(true);
  expect(pending.value.success).toBe(false);
  expect(pending.value.recovery.ok).toBe(false);
  expect(writes).toBe(1);
});

test.each(['get', 'body', 'put'])('hung %s settles, releases queue, and cannot resume local processing late', async stage => {
  const d = await fixture('deadline-' + stage);
  await d.add('1', 'Local', 'https://local.invalid/');
  const original = d.sandbox.fetch;
  let release, entered = false, signal;
  const gate = new Promise(resolve => { release = resolve; });
  d.sandbox.fetch = async (url, init) => {
    if (!entered && url === d.mainUrl && init.method === (stage === 'put' ? 'PUT' : 'GET')) {
      entered = true; signal = init.signal;
      const raw = stage === 'put' ? response(201, '') : await original(url, init);
      if (stage === 'body') raw.text = () => gate.then(() => xbel('Keep', 'https://keep.invalid/'));
      else { await gate; }
      return raw;
    }
    return original(url, init);
  };
  const pending = watch(d.M.orchestrator.uploadBookmarks({}));
  try {
    await until(() => entered);
    await d.advance(60000);
    for (let i = 0; i < 100; i++) await tick();
    expect(pending.settled).toBe(true);
    expect(pending.value.success).toBe(false);
    expect(pending.value.code).toBe(stage === 'put' ? 'WRITE_OUTCOME_UNKNOWN' : 'NETWORK_TIMEOUT');
    expect(signal.aborted).toBe(true);
    expect((await d.M.orchestrator.downloadBookmarks({})).success).toBe(true);
    const baseline = clone(d.state.store.sync_snapshots);
    release(); await drain(); await tick();
    expect(d.state.store.sync_snapshots).toEqual(baseline);
    expect(d.cloud.files.get(d.mainUrl).content).not.toContain('https://local.invalid/');
  } finally { release(); await pending.promise; }
});

test.each(['reject', 'hang'])('PUT %s after server commit is unknown and never automatically repeated', async fault => {
  const d = await fixture('committed-disconnect-' + fault);
  await d.add('1', 'New', 'https://new.invalid/');
  const fetch = d.sandbox.fetch;
  let entered = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  d.sandbox.fetch = async (url, init) => {
    const result = await fetch(url, init);
    if (url === d.mainUrl && init.method === 'PUT') {
      entered = true;
      if (fault === 'reject') throw new TypeError('Response connection dropped after commit');
      await gate;
    }
    return result;
  };
  const pending = watch(d.M.actions.uploadBookmarks({}));
  try {
    await until(() => entered);
    if (fault === 'hang') await d.advance(45000);
    await until(() => pending.settled);
    expect(pending.error).toBeUndefined();
    expect(pending.value).toMatchObject({ success: false, code: 'WRITE_OUTCOME_UNKNOWN', retryable: false });
    expect(d.cloud.files.get(d.mainUrl).content).toContain('https://new.invalid/');
    expect(d.cloud.requests.filter(r => r.method === 'PUT' && r.url === d.mainUrl)).toHaveLength(1);
    expect(d.state.store.sync_lock_at).toBe(0);
    release(); await drain(); await tick();
    expect(d.state.store.sync_status).toBe('failed');
  } finally { release(); await pending.promise; }
});

test('transient response body disconnect is classified for a safe read retry', async () => {
  const d = await fixture('body-disconnect');
  let reads = 0;
  d.cloud.hook = req => {
    if (req.url !== d.mainUrl || req.method !== 'GET' || ++reads !== 1) return null;
    return { ...response(200, ''), text: async () => { throw new TypeError('Connection lost while reading response'); } };
  };
  const pending = watch(d.M.actions.uploadBookmarks({}));
  await finishAction(d, pending);
  expect(pending.value.success).toBe(true);
  expect(reads).toBe(2);
});

test.each([
  ['downloadViaBookmarks', 'bookmarks.html', 'get'],
  ['downloadViaBookmarks', 'bookmarks.html', 'body'],
  ['downloadViaFavorites', 'favorites.txt', 'get'],
  ['downloadViaFavorites', 'favorites.txt', 'body'],
  ['uploadViaHtml', 'bookmarks.html', 'put'],
  ['uploadViaFavorites', 'favorites.txt', 'put']
])('Via %s bounds a hung %s resource at %s', async (method, file, stage) => {
  const d = await fixture('via-deadline-' + method + '-' + stage);
  const url = 'https://audit.invalid/dav/Via/' + file;
  const fetch = d.sandbox.fetch;
  let release, entered = false, signal;
  const gate = new Promise(resolve => { release = resolve; });
  d.sandbox.fetch = async (target, init) => {
    if (target !== url || init.method !== (stage === 'put' ? 'PUT' : 'GET')) return fetch(target, init);
    entered = true; signal = init.signal;
    const raw = response(stage === 'put' ? 201 : 200, 'synthetic');
    if (stage === 'body') raw.text = () => gate.then(() => 'synthetic');
    else await gate;
    return raw;
  };
  const pending = watch(d.sandbox[method]('synthetic'));
  try {
    await until(() => entered);
    await d.advance(45000);
    await drain();
    expect(pending.settled).toBe(true);
    expect(pending.error.code).toBe(stage === 'put' ? 'WRITE_OUTCOME_UNKNOWN' : 'NETWORK_TIMEOUT');
    expect(signal.aborted).toBe(true);
  } finally { release(); await pending.promise; }
});

test.each([
  ['uploadViaHtml', 'bookmarks.html', 202], ['uploadViaHtml', 'bookmarks.html', 207],
  ['uploadViaFavorites', 'favorites.txt', 202], ['uploadViaFavorites', 'favorites.txt', 207]
])('Via %s does not acknowledge unconfirmed %s PUT %s', async (method, file, status) => {
  const d = await fixture('via-unconfirmed-' + method + status);
  d.cloud.hook = req => req.method === 'PUT' && req.url.endsWith('/Via/' + file) ? response(status, '') : null;
  const pending = watch(d.sandbox[method]('synthetic'));
  await pending.promise;
  expect(pending.error).toMatchObject({ code: 'COMMIT_UNCONFIRMED', retryable: false });
});

test('watchdog never labels an active mutex task idle', async () => {
  const d = device('watchdog-active');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const active = d.M.syncMutex.run(async () => { await d.M.storage.setSyncStatus({ status: 'syncing' }); await gate; });
  await until(() => d.state.store.sync_status === 'syncing');
  d.state.now += 300001;
  try { expect((await d.M.storage.getSyncStatus()).status).toBe('syncing'); }
  finally { release(); await active; }
  expect((await d.M.storage.getSyncStatus()).status).toBe('idle');
});

async function configure(d, url) {
  await d.M.storage.setWebdavConfig({ url, username: 'synthetic-user', password: 'synthetic-password', filename: '/sync/minibookmarks.xbel' });
  return d.M.storage.getWebdavConfig();
}
test('first upload to a new relationship ignores the previous relationship timestamp', async () => {
  const d = device('new-relationship');
  await d.add('1', 'Local', 'https://local.invalid/');
  const old = await d.M.storage.getWebdavConfig();
  await d.M.syncInput.ensureSyncRelationship(old, '1');
  d.state.store.cloud_last_modified = d.cloud.clock - 20000;
  const next = await configure(d, 'https://new.invalid/dav');
  d.cloud.put(next.url + next.filename, xbel('Local', 'https://local.invalid/'));
  expect((await d.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  expect(JSON.parse(d.state.store.sync_relationship_key)[0]).toBe('https://new.invalid');
});

test('returning to a relationship detects edits since its own last observation', async () => {
  const d = device('return-relationship');
  await d.add('1', 'Local', 'https://local.invalid/');
  const b = await configure(d, 'https://b.invalid/dav');
  expect((await d.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  await configure(d, 'https://a.invalid/dav');
  expect((await d.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  d.cloud.put(b.url + b.filename, xbel('Remote only', 'https://remote-only.invalid/'));
  expect((await d.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  await configure(d, b.url);
  const result = await d.M.orchestrator.uploadBookmarks({});
  expect(result.success).toBe(false);
  expect(result.code).toBe('CLOUD_CONFLICT');
  expect(d.cloud.files.get(b.url + b.filename).content).toContain('https://remote-only.invalid/');
});

for (const action of ['uploadBookmarks', 'mergeSync']) {
  test.each(['cloud_last_modified', 'sync_status'])(`${action} preserves committed success and baseline after %s failure`, async key => {
    const d = device('postcommit-' + action + '-' + key);
    await d.add('1', 'Base', 'https://base.invalid/');
    expect((await d.M.orchestrator.uploadBookmarks({})).success).toBe(true);
    await d.add('1', 'New', 'https://new.invalid/');
    d.cloud.hook = req => { if (req.url === d.mainUrl && req.method === 'PUT') d.state.failStorageKeys.add(key); return null; };
    const pending = watch(d.M.actions[action]({}));
    await finishAction(d, pending);
    expect(pending.settled).toBe(true);
    expect(pending.error).toBeUndefined();
    expect(pending.value).toMatchObject({ success: true, partial: true });
    expect(d.cloud.files.get(d.mainUrl).content).toContain('https://new.invalid/');
    expect(d.state.store.sync_snapshots.localTree.some(n => n.url === 'https://new.invalid/')).toBe(true);
    expect(d.cloud.requests.filter(r => r.url === d.mainUrl && r.method === 'PUT')).toHaveLength(2);
  });
}
