'use strict';
const { makeDevice, makeCloud, clone } = require('./helpers/audit-harness.cjs');

const devices = [];
function device(via = false) {
  const d = makeDevice('parser-230', makeCloud(), { store: { option_via_enabled: via } });
  devices.push(d);
  return d;
}
afterEach(() => { for (const d of devices.splice(0)) d.close(); });

const XML = '<xbel version="1.0"><info><metadata owner="mini-sync"><prop key="deviceId">remote</prop></metadata></info>'
  + '<folder><title>书签栏</title><folder><title>Group</title><info><metadata owner="mini-sync"><prop key="id">group</prop></metadata></info>'
  + '<bookmark href="https://keep.invalid/"><title>Keep</title><info><metadata owner="mini-sync"><prop key="id">keep</prop></metadata></info></bookmark></folder>'
  + '<bookmark href="https://next.invalid/"><title>Next</title></bookmark></folder>'
  + '<folder><title>其他收藏夹</title></folder><folder><title>移动收藏夹</title></folder></xbel>';

function expectXmlNodes(parsed) {
  expect(parsed).not.toBeNull();
  expect(parsed.deviceId).toBe('remote');
  expect(parsed.bookmarks.map(n => [n.title, n.url, n.parentId])).toEqual([
    ['Group', '', 'root'], ['Keep', 'https://keep.invalid/', 'group'], ['Next', 'https://next.invalid/', 'root']
  ]);
  expect(parsed.bookmarks.find(n => n.title === 'Keep').id).toBe('keep');
}

for (const tag of ['xbel', 'folder', 'bookmark', 'title', 'info', 'metadata', 'prop']) {
  test.each([' ', '\t', '\r\n', ' \t\r\n '])(`XBEL preserves nodes and metadata with whitespace closing ${tag} (%j)`, space => {
    const d = device();
    expectXmlNodes(d.M.xbel.parseXbelFromString(XML.replaceAll(`</${tag}>`, `</${tag}${space}>`)));
  });
}

test('XBEL normal tags and all whitespace closing tags preserve downloaded hierarchy', async () => {
  const d = device();
  expectXmlNodes(d.M.xbel.parseXbelFromString(XML));
  const input = XML.replace(/<\/(\w+)>/g, '</$1 \t\r\n>');
  expectXmlNodes(d.M.xbel.parseXbelFromString(input));
  d.cloud.put(d.mainUrl, input, 'application/xml');
  const result = await d.M.orchestrator.downloadBookmarks({});
  expect(result.success).toBe(true);
  expect(d.paths().map(n => [n.path, n.url])).toEqual([
    ['书签栏/Group/Keep', 'https://keep.invalid/'], ['书签栏/Next', 'https://next.invalid/']
  ]);
});

const VIA_URL = 'https://audit.invalid/dav/Via/bookmarks.html';
const local = [
  { id: 'keep', title: 'Keep', url: 'https://keep.invalid/', parentId: 'root', source: 'bar', isFolder: false },
  { id: 'lost', title: 'Lost', url: 'https://lost.invalid/', parentId: 'root', source: 'bar', isFolder: false }
];
const html = lost => '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<H1>Bookmarks</H1>\n<DL><p>\n'
  + '<DT><A HREF="https://keep.invalid/">Keep</A>\n' + lost + '\n</DL><p>\n';
async function seedVia(d) {
  d.cloud.put(VIA_URL, html('<DT><A HREF="https://lost.invalid/">Lost</A>'), 'text/html');
  d.cloud.put('https://audit.invalid/dav/Via/favorites.txt', '', 'text/plain');
  const first = await d.M.via.mergeViaDataWithChanges(clone(local));
  expect(first.complete).toBe(true);
  expect(first.deletedIds).toEqual([]);
  Object.assign(d.state.store, clone(first.snapshotUpdates));
  return clone(d.state.store);
}

test.each([
  ['unterminated double quote', '<DT><A HREF="https://lost.invalid/>Lost</A>'],
  ['unterminated single quote', "<DT><A HREF='https://lost.invalid/>Lost</A>"],
  ['mismatched quote', '<DT><A HREF="https://lost.invalid/\'>Lost</A>'],
  ['quote inside unquoted href', '<DT><A HREF=https://lost.invalid/">Lost</A>'],
  ['missing href value', '<DT><A HREF=>Lost</A>'],
  ['missing anchor close', '<DT><A HREF="https://lost.invalid/">Lost'],
  ['missing actual href', '<DT><A DATA-HREF="https://lost.invalid/">Lost</A>'],
  ['truncated DT before valid anchor', '<DT <A HREF="https://lost.invalid/">Lost</A>']
])('Via partial malformed read (%s) cannot delete or advance baseline', async (_name, item) => {
  const d = device(true);
  const before = await seedVia(d);
  const writesBefore = clone(d.state.writes);
  d.cloud.put(VIA_URL, html(item), 'text/html');
  const result = await d.M.via.mergeViaDataWithChanges(clone(local));
  expect(result.complete).toBe(false);
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.deletedIds).toEqual([]);
  expect(result.deletedPathKeys).toEqual([]);
  expect(result.snapshotUpdates).toBeUndefined();
  expect(result.list).toEqual(local);
  // The compatibility entry point must not persist an incomplete read either.
  expect(await d.M.via.mergeViaData(clone(local))).toEqual(local);
  expect(d.state.store).toEqual(before);
  expect(d.state.writes).toEqual(writesBefore);
  expect(d.cloud.requests.every(r => r.method === 'GET')).toBe(true);
});

test.each([
  '<DT><A HREF="https://lost.invalid/">Lost</A>',
  "<DT><A ADD_DATE='1700000000' HREF='https://lost.invalid/'>Lost</A>",
  '<DT><A HREF=https://lost.invalid/ ADD_DATE=1700000000>Lost</A>',
  '<dt><a data-href="https://wrong.invalid/" add_date=1700000000 href = https://lost.invalid/ >Lost</a>',
  '<DT><A TITLE="x > y" HREF="https://lost.invalid/" PERSONAL_TOOLBAR_FOLDER>Lost</A>'
])('Via valid attribute forms retain known bookmarks: %s', async item => {
  const d = device(true);
  await seedVia(d);
  d.cloud.put(VIA_URL, html(item), 'text/html');
  const result = await d.M.via.mergeViaDataWithChanges(clone(local));
  expect(result.complete).toBe(true);
  expect(result.errors).toEqual([]);
  expect(result.deletedIds).toEqual([]);
  expect(result.deletedPathKeys).toEqual([]);
  expect(result.list.map(n => [n.id, n.title, n.url])).toEqual([
    ['keep', 'Keep', 'https://keep.invalid/'], ['lost', 'Lost', 'https://lost.invalid/']
  ]);
  expect(result.snapshotUpdates).toBeDefined();
});

test.each(['"', "'"])('Via comment delimiters inside %s-quoted href remain literal data', async quote => {
  const d = device(true);
  const url = 'https://literal.invalid/?q=<!--needle-->';
  const list = [{ id: 'literal', title: 'Literal', url, parentId: 'root', source: 'bar', isFolder: false }];
  const wrap = item => '<DL><p>' + item + '</DL><p>';
  d.cloud.put('https://audit.invalid/dav/Via/favorites.txt', '', 'text/plain');
  d.cloud.put(VIA_URL, wrap('<DT><A HREF="https://literal.invalid/?q=&lt;!--needle--&gt;">Literal</A>'), 'text/html');
  const first = await d.M.via.mergeViaDataWithChanges(clone(list));
  expect(first.complete).toBe(true);
  Object.assign(d.state.store, clone(first.snapshotUpdates));
  // Real comments are skipped, but identical delimiters inside quotes are URL data.
  d.cloud.put(VIA_URL, wrap('<!-- <DT><A HREF="https://ignored.invalid/">Ignored</A> -->'
    + `<DT><A HREF=${quote}${url}${quote}>Literal</A>`), 'text/html');
  const result = await d.M.via.mergeViaDataWithChanges(clone(list));
  expect(result.complete).toBe(true);
  expect(result.deletedIds).toEqual([]);
  expect(result.deletedPathKeys).toEqual([]);
  expect(result.list.map(n => [n.id, n.url])).toEqual([['literal', url]]);
  expect(result.snapshotUpdates).toEqual(first.snapshotUpdates);
});

test('Via complete empty export still represents an intentional deletion', async () => {
  const d = device(true);
  await seedVia(d);
  d.cloud.put(VIA_URL, '<DL><p></DL><p>', 'text/html');
  const result = await d.M.via.mergeViaDataWithChanges(clone(local));
  expect(result.complete).toBe(true);
  expect(result.deletedIds).toEqual(['keep', 'lost']);
  expect(result.list).toEqual([]);
  expect(result.snapshotUpdates).toBeDefined();
});
