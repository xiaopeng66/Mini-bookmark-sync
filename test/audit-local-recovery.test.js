const { makeDevice, clone, flush } = require('./helpers/audit-harness.cjs');

const devices = [];
const META = 'local_bookmark_backup_meta';
const RECEIPT = 'local_bookmark_backup_commit';
const CHECKPOINT = 'local_bookmark_recovery_checkpoint';
const REMOTE = '<xbel><folder><title>书签栏</title><bookmark href="https://remote.invalid/"><title>Remote</title></bookmark></folder></xbel>';
const device = (...args) => { const d = makeDevice(...args); devices.push(d); return d; };
afterEach(() => { for (const d of devices.splice(0)) d.close(); });
const urls = d => d.paths().map(n => n.url).sort();

async function pending(name, background = true) {
  const d = device(name, undefined, { background });
  await flush();
  await d.add('1', 'Saved', 'https://saved.invalid/');
  await d.M.syncInput.ensureSyncRelationship(await d.M.storage.getWebdavConfig(), '1');
  expect(await d.M.syncInput.backupLocalTree()).toBe(true);
  return d;
}
function restart(old, name) {
  const d = device(name, old.cloud, { store: clone(old.state.store), background: true });
  d.state.root = clone(old.state.root);
  d.byId.clear();
  (function index(n) { d.byId.set(String(n.id), n); for (const child of n.children || []) index(child); })(d.state.root);
  old.close();
  return d;
}
function failCompletedMetadata(d) {
  const set = d.chrome.storage.local.set;
  d.chrome.storage.local.set = (data, cb) => {
    if (data[META]?.status === 'committed') {
      if (!cb) return Promise.reject(new Error('Synthetic completion storage failure'));
      d.chrome.runtime.lastError = { message: 'Synthetic completion storage failure' };
      cb();
      d.chrome.runtime.lastError = null;
      return;
    }
    return set(data, cb);
  };
  return () => { d.chrome.storage.local.set = set; };
}
async function recover(d, extra = {}) {
  return d.send({ action: 'restoreFromBackup', backupId: d.state.store[META]?.id,
    expectedStatus: d.state.store[META]?.status, ...extra });
}

// Removing the zero-count success branch falsely rejects an already-matching backup.
test('zero-count recovery reports success and unblocks the next download', async () => {
  const d = await pending('zero-count');
  const tree = clone(d.state.root);
  const result = await recover(d);
  expect(result).toMatchObject({ success: true, restored: 0 });
  expect(result.message).toContain('无需补回');
  expect(d.state.store[META].status).toBe('restored');
  expect(d.state.root).toEqual(tree);
  d.cloud.put(d.mainUrl, REMOTE);
  expect(await d.M.orchestrator.downloadBookmarks({})).toMatchObject({ success: true });
  expect(d.state.store[META].status).toBe('committed');
  expect(urls(d)).toEqual(['https://remote.invalid/', 'https://saved.invalid/']);
});

test('recovery inspection is read-only and explains the saved scope', async () => {
  const d = await pending('inspect');
  const state = clone(d.state.store), tree = clone(d.state.root);
  const result = await d.M.syncInput.getLocalRecoveryStatus();
  expect(result).toMatchObject({ ok: true, available: true, needsRecovery: true, status: 'pending',
    backupId: state[META].id, targetMatches: true, relationshipMatches: true,
    canRestore: true, canRepairCompletion: false, backupBookmarkCount: 1, currentBookmarkCount: 1 });
  expect(result.targetTitle).toBe('书签栏');
  expect(d.state.store).toEqual(state);
  expect(d.state.root).toEqual(tree);
  expect(d.cloud.requests).toEqual([]);
});

test.each(['uploadBookmarks', 'downloadBookmarks', 'mergeSync'])(
  '%s stops an unresolved backup before network or relationship changes', async method => {
    const d = await pending('preflight-' + method, false);
    d.cloud.put(d.mainUrl, REMOTE);
    const before = clone(d.state.store), tree = clone(d.state.root);
    const result = await d.M.orchestrator[method]({});
    expect(result).toMatchObject({ success: false, code: 'RECOVERY_REQUIRED', retryable: false });
    expect(d.cloud.requests).toEqual([]);
    expect(d.state.root).toEqual(tree);
    expect(d.state.store[META]).toEqual(before[META]);
    expect(d.state.store.local_bookmark_backup).toEqual(before.local_bookmark_backup);
    expect(d.state.store.sync_relationship_key).toBe(before.sync_relationship_key);
  }
);

test.each(['uploadBookmarks', 'downloadBookmarks', 'mergeSync'])(
  '%s completion receipt repairs metadata after restart without undoing later edits', async method => {
    let d = device('receipt-' + method);
    await d.add('1', 'Local', 'https://local.invalid/');
    d.cloud.put(d.mainUrl, REMOTE);
    failCompletedMetadata(d);
    const result = await d.M.orchestrator[method]({});
    expect(result).toMatchObject({ success: true, partial: true });
    const meta = clone(d.state.store[META]);
    const backup = clone(d.state.store.local_bookmark_backup);
    expect(meta.status).toBe('pending');
    expect(d.state.store[RECEIPT]).toMatchObject({ version: 1, backupId: meta.id,
      backupCreatedAt: meta.createdAt, sourceBucketId: '1', relationshipKey: meta.relationshipKey });
    const gone = d.paths().find(n => n.url === 'https://local.invalid/');
    await d.chrome.bookmarks.remove(gone.id);
    await d.add('2', 'Later', 'https://later.invalid/');
    const current = clone(d.state.root);
    d = restart(d, 'receipt-restarted-' + method);
    await flush();
    const requestCount = d.cloud.requests.length;
    const inspection = await d.send({ action: 'getLocalRecoveryStatus' });
    expect(inspection.canRepairCompletion).toBe(true);
    const repaired = await recover(d);
    expect(repaired).toMatchObject({ success: true, completionRepaired: true, restored: 0 });
    expect(d.state.store[META].status).toBe('committed');
    expect(d.state.root).toEqual(current);
    expect(d.state.store.local_bookmark_backup).toEqual(backup);
    expect(d.state.store[CHECKPOINT]).toBeFalsy();
    expect(d.cloud.requests).toHaveLength(requestCount);
  }
);

test('the next sync may finalize a matching receipt but never restores the old tree', async () => {
  const d = device('next-sync');
  await d.add('1', 'Saved', 'https://saved.invalid/');
  const reset = failCompletedMetadata(d);
  expect((await d.M.orchestrator.uploadBookmarks({})).partial).toBe(true);
  reset();
  const oldId = d.state.store[META].id;
  await d.add('1', 'Later', 'https://later.invalid/');
  expect((await d.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  expect(d.state.store[META].id).not.toBe(oldId);
  expect(d.state.store[META].status).toBe('committed');
  expect(urls(d)).toEqual(['https://later.invalid/', 'https://saved.invalid/']);
});

test.each(['backupId', 'backupCreatedAt', 'sourceBucketId', 'relationshipKey', 'version'])(
  'a mismatched receipt %s cannot release an unresolved backup', async key => {
    let d = device('bad-receipt-' + key);
    await d.add('1', 'Saved', 'https://saved.invalid/');
    failCompletedMetadata(d);
    expect((await d.M.orchestrator.uploadBookmarks({})).partial).toBe(true);
    expect(d.state.store[RECEIPT]).toBeDefined();
    d.state.store[RECEIPT][key] = key === 'version' ? 99 : 'different';
    d = restart(d, 'bad-receipt-restart-' + key);
    await flush();
    expect((await d.send({ action: 'getLocalRecoveryStatus' })).canRepairCompletion).toBe(false);
    const result = await d.M.orchestrator.downloadBookmarks({});
    expect(result.code).toBe('RECOVERY_REQUIRED');
    expect(d.state.store[META].status).toBe('pending');
  }
);

test.each(['restoring', 'failed'])('commit evidence never erases an unfinished %s recovery', async status => {
  let d = device('recovery-not-commit-' + status);
  await d.add('1', 'Saved', 'https://saved.invalid/');
  failCompletedMetadata(d);
  await d.M.orchestrator.uploadBookmarks({});
  d.state.store[META].status = status;
  d = restart(d, 'recovery-not-commit-reloaded-' + status);
  await flush();
  expect((await d.send({ action: 'getLocalRecoveryStatus' })).canRepairCompletion).toBe(false);
  expect((await d.M.orchestrator.downloadBookmarks({})).code).toBe('RECOVERY_REQUIRED');
});

test('commit acknowledgement is not fabricated from a successful write report', async () => {
  const d = await pending('no-inferred-commit');
  d.state.store.last_write_report = { ok: true, failedWrites: 0, at: d.state.now + 100 };
  d.state.store.last_sync_at = d.state.now + 100;
  const status = await d.send({ action: 'getLocalRecoveryStatus' });
  expect(status).toMatchObject({ needsRecovery: true, canRepairCompletion: false });
  expect((await d.M.orchestrator.mergeSync({})).code).toBe('RECOVERY_REQUIRED');
});

test.each(['target', 'account'])('confirmed recovery rejects a changed %s before any bookmark writes', async changed => {
  const d = await pending('mismatch-' + changed);
  if (changed === 'target') d.state.store.bookmark_target_id = '2';
  else d.state.store.webdav_user = 'another-account';
  const tree = clone(d.state.root), backup = clone(d.state.store.local_bookmark_backup);
  const result = await recover(d);
  expect(result).toMatchObject({ success: false, code: changed === 'target' ? 'BACKUP_TARGET_MISMATCH' : 'BACKUP_RELATIONSHIP_MISMATCH' });
  expect(d.state.root).toEqual(tree);
  expect(d.state.store.local_bookmark_backup).toEqual(backup);
  expect(d.state.store[META].status).toBe('pending');
  expect(d.state.store[CHECKPOINT]).toBeFalsy();
});

test('stale confirmation cannot restore a newer transaction backup', async () => {
  const d = await pending('stale-confirmation');
  const oldId = d.state.store[META].id;
  expect((await d.M.syncInput.completeLocalBackup()).ok).toBe(true);
  await d.add('1', 'Newer', 'https://newer.invalid/');
  expect(await d.M.syncInput.backupLocalTree()).toBe(true);
  const meta = clone(d.state.store[META]);
  const result = await recover(d, { backupId: oldId, expectedStatus: 'pending' });
  expect(result).toMatchObject({ success: false, code: 'BACKUP_CHANGED' });
  expect(d.state.store[META]).toEqual(meta);
  expect(d.state.store[CHECKPOINT]).toBeFalsy();
});

test('manual recovery preserves both the original backup and the pre-recovery tree', async () => {
  const d = await pending('recovery-checkpoint');
  const original = clone(d.state.store.local_bookmark_backup);
  await d.chrome.bookmarks.remove(d.paths()[0].id);
  await d.add('1', 'Later', 'https://later.invalid/');
  const before = clone([d.state.root]);
  expect((await recover(d)).success).toBe(true);
  expect(urls(d)).toEqual(['https://later.invalid/', 'https://saved.invalid/']);
  expect(d.state.store.local_bookmark_backup).toEqual(original);
  expect(d.state.store[CHECKPOINT]).toMatchObject({ backupId: d.state.store[META].id, tree: before });
});

test('checkpoint storage failure blocks recovery before bookmark mutation', async () => {
  const d = await pending('checkpoint-failed');
  await d.chrome.bookmarks.remove(d.paths()[0].id);
  await d.add('2', 'Outside', 'https://outside.invalid/');
  const tree = clone(d.state.root);
  d.state.failStorageKeys.add(CHECKPOINT);
  expect(await recover(d)).toMatchObject({ success: false, code: 'RECOVERY_CHECKPOINT_FAILED' });
  expect(d.state.root).toEqual(tree);
  expect(d.state.store[META].status).toBe('pending');
});

test('failed recovery retains its initial checkpoint and exposes a safe failure code on retry', async () => {
  const d = await pending('retry-checkpoint');
  await d.chrome.bookmarks.remove(d.paths()[0].id);
  await d.add('2', 'Outside', 'https://outside.invalid/');
  d.state.failCreates = info => !!info.url;
  expect(await recover(d)).toMatchObject({ success: false, code: 'RECOVERY_FAILED' });
  const checkpoint = clone(d.state.store[CHECKPOINT]);
  expect(checkpoint).toBeDefined();
  expect((await d.send({ action: 'getLocalRecoveryStatus' })).lastRecovery).toMatchObject({ code: 'RECOVERY_FAILED', conflictCount: 1 });
  await d.add('2', 'Later folder');
  d.state.failCreates = null;
  expect((await recover(d)).success).toBe(true);
  expect(d.state.store[CHECKPOINT]).toEqual(checkpoint);
});

test('recovery completion metadata failure is never reported as success', async () => {
  const d = await pending('restore-metadata');
  const set = d.chrome.storage.local.set;
  d.chrome.storage.local.set = (data, cb) => {
    if (data[META]?.status === 'restored') {
      d.chrome.runtime.lastError = { message: 'Synthetic restored metadata failure' };
      cb(); d.chrome.runtime.lastError = null; return;
    }
    return set(data, cb);
  };
  const result = await recover(d);
  expect(result).toMatchObject({ success: false, code: 'RECOVERY_METADATA_FAILED' });
  expect(d.state.store[META].status).toBe('restoring');
  expect(d.state.store.local_bookmark_backup).toBeDefined();
});

test('private export includes current and original bookmarks, not configuration or credentials', async () => {
  const d = await pending('private-export');
  await d.add('1', 'Later', 'https://later.invalid/');
  const before = clone(d.state.root), backup = clone(d.state.store.local_bookmark_backup);
  const result = await d.send({ action: 'exportLocalRecovery' });
  expect(result.ok).toBe(true);
  expect(result.data).toMatchObject({ format: 'minibookmark-sync-local-recovery', version: 1,
    currentTree: [before], originalBackup: backup });
  expect(JSON.stringify(result.data)).not.toMatch(/synthetic-password|synthetic-user|webdav_|relationshipKey|audit\.invalid/);
  expect(d.state.root).toEqual(before);
  expect(d.state.store.local_bookmark_backup).toEqual(backup);
});

test('a confirmed recovery waits for the sync mutex and rechecks the backup identity', async () => {
  const d = await pending('recovery-mutex');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const task = d.M.syncMutex.run(async () => {
    entered(); await gate;
    await d.M.syncInput.completeLocalBackup();
    await d.M.syncInput.backupLocalTree();
  });
  await ready;
  let settled = false;
  const operation = recover(d).then(result => { settled = true; return result; });
  await flush();
  try { expect(settled).toBe(false); } finally { release(); }
  await task;
  expect(await operation).toMatchObject({ success: false, code: 'BACKUP_CHANGED' });
});

test.each(['missing-id', 'missing-status', 'unknown-status', 'committed', 'restored'])(
  'public recovery rejects %s confirmation without changing bookmarks', async scenario => {
    const d = await pending('invalid-confirmation-' + scenario);
    const message = { action: 'restoreFromBackup', backupId: d.state.store[META].id, expectedStatus: 'pending' };
    if (scenario === 'missing-id') delete message.backupId;
    else if (scenario === 'missing-status') delete message.expectedStatus;
    else {
      const status = scenario === 'unknown-status' ? 'unexpected' : scenario;
      d.state.store[META].status = status;
      message.expectedStatus = status;
    }
    const tree = clone(d.state.root), meta = clone(d.state.store[META]);
    expect(await d.send(message)).toMatchObject({ success: false, code: 'BACKUP_CHANGED' });
    expect(d.state.root).toEqual(tree);
    expect(d.state.store[META]).toEqual(meta);
    expect(d.state.store[CHECKPOINT]).toBeFalsy();
  }
);

test('metadata-only confirmation never falls back to restoring an unconfirmed backup', async () => {
  const d = await pending('completion-only');
  await d.chrome.bookmarks.remove(d.paths()[0].id);
  const tree = clone(d.state.root), meta = clone(d.state.store[META]);
  expect(await recover(d, { repairOnly: true })).toMatchObject({ success: false, code: 'BACKUP_CHANGED' });
  expect(d.state.root).toEqual(tree);
  expect(d.state.store[META]).toEqual(meta);
  expect(d.state.store[CHECKPOINT]).toBeFalsy();
});

test('recovery status reflects the live mutex, not stale persisted syncing status', async () => {
  const d = await pending('recovery-busy');
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const task = d.M.syncMutex.run(async () => { entered(); await gate; });
  await ready;
  try {
    expect(await d.send({ action: 'getLocalRecoveryStatus' })).toMatchObject({ busy: true, canRestore: false });
  } finally { release(); await task; }
  d.state.store.sync_status = 'syncing';
  expect(await d.send({ action: 'getLocalRecoveryStatus' })).toMatchObject({ busy: false, canRestore: true });
});

test('manual retry honors a saved bucket-only scope instead of reviving unrelated home bookmarks', async () => {
  const d = await pending('saved-scope');
  const home = await d.add('2', '移动端主页');
  const removed = await d.add(home.id, 'Home saved', 'https://home.invalid/');
  expect((await d.M.syncInput.completeLocalBackup()).ok).toBe(true);
  expect(await d.M.syncInput.backupLocalTree()).toBe(true);
  d.state.store[META].status = 'failed';
  d.state.store[META].restoreOptions = { includeHome: false };
  await d.chrome.bookmarks.remove(removed.id);
  expect(await d.send({ action: 'getLocalRecoveryStatus' })).toMatchObject({ includeHome: false });
  expect((await recover(d)).success).toBe(true);
  expect(urls(d)).toEqual(['https://saved.invalid/']);
  expect(d.state.store[META].restoreOptions.includeHome).toBe(false);
});

test('manual rollback without a saved write set preserves later user additions', async () => {
  const d = await pending('rollback-no-write-set');
  await d.add('1', 'Later user bookmark', 'https://later.invalid/');
  d.state.store[META].status = 'failed';
  d.state.store[META].restoreOptions = { replaceCurrent: true, includeHome: false };
  expect((await recover(d)).success).toBe(true);
  expect(urls(d)).toEqual(['https://later.invalid/', 'https://saved.invalid/']);
});

test.each(['changed-target', 'missing-backup'])('metadata-only repair is independent of %s because it cannot restore bookmarks', async condition => {
  let d = device('receipt-independent-' + condition);
  await d.add('1', 'Saved', 'https://saved.invalid/');
  failCompletedMetadata(d);
  await d.M.orchestrator.uploadBookmarks({});
  d = restart(d, 'receipt-independent-restarted-' + condition);
  await flush();
  if (condition === 'changed-target') d.state.store.bookmark_target_id = '2';
  else delete d.state.store.local_bookmark_backup;
  const tree = clone(d.state.root);
  expect((await d.send({ action: 'getLocalRecoveryStatus' })).canRepairCompletion).toBe(true);
  expect(await recover(d, { repairOnly: true })).toMatchObject({ success: true, completionRepaired: true, restored: 0 });
  expect(d.state.root).toEqual(tree);
  expect(d.state.store[META].status).toBe('committed');
  expect(d.state.store[CHECKPOINT]).toBeFalsy();
});

test('unknown backup states block new sync and remain available for private export only', async () => {
  const d = await pending('unknown-state');
  d.state.store[META].status = 'unrecognized';
  const tree = clone(d.state.root), backup = clone(d.state.store.local_bookmark_backup);
  expect(await d.send({ action: 'getLocalRecoveryStatus' })).toMatchObject({ status: 'unknown', needsRecovery: true, canRestore: false });
  expect((await d.M.orchestrator.uploadBookmarks({})).code).toBe('RECOVERY_REQUIRED');
  expect((await d.send({ action: 'exportLocalRecovery' })).ok).toBe(true);
  expect(d.state.root).toEqual(tree);
  expect(d.state.store.local_bookmark_backup).toEqual(backup);
  expect(d.cloud.requests).toEqual([]);
});

test('rollback deletions are not recorded as user tombstones', async () => {
  const d = await pending('recovery-events');
  const extra = await d.add('1', 'Transaction extra', 'https://transaction.invalid/');
  d.state.store[META].status = 'failed';
  d.state.store[META].restoreOptions = { replaceCurrent: true, createdIds: [extra.id], includeHome: false };
  await d.M.syncInput.saveLocalSnapshot();
  const remove = d.chrome.bookmarks.remove;
  const observed = [];
  d.chrome.bookmarks.remove = (id, cb) => {
    const node = clone(d.byId.get(String(id)));
    return remove(id, () => {
      observed.push(d.sandbox.handleBookmarkRemoved(id, { node, parentId: node.parentId }));
      cb();
    });
  };
  expect((await recover(d)).success).toBe(true);
  await Promise.all(observed);
  expect(urls(d)).toEqual(['https://saved.invalid/']);
  expect(d.state.store.sync_tombstones || []).toEqual([]);
  expect(d.cloud.requests).toEqual([]);
});

test('startup does not restore a committed transaction when only its final marker failed', async () => {
  let d = device('startup-receipt');
  await d.add('1', 'Saved', 'https://saved.invalid/');
  failCompletedMetadata(d);
  expect((await d.M.orchestrator.uploadBookmarks({})).partial).toBe(true);
  await d.chrome.bookmarks.remove(d.paths()[0].id);
  d = restart(d, 'startup-receipt-restart');
  await flush();
  await d.sandbox.startupRecovery();
  expect(urls(d)).toEqual([]);
  expect(d.state.store[META].status).toBe('committed');
});
