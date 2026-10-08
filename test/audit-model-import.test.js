const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadSource, ROOT } = require('./load-source');
loadSource();
const M = global.MiniSync;
const C = M.constants;
vm.runInThisContext(`
var ROOT_ID = ${JSON.stringify(C.ROOT_ID)};
var DOWNLOAD_MODE = ${JSON.stringify(C.DOWNLOAD_MODE)};
var FOLDER_TITLES = ${JSON.stringify(C.FOLDER_TITLES)};
var HOME_FOLDER_ID = ${JSON.stringify(C.HOME_FOLDER_ID)};
var MOBILE_FOLDER_ID = ${JSON.stringify(C.MOBILE_FOLDER_ID)};
var OTHER_FOLDER_ID = ${JSON.stringify(C.OTHER_FOLDER_ID)};
` + fs.readFileSync(path.join(ROOT, 'lib/import.js'), 'utf8'), { filename: 'lib/import.js' });

function makeHost(items, failures = {}) {
  const root = { id: '0', title: '', children: [{ id: '1', title: '书签栏', children: items }] };
  let nextId = 100;
  const find = (id, node = root) => {
    if (String(node.id) === String(id)) return node;
    for (const c of node.children || []) { const hit = find(id, c); if (hit) return hit; }
    return null;
  };
  const detach = (id, node = root) => {
    const arr = node.children || [];
    const idx = arr.findIndex(n => String(n.id) === String(id));
    if (idx >= 0) return arr.splice(idx, 1)[0];
    for (const c of arr) { const hit = detach(id, c); if (hit) return hit; }
    return null;
  };
  const bookmarks = {
    getTree(cb) { const tree = [JSON.parse(JSON.stringify(root))]; cb(tree); return Promise.resolve(tree); },
    async create(data) {
      if (failures.create) throw new Error('create denied');
      const node = { id: String(nextId++), ...data, ...(!data.url ? { children: [] } : {}) };
      find(data.parentId).children.push(node);
      return node;
    },
    async update(id, data) { if (failures.update) throw new Error('update denied'); Object.assign(find(id), data); },
    async move(id, data) {
      if (failures.move) throw new Error('move denied');
      const node = detach(id);
      if (!node) throw new Error('missing node');
      const target = find(data.parentId).children;
      target.splice(Math.min(data.index == null ? target.length : data.index, target.length), 0, node);
    },
    async remove(id) { if (failures.remove) throw new Error('remove denied'); if (!detach(id)) throw new Error('missing node'); },
    async removeTree(id) { if (failures.remove) throw new Error('remove denied'); if (!detach(id)) throw new Error('missing node'); }
  };
  global.chrome = { runtime: {}, bookmarks, storage: { local: { get: async () => ({}) } } };
  return root;
}

const options = { mode: C.DOWNLOAD_MODE, mergeMode: true, targetParentId: '1', skipBerryBridge: true, skipViaBridge: true };

afterEach(() => { delete global.chrome; M.utils.resetSyncBucketId(); });

describe('importer data integrity', () => {
  test('same URL under two different parents remains two bookmarks', async () => {
    const root = makeHost([
      { id: 'a', title: 'A', children: [{ id: 'existing', title: 'Shared', url: 'https://same.invalid/' }] },
      { id: 'b', title: 'B', children: [] }
    ]);
    const result = await M.importer.importBookmarksFromData({ bookmarks: [
      { id: 'ra', parentId: 'root', title: 'A', isFolder: true, source: 'bar', _index: 0 },
      { id: 'r1', parentId: 'ra', title: 'Shared', url: 'https://same.invalid/', _index: 0 },
      { id: 'rb', parentId: 'root', title: 'B', isFolder: true, source: 'bar', _index: 1 },
      { id: 'r2', parentId: 'rb', title: 'Shared', url: 'https://same.invalid/', _index: 0 }
    ] }, options);
    const [a, b] = root.children[0].children;
    expect(a.children.map(n => n.url)).toEqual(['https://same.invalid/']);
    expect(b.children.map(n => n.url)).toEqual(['https://same.invalid/']);
    expect(a.children[0].id).toBe('existing');
    expect(b.children[0].id).not.toBe('existing');
    expect(result.conflicts).toEqual([]);
  });

  test('same URL under one parent preserves separately titled copies', async () => {
    const root = makeHost([{ id: 'original', title: 'Original', url: 'https://same.invalid/' }]);
    const result = await M.importer.importBookmarksFromData({ bookmarks: [
      { id: 'r1', parentId: 'root', title: 'Original', url: 'https://same.invalid/', source: 'bar', _index: 0 },
      { id: 'r2', parentId: 'root', title: 'Second copy', url: 'https://same.invalid/', source: 'bar', _index: 1 }
    ] }, options);
    expect(root.children[0].children.map(n => [n.title, n.url])).toEqual([
      ['Original', 'https://same.invalid/'],
      ['Second copy', 'https://same.invalid/']
    ]);
    expect(result.conflicts).toEqual([]);
  });

  test('same-parent URL copies preserve titles when the new copy arrives first', async () => {
    const root = makeHost([{ id: 'original', title: 'Original', url: 'https://same.invalid/' }]);
    const result = await M.importer.importBookmarksFromData({ bookmarks: [
      { id: 'r2', parentId: 'root', title: 'Second copy', url: 'https://same.invalid/', source: 'bar', _index: 0 },
      { id: 'r1', parentId: 'root', title: 'Original', url: 'https://same.invalid/', source: 'bar', _index: 1 }
    ] }, options);
    expect(root.children[0].children.map(n => n.title)).toEqual(['Second copy', 'Original']);
    expect(root.children[0].children.find(n => n.title === 'Original').id).toBe('original');
    expect(result.conflicts).toEqual([]);
  });

  test.each([
    ['nested folder', 'Project', false],
    ['transparent bucket wrapper', '书签栏', true]
  ])('reserves later exact matches through %s', async (_name, title, transparent) => {
    const original = { id: 'original', title: 'Original', url: 'https://same.invalid/' };
    const root = makeHost(transparent ? [original] : [{ id: 'local-folder', title, children: [original] }]);
    const result = await M.importer.importBookmarksFromData({ bookmarks: [
      { id: 'remote-folder', parentId: 'root', title, isFolder: true, source: 'bar', _index: 0 },
      { id: 'r2', parentId: 'remote-folder', title: 'Second copy', url: 'https://same.invalid/', _index: 0 },
      { id: 'r1', parentId: 'remote-folder', title: 'Original', url: 'https://same.invalid/', _index: 1 }
    ] }, options);
    const children = transparent ? root.children[0].children : root.children[0].children[0].children;
    expect(children.map(n => n.title)).toEqual(['Second copy', 'Original']);
    expect(children.find(n => n.title === 'Original').id).toBe('original');
    expect(result.conflicts).toEqual([]);
  });

  test('explicit empty replacement clears the bucket but empty append does not', async () => {
    const root = makeHost([{ id: 'keep', title: 'Keep', url: 'https://keep.invalid/' }]);
    const append = await M.importer.importBookmarksFromData({ bookmarks: [] }, options);
    expect(append.conflicts).toEqual([]);
    expect(root.children[0].children.map(n => n.id)).toEqual(['keep']);

    const replace = await M.importer.importBookmarksFromData({ bookmarks: [] }, { ...options, clearLocalFirst: true });
    expect(replace.conflicts).toEqual([]);
    expect(root.children[0].children).toEqual([]);
  });

  test('a necessary bookmark creation failure is a conflict', async () => {
    makeHost([], { create: true });
    const result = await M.importer.importBookmarksFromData({ bookmarks: [
      { id: 'r', parentId: 'root', title: 'Remote', url: 'https://remote.invalid/', source: 'bar' }
    ] }, options);
    expect(result.conflicts).toMatchObject([{ type: 'bookmark', title: 'Remote', error: 'create denied' }]);
  });

  test('a necessary tombstone deletion failure is a conflict', async () => {
    makeHost([{ id: 'gone', title: 'Gone', url: 'https://gone.invalid/' }], { remove: true });
    const result = await M.importer.importBookmarksFromData({ bookmarks: [] }, { ...options, deletedIds: ['gone'] });
    expect(result.conflicts).toMatchObject([{ type: 'delete', title: 'Gone', error: 'remove denied' }]);
  });

  test('failed order moves are conflicts, not just diagnostic counters', async () => {
    makeHost([
      { id: 'a', title: 'A', url: 'https://a.invalid/' },
      { id: 'b', title: 'B', url: 'https://b.invalid/' }
    ], { move: true });
    const result = await M.importer.importBookmarksFromData({ bookmarks: [
      { id: 'rb', parentId: 'root', title: 'B', url: 'https://b.invalid/', _index: 0, source: 'bar' },
      { id: 'ra', parentId: 'root', title: 'A', url: 'https://a.invalid/', _index: 1, source: 'bar' }
    ] }, options);
    expect(result.moveFailed).toBeGreaterThan(0);
    expect(result.conflicts.some(c => c.type === 'move' && c.error === 'move denied')).toBe(true);
  });
});
