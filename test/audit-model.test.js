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

afterEach(() => {
  delete global.chrome;
  M.utils.resetSyncBucketId();
});

function storage(values = {}) {
  return { local: {
    get: (keys, cb) => { if (cb) { cb(values); return; } return Promise.resolve(values); },
    set: (data, cb) => { Object.assign(values, data); if (cb) { cb(); return; } return Promise.resolve(); }
  } };
}

const tree = [{ id: '0', children: [{ id: '1', title: '书签栏', children: [
  { id: 'l', title: 'Local', url: 'https://local.invalid/' }
] }] }];

describe('XBEL validation and serialization', () => {
  test('rejects non-XBEL and truncated XML without interpreting either as empty', () => {
    for (const xml of ['<html>login</html>', '<xbel><folder><title>cut', '<xbel><bookmark href="https://x/"><title>X</title></xbel>', '<xbel></xbel><html>login</html>']) {
      expect(M.xbel.parseXbelFromString(xml)).toBeNull();
      expect(() => M.xbel.xbelToJson(xml)).toThrow();
    }
  });

  test('rejects malformed tag attributes before interpreting the document as empty', () => {
    const malformed = '<xbel version=1.0><folder><title>Keep</title></folder></xbel>';
    expect(M.xbel.parseXbelFromString(malformed)).toBeNull();
    expect(() => M.xbel.xbelToJson(malformed)).toThrow();
  });

  test('rejects unescaped entity markers in XBEL content and attributes', () => {
    for (const malformed of [
      '<xbel><folder><title>R&D</title></folder></xbel>',
      '<xbel><bookmark href="https://site.invalid/?a=1&b=2"><title>Link</title></bookmark></xbel>'
    ]) {
      expect(M.xbel.parseXbelFromString(malformed)).toBeNull();
      expect(() => M.xbel.xbelToJson(malformed)).toThrow();
    }
    expect(M.xbel.parseXbelFromString('<xbel><folder><title>R&amp;D</title></folder></xbel>')).not.toBeNull();
  });

  test('reads valid single-quoted XBEL bookmark and metadata attributes', () => {
    const xml = `<xbel version='1.0'>
      <info><metadata owner='mini-sync'><prop key='deviceId'>device-a</prop></metadata></info>
      <folder><title>书签栏</title>
        <bookmark href='https://example.invalid/item'>
          <title>Item</title>
          <info><metadata owner='mini-sync'><prop key='id'>bookmark-a</prop></metadata></info>
        </bookmark>
      </folder>
      <folder><title>其他收藏夹</title></folder>
      <folder><title>移动收藏夹</title></folder>
    </xbel>`;
    const parsed = M.xbel.parseXbelFromString(xml);
    expect(parsed).not.toBeNull();
    expect(parsed.deviceId).toBe('device-a');
    expect(parsed.bookmarks.filter(n => n.url)).toMatchObject([
      { id: 'bookmark-a', title: 'Item', url: 'https://example.invalid/item', parentId: 'root' }
    ]);
  });

  test('named XBEL roots are not reassigned to fallback zones', () => {
    const one = M.xbel.parseXbelFromString('<xbel version="1.0"><folder><title>书签栏</title><bookmark href="https://keep.invalid/"><title>Keep</title></bookmark></folder></xbel>');
    expect(one.bookmarks.filter(n => n.url === 'https://keep.invalid/')).toMatchObject([
      { source: 'bar', parentId: 'root' }
    ]);
    const two = M.xbel.parseXbelFromString('<xbel version="1.0"><folder><title>书签栏</title><bookmark href="https://bar.invalid/"><title>Bar</title></bookmark></folder><folder><title>其他收藏夹</title><folder><title>Other folder</title><bookmark href="https://other.invalid/"><title>Other</title></bookmark></folder></folder></xbel>');
    expect(two.bookmarks.filter(n => n.url)).toMatchObject([
      { url: 'https://bar.invalid/', source: 'bar' },
      { url: 'https://other.invalid/', source: 'other' }
    ]);
  });

  test('accepts an empty XBEL including tombstone-only metadata', () => {
    expect(M.xbel.parseXbelFromString('<xbel version="1.0"/>')).toMatchObject({ bookmarks: [] });
    const xml = M.xbel.jsonToXbel({ bookmarks: [], tombstones: [{ key: 'ROOT:bar/L:https://gone.invalid/', deletedAt: 1, deviceId: 'a' }] });
    expect(M.xbel.parseXbelFromString(xml)).toMatchObject({ bookmarks: [], tombstones: [{ key: 'ROOT:bar/L:https://gone.invalid/' }] });
  });

  test('each source root is serialized once, retaining duplicate URLs in distinct paths', () => {
    const input = { bookmarks: [
      { id: 'x', parentId: 'root', title: 'X', isFolder: true, source: 'bar' },
      { id: 'xa', parentId: 'x', title: 'A', url: 'https://same.invalid/', source: 'bar' },
      { id: 'y', parentId: 'root', title: 'Y', isFolder: true, source: 'bar' },
      { id: 'ya', parentId: 'y', title: 'B', url: 'https://same.invalid/', source: 'bar' }
    ] };
    const output = M.xbel.parseXbelFromString(M.xbel.jsonToXbel(input));
    expect(output.bookmarks.filter(n => n.title === 'X')).toHaveLength(1);
    expect(output.bookmarks.filter(n => n.title === 'Y')).toHaveLength(1);
    expect(output.bookmarks.filter(n => n.url === 'https://same.invalid/').map(n => n.parentId).sort()).toEqual(['x', 'y']);
  });

  test('virtual HOME under root serializes its bookmark only in home', () => {
    const input = { bookmarks: [
      { id: 'bar', parentId: 'root', title: 'Bar', url: 'https://bar.invalid/', source: 'bar' },
      { id: C.HOME_FOLDER_ID, parentId: 'root', title: '移动端主页', isFolder: true, source: 'other' },
      { id: 'home', parentId: C.HOME_FOLDER_ID, title: 'Home', url: 'https://home.invalid/', source: 'home' }
    ] };
    const output = M.xbel.parseXbelFromString(M.xbel.jsonToXbel(input));
    expect(output.bookmarks.filter(n => n.url === 'https://home.invalid/')).toMatchObject([
      { parentId: C.HOME_FOLDER_ID, source: 'home' }
    ]);
    expect(output.bookmarks.filter(n => n.url === 'https://bar.invalid/')).toMatchObject([
      { parentId: 'root', source: 'bar' }
    ]);
  });

  test('virtual MOBILE under root serializes its bookmark only in mobile', () => {
    const input = { bookmarks: [
      { id: C.MOBILE_FOLDER_ID, parentId: 'root', title: '移动收藏夹', isFolder: true, source: 'mobile' },
      { id: 'mobile', parentId: C.MOBILE_FOLDER_ID, title: 'Mobile', url: 'https://mobile.invalid/', source: 'mobile' }
    ] };
    const xml = M.xbel.jsonToXbel(input);
    const output = M.xbel.parseXbelFromString(xml);
    expect(output.bookmarks.filter(n => n.url === 'https://mobile.invalid/')).toHaveLength(1);
    expect(xml).toMatch(/<folder>\s*<title>移动收藏夹<\/title>\s*<bookmark href="https:\/\/mobile\.invalid\/">/);
  });

  test('neither serializer leaks endpoint credentials or credential-bearing URLs', () => {
    const endpoints = { device: { berry: { url: 'https://user:password@dav.invalid/a?token=secret#frag', username: 'user', password: 'password', lastSync: 42 }, via: { enabled: true, count: 2 } } };
    for (const xml of [M.xbel.jsonToXbel({ bookmarks: [], endpoints }), M.xbel.chromeToXbel(tree, { endpoints })]) {
      expect(xml).not.toMatch(/password|secret|user:|token=/);
      const parsed = M.xbel.parseXbelFromString(xml);
      expect(parsed.endpoints.device.berry.lastSync).toBe(42);
      expect(parsed.endpoints.device.via.enabled).toBe(true);
    }
  });
});

describe('tombstone and merge plans', () => {
  test('TTL and two online copies do not prove all devices acknowledged deletion', () => {
    const old = [{ key: 'ROOT:bar/L:https://gone.invalid/', deletedAt: Date.now() - 10 * 86400000, deviceId: 'a' }];
    expect(M.tombstone.cleanExpired(old, 3 * 86400000, { localPKSet: new Set(), remotePKSet: new Set() })).toEqual(old);
    expect(M.tombstone.cleanExpired(old, 3 * 86400000)).toEqual(old);
    expect(M.tombstone.buildTombstoneView({ localTombstones: old, localList: [], remoteList: [], myDeviceId: 'a' }).tombstoneKeys.has(old[0].key)).toBe(true);
  });

  test('empty or absent remote returns a writeback plan without an engine PUT', async () => {
    const values = { sync_tombstones: [{ key: 'ROOT:bar/L:https://gone.invalid/', deletedAt: Date.now(), deviceId: 'a' }] };
    let puts = 0;
    global.chrome = { storage: storage(values) };
    const oldGetId = M.storage.getDeviceId;
    const oldWebdav = M.webdav;
    M.storage.getDeviceId = async () => 'a';
    M.webdav = { putFile: async () => { puts++; } };
    try {
      const missing = await M.merger.mergeBookmarks(tree, null, {});
      const empty = await M.merger.mergeBookmarks(tree, { bookmarks: [], tombstones: [] }, {});
      expect(puts).toBe(0);
      expect(missing).toMatchObject({ firstSync: true, requiresWriteBack: true, needWriteBack: true, remoteUpdated: true });
      expect(empty).toMatchObject({ firstSync: false, requiresWriteBack: true, needWriteBack: true, remoteUpdated: true });
      expect(empty.tombstones).toHaveLength(1);
    } finally { M.storage.getDeviceId = oldGetId; M.webdav = oldWebdav; }
  });

  test('without common history independently created folders remain separate', async () => {
    global.chrome = { storage: storage({ sync_tombstones: [], sync_move_intents: {} }) };
    const oldGetId = M.storage.getDeviceId;
    M.storage.getDeviceId = async () => 'a';
    try {
      const local = [{ id: '0', children: [{ id: '1', title: '书签栏', children: [
        { id: 'lf', title: 'Local-Project', dateAdded: 200, children: [{ id: 'lb', title: 'Local', url: 'https://local.invalid/' }] }
      ] }] }];
      const remote = { bookmarks: [
        { id: 'rf', parentId: 'root', title: 'Remote-Project', isFolder: true, source: 'bar', addedAt: 100, _index: 0 },
        { id: 'rb', parentId: 'rf', title: 'Remote', url: 'https://remote.invalid/', source: 'bar', _index: 0 }
      ], tombstones: [] };
      const result = await M.merger.mergeBookmarks(local, remote, {});
      expect(result.renamePairs).toEqual([]);
      expect(result.stats.renamed).toBe(0);
      expect(result.localOnlyIds).toContain('lf');
      expect(result.remoteOnlyIds).toContain('rf');
    } finally { M.storage.getDeviceId = oldGetId; }
  });

  test('one-sided baseline does not rename independent folders or discard their children', async () => {
    const values = { sync_tombstones: [], sync_move_intents: {} };
    global.chrome = { storage: storage(values) };
    const oldGetId = M.storage.getDeviceId;
    M.storage.getDeviceId = async () => 'a';
    try {
      const local = [{ id: '0', children: [{ id: '1', title: '书签栏', children: [
        { id: 'old', title: 'Old', dateAdded: 200, children: [
          { id: 'private', title: 'Private', url: 'https://private.invalid/' }
        ] }
      ] }] }];
      values.sync_snapshots = { localTree: M.merger.chromeTreeToList(local) };
      const remote = { bookmarks: [
        { id: 'new', parentId: 'root', title: 'New', isFolder: true, source: 'bar', addedAt: 100, _index: 0 },
        { id: 'independent', parentId: 'new', title: 'Independent', url: 'https://independent.invalid/', source: 'bar', _index: 0 }
      ], tombstones: [] };
      const result = await M.merger.mergeBookmarks(local, remote, {});
      expect(result.renamePairs).toEqual([]);
      expect(result.stats.renamed).toBe(0);
      expect(result.localOnlyIds).toContain('old');
      expect(result.localOnlyIds).toContain('private');
      expect(result.remoteOnlyIds).toContain('new');
      expect(result.remoteOnlyIds).toContain('independent');
      expect(result.localDeletedIds).not.toContain('old');
    } finally { M.storage.getDeviceId = oldGetId; }
  });

  test('same title and URL in different folders do not imply a move without history', async () => {
    global.chrome = { storage: storage({ sync_tombstones: [], sync_move_intents: {} }) };
    const oldGetId = M.storage.getDeviceId;
    M.storage.getDeviceId = async () => 'a';
    try {
      const local = [{ id: '0', children: [{ id: '1', title: '书签栏', children: [
        { id: 'fa', title: 'A', children: [{ id: 'la', title: 'Shared', url: 'https://same.invalid/' }] },
        { id: 'fb', title: 'B', children: [] }
      ] }] }];
      const remote = { bookmarks: [
        { id: 'ra', parentId: 'root', title: 'A', isFolder: true, source: 'bar', _index: 0 },
        { id: 'rb', parentId: 'root', title: 'B', isFolder: true, source: 'bar', _index: 1 },
        { id: 'rr', parentId: 'rb', title: 'Shared', url: 'https://same.invalid/', source: 'bar', _index: 0 }
      ], tombstones: [] };
      const result = await M.merger.mergeBookmarks(local, remote, {});
      expect(result.localOnlyIds).toContain('la');
      expect(result.remoteOnlyIds).toContain('rr');
      expect(result.renamePairs).toEqual([]);
    } finally { M.storage.getDeviceId = oldGetId; }
  });
});
