const { makeCloud, makeDevice } = require('./helpers/audit-harness.cjs');

const devices = [];
const device = (...args) => { const d = makeDevice(...args); devices.push(d); return d; };
afterEach(() => { for (const d of devices.splice(0)) d.close(); });
const run = (d, action) => d.M.orchestrator[{ upload: 'uploadBookmarks', download: 'downloadBookmarks', merge: 'mergeSync' }[action]]({});
async function seedPair(titles = ['Keep', 'Delete']) {
  const cloud = makeCloud();
  const a = device('follow-A', cloud), b = device('follow-B', cloud);
  const folder = await a.add('1', 'Work');
  for (const title of titles) await a.add(folder.id, title, `https://${title.toLowerCase()}.invalid/`);
  expect((await run(a, 'upload')).success).toBe(true);
  expect((await run(b, 'download')).success).toBe(true);
  a.state.now += 60000; b.state.now += 60000;
  return { a, b, folder, localFolder: b.byId.get('1').children.find(n => n.title === 'Work') };
}
function cloudBookmarks(d) {
  return d.M.xbel.xbelToJson(d.cloud.files.get(d.mainUrl).content).bookmarks;
}

test('parent rename preserves a concurrent child deletion across devices and later rounds', async () => {
  const { a, b, folder, localFolder } = await seedPair();
  await b.chrome.bookmarks.remove(localFolder.children.find(n => n.title === 'Delete').id);
  await a.chrome.bookmarks.update(folder.id, { title: 'Renamed' });
  expect((await run(a, 'upload')).success).toBe(true);
  expect((await run(b, 'merge')).success).toBe(true);
  expect(b.paths().map(n => n.path)).toEqual(['书签栏/Renamed/Keep']);
  const ts = b.M.xbel.xbelToJson(b.cloud.files.get(b.mainUrl).content).tombstones;
  expect(ts.some(t => t.key === 'ROOT:bar/F:Renamed/L:https://delete.invalid')).toBe(true);
  expect((await run(a, 'merge')).success).toBe(true);
  expect((await run(b, 'merge')).success).toBe(true);
  expect(a.paths().map(n => n.path)).toEqual(['书签栏/Renamed/Keep']);
  expect(b.paths().map(n => n.path)).toEqual(['书签栏/Renamed/Keep']);
});

test('parent rename keeps the receiver child order change and propagates it to the author', async () => {
  const { a, b, folder, localFolder } = await seedPair(['X', 'Y', 'Z']);
  await b.chrome.bookmarks.move(localFolder.children[2].id, { parentId: localFolder.id, index: 0 });
  await a.chrome.bookmarks.update(folder.id, { title: 'Renamed' });
  expect((await run(a, 'upload')).success).toBe(true);
  expect((await run(b, 'merge')).success).toBe(true);
  expect(b.byId.get(localFolder.id).children.map(n => n.title)).toEqual(['Z', 'X', 'Y']);
  expect((await run(a, 'merge')).success).toBe(true);
  expect(a.byId.get(folder.id).children.map(n => n.title)).toEqual(['Z', 'X', 'Y']);
});

test('move into a new parent retains every folder layer and the receiving node IDs', async () => {
  const { a, b, folder, localFolder } = await seedPair(['Shared']);
  const childId = localFolder.children[0].id;
  const archive = await a.add('1', 'Archive');
  await a.chrome.bookmarks.move(folder.id, { parentId: archive.id });
  expect((await run(a, 'upload')).success).toBe(true);
  const merge = b.M.merger.mergeBookmarks;
  let plan;
  b.M.merger.mergeBookmarks = async (...args) => { plan = await merge(...args); return plan; };
  expect((await run(b, 'merge')).success).toBe(true);
  expect(plan.renamePairs.filter(p => p.oldPk === 'ROOT:bar/F:Work')).toHaveLength(1);
  expect(b.paths().map(n => n.path)).toEqual(['书签栏/Archive/Work/Shared']);
  expect(b.byId.get(localFolder.id).title).toBe('Work');
  expect(b.byId.has(childId)).toBe(true);
  expect((await run(a, 'merge')).success).toBe(true);
  expect((await run(b, 'merge')).success).toBe(true);
  expect(b.paths().map(n => n.path)).toEqual(['书签栏/Archive/Work/Shared']);
});

test('move into new nested ancestors preserves offline receiver descendants', async () => {
  const { a, b, folder, localFolder } = await seedPair(['Shared']);
  await b.add(localFolder.id, 'Offline', 'https://offline.invalid/');
  const archive = await a.add('1', 'Archive');
  const year = await a.add(archive.id, '2026');
  await a.chrome.bookmarks.move(folder.id, { parentId: year.id });
  expect((await run(a, 'upload')).success).toBe(true);
  expect((await run(b, 'merge')).success).toBe(true);
  expect(b.paths().map(n => n.path).sort()).toEqual([
    '书签栏/Archive/2026/Work/Offline', '书签栏/Archive/2026/Work/Shared'
  ]);
  expect((await run(a, 'merge')).success).toBe(true);
  expect(a.paths().map(n => n.path).sort()).toEqual([
    '书签栏/Archive/2026/Work/Offline', '书签栏/Archive/2026/Work/Shared'
  ]);
});

test('a failed move into a new parent keeps the old subtree and never overwrites cloud', async () => {
  const { a, b, folder, localFolder } = await seedPair(['Shared']);
  const archive = await a.add('1', 'Archive');
  await a.chrome.bookmarks.move(folder.id, { parentId: archive.id });
  expect((await run(a, 'upload')).success).toBe(true);
  const body = b.cloud.files.get(b.mainUrl).content;
  const move = b.chrome.bookmarks.move;
  b.chrome.bookmarks.move = (id, info, cb) => {
    if (String(id) === localFolder.id && info.parentId !== '1') {
      b.chrome.runtime.lastError = { message: 'Synthetic move failure' };
      cb(); b.chrome.runtime.lastError = null;
      return;
    }
    return move(id, info, cb);
  };
  expect((await run(b, 'merge')).success).toBe(false);
  expect(b.paths().map(n => n.path)).toEqual(['书签栏/Work/Shared']);
  expect(b.cloud.files.get(b.mainUrl).content).toBe(body);
});

test('upload and no-op merge serialize a home inside the bucket only once', async () => {
  const a = device('follow-home', makeCloud());
  const home = await a.add('1', '移动端主页');
  const mark = await a.add(home.id, 'Homepage', 'https://homepage.invalid/');
  expect((await run(a, 'upload')).success).toBe(true);
  expect(cloudBookmarks(a).filter(n => n.url === 'https://homepage.invalid/')).toHaveLength(1);
  expect((await run(a, 'merge')).success).toBe(true);
  expect(a.paths()).toHaveLength(1);
  expect(a.byId.has(mark.id)).toBe(true);
});


test('local parent rename follows a remote child deletion without restoring it at the new path', async () => {
  const { a, b, folder, localFolder } = await seedPair();
  await a.chrome.bookmarks.remove(a.byId.get(folder.id).children.find(n => n.title === 'Delete').id);
  expect((await run(a, 'upload')).success).toBe(true);
  await b.chrome.bookmarks.update(localFolder.id, { title: 'Renamed' });
  expect((await run(b, 'merge')).success).toBe(true);
  expect(b.paths().map(n => n.path)).toEqual(['书签栏/Renamed/Keep']);
  expect((await run(a, 'merge')).success).toBe(true);
  expect(a.paths().map(n => n.path)).toEqual(['书签栏/Renamed/Keep']);
});

test('nested parent renames keep a concurrent child order change', async () => {
  const { a, b, folder, localFolder } = await seedPair(['Sentinel']);
  const inner = await a.add(folder.id, 'Inner');
  for (const t of ['X', 'Y', 'Z']) await a.add(inner.id, t, `https://nested-${t.toLowerCase()}.invalid/`);
  expect((await run(a, 'upload')).success).toBe(true);
  expect((await run(b, 'download')).success).toBe(true);
  const localInner = b.byId.get(localFolder.id).children.find(n => n.title === 'Inner');
  await b.chrome.bookmarks.move(localInner.children[2].id, { parentId: localInner.id, index: 0 });
  await a.chrome.bookmarks.update(folder.id, { title: 'Renamed' });
  await a.chrome.bookmarks.update(inner.id, { title: 'NewInner' });
  expect((await run(a, 'upload')).success).toBe(true);
  expect((await run(b, 'merge')).success).toBe(true);
  expect(b.byId.get(localInner.id).title).toBe('NewInner');
  expect(b.byId.get(localInner.id).children.map(n => n.title)).toEqual(['Z', 'X', 'Y']);
});

test('two unrelated new empty folders are not paired as a rename (no folder is swallowed)', async () => {
  const cloud = makeCloud();
  const a = device('empty-A', cloud), b = device('empty-B', cloud);
  await a.add('1', 'Seed', 'https://seed.invalid/');
  expect((await run(a, 'upload')).success).toBe(true);
  expect((await run(b, 'download')).success).toBe(true);
  a.state.now += 60000; b.state.now += 60000;
  // 本端新增空文件夹 Alpha；对端新增空文件夹 Beta（两者互无关，都不是对方的旧名）
  await a.add('1', 'Alpha');
  expect((await run(a, 'upload')).success).toBe(true);
  await b.add('1', 'Beta');
  expect((await run(b, 'merge')).success).toBe(true);
  // 两端最终都应同时拥有 Alpha 与 Beta，谁都不能被当成对方的旧名吞掉
  const titles = b.byId.get('1').children.map(n => n.title).sort();
  expect(titles).toEqual(['Alpha', 'Beta', 'Seed']);
  expect((await run(a, 'merge')).success).toBe(true);
  expect(a.byId.get('1').children.map(n => n.title).sort()).toEqual(['Alpha', 'Beta', 'Seed']);
});

test('a child move lands even when its parent is renamed in the same round', async () => {
  const cloud = makeCloud();
  const a = device('prm-A', cloud), b = device('prm-B', cloud);
  const work = await a.add('1', 'Work');
  const keep = await a.add(work.id, 'Keep', 'https://keep.invalid/');
  const dest = await a.add('1', 'Dest');
  expect((await run(a, 'upload')).success).toBe(true);
  expect((await run(b, 'download')).success).toBe(true);
  a.state.now += 60000; b.state.now += 60000;
  // 同一轮：父文件夹 Work 改名 Archive，子书签 Keep 移动到 Dest
  await a.chrome.bookmarks.update(work.id, { title: 'Archive' });
  await a.chrome.bookmarks.move(keep.id, { parentId: dest.id });
  expect((await run(a, 'upload')).success).toBe(true);
  expect((await run(b, 'merge')).success).toBe(true);
  expect(b.paths().map(n => n.path)).toEqual(['书签栏/Dest/Keep']);
  expect((await run(a, 'merge')).success).toBe(true);
  expect(a.paths().map(n => n.path)).toEqual(['书签栏/Dest/Keep']);
});
