const { makeDevice, clone, response } = require('./helpers/audit-harness.cjs');
const devices = [];
afterEach(() => { for (const d of devices.splice(0)) d.close(); });
async function setup(name) {
  const d = makeDevice(name);
  devices.push(d);
  const folder = await d.add('1', 'Work');
  const leaf = await d.add(folder.id, 'Leaf', 'https://leaf.invalid/');
  await d.add('1', 'Keep', 'https://keep.invalid/');
  expect((await d.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  d.state.store.option_berry_enabled = true;
  d.M.bridgePatcher.patchBridges = async () => ({ partial: false, bridgeResults: {} });
  return { d, folder, leaf };
}
function plan(list, extra = {}) { return { complete: true, list, deletedIds: [], deletedPathKeys: [], snapshotUpdates: {}, ...extra }; }
function mainUrls(d) { return d.M.xbel.parseXbelFromString(d.cloud.files.get(d.mainUrl).content).bookmarks.filter(n => n.url).map(n => n.url); }

test('bridge rename plans update the existing Chrome parent before importing descendants', async () => {
  const { d, folder, leaf } = await setup('bridge-core-rename');
  d.M.berry.mergeBerryDataWithChanges = async source => {
    const list = clone(source);
    const node = list.find(n => n.id === folder.id);
    node.title = 'Renamed';
    return plan(list, { changed: true, pathRemaps: [{ id: folder.id, oldPk: 'ROOT:bar/F:Work', newPk: 'ROOT:bar/F:Renamed', title: 'Renamed', parentId: 'root' }] });
  };
  const result = await d.M.orchestrator.mergeSync({});
  expect(result.success).toBe(true);
  expect(d.byId.get(folder.id).title).toBe('Renamed');
  expect(d.byId.get(leaf.id).parentId).toBe(folder.id);
  expect(d.paths().filter(n => n.url === leaf.url)).toEqual([{ id: leaf.id, path: '书签栏/Renamed/Leaf', url: leaf.url }]);
  expect(d.cloud.files.get(d.mainUrl).content).not.toContain('<title>Work</title>');
});

test('bridge move creates missing parent chain then moves the original subtree', async () => {
  const { d, folder, leaf } = await setup('bridge-core-move');
  d.M.berry.mergeBerryDataWithChanges = async source => {
    const list = clone(source);
    const node = list.find(n => n.id === folder.id);
    node.parentId = 'phone-inner';
    list.push({ id: 'phone-outer', parentId: 'root', title: 'Archive', isFolder: true, source: 'bar' },
      { id: 'phone-inner', parentId: 'phone-outer', title: 'Later', isFolder: true, source: 'bar' });
    return plan(list, { changed: true, pathRemaps: [{ id: folder.id, oldPk: 'ROOT:bar/F:Work', newPk: 'ROOT:bar/F:Archive/F:Later/F:Work', title: 'Work', parentId: 'phone-inner' }] });
  };
  const result = await d.M.orchestrator.mergeSync({});
  expect(result.success).toBe(true);
  expect(d.byId.get(leaf.id).parentId).toBe(folder.id);
  expect(d.paths().filter(n => n.url === leaf.url)).toEqual([{ id: leaf.id, path: '书签栏/Archive/Later/Work/Leaf', url: leaf.url }]);
});

test('bridge content remaps preserve bookmark identity for title and URL edits', async () => {
  const { d, folder, leaf } = await setup('bridge-core-content');
  d.M.berry.mergeBerryDataWithChanges = async source => {
    const list = clone(source);
    Object.assign(list.find(n => n.id === leaf.id), { title: 'Edited', url: 'https://edited.invalid/' });
    return plan(list, { changed: true, pathRemaps: [{ id: leaf.id, oldPk: 'ROOT:bar/F:Work/L:https://leaf.invalid', newPk: 'ROOT:bar/F:Work/L:https://edited.invalid', title: 'Edited', url: 'https://edited.invalid/', parentId: folder.id }] });
  };
  expect((await d.M.orchestrator.mergeSync({})).success).toBe(true);
  expect(d.byId.get(leaf.id)).toMatchObject({ title: 'Edited', url: 'https://edited.invalid/' });
  expect(mainUrls(d)).toEqual(expect.arrayContaining(['https://edited.invalid/']));
  expect(mainUrls(d)).not.toContain(leaf.url);
});

test('a bridge-only addition forces a main-file write even when the initial merge was unchanged', async () => {
  const { d } = await setup('bridge-core-add');
  d.M.berry.mergeBerryDataWithChanges = async source => plan([...clone(source), { id: 'phone-fresh', parentId: 'root', title: 'Fresh', url: 'https://fresh.invalid/', source: 'bar' }]);
  expect((await d.M.orchestrator.mergeSync({})).success).toBe(true);
  expect(mainUrls(d)).toContain('https://fresh.invalid/');
});

for (const outcome of ['committed', 'conflict', 'newer-delete']) {
  test(`bridge re-add revokes only its confirmed original tombstone version (${outcome})`, async () => {
    const { d, leaf } = await setup('bridge-core-readd-' + outcome);
    await d.chrome.bookmarks.remove(leaf.id);
    const key = 'ROOT:bar/F:Work/L:https://leaf.invalid';
    const original = { key, deletedAt: d.state.now, deviceId: 'peer' };
    d.state.store.sync_tombstones = [original];
    expect((await d.M.orchestrator.uploadBookmarks({ force: true })).success).toBe(true);
    const snapshot = { berry_pathkey_snapshot: ['new-snapshot'] };
    d.M.berry.mergeBerryDataWithChanges = async source => plan([...clone(source), { id: 'phone-readd', parentId: source.find(n => n.title === 'Work').id, title: 'Leaf', url: leaf.url, source: 'bar' }],
      { changed: true, revokedPathKeys: [key], revokedTombstones: [original], snapshotUpdates: snapshot });
    const newer = { ...original, deletedAt: original.deletedAt + 1000, deviceId: 'this-device' };
    d.cloud.hook = req => {
      if (req.url !== d.mainUrl || req.method !== 'PUT') return null;
      if (outcome === 'conflict') return response(412, 'changed');
      if (outcome === 'newer-delete') d.state.store.sync_tombstones = [newer];
      return null;
    };
    const result = await d.M.orchestrator.mergeSync({});
    if (outcome === 'conflict') {
      expect(result.success).toBe(false);
      expect(d.state.store.sync_tombstones).toContainEqual(original);
      expect(d.state.store.berry_pathkey_snapshot).not.toEqual(snapshot.berry_pathkey_snapshot);
    } else {
      expect(result.success).toBe(true);
      expect(d.M.xbel.parseXbelFromString(d.cloud.files.get(d.mainUrl).content).tombstones.some(t => t.key === key)).toBe(false);
      expect(d.state.store.sync_tombstones).toEqual(outcome === 'newer-delete' ? [newer] : []);
      expect(d.state.store.berry_pathkey_snapshot).toEqual(snapshot.berry_pathkey_snapshot);
    }
  });
}
