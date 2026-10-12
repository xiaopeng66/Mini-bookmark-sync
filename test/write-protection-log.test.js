const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeDevice, clone, flush, response } = require('./helpers/audit-harness.cjs');

const devices = [];
const capabilityNotice = '[sync] 云端未提供强 ETag（etag="opaque-version"，Last-Modified=(无)），本次写入保护级别：none';
const modifiedNotice = '[sync] 云端未提供强 ETag（etag=null，Last-Modified=1791374400000），本次写入保护级别：last-modified';
const noticeRecord = (action = capabilityNotice) => ({
  time: 1791374400000, action, type: 'warn', count: '-', change: 'warn'
});

afterEach(() => { for (const d of devices.splice(0)) d.close(); });

function device(name) {
  const d = makeDevice(name);
  devices.push(d);
  return d;
}

async function existingCloud(name, headers = {}) {
  const d = device(name);
  await d.add('1', 'Keep', 'https://keep.invalid/');
  expect((await d.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  d.cloud.etagMode = headers.etagMode || 'none';
  d.cloud.lastModifiedMode = headers.lastModifiedMode || 'none';
  if (headers.etag) d.cloud.files.get(d.mainUrl).etag = headers.etag;
  d.cloud.requests.length = 0;
  d.state.logs.length = 0;
  d.M.logger.install();
  return d;
}

function logView(d) {
  const elements = {};
  for (const id of ['lastActionInfo', 'logExpand', 'viewAllLogs', 'clearLogsBtn']) {
    const classes = new Set();
    elements[id] = {
      textContent: '', innerHTML: '', handlers: {},
      classList: { add: name => classes.add(name), remove: name => classes.delete(name),
        contains: name => classes.has(name) },
      addEventListener(event, handler) { this.handlers[event] = handler; }
    };
  }
  const ctx = {
    chrome: d.chrome, Date: d.sandbox.Date,
    document: { getElementById: id => elements[id] || null },
    esc: d.M.utils.escapeHtml
  };
  vm.createContext(ctx);
  const source = fs.readFileSync(path.join(__dirname, '../options.js'), 'utf8');
  const start = source.indexOf('// 最近一次操作');
  const end = source.indexOf('// 通用：列出 WebDAV 根目录下的文件夹', start);
  if (start < 0 || end <= start) throw new Error('Options operation-log section not found');
  vm.runInContext(source.slice(start, end), ctx, { filename: 'options.js#operation-log' });
  return { elements, loadLast: () => ctx.loadLastAction(),
    expand: () => elements.viewAllLogs.handlers.click() };
}

for (const action of ['uploadBookmarks', 'mergeSync']) {
  test.each([
    { name: 'unquoted ETag', etagMode: 'strong', etag: 'opaque-version', lastModifiedMode: 'none', note: '没有并发保护' },
    { name: 'missing version headers', etagMode: 'none', lastModifiedMode: 'none', note: '没有并发保护' },
    { name: 'weak ETag with modification time', etagMode: 'weak', lastModifiedMode: 'full', note: '改用云端修改时间做并发校验' }
  ])(`${action} keeps the $name diagnostic out of operation history`, async headers => {
    const d = await existingCloud('quiet-' + action, headers);
    await d.add('1', 'Later', 'https://later.invalid/');
    const result = await d.M.actions[action]({});
    await flush();
    expect(result.success).toBe(true);
    expect(result.message).toContain(headers.note);
    expect(d.cloud.files.get(d.mainUrl).content).toContain('https://later.invalid/');
    expect(d.cloud.requests.filter(r => r.url === d.mainUrl && r.method === 'PUT')).toHaveLength(1);
    expect(d.state.logs.filter(log => log.text.startsWith('[sync] 云端未提供强 ETag（'))).toHaveLength(1);
    expect(d.state.store.sync_log).toEqual([
      expect.objectContaining({ action: action === 'uploadBookmarks' ? '上传' : '合并', success: true })
    ]);
  });

  test(`${action} still records and displays a real cloud conflict`, async () => {
    const d = await existingCloud('conflict-' + action);
    await d.add('1', 'Later', 'https://later.invalid/');
    d.cloud.hook = req => req.url === d.mainUrl && req.method === 'PUT'
      ? response(412, 'precondition failed') : null;
    const result = await d.M.actions[action]({});
    await flush();
    expect(result).toMatchObject({ success: false, code: 'CLOUD_CONFLICT' });
    expect(d.state.store.sync_log).toContainEqual(expect.objectContaining({
      action: action === 'uploadBookmarks' ? '上传' : '合并', success: false
    }));
    expect(d.cloud.files.get(d.mainUrl).content).not.toContain('https://later.invalid/');
    const view = logView(d);
    await view.expand();
    expect(view.elements.logExpand.innerHTML).toContain('操作失败');
    expect(view.elements.logExpand.innerHTML).toContain('云端文件已更改');
    expect(view.elements.logExpand.innerHTML).not.toContain('云端未提供强 ETag');
  });
}

test('a no-change merge records its result without an extra capability error', async () => {
  const d = await existingCloud('quiet-unchanged-merge');
  const result = await d.M.actions.mergeSync({});
  await flush();
  expect(result.success).toBe(true);
  expect(d.cloud.requests.filter(r => r.url === d.mainUrl && r.method === 'PUT')).toHaveLength(0);
  expect(d.state.logs.some(log => log.text.includes('云端未提供强 ETag'))).toBe(true);
  expect(d.state.store.sync_log).toEqual([
    expect.objectContaining({ action: '合并', success: true, message: '1 条' })
  ]);
});

test('old capability notices do not replace the latest result or consume the five visible rows', async () => {
  const d = device('legacy-notices');
  const results = Array.from({ length: 6 }, (_, index) => ({
    time: 1791374400000 + index * 60000, action: '合并', success: true,
    message: (230 + index) + ' 条', trigger: '手动'
  }));
  d.state.store.sync_log = results.flatMap((result, index) => [result,
    noticeRecord(index % 2 ? capabilityNotice : modifiedNotice)]);
  const original = clone(d.state.store.sync_log);
  const view = logView(d);
  await view.loadLast();
  await view.expand();
  expect(view.elements.lastActionInfo.innerHTML).toContain('合并操作');
  expect(view.elements.lastActionInfo.innerHTML).not.toContain('操作失败');
  const html = view.elements.logExpand.innerHTML;
  expect(html.match(/class="log-item /g)).toHaveLength(5);
  expect(html).toContain('235 条');
  expect(html).toContain('231 条');
  expect(html).not.toContain('230 条');
  expect(html).not.toContain('云端未提供强 ETag');
  expect(html).not.toContain('操作失败');
  expect(d.state.store.sync_log).toEqual(original);
});

test('history containing only old capability notices renders empty without deleting stored diagnostics', async () => {
  const d = device('notices-only');
  d.state.store.sync_log = [noticeRecord(), noticeRecord(modifiedNotice)];
  const original = clone(d.state.store.sync_log);
  const view = logView(d);
  await view.loadLast();
  await view.expand();
  expect(view.elements.lastActionInfo.textContent).toBe('暂无记录');
  expect(view.elements.logExpand.innerHTML).toContain('暂无记录');
  expect(view.elements.logExpand.innerHTML).not.toContain('操作失败');
  expect(d.state.store.sync_log).toEqual(original);
});

test('filtering capability notices never hides error-level records, failed results, or unrelated warnings', async () => {
  const d = device('real-errors-visible');
  d.state.store.sync_log = [
    { ...noticeRecord(), type: 'error', change: 'err' },
    { ...noticeRecord(), success: false },
    { time: 1791374400001, action: '合并', success: false, message: capabilityNotice },
    noticeRecord('[sync] ETag 校验失败，已拒绝覆盖云端文件'),
    noticeRecord(capabilityNotice + '；随后写入失败')
  ];
  const original = clone(d.state.store.sync_log);
  const view = logView(d);
  await view.expand();
  const html = view.elements.logExpand.innerHTML;
  expect(html.match(/class="log-item /g)).toHaveLength(5);
  expect(html).toContain('云端未提供强 ETag');
  expect(html).toContain('已拒绝覆盖云端文件');
  expect(html).toContain('随后写入失败');
  expect(html).toContain('data-copy=');
  expect(d.state.store.sync_log).toEqual(original);
});
