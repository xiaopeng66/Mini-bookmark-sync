const vm = require('node:vm');
const { makeDevice, clone } = require('./helpers/audit-harness.cjs');
const devices = [];
function device(name) { const d = makeDevice(name); devices.push(d); return d; }
afterEach(() => { for (const d of devices.splice(0)) d.close(); });

// A repeated full ancestor walk violates the linear read budget even when timing is noisy.
test('path computation reuses ancestor work without changing deep folder paths', () => {
  const d = device('path-work-budget');
  const count = 300;
  let parentReads = 0;
  const nodes = Array.from({ length: count }, (_, i) => ({ id: 'f' + i, title: 'Level' + i,
    isFolder: true, source: 'bar', get parentId() { parentReads++; return i ? 'f' + (i - 1) : 'root'; } }));
  const keys = d.M.xbelPath.computeJsonPathKeys(nodes);
  expect(keys.size).toBe(count);
  expect(keys.get('f0')).toBe('ROOT:bar/F:Level0');
  expect(keys.get('f299')).toBe('ROOT:bar/' + Array.from({ length: count }, (_, i) => 'F:Level' + i).join('/'));
  expect(parentReads).toBeLessThan(count * 20);
});

test.each([
  [[{ id: 'a', parentId: 'b', title: 'A', isFolder: true }, { id: 'b', parentId: 'a', title: 'B', isFolder: true },
    { id: 'c', parentId: 'a', title: 'C', isFolder: true }], [['a', 'ROOT:cyclic'], ['b', 'ROOT:cyclic'], ['c', 'ROOT:cyclic']]],
  [[{ id: 'a', parentId: 'b', title: 'Earlier', isFolder: true, source: 'bar' },
    { id: 'b', parentId: 'a', title: 'B', isFolder: true },
    { id: 'a', parentId: 'root', title: 'Last', isFolder: true, source: 'bar' }],
    [['a', 'ROOT:bar/F:Last'], ['b', 'ROOT:bar/F:Last/F:B']]],
  [[{ id: 'leaf', parentId: 'missing', title: 'Lost', url: 'https://lost.invalid/', source: 'bar' },
    { id: 'home', parentId: '__home_folder__', title: 'Home', url: 'https://home.invalid/', source: 'home' }],
    [['leaf', 'ROOT:bar/L:https://lost.invalid'], ['home', 'ROOT:home/L:https://home.invalid']]]
])('path caches retain cycle, duplicate-ID and virtual-root semantics (%#)', (list, expected) => {
  const d = device('path-semantics');
  const before = clone(list);
  expect([...d.M.xbelPath.computeJsonPathKeys(list)]).toEqual(expected);
  expect(list).toEqual(before);
});

test('path cache is per-call, so title edits and parent moves cannot reuse stale paths', () => {
  const d = device('path-no-stale');
  const list = [{ id: 'f', parentId: 'root', title: 'Before', isFolder: true, source: 'bar' },
    { id: 'l', parentId: 'f', title: 'Leaf', url: 'https://leaf.invalid/', source: 'bar' }];
  expect(d.M.xbelPath.computeJsonPathKeys(list).get('l')).toBe('ROOT:bar/F:Before/L:https://leaf.invalid');
  list[0].title = 'After/Slash';
  expect(d.M.xbelPath.computeJsonPathKeys(list).get('l')).toBe('ROOT:bar/F~:After%2FSlash/L:https://leaf.invalid');
  list[1].parentId = 'root';
  expect(d.M.xbelPath.computeJsonPathKeys(list).get('l')).toBe('ROOT:bar/L:https://leaf.invalid');
});

// Count observable input reads rather than an implementation-specific method name.
test('unchanged merge indexes remote IDs instead of rescanning every remote node', async () => {
  const d = device('remote-index-budget');
  const count = 400;
  for (let i = 0; i < count; i++) await d.add('1', 'Leaf' + i, 'https://site' + i + '.invalid/');
  const local = d.M.merger.chromeTreeToList([d.state.root]);
  d.state.store.sync_snapshots = { localTree: clone(local) };
  let idReads = 0;
  const remote = local.filter(n => n.url).map((n, i) => ({ ...n, _index: i, parentId: 'root',
    get id() { idReads++; return 'remote-' + i; } }));
  const result = await d.M.merger.mergeBookmarks([d.state.root], { bookmarks: remote, tombstones: [] }, {});
  expect(result.localOnlyIds).toEqual([]);
  expect(result.remoteOnlyIds).toEqual([]);
  expect(result.localDeletedIds).toEqual([]);
  expect(result.orderChanged).toBe(false);
  expect(result.stats.skipped).toBe(count);
  expect(idReads).toBeLessThan(count * 120);
});

test('rename grouping reuses folder membership and longest-prefix ordering', async () => {
  const d = device('rename-work-budget');
  const count = 30;
  for (let i = 0; i < count; i++) {
    const folder = await d.add('1', 'Old ' + i);
    for (let j = 0; j < 2; j++) await d.add(folder.id, 'Leaf ' + i + '-' + j, 'https://rename' + i + '.invalid/' + j);
  }
  const local = clone(d.M.merger.chromeTreeToList([d.state.root]));
  d.state.store.sync_snapshots = { localTree: clone(local) };
  const ranks = new Map();
  const remote = local.map(n => {
    const index = ranks.get(n.parentId) || 0;
    ranks.set(n.parentId, index + 1);
    return { ...n, id: 'remote-' + n.id, parentId: 'remote-' + n.parentId, _index: index,
      title: n.isFolder && !n.zoneRoot ? n.title.replace('Old ', 'New ') : n.title, addedAt: n.addedAt + 1000 };
  });
  vm.runInContext(`globalThis.__workBudget = { predicateCalls: 0, sorts: 0 };
    const originalFind = Array.prototype.find;
    Array.prototype.find = function (fn, self) {
      return originalFind.call(this, (item, index, array) => {
        __workBudget.predicateCalls++;
        return fn.call(self, item, index, array);
      });
    };
    const originalSort = Array.prototype.sort;
    Array.prototype.sort = function (...args) { __workBudget.sorts++; return originalSort.apply(this, args); };`, d.sandbox);
  const result = await d.M.merger.mergeBookmarks([d.state.root], { bookmarks: remote, tombstones: [] }, {});
  expect(result.renameLocalNodes.map(n => n.title).sort())
    .toEqual(Array.from({ length: count }, (_, i) => 'New ' + i).sort());
  expect(result.localOnlyIds).toEqual([]);
  expect(result.remoteOnlyIds).toEqual([]);
  expect(result.localDeletedIds).toEqual([]);
  expect(d.sandbox.__workBudget.predicateCalls).toBeLessThan(count * count * 40);
  expect(d.sandbox.__workBudget.sorts).toBeLessThan(30);
});
