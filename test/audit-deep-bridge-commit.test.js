const { makeDevice } = require('./helpers/audit-harness.cjs');
const devices = [];
function device(name) { const d = makeDevice(name); devices.push(d); return d; }
afterEach(() => { for (const d of devices.splice(0)) d.close(); });

for (const kind of ['berry', 'via', 'aira', 'airaHome']) {
  test(`${kind} commits only its confirmed phone write snapshot`, async () => {
    const d = device('bridge-write-' + kind);
    const key = kind + '_confirmed_snapshot';
    const value = { status: 'success', snapshotUpdates: { [key]: ['confirmed'] } };
    d.M.berry.patchBerryFile = async () => value;
    d.M.via.patchViaFile = async () => ({ html: { status: 'success' }, favorites: { status: 'success' }, snapshotUpdates: { [key]: ['confirmed'] } });
    d.M.aira.patchAiraFile = async () => kind === 'aira' ? value : { status: 'skipped' };
    d.M.aira.patchAiraPersonalization = async () => kind === 'airaHome' ? value : { status: 'skipped' };
    const result = await d.M.bridgePatcher.patchBridges({}, { berryOn: kind === 'berry', viaOn: kind === 'via', airaOn: kind.startsWith('aira') });
    expect(result.partial).toBe(false);
    expect(d.state.store[key]).toEqual(['confirmed']);
    expect(JSON.stringify(result.bridgeResults)).not.toContain('snapshotUpdates');
  });
}

test('incomplete Via two-file write cannot authorize a complete deletion baseline', async () => {
  const d = device('via-incomplete-write');
  d.state.store.via_pathkey_snapshot = ['old'];
  d.M.via.patchViaFile = async () => ({ html: { status: 'success' }, favorites: { status: 'failed', error: 'offline' }, snapshotUpdates: { via_pathkey_snapshot: ['unsafe'] } });
  const result = await d.M.bridgePatcher.patchBridges({}, { viaOn: true });
  expect(result.partial).toBe(true);
  expect(d.state.store.via_pathkey_snapshot).toEqual(['old']);
});

test('phone write snapshot storage failure is partial while other successful files continue', async () => {
  const d = device('bridge-snapshot-quota');
  d.state.failStorageKeys.add('berry_pathkey_snapshot');
  d.M.berry.patchBerryFile = async () => ({ status: 'success', snapshotUpdates: { berry_pathkey_snapshot: ['new'] } });
  d.M.aira.patchAiraFile = async () => ({ status: 'success', snapshotUpdates: { aira_pathkey_snapshot: ['new'] } });
  d.M.aira.patchAiraPersonalization = async () => ({ status: 'skipped' });
  const result = await d.M.bridgePatcher.patchBridges({}, { berryOn: true, airaOn: true });
  expect(result.partial).toBe(true);
  expect(result.bridgeResults.berry.status).toBe('failed');
  expect(result.bridgeResults.berry.error).toContain('基线');
  expect(result.bridgeResults.aira.status).toBe('success');
  expect(d.state.store.aira_pathkey_snapshot).toEqual(['new']);
});
