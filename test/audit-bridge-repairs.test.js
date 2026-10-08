const fs = require('fs');
const path = require('path');
const vm = require('vm');

function harness() {
  const store = {}, files = {};
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} }, Date, Math, URL, Set, Map,
    MiniSync: { webdav: {
      getFile: async (_base, _user, _pass, file) => files[file] ?? null,
      putFile: async (_base, _user, _pass, file, value) => { files[file] = value; return { lastModified: Date.now() }; },
      ensureWebDAVDir: async () => {}
    } },
    chrome: { storage: { local: {
      get: async (keys, callback) => {
        const result = Object.fromEntries(keys.map(k => [k, store[k]]));
        if (callback) callback(result);
        return result;
      },
      set: async data => Object.assign(store, data),
      remove: async key => { delete store[key]; }
    } } },
    fetch: async () => ({ ok: true, status: 200, text: async () => '', json: async () => null }),
    btoa: value => Buffer.from(value, 'binary').toString('base64')
  });
  const load = name => vm.runInContext(fs.readFileSync(path.resolve(__dirname, '..', name), 'utf8'), ctx, { filename: name, timeout: 300 });
  for (const file of ['lib/constants.js', 'lib/utils.js', 'model/xbel.js', 'model/xbel-path.js', 'adapters/berry-adapter.js', 'adapters/via-adapter.js', 'adapters/aira-adapter.js', 'core/bridge-patcher.js']) load(file);
  vm.runInContext(`getWebDAVConfig = async () => ({ url: 'https://local.invalid', user: 'test', username: 'test', password: 'synthetic' });
    getViaPath = async () => 'Via'; getBerryPath = async () => 'berry'; getDeviceId = async () => 'test';
    ensureWebDAVDir = async () => {}; zoneSummary = () => 'test';
    downloadBerryBookmarks = async () => bridgeBerry; uploadBerryBookmarks = async () => {};
    downloadViaBookmarks = async () => bridgeHtml; downloadViaFavorites = async () => bridgeFavorites;
    downloadAiraBookmarks = async () => bridgeAira; downloadAiraPersonalization = async () => bridgeHome;
    MiniSync.utils.fillMissingSiblingIndex = () => {};`, ctx);
  return { ctx, store, files, eval: code => vm.runInContext(code, ctx, { timeout: 300 }) };
}

const local = [
  { id: '1', parentId: 'root', title: '书签栏', isFolder: true, source: 'bar' },
  { id: 'gone', parentId: '1', title: 'Gone', url: 'https://gone.invalid/', isFolder: false, source: 'bar' },
  { id: 'keep', parentId: '1', title: 'Keep', url: 'https://keep.invalid/', isFolder: false, source: 'bar' }
];
const berry = nodes => ({ schemaVersion: 2, data: nodes.map(([id, title, url]) => ({ id, parentId: 'root', title, url, source: 'bar', isFolder: false })) });
const aira = nodes => ({ version: 2, deviceId: 'phone', snapshot: {
  bookmarkFolders: [{ id: 'browser_root_toolbar', parentId: null, title: '书签栏', type: 'bookmark-folder' }],
  bookmarkItems: nodes.map(([id, title, url]) => ({ id, parentId: 'browser_root_toolbar', title, url, type: 'bookmark-item' })),
  bookmarkOrders: [], tombstones: []
} });
const both = [['a', 'Gone', 'https://gone.invalid/'], ['b', 'Keep', 'https://keep.invalid/']];
const onlyKeep = [both[1]];

test.each(['berry', 'via', 'aira'])('%s exposes deletion ids and path keys only after complete phone read', async kind => {
  const h = harness();
  const set = nodes => {
    h.ctx.bridgeBerry = berry(nodes);
    h.ctx.bridgeAira = aira(nodes);
    h.ctx.bridgeHome = null;
    h.ctx.bridgeHtml = h.eval(`serializeToHtml(${JSON.stringify(nodes.map(([id, title, url]) => ({ id, title, url, parentId: 'root', source: 'bar', isFolder: false })))})`);
    h.ctx.bridgeFavorites = '';
  };
  const invoke = () => h.ctx.MiniSync[kind][`merge${kind[0].toUpperCase() + kind.slice(1)}DataWithChanges`](local.map(n => ({ ...n })), kind === 'via' ? null : false, kind === 'via' ? undefined : null);
  set(both);
  const first = await invoke();
  expect(first.complete).toBe(true);
  expect([...first.deletedIds]).toEqual([]);
  expect(h.store[`${kind}_pathkey_snapshot`]).toBeUndefined();
  Object.assign(h.store, first.snapshotUpdates);
  set(onlyKeep);
  const second = await invoke();
  expect(second.complete).toBe(true);
  expect([...second.deletedIds]).toContain('gone');
  expect([...second.deletedPathKeys]).toContain('ROOT:bar/L:https://gone.invalid');
  expect(second.list.some(n => n.id === 'gone')).toBe(false);
});

test('Via GET error leaves deletion baseline unchanged', async () => {
  const h = harness();
  h.ctx.bridgeHtml = h.eval(`serializeToHtml(${JSON.stringify(local.slice(1).map(n => ({ ...n, parentId: 'root' })))})`);
  h.ctx.bridgeFavorites = '';
  await h.ctx.MiniSync.via.mergeViaDataWithChanges(local).then(changes => Object.assign(h.store, changes.snapshotUpdates));
  const before = [...h.store.via_pathkey_snapshot];
  h.eval(`downloadViaBookmarks = async () => { throw new Error('network'); }`);
  const failed = await h.ctx.MiniSync.via.mergeViaDataWithChanges(local);
  expect(failed.complete).toBe(false);
  expect([...failed.deletedIds]).toEqual([]);
  expect(h.store.via_pathkey_snapshot).toEqual(before);
});

test('Aira home tombstone blocks shortcut injection', async () => {
  const h = harness();
  h.ctx.bridgeAira = aira(onlyKeep);
  h.ctx.bridgeHome = { sections: { home_shortcuts: { payload: { shortcuts: [{ id: 'sc1', title: 'Gone', url: 'https://gone.invalid/' }] } } } };
  const result = await h.ctx.MiniSync.aira.mergeAiraDataWithChanges(local, false, new Set(['ROOT:home/L:https://gone.invalid']));
  expect(result.list.some(n => n.id === 'sc1')).toBe(false);
});

test('Aira cyclic parent input fails promptly without updating deletion baseline', async () => {
  const h = harness();
  h.store.aira_pathkey_snapshot = ['ROOT:bar/L:https://gone.invalid'];
  h.ctx.bridgeAira = { snapshot: { bookmarkFolders: [{ id: 'a', parentId: 'b', title: 'A' }, { id: 'b', parentId: 'a', title: 'B' }], bookmarkItems: [] } };
  const result = await h.ctx.MiniSync.aira.mergeAiraDataWithChanges(local);
  expect(result.complete).toBe(false);
  expect([...result.deletedIds]).toEqual([]);
  expect(h.store.aira_pathkey_snapshot).toEqual(['ROOT:bar/L:https://gone.invalid']);
});

test('bridge patcher reports failed and skipped files independently', async () => {
  const h = harness();
  h.ctx.MiniSync.berry.patchBerryFile = async () => { throw Error('PUT 500'); };
  h.ctx.MiniSync.via.patchViaFile = async () => ({ html: { status: 'failed', error: 'PUT 500' }, favorites: { status: 'success' } });
  const result = await h.ctx.MiniSync.bridgePatcher.patchBridges({ berryList: local, viaList: local }, { berryOn: true, viaOn: true });
  expect(result.partial).toBe(true);
  expect(result.bridgeResults.berry.status).toBe('failed');
  expect(result.bridgeResults.viaHtml.status).toBe('failed');
  expect(result.bridgeResults.viaFavorites.status).toBe('success');
  expect(result.bridgeResults.aira.status).toBe('skipped');
});

test('bridge patcher treats missing per-file status as failure', async () => {
  const h = harness();
  h.ctx.MiniSync.berry.patchBerryFile = async () => undefined;
  h.ctx.MiniSync.via.patchViaFile = async () => ({ html: { status: 'success' } });
  h.ctx.MiniSync.aira.patchAiraFile = async () => undefined;
  h.ctx.MiniSync.aira.patchAiraPersonalization = async () => ({ status: 'success' });
  const result = await h.ctx.MiniSync.bridgePatcher.patchBridges({ berryList: local, viaList: local, airaList: local }, { berryOn: true, viaOn: true, airaOn: true });
  expect(result.partial).toBe(true);
  expect(result.bridgeResults.berry.status).toBe('failed');
  expect(result.bridgeResults.viaHtml.status).toBe('success');
  expect(result.bridgeResults.viaFavorites.status).toBe('failed');
  expect(result.bridgeResults.aira.status).toBe('failed');
  expect(result.bridgeResults.airaHome.status).toBe('success');
});

test('Aira incomplete g2 read exposes neither g3 deletions nor pending snapshots', async () => {
  const h = harness();
  h.store.aira_pathkey_snapshot = ['ROOT:bar/L:https://gone.invalid'];
  h.ctx.bridgeAira = aira(onlyKeep);
  h.eval(`downloadAiraPersonalization = async () => { throw Error('GET 500'); };`);
  const result = await h.ctx.MiniSync.aira.mergeAiraDataWithChanges(local);
  expect(result.complete).toBe(false);
  expect(result.list).toBe(local);
  expect(result.deletedIds).toEqual([]);
  expect(result.deletedPathKeys).toEqual([]);
  expect(result.snapshotUpdates).toBeUndefined();
  expect(h.store.aira_pathkey_snapshot).toEqual(['ROOT:bar/L:https://gone.invalid']);
});

test('Berry preferred ordering does not reinsert a tombstoned phone item', async () => {
  const h = harness();
  h.ctx.bridgeBerry = { ...berry(both), lastModified: 100 };
  const result = await h.ctx.MiniSync.berry.mergeBerryDataWithChanges(local, false, new Set(['ROOT:bar/L:https://gone.invalid']));
  expect(result.list.some(n => n.url === 'https://gone.invalid/')).toBe(false);
});

test.each([
  ['/custom/g3/bookmarks', '/custom/g2/personalization'],
  ['team/custom/g3/bookmarks', 'team/custom/g2/personalization'],
  ['aira/g3/bookmarks', 'aira/g2/personalization']
])('Aira g2 read and write preserve configured g3 prefix %s', async (g3, g2) => {
  const h = harness();
  h.store.aira_folder_path = g3;
  const reads = [], writes = [];
  h.ctx.MiniSync.webdav.getFile = async (_base, _user, _pass, file) => {
    reads.push(file);
    return JSON.stringify({ sections: {} });
  };
  h.ctx.MiniSync.webdav.putFile = async (_base, _user, _pass, file) => { writes.push(file); };
  await h.ctx.MiniSync.aira.downloadAiraBookmarks();
  await h.ctx.MiniSync.aira.downloadAiraPersonalization();
  await h.ctx.MiniSync.aira.uploadAiraPersonalization({ sections: {} });
  expect(reads).toEqual([`${g3}/snapshot.json`, `${g2}/snapshot.json`]);
  expect(writes).toEqual([`${g2}/snapshot.json`]);
  expect(h.store.aira_folder_path).toBe(g3);
});

test('Aira personalization read errors do not seed a replacement file', async () => {
  const h = harness();
  h.eval(`downloadAiraPersonalization = async () => { throw Error('GET 500'); };`);
  await expect(h.ctx.MiniSync.aira.patchAiraPersonalization(local, { align: true })).rejects.toThrow('GET 500');
});

test('Via malformed and empty HTML cannot advance deletion baseline', async () => {
  const h = harness();
  h.store.via_pathkey_snapshot = ['ROOT:bar/L:https://gone.invalid'];
  h.ctx.bridgeFavorites = '';
  for (const html of ['', '<DL><DT><A HREF="https://keep.invalid/">Keep']) {
    h.ctx.bridgeHtml = html;
    const result = await h.ctx.MiniSync.via.mergeViaDataWithChanges(local);
    expect(result.complete).toBe(false);
    expect(result.deletedIds).toEqual([]);
    expect(h.store.via_pathkey_snapshot).toEqual(['ROOT:bar/L:https://gone.invalid']);
  }
});

test('Aira malformed items cannot advance deletion baseline', async () => {
  const h = harness();
  h.store.aira_pathkey_snapshot = ['ROOT:bar/L:https://gone.invalid'];
  h.ctx.bridgeAira = { snapshot: { bookmarkFolders: [], bookmarkItems: {}, bookmarkOrders: [] } };
  const result = await h.ctx.MiniSync.aira.mergeAiraDataWithChanges(local);
  expect(result.complete).toBe(false);
  expect(result.deletedIds).toEqual([]);
  expect(h.store.aira_pathkey_snapshot).toEqual(['ROOT:bar/L:https://gone.invalid']);
});

test('failed Aira rebuild keeps one-shot rebuild flag for retry', async () => {
  const h = harness();
  h.store.aira_rebuild_once = true;
  h.ctx.MiniSync.aira.patchAiraFile = async () => { throw Error('PUT 500'); };
  const result = await h.ctx.MiniSync.bridgePatcher.patchBridges({ airaList: local }, { airaOn: true });
  expect(result.bridgeResults.aira.status).toBe('failed');
  expect(h.store.aira_rebuild_once).toBe(true);
});

test('Aira home shortcut deletion emits browser id and home path tombstone', async () => {
  const h = harness();
  const home = { id: 'home-gone', parentId: '__home_folder__', title: 'Gone', url: 'https://gone.invalid/', isFolder: false, source: 'home' };
  h.ctx.bridgeAira = aira(onlyKeep);
  h.ctx.bridgeHome = { sections: { home_shortcuts: { payload: { shortcuts: [{ id: 'sc1', title: 'Gone', url: 'https://gone.invalid/' }] } } } };
  const first = await h.ctx.MiniSync.aira.mergeAiraDataWithChanges([...local, home]);
  expect(first.complete).toBe(true);
  expect(h.store.aira_home_pathkey_snapshot).toBeUndefined();
  Object.assign(h.store, first.snapshotUpdates);
  h.ctx.bridgeHome = { sections: { home_shortcuts: { payload: { shortcuts: [] } } } };
  const second = await h.ctx.MiniSync.aira.mergeAiraDataWithChanges([...local, home]);
  expect(second.complete).toBe(true);
  expect(second.deletedIds).toContain('home-gone');
  expect(second.deletedPathKeys).toContain('ROOT:home/L:https://gone.invalid');
  expect(second.list.some(n => n.id === 'home-gone')).toBe(false);
});

test('Via malformed favorites records cannot advance deletion baseline', async () => {
  const h = harness();
  h.store.via_pathkey_snapshot = ['ROOT:bar/L:https://gone.invalid'];
  h.ctx.bridgeHtml = h.eval(`serializeToHtml(${JSON.stringify(local.slice(2).map(n => ({ ...n, parentId: 'root' })))})`);
  for (const txt of ['{invalid', '{"title":"No URL"}']) {
    h.ctx.bridgeFavorites = txt;
    const result = await h.ctx.MiniSync.via.mergeViaDataWithChanges(local);
    expect(result.complete).toBe(false);
    expect(result.deletedIds).toEqual([]);
    expect(h.store.via_pathkey_snapshot).toEqual(['ROOT:bar/L:https://gone.invalid']);
  }
});

test('Berry malformed rows cannot advance deletion baseline', async () => {
  const h = harness();
  h.store.berry_pathkey_snapshot = ['ROOT:bar/L:https://gone.invalid'];
  h.ctx.bridgeBerry = { schemaVersion: 2, data: [{ title: 'Broken', isFolder: false, url: 'https://keep.invalid/' }] };
  const result = await h.ctx.MiniSync.berry.mergeBerryDataWithChanges(local);
  expect(result.complete).toBe(false);
  expect(result.deletedIds).toEqual([]);
  expect(h.store.berry_pathkey_snapshot).toEqual(['ROOT:bar/L:https://gone.invalid']);
});

test('Via HTTP PUT failures cannot be reported as successful files', async () => {
  const h = harness();
  h.eval(`uploadViaHtml = async () => { throw Error('PUT 500'); }; uploadViaFavorites = async () => {};`);
  const result = await h.ctx.MiniSync.via.patchViaFile(local);
  expect(result.html.status).toBe('failed');
  expect(result.favorites.status).toBe('success');
});
