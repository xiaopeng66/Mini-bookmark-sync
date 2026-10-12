const { makeCloud, makeDevice } = require('./helpers/audit-harness.cjs');

const devices = [];
afterEach(() => { for (const d of devices.splice(0)) d.close(); });
const device = (name, cloud) => { const d = makeDevice(name, cloud); devices.push(d); return d; };
const folder = (d, title) => [...d.byId.values()].find(n => !n.url && n.title === title);
const leaf = (d, title) => [...d.byId.values()].find(n => n.url && n.title === title);
async function run(d, action) {
  const result = await d.M.orchestrator[{ upload: 'uploadBookmarks', download: 'downloadBookmarks', merge: 'mergeSync' }[action]]({});
  expect(result.success, JSON.stringify(result)).toBe(true);
}
async function setup(seed = async () => ({})) {
  const cloud = makeCloud(), a = device('230-A', cloud), b = device('230-B', cloud);
  await a.add('1', 'Sentinel', 'https://sentinel.invalid/');
  const ids = await seed(a);
  await run(a, 'upload'); await run(b, 'download');
  a.state.now += 60000; b.state.now += 60000;
  return { a, b, ids };
}
async function rounds(a, b) { for (const d of [b, a, b, a]) await run(d, 'merge'); }
const paths = d => d.paths().map(n => n.path.replace(/^书签栏\//, '')).sort();
async function move(d, id, parentId) {
  const keys = () => d.M.xbelPath.computeJsonPathKeys(d.M.merger.chromeTreeToList([d.state.root]));
  const oldPk = keys().get(id);
  await d.chrome.bookmarks.move(id, { parentId });
  d.state.store.sync_move_intents ||= {};
  for (const pk of [oldPk, keys().get(id)]) d.state.store.sync_move_intents[pk] = { time: d.state.now, deviceId: d.state.store.sync_device_id };
}

test('independent new folders with identical descendants keep both copies after four merges', async () => {
  const { a, b } = await setup();
  const alpha = await a.add('1', 'Alpha'); await a.add(alpha.id, 'Shared', 'https://shared.invalid/');
  const beta = await b.add('1', 'Beta'); await b.add(beta.id, 'Shared', 'https://shared.invalid/');
  await run(a, 'upload'); await rounds(a, b);
  for (const d of [a, b]) expect(paths(d)).toEqual(['Alpha/Shared', 'Beta/Shared', 'Sentinel']);
});

test('a deleted folder is not renamed to unrelated empty candidates and offline descendants survive', async () => {
  const { a, b, ids } = await setup(async a => {
    const old = await a.add('1', 'Old'); await a.add(old.id, 'Deleted', 'https://deleted.invalid/'); return { old };
  });
  await a.chrome.bookmarks.removeTree(ids.old.id);
  await a.add('1', 'Alpha'); await a.add('1', 'Beta'); await run(a, 'upload');
  await b.add(folder(b, 'Old').id, 'Offline', 'https://offline.invalid/');
  await rounds(a, b);
  for (const d of [a, b]) {
    expect(paths(d)).toEqual(['Old/Offline', 'Sentinel']);
    expect(folder(d, 'Alpha').children).toHaveLength(0);
    expect(folder(d, 'Beta').children).toHaveLength(0);
  }
});

for (const order of [['P', 'Q'], ['Q', 'P']]) test(`cross-parent equal-content rename ambiguity preserves both offline branches (${order.join(',')})`, async () => {
  const { a, b, ids } = await setup(async a => {
    const parents = {};
    for (const title of order) parents[title] = await a.add('1', title);
    const old = await a.add(parents.P.id, 'Old'), other = await a.add(parents.Q.id, 'Other');
    await a.add(old.id, 'One', 'https://shared.invalid/');
    await a.add(other.id, 'Two', 'https://shared.invalid/');
    return { old, other, dest: await a.add('1', 'R') };
  });
  await a.chrome.bookmarks.removeTree(ids.old.id);
  await a.chrome.bookmarks.removeTree(ids.other.id);
  const replacement = await a.add(ids.dest.id, 'New');
  await a.add(replacement.id, 'Three', 'https://shared.invalid/');
  await b.add(folder(b, 'Old').id, 'OfflineP', 'https://p.invalid/');
  await b.add(folder(b, 'Other').id, 'OfflineQ', 'https://q.invalid/');
  await run(a, 'upload'); await rounds(a, b);
  for (const d of [a, b]) expect(paths(d)).toEqual([
    'P/Old/OfflineP', 'Q/Other/OfflineQ', 'R/New/Three', 'Sentinel'
  ]);
});

test('literal slash and percent-encoded-looking folder names remain separate on both devices', async () => {
  const { a, b } = await setup(async a => {
    const percent = await a.add('1', 'A%2FB'); await a.add(percent.id, 'Percent', 'https://percent.invalid/');
  });
  const slash = await a.add('1', 'A/B'); await a.add(slash.id, 'Slash', 'https://slash.invalid/');
  await run(a, 'upload'); await rounds(a, b);
  for (const d of [a, b]) {
    expect(paths(d)).toEqual(['A%2FB/Percent', 'A/B/Slash', 'Sentinel']);
    expect(folder(d, 'A%2FB').children.map(n => n.title)).toEqual(['Percent']);
    expect(folder(d, 'A/B').children.map(n => n.title)).toEqual(['Slash']);
  }
});

for (const renamer of ['a', 'b']) test(`parent rename preserves the other device child title edit (rename on ${renamer})`, async () => {
  const { a, b } = await setup(async a => {
    const work = await a.add('1', 'Work'); await a.add(work.id, 'Shared', 'https://shared.invalid/');
  });
  const author = renamer === 'a' ? a : b, editor = renamer === 'a' ? b : a;
  await author.chrome.bookmarks.update(folder(author, 'Work').id, { title: 'Renamed' });
  await editor.chrome.bookmarks.update(leaf(editor, 'Shared').id, { title: 'Edited' });
  await run(a, 'upload'); await rounds(a, b);
  for (const d of [a, b]) expect(paths(d)).toEqual(['Renamed/Edited', 'Sentinel']);
});

test('legacy slash tombstones delete their snapshot identity after upgrading, not URL percent bytes', async () => {
  const { a, b } = await setup(async a => {
    const slash = await a.add('1', 'A/B'); await a.add(slash.id, 'Slash', 'https://slash.invalid/a%2Fb');
    const percent = await a.add('1', '100%'); await a.add(percent.id, 'Percent', 'https://percent.invalid/a%2Fb');
  });
  const slash = folder(a, 'A/B');
  await a.chrome.bookmarks.removeTree(slash.id); await run(a, 'upload');
  // Simulate v2.3.0 persisted metadata, retaining all production XML/parser paths.
  const file = a.cloud.files.get(a.mainUrl);
  file.content = file.content.replaceAll('F~:A%2FB', 'F:A%2FB');
  await rounds(a, b);
  for (const d of [a, b]) {
    expect(paths(d)).toEqual(['100%/Percent', 'Sentinel']);
    expect(d.paths().find(n => n.path.endsWith('/Percent')).url).toBe('https://percent.invalid/a%2Fb');
  }
});

test('ambiguous legacy tombstone never deletes either slash or literal percent identity', () => {
  const d = device('legacy-ambiguous', makeCloud());
  const localList = [
    { id: 's', title: 'A/B', isFolder: true, parentId: '0', source: 'bar' },
    { id: 'p', title: 'A%2FB', isFolder: true, parentId: '0', source: 'bar' }
  ];
  const view = d.M.tombstone.buildTombstoneView({ localList, prevSnapshotList: localList,
    remoteList: [], myDeviceId: 'receiver', remoteTombstones: [{ key: 'ROOT:bar/F:A%2FB', deviceId: 'old-peer', deletedAt: 1 }] });
  expect([...view.tombstoneKeys]).toEqual([]);
});

test('empty remote merge persists translated legacy tombstones rather than the colliding old key', async () => {
  const d = device('legacy-empty', makeCloud());
  const slash = await d.add('1', 'A/B');
  const list = d.M.merger.chromeTreeToList([d.state.root]);
  d.state.store.sync_snapshots = { localTree: list };
  const result = await d.M.merger.mergeBookmarks([d.state.root], { bookmarks: [], tombstones: [
    { key: 'ROOT:bar/F:A%2FB', deviceId: 'peer', deletedAt: 1 }
  ] }, {});
  expect(result.localDeletedIds).toContain(slash.id);
  expect(result.tombstones.map(t => t.key)).toEqual(['ROOT:bar/F~:A%2FB']);
  expect(d.state.store.sync_tombstones.map(t => t.key)).toEqual(['ROOT:bar/F~:A%2FB']);
});

test('ordinary percent-title tombstones still delete literal identities without slash evidence', () => {
  const d = device('legacy-percent', makeCloud());
  const localList = [{ id: 'p', title: 'A%2FB', isFolder: true, parentId: '0', source: 'bar' }];
  const view = d.M.tombstone.buildTombstoneView({ localList, prevSnapshotList: localList,
    remoteList: [], myDeviceId: 'receiver', remoteTombstones: [{ key: 'ROOT:bar/F:A%2FB', deviceId: 'peer', deletedAt: 1 }] });
  expect([...view.tombstoneKeys]).toEqual(['ROOT:bar/F:A%2FB']);
});

test('parent rename plus nested move and rename carries receiver-only leaves without deleting their IDs', async () => {
  const { a, b, ids } = await setup(async a => {
    const work = await a.add('1', 'Work'), inner = await a.add(work.id, 'Inner');
    await a.add(inner.id, 'Shared', 'https://shared.invalid/');
    return { work, inner, dest: await a.add('1', 'Dest') };
  });
  const offline = await b.add(folder(b, 'Inner').id, 'Offline', 'https://offline.invalid/');
  await a.chrome.bookmarks.update(ids.work.id, { title: 'Archive' });
  await a.chrome.bookmarks.update(ids.inner.id, { title: 'Updated' });
  await move(a, ids.inner.id, ids.dest.id);
  await run(a, 'upload'); await rounds(a, b);
  for (const d of [a, b]) expect(paths(d)).toEqual(['Dest/Updated/Offline', 'Dest/Updated/Shared', 'Sentinel']);
  expect(b.byId.has(offline.id)).toBe(true);
});
