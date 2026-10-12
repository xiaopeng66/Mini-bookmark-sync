const { makeCloud, makeDevice } = require('./helpers/audit-harness.cjs');
test('local nested rename and move attaches remote-only descendants to the confirmed new parent', async () => {
  const cloud = makeCloud(), a = makeDevice('reverse-A', cloud), b = makeDevice('reverse-B', cloud);
  const folder = (d, title) => [...d.byId.values()].find(n => !n.url && n.title === title);
  const sync = async (d, action) => expect((await d.M.orchestrator[action]({})).success).toBe(true);
  try {
    const work = await a.add('1', 'Work'), inner = await a.add(work.id, 'Inner');
    await a.add(inner.id, 'Shared', 'https://shared.invalid/');
    await a.add('1', 'Dest');
    await sync(a, 'uploadBookmarks'); await sync(b, 'downloadBookmarks');
    a.state.now += 60000; b.state.now += 60000;
    const offline = await a.add(inner.id, 'Offline', 'https://offline.invalid/');
    await b.chrome.bookmarks.update(folder(b, 'Work').id, { title: 'Archive' });
    const localInner = folder(b, 'Inner');
    await b.chrome.bookmarks.update(localInner.id, { title: 'Updated' });
    const keys = () => b.M.xbelPath.computeJsonPathKeys(b.M.merger.chromeTreeToList([b.state.root]));
    const oldPk = keys().get(localInner.id);
    await b.chrome.bookmarks.move(localInner.id, { parentId: folder(b, 'Dest').id });
    b.state.store.sync_move_intents = {};
    for (const pk of [oldPk, keys().get(localInner.id)]) b.state.store.sync_move_intents[pk] = { time: b.state.now, deviceId: b.state.store.sync_device_id };
    await sync(a, 'uploadBookmarks');
    for (const d of [b, a, b, a]) await sync(d, 'mergeSync');
    for (const d of [a, b]) expect(d.paths().map(n => n.path).sort()).toEqual([
      '书签栏/Dest/Updated/Offline', '书签栏/Dest/Updated/Shared'
    ]);
    expect(a.byId.has(offline.id)).toBe(true);
  } finally { a.close(); b.close(); }
});
