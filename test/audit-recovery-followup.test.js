const { makeDevice, flush } = require('./helpers/audit-harness.cjs');
const devices = [];
function device(...args) { const d = makeDevice(...args); devices.push(d); return d; }
afterEach(() => { for (const d of devices.splice(0)) d.close(); });

const HOME = '\u79fb\u52a8\u7aef\u4e3b\u9875';
const cloudBody = `<xbel version="1.0"><folder><title>\u4e66\u7b7e\u680f</title>
  <bookmark href="https://remote-bucket.invalid/"><title>RemoteBucket</title></bookmark></folder>
  <folder><title>\u5176\u4ed6\u4e66\u7b7e</title><folder><title>${HOME}</title>
  <bookmark href="https://remote-home.invalid/"><title>RemoteHome</title></bookmark></folder></folder></xbel>`;
const homeData = { bookmarks: [
  { id: '__home_folder__', parentId: 'root', title: HOME, isFolder: true, source: 'other' },
  { id: 'remote-home', parentId: '__home_folder__', title: 'RemoteHome', url: 'https://remote-home.invalid/', source: 'home' }
] };

async function overlappingTargets(d, direction, depth) {
  const outer = await d.add('2', direction === 'bucket-under-home' ? HOME : 'Bucket');
  let parent = outer;
  const anchors = [];
  for (let i = 0; i < depth; i++) {
    parent = await d.add(parent.id, 'Anchor' + i);
    anchors.push(parent.id);
    await d.add(parent.id, 'Discard' + i, 'https://discard-' + i + '.invalid/');
  }
  const inner = await d.add(parent.id, direction === 'bucket-under-home' ? 'Bucket' : HOME);
  const bucket = direction === 'bucket-under-home' ? inner : outer;
  const home = direction === 'bucket-under-home' ? outer : inner;
  d.state.store.bookmark_target_id = bucket.id;
  d.M.utils.setSyncBucketId(bucket.id);
  await d.add(bucket.id, 'SavedBucket', 'https://saved-bucket.invalid/');
  await d.add(home.id, 'SavedHome', 'https://saved-home.invalid/');
  return { bucket, home, anchors };
}

const overlaps = [
  ['bucket-under-home', 0], ['bucket-under-home', 2],
  ['home-under-bucket', 0], ['home-under-bucket', 2]
];
test.each(overlaps)('clear-first download protects %s containers and depth-%i anchors', async (direction, depth) => {
  const d = device('overlap-success-' + direction + depth);
  const { bucket, home, anchors } = await overlappingTargets(d, direction, depth);
  d.cloud.put(d.mainUrl, cloudBody);
  d.state.store.download_clear = true;
  const result = await d.M.orchestrator.downloadBookmarks({});
  expect(result.success).toBe(true);
  expect([bucket.id, home.id, ...anchors].every(id => d.byId.has(id))).toBe(true);
  expect(d.paths().map(n => n.url).sort()).toEqual([
    'https://remote-bucket.invalid/', 'https://remote-home.invalid/'
  ]);
  expect(d.byId.get(bucket.id).children.some(n => n.url === 'https://remote-bucket.invalid/')).toBe(true);
  expect(d.byId.get(home.id).children.some(n => n.url === 'https://remote-home.invalid/')).toBe(true);
});

test.each(overlaps)('failed clear-first download restores %s depth-%i contents exactly once', async (direction, depth) => {
  const d = device('overlap-failure-' + direction + depth);
  const { bucket, home, anchors } = await overlappingTargets(d, direction, depth);
  const before = d.paths().map(n => ({ path: n.path, url: n.url })).sort((a, b) => a.url.localeCompare(b.url));
  d.cloud.put(d.mainUrl, cloudBody);
  d.state.store.download_clear = true;
  d.state.failCreates = info => info.url === 'https://remote-home.invalid/';
  const result = await d.M.orchestrator.downloadBookmarks({});
  expect(result.success).toBe(false);
  expect([bucket.id, home.id, ...anchors].every(id => d.byId.has(id))).toBe(true);
  expect(d.paths().map(n => ({ path: n.path, url: n.url })).sort((a, b) => a.url.localeCompare(b.url))).toEqual(before);
});

test.each([false, true])('missing home recreates at its saved parent chain (missing ancestor: %s)', async missingAncestor => {
  const d = device('home-anchor-' + missingAncestor);
  const parent = await d.add('3', 'OriginalParent');
  const home = await d.add(parent.id, HOME);
  await d.add(home.id, 'KeepHome', 'https://keep-home.invalid/');
  expect(await d.M.syncInput.backupLocalTree()).toBe(true);
  await d.chrome.bookmarks.removeTree(missingAncestor ? parent.id : home.id);
  const result = await d.M.syncInput.restoreLocalBackup({ targetParentId: '1', replaceCurrent: true,
    includeHome: true, recreateMissingHome: true, createdIds: [] });
  expect(result.ok).toBe(true);
  expect(d.paths().map(n => ({ path: n.path, url: n.url }))).toEqual([
    { path: '\u79fb\u52a8\u8bbe\u5907\u4e66\u7b7e/OriginalParent/' + HOME + '/KeepHome', url: 'https://keep-home.invalid/' }
  ]);
  expect(d.byId.get('2').children).toEqual([]);
});

test.each(['bucket', 'ancestor', 'home'])('missing nested bucket recovers saved anchors without duplicate restoration (%s missing)', async missing => {
  const d = device('bucket-anchor-' + missing);
  const { bucket, home, anchors } = await overlappingTargets(d, 'bucket-under-home', 2);
  const before = d.paths().map(n => ({ path: n.path, url: n.url })).sort((a, b) => a.url.localeCompare(b.url));
  expect(await d.M.syncInput.backupLocalTree()).toBe(true);
  await d.chrome.bookmarks.removeTree(missing === 'home' ? home.id : missing === 'ancestor' ? anchors[0] : bucket.id);
  const result = await d.M.syncInput.restoreLocalBackup({ targetParentId: bucket.id, replaceCurrent: true,
    includeHome: true, recreateMissingHome: true, createdIds: [] });
  expect(result.ok).toBe(true);
  expect(d.paths().map(n => ({ path: n.path, url: n.url })).sort((a, b) => a.url.localeCompare(b.url))).toEqual(before);
  const buckets = [...d.byId.values()].filter(n => n.title === 'Bucket');
  expect(buckets).toHaveLength(1);
  expect(d.state.store.bookmark_target_id).toBe(buckets[0].id);
  expect(d.M.utils.getSyncBucketId()).toBe(buckets[0].id);
});

test('home recreation failure reports conflicts instead of a temporal-dead-zone exception', async () => {
  const d = device('home-recreate-conflict');
  const home = await d.add('2', HOME);
  await d.add(home.id, 'Keep', 'https://keep.invalid/');
  expect(await d.M.syncInput.backupLocalTree()).toBe(true);
  await d.chrome.bookmarks.removeTree(home.id);
  d.state.failCreates = info => info.title === HOME;
  const result = await d.M.syncInput.restoreLocalBackup({ targetParentId: '1', includeHome: true, recreateMissingHome: true });
  expect(result.ok).toBe(false);
  expect(result.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ error: 'Synthetic bookmark write failure' })]));
});

test('import write-set includes new home container and every new descendant', async () => {
  const d = device('home-write-set');
  const transaction = { createdIds: [] };
  const result = await d.M.importer.importBookmarksFromData(homeData, { targetParentId: '1', transaction,
    skipBerryBridge: true, skipViaBridge: true, mergeIntoLocal: true });
  const home = d.byId.get('2').children.find(n => n.title === HOME);
  expect(home).toBeDefined();
  expect(result.createdIds.slice().sort()).toEqual([home.id, home.children[0].id].sort());
  expect(transaction.createdIds.slice().sort()).toEqual([home.id, home.children[0].id].sort());
});

test.each([false, true])('rollback cleans new home outside saved targets and preserves late descendants (%s)', async lateUser => {
  const d = device('home-write-cleanup-' + lateUser);
  expect(await d.M.syncInput.backupLocalTree()).toBe(true);
  const imported = await d.M.importer.importBookmarksFromData(homeData, { targetParentId: '1',
    skipBerryBridge: true, skipViaBridge: true, mergeIntoLocal: true });
  const home = d.byId.get('2').children.find(n => n.title === HOME);
  const userFolder = lateUser ? await d.add(home.id, 'UserFolder') : null;
  const user = lateUser ? await d.add(userFolder.id, 'LateUser', 'https://late-user.invalid/') : null;
  const result = await d.M.syncInput.restoreLocalBackup({ targetParentId: '1', replaceCurrent: true,
    includeHome: true, recreateMissingHome: true, createdIds: imported.createdIds });
  expect(result.ok).toBe(true);
  expect(d.paths().map(n => n.url)).toEqual(lateUser ? ['https://late-user.invalid/'] : []);
  expect(d.byId.has(home.id)).toBe(lateUser);
  if (lateUser) {
    expect(d.byId.get(user.id).parentId).toBe(userFolder.id);
    expect(d.state.removals.some(n => n.id === home.id)).toBe(false);
  }
});

test('rollback never removes a transaction folder containing user-added descendants', async () => {
  const d = device('bucket-write-cleanup');
  expect(await d.M.syncInput.backupLocalTree()).toBe(true);
  const folder = await d.add('1', 'TransactionFolder');
  const child = await d.add(folder.id, 'TransactionChild', 'https://transaction.invalid/');
  const user = await d.add(folder.id, 'LateUser', 'https://late-user.invalid/');
  const result = await d.M.syncInput.restoreLocalBackup({ targetParentId: '1', replaceCurrent: true,
    createdIds: [folder.id, child.id] });
  expect(result.ok).toBe(true);
  expect(d.byId.has(child.id)).toBe(false);
  expect(d.byId.get(user.id)?.parentId).toBe(folder.id);
  expect(d.state.removals.some(n => n.id === folder.id)).toBe(false);
});

function failIndexReadAfterHomeCreate(d) {
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
}

test('import exceptions attach the completed home-container write-set', async () => {
  const d = device('import-exception-write-set');
  failIndexReadAfterHomeCreate(d);
  const transaction = { createdIds: [] };
  let error;
  try { await d.M.importer.importBookmarksFromData(homeData, { targetParentId: '1', transaction,
    skipBerryBridge: true, skipViaBridge: true, mergeIntoLocal: true }); } catch (e) { error = e; }
  const home = d.byId.get('2').children.find(n => n.title === HOME);
  expect(error?.message).toBe('Synthetic import index read failure');
  expect(error.writeSet).toEqual([home.id]);
  expect(transaction.createdIds).toEqual([home.id]);
});

test('download import exception rolls back only its write-set and retains concurrent local additions', async () => {
  const d = device('download-exception-write-set');
  d.cloud.put(d.mainUrl, cloudBody);
  failIndexReadAfterHomeCreate(d);
  const create = d.chrome.bookmarks.create;
  let user;
  d.chrome.bookmarks.create = (info, cb) => {
    const result = create(info, cb);
    if (info.title === HOME) user = create({ parentId: '1', title: 'LateUser', url: 'https://late-user.invalid/' });
    return result;
  };
  const result = await d.M.orchestrator.downloadBookmarks({});
  const added = await user;
  expect(result.success).toBe(false);
  expect(d.paths().map(n => n.url)).toEqual(['https://late-user.invalid/']);
  expect(d.byId.has(added.id)).toBe(true);
  expect(d.byId.get('2').children).toEqual([]);
});

test('public restore waits for an actual download callback and internal rollback does not deadlock', async () => {
  const d = device('restore-download-mutex');
  await d.add('1', 'Saved', 'https://saved.invalid/');
  d.cloud.put(d.mainUrl, cloudBody);
  d.state.store.download_clear = true;
  d.state.failCreates = info => info.url === 'https://remote-home.invalid/';
  const removeTree = d.chrome.bookmarks.removeTree;
  let release;
  let enteredResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  let blocked = false;
  d.chrome.bookmarks.removeTree = (id, cb) => {
    if (!blocked) {
      blocked = true;
      release = () => removeTree(id, cb);
      enteredResolve();
      return;
    }
    return removeTree(id, cb);
  };
  const download = d.M.orchestrator.downloadBookmarks({});
  await entered;
  let restoreSettled = false;
  const restore = d.M.orchestrator.restoreLocalBackup({ targetParentId: '1' }).then(result => {
    restoreSettled = true;
    return result;
  });
  await flush();
  try { expect(restoreSettled).toBe(false); } finally { release(); }
  expect((await download).success).toBe(false);
  expect((await restore).ok).toBe(true);
  expect(d.paths().map(n => n.url)).toEqual(['https://saved.invalid/']);
});
