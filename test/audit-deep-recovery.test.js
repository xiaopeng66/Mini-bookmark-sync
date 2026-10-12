const { makeDevice, clone, flush } = require('./helpers/audit-harness.cjs');

// Real production modules in fresh workers; only Chrome IO and WebDAV are synthetic.
const devices = [];
function device(...args) { const d = makeDevice(...args); devices.push(d); return d; }
afterEach(() => { for (const d of devices.splice(0)) d.close(); });
const HOME = '移动端主页';
const REMOTE = '<xbel><folder><title>书签栏</title><bookmark href="https://remote.invalid/"><title>Remote</title></bookmark></folder></xbel>';
const urls = d => d.paths().map(n => n.url).sort();
const snapshotUrls = d => (d.state.store.sync_snapshots?.localTree || []).filter(n => n.url).map(n => n.url).sort();
const tombstoneKeys = d => (d.state.store.sync_tombstones || []).map(t => typeof t === 'string' ? t : t.key).sort();
function treeUrls(tree) {
  const result = [];
  (function walk(node) {
    if (node.url) result.push(node.url);
    for (const child of node.children || []) walk(child);
  })(tree[0]);
  return result.sort();
}
function restart(old, name) {
  const d = device(name, old.cloud, { store: clone(old.state.store), background: true });
  d.state.root = clone(old.state.root);
  d.state.now = old.state.now;
  d.byId.clear();
  (function index(node) { d.byId.set(String(node.id), node); for (const child of node.children || []) index(child); })(d.state.root);
  old.close();
  return d;
}
async function removeAsUser(d, node, notify = true) {
  const removed = clone(d.byId.get(node.id));
  const parent = d.byId.get(removed.parentId);
  const index = parent.children.findIndex(n => n.id === removed.id);
  await d.chrome.bookmarks[removed.url ? 'remove' : 'removeTree'](removed.id);
  if (notify) await d.sandbox.handleBookmarkRemoved(removed.id, { parentId: removed.parentId, index, node: removed });
}

// Removing the pending baseline or reading only sync_snapshots must fail these tests.
test.each([[true, true], [true, false], [false, true]])(
  'R1: uploaded deletion survives a fresh worker (snapshot failure=%s, event delivered=%s)',
  async (failBaseline, notify) => {
    let d = device('committed-baseline-' + failBaseline + notify, undefined, { background: true });
    await flush();
    await d.add('1', 'Sentinel', 'https://sentinel.invalid/');
    expect((await d.M.orchestrator.uploadBookmarks({})).success).toBe(true);
    const folder = await d.add('1', 'Work');
    const gone = await d.add(folder.id, 'Delete after commit', 'https://deleted.invalid/');
    if (failBaseline) d.state.failStorageKeys.add('sync_snapshots');
    const upload = await d.M.orchestrator.uploadBookmarks({});
    expect(upload.success).toBe(true);
    expect(!!upload.partial).toBe(failBaseline);
    expect(d.cloud.files.get(d.mainUrl).content).toContain('https://deleted.invalid/');
    if (failBaseline) expect(snapshotUrls(d)).toEqual(['https://sentinel.invalid/']);

    d = restart(d, 'committed-baseline-reloaded-' + failBaseline + notify);
    await flush();
    d.state.now += 60000;
    await removeAsUser(d, gone, notify);
    if (notify) expect(tombstoneKeys(d)).toContain('ROOT:bar/F:Work/L:https://deleted.invalid');
    const merged = await d.M.orchestrator.mergeSync({});
    expect(merged.success).toBe(true);
    expect(urls(d)).toEqual(['https://sentinel.invalid/']);
    const remote = d.M.xbel.parseXbelFromString(d.cloud.files.get(d.mainUrl).content);
    expect(remote.bookmarks.filter(n => n.url).map(n => n.url)).toEqual(['https://sentinel.invalid/']);
    expect(d.state.store.sync_baseline_repair_needed).toBeFalsy();
  }
);

test('R1: repair replays committed history, not a new snapshot of the edited current tree', async () => {
  let d = device('history-source');
  await d.add('1', 'Sentinel', 'https://sentinel.invalid/');
  const gone = await d.add('1', 'Historical', 'https://historical.invalid/');
  d.state.failStorageKeys.add('sync_snapshots');
  expect((await d.M.syncInput.saveLocalTreeSnapshot()).ok).toBe(false);
  d = restart(d, 'history-source-reloaded');
  await flush();
  await removeAsUser(d, gone, false);
  await d.add('1', 'Later', 'https://later.invalid/');
  expect((await d.M.syncInput.repairBaselineIfNeeded()).ok).toBe(true);
  expect(snapshotUrls(d)).toEqual(['https://historical.invalid/', 'https://sentinel.invalid/']);
  expect(urls(d)).toEqual(['https://later.invalid/', 'https://sentinel.invalid/']);
  expect(d.state.store.sync_baseline_repair_needed).toBeFalsy();
  await d.M.syncInput.backfillDeletedTombstones(d.M.merger.chromeTreeToList([d.state.root]));
  expect(tombstoneKeys(d)).toEqual(['ROOT:bar/L:https://historical.invalid']);
});

test('R1: a second failed save cannot overwrite unrecorded historical deletion evidence', async () => {
  const d = device('history-preserved');
  const gone = await d.add('1', 'Historical', 'https://historical.invalid/');
  d.state.failStorageKeys.add('sync_snapshots');
  expect((await d.M.syncInput.saveLocalTreeSnapshot()).ok).toBe(false);
  const pending = clone(d.state.store.sync_baseline_repair_needed);
  await d.chrome.bookmarks.remove(gone.id);
  await d.add('1', 'Later', 'https://later.invalid/');
  d.state.failStorageKeys.add('sync_tombstones');
  expect((await d.M.syncInput.saveLocalTreeSnapshot()).ok).toBe(false);
  expect(d.state.store.sync_baseline_repair_needed).toEqual(pending);
  d.state.failStorageKeys.clear();
  expect((await d.M.syncInput.repairBaselineIfNeeded()).ok).toBe(true);
  expect(snapshotUrls(d)).toEqual(['https://historical.invalid/']);
  await d.M.syncInput.backfillDeletedTombstones(d.M.merger.chromeTreeToList([d.state.root]));
  expect(tombstoneKeys(d)).toEqual(['ROOT:bar/L:https://historical.invalid']);
});

test('R1: pending history follows its relationship, never the next selected target', async () => {
  const d = device('relationship-history');
  const a = { url: 'https://a.invalid/dav', username: 'synthetic', filename: 'bookmarks.xbel' };
  const b = { url: 'https://b.invalid/dav', username: 'synthetic', filename: 'bookmarks.xbel' };
  await d.M.syncInput.ensureSyncRelationship(a, '1');
  const old = await d.add('1', 'Only A', 'https://only-a.invalid/');
  d.state.failStorageKeys.add('sync_snapshots');
  expect((await d.M.syncInput.saveLocalTreeSnapshot()).ok).toBe(false);
  d.state.failStorageKeys.clear();
  await d.chrome.bookmarks.remove(old.id);

  await d.M.syncInput.ensureSyncRelationship(b, '1');
  expect(d.state.store.sync_baseline_repair_needed).toBeFalsy();
  expect((await d.M.syncInput.repairBaselineIfNeeded()).skipped).toBe(true);
  expect(d.state.store.sync_snapshots).toEqual({});
  await d.add('1', 'Only B', 'https://only-b.invalid/');
  expect((await d.M.syncInput.saveLocalTreeSnapshot()).ok).toBe(true);
  expect(tombstoneKeys(d)).toEqual([]);

  await d.M.syncInput.ensureSyncRelationship(a, '1');
  expect((await d.M.syncInput.repairBaselineIfNeeded()).ok).toBe(true);
  expect(snapshotUrls(d)).toEqual(['https://only-a.invalid/']);
  await d.M.syncInput.backfillDeletedTombstones(d.M.merger.chromeTreeToList([d.state.root]));
  expect(tombstoneKeys(d)).toEqual(['ROOT:bar/L:https://only-a.invalid']);
  await d.M.syncInput.ensureSyncRelationship(b, '1');
  expect(snapshotUrls(d)).toEqual(['https://only-b.invalid/']);
  expect(tombstoneKeys(d)).toEqual([]);
});

test('R1: relationship reset clears bridge owner and version evidence, not just path arrays', async () => {
  const d = device('relationship-bridge-evidence');
  await d.M.syncInput.ensureSyncRelationship({ url: 'https://old.invalid/dav' }, '1');
  const keys = ['berry_pathkey_snapshot', 'via_pathkey_snapshot', 'aira_pathkey_snapshot', 'aira_home_pathkey_snapshot'];
  for (const key of keys) {
    d.state.store[key] = ['ROOT:bar/L:https://old.invalid'];
    d.state.store[key + '_owner'] = 'old-bridge';
    d.state.store[key + '_meta'] = { owner: 'old-bridge', relationshipKey: d.state.store.sync_relationship_key };
  }
  await d.M.syncInput.ensureSyncRelationship({ url: 'https://new.invalid/dav' }, '1');
  for (const key of keys) {
    expect(d.state.store[key]).toEqual([]);
    expect(d.state.store[key + '_owner']).toBeFalsy();
    expect(d.state.store[key + '_meta']).toBeFalsy();
  }
});

test('R1: legacy flag without historical data is not falsely repaired by recapturing current tree', async () => {
  const d = device('legacy-history-flag');
  await d.add('1', 'Current only', 'https://current.invalid/');
  const old = { at: 1, error: 'Legacy failed baseline' };
  d.state.store.sync_baseline_repair_needed = clone(old);
  const result = await d.M.syncInput.repairBaselineIfNeeded();
  expect(result.ok).toBe(false);
  expect(d.state.store.sync_baseline_repair_needed).toEqual(old);
  expect(d.state.store.sync_snapshots).toBeUndefined();
});

test('R1: real removed subtree supplies paths if both baseline storage writes failed', async () => {
  let d = device('removed-source', undefined, { background: true });
  await flush();
  await d.add('1', 'Sentinel', 'https://sentinel.invalid/');
  expect((await d.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  const folder = await d.add('1', 'A/B');
  await d.add(folder.id, 'Nested', 'https://nested.invalid/');
  d.state.failStorageKeys.add('sync_snapshots');
  d.state.failStorageKeys.add('sync_baseline_repair_needed');
  expect((await d.M.orchestrator.uploadBookmarks({})).partial).toBe(true);
  d = restart(d, 'removed-source-reloaded');
  await flush();
  await removeAsUser(d, folder);
  expect(tombstoneKeys(d)).toEqual([
    'ROOT:bar/F~:A%2FB', 'ROOT:bar/F~:A%2FB/L:https://nested.invalid'
  ]);
  expect((await d.M.orchestrator.mergeSync({})).success).toBe(true);
  expect(urls(d)).toEqual(['https://sentinel.invalid/']);
});

test('R1 control: removed nodes outside the selected bucket never create sync tombstones', async () => {
  const d = device('removed-outside', undefined, { background: true });
  await flush();
  const outside = await d.add('2', 'Outside', 'https://outside.invalid/');
  await removeAsUser(d, outside);
  expect(tombstoneKeys(d)).toEqual([]);
});

// Resolving backup source by current target ID (or taking over by title) breaks retries.
test.each([[true, true], [true, false], [false, true]])(
  'R2: default restore retries across workers (bucket removed=%s, first leaf failed=%s)',
  async (removeBucket, failFirst) => {
    let d = device('bucket-identity-' + removeBucket + failFirst);
    const bucket = await d.add('2', 'CustomBucket');
    const saved = await d.add(bucket.id, 'Saved', 'https://saved.invalid/');
    d.state.store.bookmark_target_id = bucket.id;
    d.M.utils.setSyncBucketId(bucket.id);
    expect(await d.M.syncInput.backupLocalTree()).toBe(true);
    const originalBackup = clone(d.state.store.local_bookmark_backup);
    await d.chrome.bookmarks[removeBucket ? 'removeTree' : 'remove'](removeBucket ? bucket.id : saved.id);
    if (failFirst) d.state.failCreates = n => n.url === saved.url;
    const first = await d.M.orchestrator.restoreLocalBackup({ replaceCurrent: true, includeHome: true,
      recreateMissingHome: true, createdIds: [] });
    expect(first.ok).toBe(!failFirst);
    const liveBucketId = d.state.store.bookmark_target_id;
    if (removeBucket) expect(liveBucketId).not.toBe(bucket.id);
    d = restart(d, 'bucket-identity-reloaded-' + removeBucket + failFirst);
    await flush();
    expect((await d.M.orchestrator.restoreLocalBackup({})).ok).toBe(true);
    expect(urls(d)).toEqual(['https://saved.invalid/']);
    expect(d.paths()[0].path).toBe('其他书签/CustomBucket/Saved');
    expect(d.byId.get(liveBucketId).children.filter(n => n.url === saved.url)).toHaveLength(1);
    expect(d.state.store.local_bookmark_backup).toEqual(originalBackup);
    expect((await d.M.orchestrator.restoreLocalBackup({})).ok).toBe(true);
    expect(urls(d)).toEqual(['https://saved.invalid/']);
  }
);

test('R2: recreated ancestor mapping never adopts unrelated same-title containers', async () => {
  let d = device('identity-not-title');
  const parent = await d.add('2', 'SavedParent');
  const bucket = await d.add(parent.id, 'Bucket');
  await d.add(bucket.id, 'Saved', 'https://saved.invalid/');
  d.state.store.bookmark_target_id = bucket.id;
  d.M.utils.setSyncBucketId(bucket.id);
  expect(await d.M.syncInput.backupLocalTree()).toBe(true);
  await d.chrome.bookmarks.removeTree(parent.id);
  const impostorParent = await d.add('2', 'SavedParent');
  const impostor = await d.add(impostorParent.id, 'Bucket');
  await d.add(impostor.id, 'Unrelated', 'https://unrelated.invalid/');
  d.state.failCreates = n => n.url === 'https://saved.invalid/';
  expect((await d.M.orchestrator.restoreLocalBackup({ replaceCurrent: true, recreateMissingHome: true, createdIds: [] })).ok).toBe(false);
  const selected = d.state.store.bookmark_target_id;
  expect(selected).not.toBe(impostor.id);
  d = restart(d, 'identity-not-title-reloaded');
  await flush();
  expect((await d.M.orchestrator.restoreLocalBackup({})).ok).toBe(true);
  expect(d.byId.get(impostor.id).children.map(n => n.url)).toEqual(['https://unrelated.invalid/']);
  expect(d.byId.get(selected).children.map(n => n.url)).toEqual(['https://saved.invalid/']);
  expect(d.byId.get('2').children.filter(n => n.title === 'SavedParent')).toHaveLength(2);
});

// A home containing the bucket must not cause a second removal from a stale cached tree.
test.each([true, false])('R3: rollback cleans each physical subtree once and preserves concurrent additions (nested=%s)', async nested => {
  const d = device('overlap-' + nested);
  const home = await d.add('2', HOME);
  const bucket = await d.add(nested ? home.id : '1', 'Bucket');
  await d.add(home.id, 'SavedHome', 'https://saved-home.invalid/');
  await d.add(bucket.id, 'SavedBucket', 'https://saved-bucket.invalid/');
  d.state.store.bookmark_target_id = bucket.id;
  d.M.utils.setSyncBucketId(bucket.id);
  d.cloud.put(d.mainUrl, REMOTE.replace('</xbel>', `<folder><title>其他书签</title><folder><title>${HOME}</title><bookmark href="https://remote-home.invalid/"><title>RemoteHome</title></bookmark></folder></folder></xbel>`));
  const create = d.chrome.bookmarks.create;
  const removeAttempts = [];
  for (const method of ['remove', 'removeTree']) {
    const original = d.chrome.bookmarks[method];
    d.chrome.bookmarks[method] = (id, cb) => { removeAttempts.push(String(id)); return original(id, cb); };
  }
  let late;
  d.chrome.bookmarks.create = (info, cb) => {
    const value = create(info, cb);
    if (info.url === 'https://remote.invalid/') {
      late = create({ parentId: bucket.id, title: 'LateUser', url: 'https://late-user.invalid/' });
      d.state.failStorageKeys.add('cloud_last_modified');
    }
    return value;
  };
  const result = await d.M.orchestrator.downloadBookmarks({});
  const user = await late;
  expect(result.success).toBe(false);
  expect(urls(d)).toEqual(['https://late-user.invalid/', 'https://saved-bucket.invalid/', 'https://saved-home.invalid/']);
  expect(d.byId.has(user.id)).toBe(true);
  expect(result.recovery?.ok).toBe(true);
  expect(new Set(removeAttempts).size).toBe(removeAttempts.length);
});

test('R3: nested rollback keeps late user children inside a transaction-created folder', async () => {
  const d = device('nested-late-folder');
  const home = await d.add('2', HOME);
  const bucket = await d.add(home.id, 'Bucket');
  await d.add(home.id, 'SavedHome', 'https://saved-home.invalid/');
  await d.add(bucket.id, 'SavedBucket', 'https://saved-bucket.invalid/');
  d.state.store.bookmark_target_id = bucket.id;
  d.M.utils.setSyncBucketId(bucket.id);
  expect(await d.M.syncInput.backupLocalTree()).toBe(true);
  const transactionFolder = await d.add(bucket.id, 'TransactionFolder');
  const transactionLeaf = await d.add(transactionFolder.id, 'TransactionLeaf', 'https://transaction.invalid/');
  const late = await d.add(transactionFolder.id, 'LateUser', 'https://late-user.invalid/');
  const homeExtra = await d.add(home.id, 'TransactionHome', 'https://transaction-home.invalid/');
  const result = await d.M.syncInput.restoreLocalBackup({ replaceCurrent: true, includeHome: true,
    recreateMissingHome: true, createdIds: [transactionFolder.id, transactionLeaf.id, homeExtra.id] });
  expect(result.ok).toBe(true);
  expect(urls(d)).toEqual(['https://late-user.invalid/', 'https://saved-bucket.invalid/', 'https://saved-home.invalid/']);
  expect(d.byId.get(late.id)?.parentId).toBe(transactionFolder.id);
});

// Unresolved backup protection must persist, while accepted commits/restores permit replacement.
test('R4: pending transaction backup cannot be replaced before an explicit completion', async () => {
  let d = device('backup-pending');
  const saved = await d.add('1', 'OnlyLocal', 'https://only-local.invalid/');
  expect(await d.M.syncInput.backupLocalTree()).toBe(true);
  const backup = clone(d.state.store.local_bookmark_backup);
  await d.chrome.bookmarks.remove(saved.id);
  d = restart(d, 'backup-pending-reloaded');
  await flush();
  expect(await d.M.syncInput.backupLocalTree()).toBe(false);
  expect(d.M.syncInput.getLocalBackupFailure()).toMatchObject({ code: 'RECOVERY_REQUIRED', retryable: false });
  expect(d.state.store.local_bookmark_backup).toEqual(backup);
});

test('R4: backup and transaction protection must persist together before destructive work', async () => {
  const d = device('backup-metadata-failure');
  await d.add('1', 'Saved', 'https://saved.invalid/');
  d.state.failStorageKeys.add('local_bookmark_backup_meta');
  expect(await d.M.syncInput.backupLocalTree()).toBe(false);
  expect(d.state.store.local_bookmark_backup).toBeUndefined();
});

test.each([false, true])('R4: failed clear-download rollback retains the only copy through retry (worker restarted=%s)', async reboot => {
  let d = device('backup-retry-' + reboot, undefined, { background: true });
  await flush();
  await d.add('1', 'OnlyLocal', 'https://only-local.invalid/');
  d.state.store.download_clear = true;
  d.cloud.put(d.mainUrl, REMOTE);
  d.state.failCreates = info => !!info.url;
  const first = await d.M.orchestrator.downloadBookmarks({});
  expect(first.success).toBe(false);
  expect(urls(d)).toEqual([]);
  const original = clone(d.state.store.local_bookmark_backup);
  expect(treeUrls(original)).toEqual(['https://only-local.invalid/']);
  expect((d.state.store.local_snapshots || []).some(s => treeUrls(s.tree).includes('https://only-local.invalid/'))).toBe(false);
  if (reboot) {
    d = restart(d, 'backup-retry-reloaded');
    d.state.failCreates = info => !!info.url;
    await flush();
  }
  const retry = await d.M.orchestrator.downloadBookmarks({});
  expect(retry.success).toBe(false);
  expect(d.state.store.local_bookmark_backup).toEqual(original);
  d.state.failCreates = null;
  expect((await d.M.orchestrator.restoreLocalBackup({})).ok).toBe(true);
  expect(urls(d)).toEqual(['https://only-local.invalid/']);
  await d.add('1', 'Newer', 'https://newer.invalid/');
  expect(await d.M.syncInput.backupLocalTree()).toBe(true);
  expect(treeUrls(d.state.store.local_bookmark_backup)).toEqual(['https://newer.invalid/', 'https://only-local.invalid/']);
});

test.each(['uploadBookmarks', 'downloadBookmarks', 'mergeSync'])('R4 control: successive successful %s replaces the completed backup', async action => {
  const d = device('successive-' + action);
  await d.add('1', 'Before', 'https://before.invalid/');
  if (action === 'downloadBookmarks') d.cloud.put(d.mainUrl, REMOTE);
  expect((await d.M.orchestrator[action]({})).success).toBe(true);
  await d.add('1', 'Later', 'https://later.invalid/');
  expect((await d.M.orchestrator[action]({})).success).toBe(true);
  expect(treeUrls(d.state.store.local_bookmark_backup)).toContain('https://later.invalid/');
});

test('R4: startup does not undo a deliberate clear after a committed sync', async () => {
  let d = device('deliberate-clear', undefined, { background: true });
  await flush();
  const saved = await d.add('1', 'Saved', 'https://saved.invalid/');
  expect((await d.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  await removeAsUser(d, saved);
  d = restart(d, 'deliberate-clear-reloaded');
  await flush();
  await d.sandbox.startupRecovery();
  expect(urls(d)).toEqual([]);
  expect(tombstoneKeys(d)).toContain('ROOT:bar/L:https://saved.invalid');
});

test('R4: legacy unbound backup is manual recovery evidence, not permission to undo an empty tree', async () => {
  const d = device('legacy-backup', undefined, { background: true });
  await flush();
  const saved = await d.add('1', 'Saved', 'https://saved.invalid/');
  d.state.store.local_bookmark_backup = clone([d.state.root]);
  await d.chrome.bookmarks.remove(saved.id);
  await d.sandbox.startupRecovery();
  expect(urls(d)).toEqual([]);
  expect(treeUrls(d.state.store.local_bookmark_backup)).toEqual(['https://saved.invalid/']);
  expect((await d.M.orchestrator.restoreLocalBackup({})).ok).toBe(true);
  expect(urls(d)).toEqual(['https://saved.invalid/']);
});

test('R4: startup resolves an explicitly unfinished transaction once, not future deliberate clears', async () => {
  let d = device('startup-pending', undefined, { background: true });
  await flush();
  const saved = await d.add('1', 'Saved', 'https://saved.invalid/');
  expect(await d.M.syncInput.backupLocalTree()).toBe(true);
  await d.chrome.bookmarks.remove(saved.id);
  d = restart(d, 'startup-pending-reloaded');
  await flush();
  await d.sandbox.startupRecovery();
  expect(urls(d)).toEqual(['https://saved.invalid/']);
  await removeAsUser(d, d.byId.get(d.paths()[0].id));
  await d.sandbox.startupRecovery();
  expect(urls(d)).toEqual([]);
});
