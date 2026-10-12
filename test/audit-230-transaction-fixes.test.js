const { makeDevice, response } = require('./helpers/audit-harness.cjs');
const devices = [];
function device(name) { const d = makeDevice(name); devices.push(d); return d; }
afterEach(() => { for (const d of devices.splice(0)) d.close(); });
const HOME = '移动端主页';

test('replace recovery reports failure when saved home cannot be recreated', async () => {
  const d = device('restore-home-failure');
  const home = await d.add('2', HOME);
  await d.add(home.id, 'Keep', 'https://keep.invalid/');
  expect(await d.M.syncInput.backupLocalTree()).toBe(true);
  await d.chrome.bookmarks.removeTree(home.id);
  d.state.failCreates = info => info.title === HOME;
  const result = await d.M.syncInput.restoreLocalBackup({ targetParentId: '1', replaceCurrent: true,
    includeHome: true, recreateMissingHome: true, createdIds: [] });
  expect(result.conflicts.length).toBeGreaterThan(0);
  expect(result.ok).toBe(false);
});

test('download metadata failure preserves additions outside the import transaction', async () => {
  const d = device('download-metadata-failure');
  await d.add('1', 'Saved', 'https://saved.invalid/');
  d.cloud.put(d.mainUrl, '<xbel><folder><title>书签栏</title><bookmark href="https://remote.invalid/"><title>Remote</title></bookmark></folder></xbel>');
  const create = d.chrome.bookmarks.create;
  let user;
  d.chrome.bookmarks.create = (info, cb) => {
    const value = create(info, cb);
    if (info.url === 'https://remote.invalid/') {
      user = create({ parentId: '1', title: 'LateUser', url: 'https://late-user.invalid/' });
      d.state.failStorageKeys.add('cloud_last_modified');
    }
    return value;
  };
  const result = await d.M.orchestrator.downloadBookmarks({});
  const added = await user;
  expect(result.success).toBe(false);
  expect(d.byId.has(added.id)).toBe(true);
  expect(d.paths().map(n => n.url).sort()).toEqual(['https://late-user.invalid/', 'https://saved.invalid/']);
});

test('merge import exception removes its newly created home container', async () => {
  const d = device('merge-exception-home');
  await d.add('1', 'Saved', 'https://saved.invalid/');
  d.cloud.put(d.mainUrl, `<xbel><folder><title>书签栏</title></folder><folder><title>其他书签</title><folder><title>${HOME}</title><bookmark href="https://remote.invalid/"><title>Remote</title></bookmark></folder></folder></xbel>`);
  const create = d.chrome.bookmarks.create;
  const getTree = d.chrome.bookmarks.getTree;
  let createdHome = false, failed = false;
  d.chrome.bookmarks.create = (info, cb) => {
    const result = create(info, cb);
    if (info.title === HOME) createdHome = true;
    return result;
  };
  d.chrome.bookmarks.getTree = cb => {
    if (createdHome && !failed) {
      failed = true;
      d.chrome.runtime.lastError = { message: 'Synthetic import index read failure' };
      cb();
      d.chrome.runtime.lastError = null;
      return;
    }
    return getTree(cb);
  };
  const result = await d.M.orchestrator.mergeSync({});
  expect(failed).toBe(true);
  expect(result.success).toBe(false);
  expect([...d.byId.values()].filter(n => n.title === HOME)).toEqual([]);
  expect(d.paths().map(n => n.url)).toEqual(['https://saved.invalid/']);
});

test('download import exception exposes incomplete home recovery to the caller', async () => {
  const d = device('download-incomplete-recovery');
  const home = await d.add('2', HOME);
  await d.add(home.id, 'HomeSaved', 'https://home-saved.invalid/');
  await d.add('1', 'Saved', 'https://saved.invalid/');
  d.cloud.put(d.mainUrl, '<xbel><folder><title>书签栏</title><bookmark href="https://remote.invalid/"><title>Remote</title></bookmark></folder></xbel>');
  const importBookmarks = d.M.importer.importBookmarksFromData;
  d.M.importer.importBookmarksFromData = async (...args) => {
    const imported = await importBookmarks(...args);
    await d.chrome.bookmarks.removeTree(home.id);
    d.state.failCreates = item => item.title === HOME;
    const error = new Error('Synthetic import finalization failure');
    error.writeSet = imported.createdIds;
    throw error;
  };
  const result = await d.M.orchestrator.downloadBookmarks({});
  expect(result.success).toBe(false);
  expect(result.recovery?.ok).toBe(false);
  expect(result.recovery.conflicts.length).toBeGreaterThan(0);
  expect(result.message).toContain('回滚未完成');
});

test.each([202, 207])('PUT %i cannot advance a successful baseline without committed data', async status => {
  const d = device('put-status-' + status);
  await d.add('1', 'Keep', 'https://keep.invalid/');
  d.cloud.hook = req => req.method === 'PUT' && req.url === d.mainUrl
    ? response(status, status === 207
      ? '<D:multistatus xmlns:D="DAV:"><D:response><D:status>HTTP/1.1 507 Insufficient Storage</D:status></D:response></D:multistatus>'
      : 'Accepted for asynchronous processing') : null;
  const result = await d.M.actions.uploadBookmarks({});
  expect(d.cloud.files.has(d.mainUrl)).toBe(false);
  expect(result.success).toBe(false);
  expect(d.state.store.sync_snapshots?.localTree).toBeUndefined();
  expect(d.state.store.sync_status).not.toBe('success');
});

test.each([false, true])('upload metadata failure reports partial committed success and still saves baseline (status failure: %s)', async statusFailure => {
  const d = device('upload-metadata-failure');
  await d.add('1', 'Before', 'https://before.invalid/');
  expect((await d.M.actions.uploadBookmarks({})).success).toBe(true);
  await d.add('1', 'After', 'https://after.invalid/');
  d.state.failStorageKeys.add('cloud_last_modified');
  const set = d.chrome.storage.local.set;
  let rejected = false;
  d.chrome.storage.local.set = (data, cb) => {
    if (statusFailure && !rejected && ['success', 'partial'].includes(data.sync_status)) {
      rejected = true;
      d.chrome.runtime.lastError = { message: 'Synthetic final status failure' };
      cb();
      d.chrome.runtime.lastError = null;
      return;
    }
    return set(data, cb);
  };
  const result = await d.M.actions.uploadBookmarks({});
  expect(d.cloud.files.get(d.mainUrl).content).toContain('https://after.invalid/');
  expect(result.success).toBe(true);
  expect(result.partial).toBe(true);
  if (!statusFailure) expect(d.state.store.sync_status).toBe('partial');
  expect(d.state.store.sync_snapshots.localTree.filter(n => n.url).map(n => n.url).sort())
    .toEqual(['https://after.invalid/', 'https://before.invalid/']);
});
