const { makeDevice, clone } = require('./helpers/audit-harness.cjs');
const devices = [];
afterEach(() => { for (const d of devices.splice(0)) d.close(); });
function device(store) {
  const d = makeDevice('recovery-diagnostics', undefined, { store });
  devices.push(d);
  return d;
}

test('diagnostics expose incomplete recovery state without bookmark contents or relationship identities', async () => {
  const d = device({
    local_bookmark_backup: [{ id: '0', title: 'Private root', children: [
      { id: '1', title: 'Private folder', children: [{ id: '9', title: 'Private bookmark', url: 'https://private.invalid/?token=secret' }] }
    ] }],
    local_bookmark_backup_meta: { version: 1, id: 'backup-one', status: 'failed', createdAt: 123,
      sourceBucketId: '1', currentBucketId: '1', relationshipKey: 'private-account-key',
      restoreOptions: { replaceCurrent: true, createdIds: ['9'] },
      lastRecovery: { at: 456, code: 'RECOVERY_FAILED', restored: 0, conflictCount: 1,
        error: 'Private bookmark https://user:secret@private.invalid/ failed' } },
    sync_relationship_key: 'private-account-key'
  });
  const before = clone(d.state.store);
  const report = await d.M.utils.collectDiagnostics({ messageTimeoutMs: 50 });
  expect(report.localRecovery).toMatchObject({ ok: true, report: { status: 'failed', needsRecovery: true,
    createdAt: 123, targetMatches: true, relationshipMatches: true,
    lastRecovery: { at: 456, code: 'RECOVERY_FAILED', restored: 0, conflictCount: 1 } } });
  expect(JSON.stringify(report.localRecovery)).not.toMatch(/Private|private\.invalid|private-account-key|secret|createdIds|originalBackup/);
  expect(d.state.store).toEqual(before);
});

test('diagnostics distinguish a missing backup from a harmless absence of recovery metadata', async () => {
  const d = device({ local_bookmark_backup_meta: { version: 1, id: 'lost-backup', status: 'pending',
    createdAt: 123, sourceBucketId: '1' } });
  const missing = await d.M.utils.collectDiagnostics({ messageTimeoutMs: 50 });
  expect(missing.localRecovery).toMatchObject({ ok: true, report: { needsRecovery: true, available: false } });
  delete d.state.store.local_bookmark_backup_meta;
  const absent = await d.M.utils.collectDiagnostics({ messageTimeoutMs: 50 });
  expect(absent.localRecovery).toMatchObject({ ok: true, report: { needsRecovery: false, available: false, status: 'none' } });
});

test('unrecognized recovery error text is reduced to a fixed category', async () => {
  const d = device({ local_bookmark_backup_meta: { id: 'backup', status: 'failed',
    lastRecovery: { at: 123, code: 'Private-title-secret', error: 'password-value' } } });
  const report = await d.M.utils.collectDiagnostics({ messageTimeoutMs: 50 });
  expect(report.localRecovery?.report?.lastRecovery?.code).toBe('RECOVERY_FAILED');
  expect(JSON.stringify(report)).not.toMatch(/Private-title-secret|password-value/);
});
