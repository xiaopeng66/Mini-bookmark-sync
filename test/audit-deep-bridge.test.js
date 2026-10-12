'use strict';

const vm = require('node:vm');
const { makeCloud, makeDevice, clone, response } = require('./helpers/audit-harness.cjs');

// All sync tests load the actual background importScripts modules. Only Chrome,
// WebDAV and time are synthetic. Expected parent chains below are hand-written.
const KINDS = ['berry', 'via', 'aira'];
const URLS = {
  berry: 'https://audit.invalid/dav/berry/bookmarks.json',
  via: 'https://audit.invalid/dav/Via/bookmarks.html',
  aira: 'https://audit.invalid/dav/aira/g3/bookmarks/snapshot.json'
};
const HOME_URL = 'https://audit.invalid/dav/aira/g2/personalization/snapshot.json';
const TARGET = 'https://target.invalid';
const TARGET_KEY = 'ROOT:bar/F~:A%2FB/L:https://target.invalid';
const ROOTS = new Set(['root', '0', '1', '2', '3', 'browser_root_toolbar', 'browser_root_other', 'browser_root_mobile']);
const devices = [];
afterEach(() => { for (const d of devices.splice(0)) d.close(); });
function device(kind) {
  const d = makeDevice('deep-bridge-' + kind, makeCloud());
  devices.push(d);
  return d;
}
const evaluate = (d, code) => vm.runInContext(code, d.sandbox);
const folder = (id, title, parentId = 'root') => ({ id, parentId, title, isFolder: true, source: 'bar' });
const leaf = (id, title, url, parentId = 'root') => ({ id, parentId, title, url, isFolder: false, source: 'bar' });
function fixture(title = 'A/B', target = true) {
  return [folder('phone-folder', title),
    ...(target ? [leaf('phone-leaf', 'Target', TARGET, 'phone-folder')] : []),
    leaf('phone-keep', 'Sentinel', 'https://sentinel.invalid')];
}
function rawAira(list) {
  return { version: 2, deviceId: 'synthetic-phone', history: { epochId: 'synthetic-history' },
    snapshot: { meta: { version: 2, deviceId: 'synthetic-phone' },
      bookmarkFolders: [{ id: 'browser_root_toolbar', parentId: null, title: '书签栏', type: 'bookmark-folder' },
        ...list.filter(n => n.isFolder).map(n => ({ ...clone(n), parentId: n.parentId === 'root' ? 'browser_root_toolbar' : n.parentId, type: 'bookmark-folder' }))],
      bookmarkItems: list.filter(n => !n.isFolder).map(n => ({ ...clone(n), parentId: n.parentId === 'root' ? 'browser_root_toolbar' : n.parentId, type: 'bookmark-item' })),
      bookmarkOrders: [], tombstones: [], appPrivateBookmarks: { opaque: 'do-not-rewrite' } } };
}
function seed(d, kind, list) {
  if (kind === 'berry') d.cloud.put(URLS.berry, JSON.stringify({ schemaVersion: 2, data: clone(list) }), 'application/json');
  if (kind === 'via') {
    d.cloud.put(URLS.via, evaluate(d, `serializeToHtml(${JSON.stringify(list)})`), 'text/html');
    d.cloud.put('https://audit.invalid/dav/Via/favorites.txt', '', 'text/plain');
  }
  if (kind === 'aira') {
    d.cloud.put(URLS.aira, JSON.stringify(rawAira(list)), 'application/json');
    d.cloud.put(HOME_URL, JSON.stringify({ sections: {
      home_shortcuts: { enabled: true, updatedAt: 0, payload: { scenarios: [], shortcuts: [], orders: [] } },
      core_preferences: { enabled: false, updatedAt: 0, payload: {} },
      activity_heatmap: { enabled: false, updatedAt: 0, payload: { contributions: [] } },
      search: { enabled: false, updatedAt: 0, payload: {} }
    } }), 'application/json');
  }
}
function phone(d, kind) {
  const content = d.cloud.files.get(URLS[kind]).content;
  if (kind === 'berry') return JSON.parse(content).data;
  if (kind === 'via') return clone(evaluate(d, `parseHtmlToBookmarks(${JSON.stringify(content)})`));
  return clone(evaluate(d, `airaSnapshotToList(${content})`));
}
const local = d => clone(d.M.merger.chromeTreeToList([d.state.root]));
const main = d => clone(d.M.xbel.xbelToJson(d.cloud.files.get(d.mainUrl).content).bookmarks);
const tombstoneKeys = d => (d.state.store.sync_tombstones || []).map(t => typeof t === 'string' ? t : t.key);
function parentChain(list, node) {
  const byId = new Map(list.map(n => [String(n.id), n]));
  const seen = new Set([String(node.id)]);
  const chain = [];
  let pid = node.parentId;
  while (pid && !ROOTS.has(String(pid))) {
    if (seen.has(String(pid))) throw Error('Cyclic parent in test output');
    seen.add(String(pid));
    const p = byId.get(String(pid));
    if (!p) throw Error('Orphan parent ' + pid + ' for ' + node.title);
    chain.unshift(p.title);
    pid = p.parentId;
  }
  return chain;
}
function leafParents(list, url) {
  return list.filter(n => n.url === url).map(n => parentChain(list, n));
}
function expectEveryCopy(d, kind, url, parents) {
  for (const list of [local(d), main(d), phone(d, kind)]) expect(leafParents(list, url)).toEqual(parents);
}
async function boundary(d, kind, list, keys = null) {
  const fn = d.M[kind][`merge${kind[0].toUpperCase() + kind.slice(1)}DataWithChanges`];
  return kind === 'via' ? fn(clone(list), keys) : fn(clone(list), false, keys);
}
async function sync(d, { partial = false } = {}) {
  d.state.now += 60000;
  const result = await d.M.orchestrator.mergeSync({});
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(!!result.partial, JSON.stringify(result)).toBe(partial);
  return result;
}
async function setup(kind, list = fixture()) {
  const d = device(kind);
  const ids = new Map([['root', '1']]);
  for (const n of list) {
    const created = await d.add(ids.get(n.parentId), n.title, n.url);
    ids.set(n.id, created.id);
  }
  expect((await d.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  seed(d, kind, list);
  d.state.store['option_' + kind + '_enabled'] = true;
  await sync(d);
  return { d, ids };
}
function legacySnapshot(d, kind) {
  const key = kind + '_pathkey_snapshot';
  d.state.store[key] = d.state.store[key].map(pk => pk.replaceAll('F~:A%2FB', 'F:A%2FB'));
  delete d.state.store[key + '_meta']; // Real upgrade: no new identity/version metadata.
}
function readd(d) {
  const nodes = fixture().map(n => n.url === TARGET ? { ...n, id: 'phone-readded-leaf',
    addedAt: d.state.now + 1000, createdAt: new Date(d.state.now + 1000).toISOString(),
    updatedAt: new Date(d.state.now + 1000).toISOString() } : n);
  nodes.push(leaf('phone-fresh', 'Fresh control', 'https://fresh-control.invalid', 'phone-folder'));
  return nodes;
}
async function deletedBaseline(kind, legacy = false) {
  const result = await setup(kind);
  if (legacy) legacySnapshot(result.d, kind);
  seed(result.d, kind, fixture('A/B', false));
  await sync(result.d);
  expectEveryCopy(result.d, kind, TARGET, []);
  expect(tombstoneKeys(result.d)).toContain(TARGET_KEY);
  return result;
}

// Break caught: treating the missing old folder as deletion while globally
// deduplicating its surviving child by URL; importer then roots the orphan.
for (const kind of KINDS) {
  test.each(['Work', 'A/B'])(`${kind}: phone parent rename preserves Chrome child identity and converges (%s)`, async title => {
    const { d, ids } = await setup(kind, fixture(title));
    seed(d, kind, fixture('Renamed'));
    for (let i = 0; i < 2; i++) {
      await sync(d);
      expectEveryCopy(d, kind, TARGET, [['Renamed']]);
      expectEveryCopy(d, kind, 'https://sentinel.invalid', [[]]);
      expect(d.byId.get(ids.get('phone-folder'))?.title).toBe('Renamed');
      expect(d.byId.get(ids.get('phone-leaf'))?.parentId).toBe(ids.get('phone-folder'));
      expect(tombstoneKeys(d).some(pk => pk.includes('/F:Renamed/'))).toBe(false);
    }
  });

  test(`${kind}: unchanged literal percent folder and URL bytes survive two syncs`, async () => {
    const url = 'https://literal.invalid/path?q=%2F&name=&amp;literal#/route/';
    const list = [folder('percent', 'A%2FB'), leaf('literal', 'Literal', url, 'percent'),
      leaf('sentinel', 'Sentinel', 'https://sentinel.invalid')];
    const { d, ids } = await setup(kind, list);
    await sync(d);
    expectEveryCopy(d, kind, url, [['A%2FB']]);
    expect(d.byId.has(ids.get('literal'))).toBe(true);
  });

  test.each(['current', 'legacy'])(`${kind}: phone deletion uses canonical tree evidence with %s snapshot`, async version => {
    const { d } = await deletedBaseline(kind, version === 'legacy');
    await sync(d);
    expectEveryCopy(d, kind, TARGET, []);
    expectEveryCopy(d, kind, 'https://sentinel.invalid', [[]]);
    expect(tombstoneKeys(d)).toContain(TARGET_KEY);
  });

  // Break caught: a confirmed deleted bridge snapshot is ignored and an old
  // tombstone permanently rejects the reappearing path, unlike fresh URLs.
  test.each(['current', 'legacy'])(`${kind}: acknowledged phone deletion permits later re-add (%s)`, async version => {
    const { d } = await deletedBaseline(kind, version === 'legacy');
    seed(d, kind, readd(d));
    for (let i = 0; i < 2; i++) {
      await sync(d);
      expectEveryCopy(d, kind, TARGET, [['A/B']]);
      expectEveryCopy(d, kind, 'https://fresh-control.invalid', [['A/B']]);
      expect(tombstoneKeys(d)).not.toContain(TARGET_KEY);
      const remoteKeys = d.M.tombstone.extractKeys(d.M.xbel.parseXbelFromString(d.cloud.files.get(d.mainUrl).content).tombstones);
      expect(remoteKeys.has(TARGET_KEY)).toBe(false);
    }
  });

  test(`${kind}: unacknowledged local deletion cannot be revoked by the old phone copy`, async () => {
    const { d, ids } = await setup(kind);
    await d.chrome.bookmarks.remove(ids.get('phone-leaf'));
    d.state.store.sync_tombstones = [{ key: TARGET_KEY, deletedAt: ++d.state.now, deviceId: d.state.store.sync_device_id }];
    d.state.store.sync_tombstone_acked = [];
    await sync(d);
    expectEveryCopy(d, kind, TARGET, []);
    expect(tombstoneKeys(d)).toContain(TARGET_KEY);
  });

  test(`${kind}: desktop deletion successfully written to phone permits immediate phone re-add`, async () => {
    const { d, ids } = await setup(kind);
    await d.chrome.bookmarks.remove(ids.get('phone-leaf'));
    await sync(d);
    expectEveryCopy(d, kind, TARGET, []);
    seed(d, kind, readd(d));
    await sync(d);
    await sync(d);
    expectEveryCopy(d, kind, TARGET, [['A/B']]);
    expect(tombstoneKeys(d)).not.toContain(TARGET_KEY);
  });

  test(`${kind}: failed phone deletion write does not acknowledge absence or resurrect a stale copy`, async () => {
    const { d, ids } = await setup(kind);
    await d.chrome.bookmarks.remove(ids.get('phone-leaf'));
    d.cloud.hook = req => req.url === URLS[kind] && req.method === 'PUT' ? response(500, 'synthetic failure') : null;
    await sync(d, { partial: true });
    expect(leafParents(phone(d, kind), TARGET)).toEqual([['A/B']]);
    d.cloud.hook = null;
    await sync(d);
    expectEveryCopy(d, kind, TARGET, []);
    expect(tombstoneKeys(d)).toContain(TARGET_KEY);
  });

  test(`${kind}: confirmed older deletion does not authorize revoking a newer same-key tombstone`, async () => {
    const { d } = await deletedBaseline(kind);
    d.state.now += 1000;
    const newer = { key: TARGET_KEY, deletedAt: d.state.now, deviceId: d.state.store.sync_device_id };
    d.state.store.sync_tombstones = [newer];
    seed(d, kind, readd(d));
    await sync(d);
    expect(leafParents(local(d), TARGET)).toEqual([]);
    expect(leafParents(main(d), TARGET)).toEqual([]);
    expect(d.state.store.sync_tombstones).toContainEqual(newer);
    expectEveryCopy(d, kind, 'https://fresh-control.invalid', [['A/B']]);
  });

  test(`${kind}: main PUT failure retains deletion evidence for a re-add retry`, async () => {
    const { d } = await deletedBaseline(kind);
    const originalTs = clone(d.state.store.sync_tombstones);
    const originalKeys = clone(d.state.store[kind + '_pathkey_snapshot']);
    seed(d, kind, readd(d));
    d.cloud.hook = req => req.url === d.mainUrl && req.method === 'PUT' ? response(500, 'synthetic failure') : null;
    d.state.now += 60000;
    const failed = await d.M.orchestrator.mergeSync({});
    expect(failed.success).toBe(false);
    expect(d.state.store.sync_tombstones).toEqual(originalTs);
    expect(d.state.store[kind + '_pathkey_snapshot']).toEqual(originalKeys);
    d.cloud.hook = null;
    await sync(d);
    expectEveryCopy(d, kind, TARGET, [['A/B']]);
  });

  test(`${kind}: equal URL in another folder neither masks a deletion nor guesses identity`, async () => {
    const list = [...fixture('Work'), folder('archive', 'Archive'), leaf('archive-copy', 'Target', TARGET, 'archive')];
    const { d, ids } = await setup(kind, list);
    seed(d, kind, list.filter(n => n.id !== 'phone-leaf'));
    await sync(d);
    await sync(d);
    expectEveryCopy(d, kind, TARGET, [['Archive']]);
    expect(d.byId.has(ids.get('archive-copy'))).toBe(true);
    expect(d.byId.has(ids.get('phone-leaf'))).toBe(false);
  });

  test(`${kind}: a new same-title subtree in another parent is not globally deduplicated`, async () => {
    const list = [folder('old-parent', 'Old'), folder('old-child', 'Shared', 'old-parent'),
      leaf('old-leaf', 'Target', TARGET, 'old-child'), leaf('keep', 'Sentinel', 'https://sentinel.invalid')];
    const { d } = await setup(kind, list);
    const added = [folder('new-parent', 'New'), folder('new-child', 'Shared', 'new-parent'),
      leaf('new-leaf', 'Target', TARGET, 'new-child')];
    seed(d, kind, [...list, ...added]);
    await sync(d);
    await sync(d);
    expectEveryCopy(d, kind, TARGET, [['Old', 'Shared'], ['New', 'Shared']]);
  });

  // Break caught: blindly decoding legacy %2F chooses one of two possible
  // identities or disables all deletions instead of isolating the ambiguity.
  test(`${kind}: ambiguous legacy slash key preserves both candidates but propagates unrelated deletion`, async () => {
    const list = [...fixture(), folder('percent', 'A%2FB'), leaf('percent-leaf', 'Target', TARGET, 'percent'),
      leaf('gone', 'Gone', 'https://gone.invalid')];
    const { d } = await setup(kind, list);
    legacySnapshot(d, kind);
    seed(d, kind, list.filter(n => !['phone-leaf', 'percent-leaf', 'gone'].includes(n.id)));
    await sync(d);
    expectEveryCopy(d, kind, TARGET, [['A/B'], ['A%2FB']]);
    expectEveryCopy(d, kind, 'https://gone.invalid', []);
    expect(tombstoneKeys(d)).toContain('ROOT:bar/L:https://gone.invalid');
  });

  test(`${kind}: bridge node IDs cannot overwrite unrelated current IDs`, async () => {
    const d = device(kind);
    seed(d, kind, fixture('Incoming'));
    const incoming = phone(d, kind);
    const parent = incoming.find(n => n.title === 'Incoming');
    const current = [folder(parent.id, 'Unrelated'), leaf('local-child', 'Local', 'https://local.invalid', parent.id)];
    const result = await boundary(d, kind, current);
    expect(result.complete).toBe(true);
    expect(new Set(result.list.map(n => n.id)).size).toBe(result.list.length);
    expect(leafParents(result.list, TARGET)).toEqual([['Incoming']]);
    expect(leafParents(result.list, 'https://local.invalid')).toEqual([['Unrelated']]);
    expect(current[0].title).toBe('Unrelated');
  });
}

function airaIntegrity(d) {
  const snap = JSON.parse(d.cloud.files.get(URLS.aira).content).snapshot;
  const all = [...snap.bookmarkFolders, ...snap.bookmarkItems];
  const byId = new Map(all.map(n => [n.id, n]));
  const orphanParents = all.filter(n => n.parentId != null && !byId.has(n.parentId));
  expect(orphanParents).toEqual([]);
  expect(byId.size).toBe(all.length);
  for (const o of snap.bookmarkOrders) {
    expect(o.parentId == null || byId.get(o.parentId)?.type === 'bookmark-folder').toBe(true);
    expect(new Set(o.ids).size).toBe(o.ids.length);
    for (const id of o.ids) {
      expect(byId.has(id)).toBe(true);
      expect(byId.get(id).parentId).toBe(o.parentId);
    }
  }
  return snap;
}
function collisionList(nested = true) {
  return [folder('slash', nested ? 'A/F:B' : 'A/B'), leaf('slash-leaf', 'Slash', 'https://slash.invalid', 'slash'),
    ...(nested ? [folder('outer', 'A'), folder('nested', 'B', 'outer')] : [folder('nested', 'A%2FB')]),
    leaf('nested-leaf', 'Nested', 'https://nested.invalid', 'nested')];
}

test.each([true, false])('Aira canonical dedup keeps distinct folder chains (nested collision=%s)', async nested => {
  const d = device('aira');
  const list = collisionList(nested);
  seed(d, 'aira', list);
  await d.M.aira.patchAiraFile(clone(list));
  airaIntegrity(d);
  expect(leafParents(phone(d, 'aira'), 'https://slash.invalid')).toEqual([[nested ? 'A/F:B' : 'A/B']]);
  expect(leafParents(phone(d, 'aira'), 'https://nested.invalid')).toEqual([nested ? ['A', 'B'] : ['A%2FB']]);
});

test('Aira no-op merge never writes dangling parents for A/F:B versus nested A/B', async () => {
  const { d } = await setup('aira', collisionList());
  for (let i = 0; i < 2; i++) {
    await sync(d);
    airaIntegrity(d);
    expectEveryCopy(d, 'aira', 'https://slash.invalid', [['A/F:B']]);
    expectEveryCopy(d, 'aira', 'https://nested.invalid', [['A', 'B']]);
  }
});

test('Aira duplicate aliases remap every surviving parent and order reference without replacing native fields', async () => {
  const d = device('aira');
  const list = [folder('keep-parent', 'Shared'), folder('alias-parent', 'Shared'),
    folder('keep-child', 'Inner', 'keep-parent'), folder('alias-child', 'Inner', 'alias-parent'),
    leaf('keep-leaf', 'One', 'https://one.invalid', 'keep-child'),
    leaf('alias-leaf', 'Two', 'https://two.invalid', 'alias-child')];
  const raw = rawAira(list);
  raw.snapshot.bookmarkFolders.find(n => n.id === 'keep-parent').nativeFolderField = { color: 'green' };
  raw.snapshot.bookmarkItems.find(n => n.id === 'alias-leaf').nativeItemField = { untouched: true };
  raw.snapshot.bookmarkOrders = [
    { type: 'bookmark-order', parentId: 'browser_root_toolbar', ids: ['keep-parent', 'alias-parent'], revision: 17, updatedBy: 'phone', extension: 'preserve' },
    { type: 'bookmark-order', parentId: 'alias-parent', ids: ['alias-child'] },
    { type: 'bookmark-order', parentId: 'keep-child', ids: ['keep-leaf'] },
    { type: 'bookmark-order', parentId: 'alias-child', ids: ['alias-leaf'] }
  ];
  d.cloud.put(URLS.aira, JSON.stringify(raw), 'application/json');
  await d.M.aira.patchAiraFile([]);
  const snap = airaIntegrity(d);
  expect(snap.bookmarkFolders.map(n => n.id)).toEqual(['browser_root_toolbar', 'keep-parent', 'keep-child']);
  expect(snap.bookmarkItems.find(n => n.id === 'alias-leaf').parentId).toBe('keep-child');
  expect(snap.bookmarkFolders.find(n => n.id === 'keep-child').parentId).toBe('keep-parent');
  expect(snap.bookmarkFolders.find(n => n.id === 'keep-parent').nativeFolderField).toEqual({ color: 'green' });
  expect(snap.bookmarkItems.find(n => n.id === 'alias-leaf').nativeItemField).toEqual({ untouched: true });
  expect(snap.bookmarkOrders.find(n => n.parentId === 'browser_root_toolbar').extension).toBe('preserve');
  expect(snap.bookmarkOrders.find(n => n.parentId === 'keep-child').ids).toEqual(['keep-leaf', 'alias-leaf']);
  expect(snap.appPrivateBookmarks).toEqual({ opaque: 'do-not-rewrite' });
});

test('Aira validates raw output parents before PUT instead of hiding an orphan through parsing fallback', async () => {
  const d = device('aira');
  const raw = rawAira([leaf('orphan', 'Orphan', 'https://orphan.invalid', 'missing-parent')]);
  const original = JSON.stringify(raw);
  d.cloud.put(URLS.aira, original, 'application/json');
  await expect(d.M.aira.patchAiraFile([])).rejects.toThrow();
  expect(d.cloud.files.get(URLS.aira).content).toBe(original);
  expect(d.cloud.requests.filter(r => r.method === 'PUT' && r.url === URLS.aira)).toEqual([]);
});

test('Aira writes equal URLs in distinct parents and preserves native metadata and phone-only nodes', async () => {
  const d = device('aira');
  const original = rawAira([folder('phone-parent', 'Phone'), leaf('phone-only', 'Phone only', TARGET, 'phone-parent')]);
  original.extension = { untouched: true };
  original.snapshot.nativeSettings = { theme: 'green' };
  d.cloud.put(URLS.aira, JSON.stringify(original), 'application/json');
  await d.M.aira.patchAiraFile([folder('desktop-parent', 'Desktop'), leaf('desktop-copy', 'Copy', TARGET, 'desktop-parent')]);
  airaIntegrity(d);
  const result = JSON.parse(d.cloud.files.get(URLS.aira).content);
  expect(leafParents(phone(d, 'aira'), TARGET)).toEqual([['Phone'], ['Desktop']]);
  expect(result.extension).toEqual({ untouched: true });
  expect(result.snapshot.nativeSettings).toEqual({ theme: 'green' });
  expect(result.deviceId).toBe('synthetic-phone');
  expect(result.history).toEqual({ epochId: 'synthetic-history' });
});

test('Aira maps both folder and leaf root aliases to existing native root IDs', async () => {
  const d = device('aira');
  const original = rawAira([folder('work', 'Work'), leaf('nested', 'Nested', TARGET, 'work')]);
  Object.assign(original.snapshot.bookmarkFolders[0], { id: 'native-root', title: 'browser_root_toolbar' });
  original.snapshot.bookmarkFolders[1].parentId = 'native-root';
  d.cloud.put(URLS.aira, JSON.stringify(original), 'application/json');
  await d.M.aira.patchAiraFile([folder('desktop-work', 'Work'), leaf('desktop-nested', 'Nested', TARGET, 'desktop-work'),
    leaf('desktop-top', 'Top', 'https://top.invalid')]);
  airaIntegrity(d);
  expect(leafParents(phone(d, 'aira'), TARGET)).toEqual([['Work']]);
  const result = JSON.parse(d.cloud.files.get(URLS.aira).content).snapshot;
  expect(result.bookmarkFolders.filter(n => n.title === 'Work')).toHaveLength(1);
  expect(result.bookmarkItems.find(n => n.url === 'https://top.invalid').parentId).toBe('native-root');
});

test('Aira homepage propagates a desktop deletion and accepts a subsequent confirmed phone re-add', async () => {
  const { d } = await setup('aira');
  const home = await d.add('2', 'Berry主页');
  const saved = await d.add(home.id, 'Home', 'https://home.invalid');
  await sync(d);
  const readHome = () => JSON.parse(d.cloud.files.get(HOME_URL).content);
  const readShortcuts = () => readHome().sections.home_shortcuts.payload.shortcuts;
  expect(readShortcuts().map(n => n.url)).toEqual(['https://home.invalid']);
  const native = clone(readShortcuts()[0]);
  await d.chrome.bookmarks.remove(saved.id);
  await sync(d);
  expect(readShortcuts()).toEqual([]);
  expect(d.state.store.aira_home_pathkey_snapshot_meta.absentTombstones.map(t => t.key))
    .toContain('ROOT:home/L:https://home.invalid');
  const readded = readHome();
  readded.sections.home_shortcuts.payload.shortcuts.push({ ...native, id: 'home-readd', updatedAt: d.state.now + 1 });
  d.cloud.put(HOME_URL, JSON.stringify(readded), 'application/json');
  await sync(d);
  await sync(d);
  for (const list of [local(d), main(d)]) expect(list.filter(n => n.url === 'https://home.invalid')).toHaveLength(1);
  expect(readShortcuts().map(n => n.url)).toEqual(['https://home.invalid']);
  expect(tombstoneKeys(d)).not.toContain('ROOT:home/L:https://home.invalid');
});
