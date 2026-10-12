const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeDevice, clone, flush } = require('./helpers/audit-harness.cjs');
const root = path.resolve(__dirname, '..');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');
const devices = [];
afterEach(() => { for (const d of devices.splice(0)) d.close(); });

async function harness() {
  const d = makeDevice('recovery-ui', undefined, { background: true });
  devices.push(d);
  await flush();
  await d.add('1', 'Saved', 'https://saved.invalid/');
  await d.M.syncInput.ensureSyncRelationship(await d.M.storage.getWebdavConfig(), '1');
  await d.M.syncInput.backupLocalTree();
  const elements = {}, messages = [], downloads = [], storageListeners = [];
  for (const id of ['recoveryCard', 'recoverySummary', 'recoveryDetail', 'recoveryCheckBtn',
    'recoveryExportBtn', 'recoveryRestoreBtn', 'recoveryConfirm', 'recoveryConfirmText',
    'recoveryConfirmBtn', 'recoveryCancelBtn', 'recoveryResult']) {
    elements[id] = { id, textContent: '', hidden: false, disabled: false, className: '', style: {},
      handlers: {}, addEventListener(event, fn) { this.handlers[event] = fn; },
      setAttribute() {}, focus() {} };
  }
  const ctx = { console, URL, Date, setTimeout, clearTimeout,
    document: { getElementById(id) { return elements[id] || null; } },
    chrome: { runtime: { async sendMessage(message) {
      messages.push(clone(message));
      return d.send(message);
    } }, storage: { local: d.chrome.storage.local, onChanged: { addListener(fn) { storageListeners.push(fn); } } } },
    downloadTextFile(filename, text) { downloads.push({ filename, text }); }
  };
  vm.createContext(ctx);
  for (const file of ['lib/constants.js', 'lib/utils.js']) vm.runInContext(source(file), ctx, { filename: file });
  const code = source('options.js');
  const start = code.indexOf('// ========== 本地书签恢复 ==========');
  const end = code.indexOf('// ========== 配置备份 / 迁移 ==========', start);
  if (start >= 0 && end > start) vm.runInContext(code.slice(start, end), ctx, { filename: 'options.js#recovery' });
  expect(typeof ctx.initLocalRecovery).toBe('function');
  await ctx.initLocalRecovery();
  const click = id => {
    const el = elements[id];
    expect(el.disabled).toBe(false);
    const fn = el.handlers.click || el.onclick;
    expect(typeof fn).toBe('function');
    return fn({ preventDefault() {} });
  };
  return { d, ctx, elements, messages, downloads, click, storageListeners };
}

test('settings inspection shows a recovery entry without changing bookmarks', async () => {
  const h = await harness();
  expect(h.elements.recoverySummary.textContent).toContain('未完成');
  expect(h.elements.recoveryDetail.textContent).toContain('书签栏');
  expect(h.elements.recoveryRestoreBtn.disabled).toBe(false);
  expect(h.elements.recoveryConfirm.hidden).toBe(true);
  expect(h.messages.map(m => m.action)).toEqual(['getLocalRecoveryStatus']);
  expect(h.d.state.store.local_bookmark_backup_meta.status).toBe('pending');
});

test('opening and cancelling recovery confirmation does not invoke restore', async () => {
  const h = await harness();
  const tree = clone(h.d.state.root);
  await h.click('recoveryRestoreBtn');
  expect(h.elements.recoveryConfirm.hidden).toBe(false);
  expect(h.elements.recoveryConfirmText.textContent).toContain('云端');
  await h.click('recoveryCancelBtn');
  expect(h.elements.recoveryConfirm.hidden).toBe(true);
  expect(h.messages.some(m => m.action === 'restoreFromBackup')).toBe(false);
  expect(h.d.state.root).toEqual(tree);
});

test('explicit confirmation uses the inspected backup and displays zero-count success', async () => {
  const h = await harness();
  const backupId = h.d.state.store.local_bookmark_backup_meta.id;
  await h.click('recoveryRestoreBtn');
  await h.click('recoveryConfirmBtn');
  expect(h.messages.find(m => m.action === 'restoreFromBackup')).toMatchObject({ backupId, expectedStatus: 'pending' });
  expect(h.elements.recoveryResult.textContent).toContain('无需补回');
  expect(h.elements.recoveryResult.className).toContain('ok');
  expect(h.elements.recoveryRestoreBtn.disabled).toBe(true);
  expect(h.d.state.store.local_bookmark_backup_meta.status).toBe('restored');
});

test('export preserves the recovery lock and creates a private local JSON download', async () => {
  const h = await harness();
  await h.click('recoveryExportBtn');
  expect(h.downloads).toHaveLength(1);
  expect(h.downloads[0].filename).toMatch(/^minibookmark-sync-local-recovery-.*\.json$/);
  const data = JSON.parse(h.downloads[0].text);
  expect(data.currentTree[0].children[0].children[0].url).toBe('https://saved.invalid/');
  expect(data.originalBackup[0].children[0].children[0].url).toBe('https://saved.invalid/');
  expect(h.messages.some(m => m.action === 'restoreFromBackup')).toBe(false);
  expect(h.d.state.store.local_bookmark_backup_meta.status).toBe('pending');
});

test('a changed target disables recovery but not export', async () => {
  const h = await harness();
  h.d.state.store.bookmark_target_id = '2';
  await h.click('recoveryCheckBtn');
  expect(h.elements.recoveryRestoreBtn.disabled).toBe(true);
  expect(h.elements.recoveryExportBtn.disabled).toBe(false);
  expect(h.elements.recoveryDetail.textContent).toContain('不一致');
});

test('failed recovery remains actionable and never displays green success', async () => {
  const h = await harness();
  await h.d.chrome.bookmarks.remove(h.d.paths()[0].id);
  h.d.state.failCreates = info => !!info.url;
  await h.click('recoveryRestoreBtn');
  await h.click('recoveryConfirmBtn');
  expect(h.elements.recoveryResult.className).toContain('err');
  expect(h.elements.recoveryResult.textContent).toContain('备份');
  expect(h.elements.recoveryRestoreBtn.disabled).toBe(false);
  expect(h.d.state.store.local_bookmark_backup_meta.status).toBe('failed');
});

test('metadata repair confirmation is sent as a metadata-only operation', async () => {
  const h = await harness();
  const set = h.d.chrome.storage.local.set;
  h.d.chrome.storage.local.set = (data, cb) => {
    if (data.local_bookmark_backup_meta?.status === 'committed') {
      h.d.chrome.runtime.lastError = { message: 'Synthetic completion failure' };
      cb(); h.d.chrome.runtime.lastError = null; return;
    }
    return set(data, cb);
  };
  expect((await h.d.M.syncInput.completeLocalBackup()).ok).toBe(false);
  h.d.chrome.storage.local.set = set;
  const tree = clone(h.d.state.root);
  await h.click('recoveryCheckBtn');
  await h.click('recoveryRestoreBtn');
  expect(h.elements.recoveryConfirmText.textContent).toContain('不修改');
  await h.click('recoveryConfirmBtn');
  expect(h.messages.find(m => m.action === 'restoreFromBackup')).toMatchObject({ repairOnly: true });
  expect(h.elements.recoveryResult.textContent).toContain('未改动书签');
  expect(h.d.state.root).toEqual(tree);
});

test('completion of another operation clears the busy recovery view', async () => {
  const h = await harness();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const task = h.d.M.syncMutex.run(async () => { entered(); await gate; });
  await ready;
  try {
    await h.click('recoveryCheckBtn');
    expect(h.elements.recoveryRestoreBtn.disabled).toBe(true);
    expect(h.elements.recoverySummary.textContent).toContain('进行中');
  } finally { release(); await task; }
  for (const fn of h.storageListeners) fn({ sync_status: { oldValue: 'syncing', newValue: 'failed' } }, 'local');
  await flush();
  expect(h.elements.recoveryRestoreBtn.disabled).toBe(false);
  expect(h.elements.recoverySummary.textContent).toContain('未完成');
});

test('a missing restore response remains a warning until status is rechecked', async () => {
  const h = await harness();
  const send = h.ctx.chrome.runtime.sendMessage;
  h.ctx.chrome.runtime.sendMessage = async message => message.action === 'restoreFromBackup' ? undefined : send(message);
  await h.click('recoveryRestoreBtn');
  await h.click('recoveryConfirmBtn');
  expect(h.elements.recoveryResult.className).toContain('warn');
  expect(h.elements.recoveryResult.textContent).toContain('不要清除备份');
  expect(h.d.state.store.local_bookmark_backup_meta.status).toBe('pending');
});

test('popup reopens a pending recovery as a warning instead of connection success', async () => {
  const statuses = [], messages = [];
  const ctx = { console, URL, Date, setTimeout, clearTimeout,
    homeView: { classList: { contains: () => false } },
    chrome: { runtime: { async sendMessage(message) { messages.push(message); return { ok: true }; } },
      storage: { local: { async get() { return { webdav_url: 'https://dav.invalid/', webdav_user: 'u', webdav_password: 'p',
        local_bookmark_backup_meta: { id: 'pending', status: 'pending' } }; }, async set() {} } } },
    setStatus(text, level) { statuses.push({ text, level }); }, renderProgressLine() {}, renderBusySync() {},
    renderLocalRecoveryEntry() {} };
  vm.createContext(ctx);
  for (const file of ['lib/constants.js', 'lib/utils.js']) vm.runInContext(source(file), ctx);
  const popup = source('popup.js');
  const start = popup.indexOf('const STATUS_PROBE_TTL =');
  const end = popup.indexOf('// 显示/隐藏操作记录行', start);
  vm.runInContext(popup.slice(start, end), ctx);
  await ctx.updateHomeStatus();
  expect(statuses.at(-1)).toMatchObject({ level: 'warn' });
  expect(statuses.at(-1).text).toContain('备份');
  expect(messages).toEqual([]);
});
