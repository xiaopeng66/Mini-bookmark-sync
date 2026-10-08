const { makeCloud, makeDevice, response } = require('./helpers/audit-harness.cjs');
const devices = [];
function device(...args) { const d = makeDevice(...args); devices.push(d); return d; }
afterEach(() => { for (const d of devices.splice(0)) d.close(); });

test('sync status keeps the starting relationship after config changes midflight', async () => {
  const d = device('status-relationship');
  const initial = await d.M.utils.syncStatusConfigKey(d.state.store);
  await d.M.storage.setSyncStatus({ status: 'syncing', action: 'merge' });
  expect(d.state.store.sync_status_config_key).toBe(initial);
  d.state.store.webdav_url = 'https://other.invalid/dav';
  const changed = await d.M.utils.syncStatusConfigKey(d.state.store);
  expect(changed).not.toBe(initial);
  await d.M.storage.setSyncStatus({ status: 'partial', partial: true, error: 'Bridge failed' });
  expect(d.state.store.sync_status_config_key).toBe(initial);
});

test.each(['upload', 'merge'])('%s partial status binds the automatically resolved bucket', async action => {
  const cloud = makeCloud();
  const d = device('auto-status-' + action, cloud, { store: { bookmark_target_id: '', option_berry_enabled: true } });
  await d.add('1', 'Keep', 'https://keep.invalid/');
  const initial = await d.M.utils.syncStatusConfigKey(d.state.store);
  cloud.hook = req => req.method === 'PUT' && req.url.endsWith('/berry/bookmarks.json')
    ? response(500, 'synthetic bridge failure') : null;
  const result = await d.M.orchestrator[action === 'upload' ? 'uploadBookmarks' : 'mergeSync']({});
  expect(result.success).toBe(true);
  expect(result.partial).toBe(true);
  expect(d.state.store.sync_bridge_results.berry.status).toBe('failed');
  expect(d.state.store.bookmark_target_id).toBe('1');
  expect(d.state.store.sync_status_config_key).toBe(await d.M.utils.syncStatusConfigKey(d.state.store));
  expect(d.state.store.sync_status_config_key).not.toBe(initial);
});

test.each(['upload', 'merge'])('%s automatic bucket status excludes midflight configuration edits', async action => {
  const cloud = makeCloud();
  const d = device('auto-status-edited-' + action, cloud, { store: { bookmark_target_id: '', option_berry_enabled: true } });
  await d.add('1', 'Keep', 'https://keep.invalid/');
  const expected = await d.M.utils.syncStatusConfigKey({ ...d.state.store, bookmark_target_id: '1' });
  cloud.hook = req => {
    if (req.method === 'GET' && req.url === d.mainUrl) {
      d.state.store.webdav_user = 'changed-midflight';
    }
    if (req.method === 'PUT' && req.url.endsWith('/berry/bookmarks.json')) {
      d.state.store.bookmark_target_id = '2';
      return response(500, 'synthetic bridge failure');
    }
    return null;
  };
  const result = await d.M.orchestrator[action === 'upload' ? 'uploadBookmarks' : 'mergeSync']({});
  expect(result.success).toBe(true);
  expect(result.partial).toBe(true);
  expect(d.state.store.sync_status_config_key).toBe(expected);
  expect(d.state.store.sync_status_config_key).not.toBe(await d.M.utils.syncStatusConfigKey(d.state.store));
});

test.each(['upload', 'merge'])('%s status binds the cloud-declared automatic bucket', async action => {
  const cloud = makeCloud();
  const d = device('declared-status-' + action, cloud, { store: { bookmark_target_id: '', option_berry_enabled: true } });
  await d.add('1', 'Bar-only', 'https://bar.invalid/');
  const mirror = await d.add('2', 'Phone');
  await d.add(mirror.id, 'Keep', 'https://keep.invalid/');
  const remote = d.M.xbel.chromeToXbel([{ id: '0', children: [d.byId.get(mirror.id)] }], {
    syncBucketId: mirror.id, flatRootContainer: 'Phone'
  });
  cloud.put(d.mainUrl, remote);
  cloud.hook = req => req.method === 'PUT' && req.url.endsWith('/berry/bookmarks.json')
    ? response(500, 'synthetic bridge failure') : null;
  const result = await d.M.orchestrator[action === 'upload' ? 'uploadBookmarks' : 'mergeSync']({});
  expect(result.success).toBe(true);
  expect(result.partial).toBe(true);
  expect(d.state.store.bookmark_target_id).toBe(mirror.id);
  expect(d.state.store.sync_status_config_key).toBe(await d.M.utils.syncStatusConfigKey(d.state.store));
  expect(d.paths().filter(n => n.url === 'https://bar.invalid/')).toHaveLength(1);
});

test('backup callback failure blocks destructive download', async () => {
  const cloud = makeCloud(), source = device('backup-source', cloud), target = device('backup-target', cloud);
  await source.add('1', 'Remote', 'https://remote.invalid/');
  await source.M.orchestrator.uploadBookmarks({});
  await target.add('1', 'Private', 'https://private.invalid/');
  target.state.store.download_clear = true;
  target.state.failStorageKeys.add('local_bookmark_backup');
  const result = await target.M.orchestrator.downloadBookmarks({});
  expect(result.success).toBe(false);
  expect(target.paths().map(n => n.url)).toContain('https://private.invalid/');
  expect(target.state.removals).toHaveLength(0);
});

test('replacement restore preserves outside nodes and their original IDs', async () => {
  const d = device('restore-scope');
  await d.add('1', 'Before', 'https://before.invalid/');
  const outside = await d.add('2', 'Outside');
  const secret = await d.add(outside.id, 'Secret', 'https://secret.invalid/');
  expect(await d.M.syncInput.backupLocalTree()).toBe(true);
  await d.add('1', 'Newer', 'https://newer.invalid/');
  const result = await d.M.syncInput.restoreLocalBackup({ replaceCurrent: true, targetParentId: '1' });
  expect(result.ok).toBe(true);
  expect(result.restored).toBeGreaterThan(0);
  expect(d.paths().map(n => n.url)).toContain('https://before.invalid/');
  expect(d.paths().map(n => n.url)).not.toContain('https://newer.invalid/');
  expect(d.byId.get(secret.id).parentId).toBe(outside.id);
  expect(d.byId.get('2').children.map(n => n.id)).toEqual([outside.id]);
  expect(d.state.removals.map(n => n.id)).not.toContain(outside.id);
});

test('replacement restore retains current bucket when recreating backup fails', async () => {
  const d = device('restore-create-failure');
  const saved = await d.add('1', 'Saved', 'https://saved.invalid/');
  expect(await d.M.syncInput.backupLocalTree()).toBe(true);
  await d.chrome.bookmarks.remove(saved.id);
  const keep = await d.add('1', 'Keep', 'https://keep.invalid/');
  const outside = await d.add('2', 'Outside', 'https://outside.invalid/');
  d.state.failCreates = info => info.url === 'https://saved.invalid/';
  const result = await d.M.syncInput.restoreLocalBackup({ replaceCurrent: true, targetParentId: '1' });
  expect(result.ok).toBe(false);
  expect(d.byId.has(keep.id)).toBe(true);
  expect(d.byId.has(outside.id)).toBe(true);
  expect(d.paths().map(n => n.url)).toContain('https://keep.invalid/');
  expect(d.state.removals.map(n => n.id)).not.toContain(keep.id);
});

test.each(['upload', 'download'])('%s restores earlier tombstone deletions when a later delete fails', async action => {
  const cloud = makeCloud(), source = device('tombstone-source-' + action, cloud), target = device('tombstone-target-' + action, cloud);
  const a = await source.add('1', 'A', 'https://a.invalid/');
  const b = await source.add('1', 'B', 'https://b.invalid/');
  expect((await source.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  await target.add('1', 'A', 'https://a.invalid/');
  await target.add('1', 'B', 'https://b.invalid/');
  await source.chrome.bookmarks.remove(a.id);
  await source.chrome.bookmarks.remove(b.id);
  expect((await source.M.orchestrator.mergeSync({})).success).toBe(true);
  const originalRemove = target.chrome.bookmarks.remove;
  target.chrome.bookmarks.remove = (id, cb) => {
    const node = target.byId.get(String(id));
    if (node?.url === 'https://b.invalid/') {
      target.chrome.runtime.lastError = { message: 'Synthetic removal failure' };
      cb(); target.chrome.runtime.lastError = null;
    } else originalRemove(id, cb);
  };
  const result = await target.M.orchestrator[action === 'upload' ? 'uploadBookmarks' : 'downloadBookmarks']({ force: true });
  expect(result.success).toBe(false);
  expect(target.paths().filter(n => n.url === 'https://a.invalid/')).toHaveLength(1);
  expect(target.paths().filter(n => n.url === 'https://b.invalid/')).toHaveLength(1);
});

test('upload PUT conflict restores precommit tombstone deletions', async () => {
  const cloud = makeCloud(), source = device('put-restore-source', cloud), target = device('put-restore-target', cloud);
  const gone = await source.add('1', 'Gone', 'https://put-restore.invalid/');
  expect((await source.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  await target.add('1', 'Gone', 'https://put-restore.invalid/');
  await source.chrome.bookmarks.remove(gone.id);
  expect((await source.M.orchestrator.mergeSync({})).success).toBe(true);
  cloud.hook = req => req.method === 'PUT' && req.url === target.mainUrl ? response(412, 'stale') : null;
  const result = await target.M.orchestrator.uploadBookmarks({ force: true });
  expect(result.success).toBe(false);
  expect(target.paths().map(n => n.url)).toContain('https://put-restore.invalid/');
});

test('failed clear-first download restores Berry home as well as bucket', async () => {
  const cloud = makeCloud(), source = device('clear-home-source', cloud), target = device('clear-home-target', cloud);
  await source.add('1', 'New', 'https://new.invalid/');
  expect((await source.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  await target.add('1', 'Keep', 'https://keep.invalid/');
  const home = await target.add('2', '移动端主页');
  await target.add(home.id, 'PrivateHome', 'https://private-home.invalid/');
  target.state.store.download_clear = true;
  target.state.failCreates = info => info.url === 'https://new.invalid/';
  const result = await target.M.orchestrator.downloadBookmarks({});
  expect(result.success).toBe(false);
  expect(target.paths().map(n => n.url)).toEqual(expect.arrayContaining(['https://keep.invalid/', 'https://private-home.invalid/']));
});

test('partial merge import never overwrites cloud or commits baseline', async () => {
  const cloud = makeCloud(), source = device('merge-source', cloud), target = device('merge-target', cloud);
  await source.add('1', 'Keep', 'https://keep.invalid/');
  await source.add('1', 'Remote-only', 'https://remote-only.invalid/');
  await source.M.orchestrator.uploadBookmarks({});
  await target.add('1', 'Keep', 'https://keep.invalid/');
  target.state.failCreates = info => info.url === 'https://remote-only.invalid/';
  const before = cloud.files.get(source.mainUrl).content;
  const writes = cloud.requests.filter(r => r.method === 'PUT' && r.url === source.mainUrl).length;
  const result = await target.M.orchestrator.mergeSync({});
  expect(result.success).toBe(false);
  expect(result.conflictCount).toBeGreaterThan(0);
  expect(cloud.files.get(source.mainUrl).content).toBe(before);
  expect(cloud.requests.filter(r => r.method === 'PUT' && r.url === source.mainUrl)).toHaveLength(writes);
  expect(target.state.store.last_sync_at).toBeUndefined();
  expect(target.state.store.sync_snapshots?.localTree).toBeUndefined();
});

test('valid empty cloud with tombstone deletes local bookmark on download', async () => {
  const cloud = makeCloud(), source = device('empty-source', cloud), target = device('empty-target', cloud);
  const bookmark = await source.add('1', 'Gone', 'https://gone.invalid/');
  await source.M.orchestrator.uploadBookmarks({});
  await target.M.orchestrator.downloadBookmarks({});
  await source.chrome.bookmarks.remove(bookmark.id);
  await source.M.orchestrator.mergeSync({});
  const parsed = target.M.xbel.parseXbelFromString(cloud.files.get(target.mainUrl).content);
  expect(parsed.bookmarks).toHaveLength(0);
  expect(parsed.tombstones.length).toBeGreaterThan(0);
  const result = await target.M.orchestrator.downloadBookmarks({});
  expect(result.success).toBe(true);
  expect(target.paths().some(n => n.url === 'https://gone.invalid/')).toBe(false);
});

test('versioned GET binds body and ETag to the same response', async () => {
  const d = device('version-get');
  d.cloud.put(d.mainUrl, '<xbel>old</xbel>');
  const old = d.cloud.files.get(d.mainUrl);
  d.cloud.hook = req => req.method === 'HEAD' ? response(200, '', d.cloud.put(d.mainUrl, '<xbel>new</xbel>')) : null;
  const version = await d.M.webdav.getFileVersion(d.state.store.webdav_url, 'synthetic-user', 'synthetic-password', 'sync/minibookmarks.xbel');
  expect(version.content).toBe('<xbel>old</xbel>');
  expect(version.etag).toBe(old.etag);
  expect(d.cloud.requests.filter(r => r.method === 'HEAD')).toHaveLength(0);
});

test('conditional PUT reports conflict without replacing newer cloud body', async () => {
  const d = device('version-put');
  d.cloud.put(d.mainUrl, '<xbel>old</xbel>');
  const version = await d.M.webdav.getFileVersion(d.state.store.webdav_url, 'synthetic-user', 'synthetic-password', 'sync/minibookmarks.xbel');
  d.cloud.put(d.mainUrl, '<xbel>newer</xbel>');
  d.cloud.hook = req => req.method === 'PUT' && req.headers['If-Match'] !== d.cloud.files.get(req.url).etag ? response(412, 'conflict') : null;
  await expect(d.M.webdav.putFile(d.state.store.webdav_url, 'synthetic-user', 'synthetic-password', 'sync/minibookmarks.xbel', '<xbel>mine</xbel>', undefined, { etag: version.etag }))
    .rejects.toMatchObject({ code: 'CLOUD_CONFLICT' });
  expect(d.cloud.files.get(d.mainUrl).content).toBe('<xbel>newer</xbel>');
  expect(d.cloud.requests.findLast(r => r.method === 'PUT').headers['If-Match']).toBe(version.etag);
});

test('relationship change isolates tombstones and old deletion baselines', async () => {
  const d = device('identity');
  d.state.store.sync_tombstones = [{ key: 'ROOT:bar/L:https://old.invalid/', deletedAt: 1, deviceId: 'old' }];
  d.state.store.sync_snapshots = { localTree: [{ id: 'old', title: 'Old' }] };
  d.state.store.cloud_last_modified = 123;
  const first = await d.M.syncInput.ensureSyncRelationship({ url: 'https://dav.invalid/dav', username: 'one', filename: '/sync/one.xbel' }, '1');
  expect(first.changed).toBe(true);
  expect(d.state.store.sync_tombstones).toEqual([]);
  expect(d.state.store.sync_snapshots).toEqual({});
  expect(d.state.store.cloud_last_modified).toBe(0);
  d.state.store.sync_tombstones = [{ key: 'ROOT:bar/L:https://one.invalid/', deletedAt: 2, deviceId: 'one' }];
  await d.M.syncInput.ensureSyncRelationship({ url: 'https://dav.invalid/dav', username: 'two', filename: '/sync/one.xbel' }, '2');
  expect(d.state.store.sync_tombstones).toEqual([]);
  await d.M.syncInput.ensureSyncRelationship({ url: 'https://dav.invalid/dav', username: 'one', filename: '/sync/one.xbel' }, '1');
  expect(d.state.store.sync_tombstones.map(t => t.deviceId)).toEqual(['one']);
});

test('relationship switch clears every bridge baseline before actual Berry read', async () => {
  const d = device('bridge-relationship');
  await d.add('1', 'Keep', 'https://bridge-relation.invalid/');
  const local = d.M.merger.chromeTreeToList(await d.M.syncInput.getChromeTree());
  const currentKeys = [...d.M.xbelPath.computeJsonPathKeys(local).values()];
  const config = { url: 'https://audit.invalid/dav', username: 'old', filename: '/sync/minibookmarks.xbel' };
  await d.M.syncInput.ensureSyncRelationship(config, '1');
  for (const key of ['berry_pathkey_snapshot', 'via_pathkey_snapshot', 'aira_pathkey_snapshot', 'aira_home_pathkey_snapshot']) {
    d.state.store[key] = currentKeys;
  }
  await d.M.syncInput.ensureSyncRelationship({ ...config, username: 'new' }, '1');
  d.cloud.put(d.state.store.webdav_url + '/berry/bookmarks.json', JSON.stringify({ schemaVersion: 2, data: [] }), 'application/json');
  const result = await d.M.berry.mergeBerryDataWithChanges(local);
  expect(result.complete).toBe(true);
  expect(result.deletedIds).toEqual([]);
  expect(result.list.some(n => n.url === 'https://bridge-relation.invalid/')).toBe(true);
  for (const key of ['berry_pathkey_snapshot', 'via_pathkey_snapshot', 'aira_pathkey_snapshot', 'aira_home_pathkey_snapshot']) {
    expect(d.state.store[key]).toEqual([]);
  }
});

// ===== 服务器并发标识能力差异 =====
// 实测回归（坚果云）：v2.2.0 要求云端必须返回强 ETag，否则「合并」直接报
// 「云端缺少强 ETag，无法安全地合并写入」—— 同步彻底不可用。
// 契约改为按服务器实际能力分层，下面这组用例锁定分层结果：
//   ① 强 ETag 可用 → If-Match，不得退化；
//   ② 只有弱 ETag → 绝不拿它做 If-Match（RFC 7232 强比较必然 412），改用 Last-Modified；
//   ③ 连 Last-Modified 都没有 → 仍然写成功，但在结果里如实说明没有并发保护；
//   ④ 下载不写云端，版本标识缺失一律不影响。
// ②③④ 在 v2.2.0 上必须失败，否则这组回归没有守住任何东西。

function mainFilePuts(d) {
  return d.cloud.requests.filter(r => r.method === 'PUT' && r.url === d.mainUrl);
}

test('versionWriteCondition never hands a weak ETag to If-Match', async () => {
  const d = device('write-condition-unit');
  const condition = d.M.webdav.versionWriteCondition({ exists: true, etag: 'W/"weak"', serverModified: 0 });
  expect(condition).toEqual({});
  expect(d.M.webdav.describeWriteProtection({ etag: 'W/"weak"' })).toBe('none');
  expect(d.M.webdav.versionWriteCondition({ exists: true, etag: 'W/"weak"', serverModified: 1000 }))
    .toEqual({ since: 1000 });
  expect(d.M.webdav.versionWriteCondition({ exists: true, etag: '"strong"', serverModified: 1000 }))
    .toEqual({ etag: '"strong"' });
  expect(d.M.webdav.versionWriteCondition({ exists: false })).toEqual({ missing: true });
});

test('a strong-ETag server still uses If-Match and never degrades', async () => {
  const d = device('strong-etag-kept');
  await d.add('1', 'Keep', 'https://strong.invalid/');
  expect((await d.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  // 云端本来没有文件 → 只允许创建，避免覆盖掉同名的既有文件
  expect(mainFilePuts(d).pop().headers['If-None-Match']).toBe('*');

  await d.add('1', 'Later', 'https://later.invalid/');
  const beforeEtag = d.cloud.files.get(d.mainUrl).etag;
  expect((await d.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  const updated = mainFilePuts(d).pop();
  expect(updated.headers['If-Match']).toBe(beforeEtag);
  expect(updated.headers['If-Unmodified-Since']).toBeUndefined();
});

test('clearing cloud tombstones writes the shared XBEL conditionally', async () => {
  const cloud = makeCloud();
  const d = device('clear-cache-conditional', cloud, { background: true });
  await d.add('1', 'Keep', 'https://keep.invalid/');
  expect((await d.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  const lastPut = () => cloud.requests.filter(r => r.method === 'PUT').pop();
  const mainUrl = lastPut().url;

  const beforeEtag = cloud.files.get(mainUrl).etag;
  const first = await d.send({ action: 'clearSyncCache', scope: 'current' });
  expect(first).toMatchObject({ ok: true, success: true, cloudCleared: true });
  expect(first.note).toBe('');                       // 满档保护不该冒出降档提醒
  expect(lastPut().headers['If-Match']).toBe(beforeEtag);

  // 服务器不再暴露 ETag：清理仍要写成功（不许整条流程失败），但必须带条件，
  // 不许退回成无条件覆盖 —— 这条路径改的是全局共享的 XBEL。
  cloud.etagMode = 'none';
  const beforeModified = new Date(cloud.files.get(mainUrl).mtime).toUTCString();
  const second = await d.send({ action: 'clearSyncCache', scope: 'all' });
  expect(second).toMatchObject({ ok: true, success: true, cloudCleared: true });
  expect(lastPut().headers['If-Match']).toBeUndefined();
  expect(lastPut().headers['If-Unmodified-Since']).toBe(beforeModified);
  // ★ 这条路径此前既不写条件、也不告诉用户保护级别；现在两者都必须成立。
  expect(second.note).toContain('改用云端修改时间做并发校验');

  // 完全没有版本线索的服务器上，清理仍然成功，但必须如实说明没有并发保护
  cloud.lastModifiedMode = 'none';
  cloud.dateMode = 'none';
  const third = await d.send({ action: 'clearSyncCache', scope: 'all' });
  expect(third).toMatchObject({ ok: true, success: true, cloudCleared: true });
  expect(third.note).toContain('没有并发保护');
});

test('a rejected maintenance write is reported as a conflict, not a network fault', async () => {
  const cloud = makeCloud();
  const d = device('clear-cache-conflict', cloud, { background: true });
  await d.add('1', 'Keep', 'https://keep.invalid/');
  expect((await d.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  cloud.etagMode = 'weak';
  const mainUrl = cloud.requests.filter(r => r.method === 'PUT').pop().url;
  // 清理流程读完之后，另一台设备抢先写入了共享 XBEL
  cloud.hook = req => {
    if (req.method !== 'GET' || req.url !== mainUrl) return null;
    const served = response(200, cloud.files.get(req.url).content, cloud.files.get(req.url), cloud);
    cloud.put(req.url, cloud.files.get(req.url).content.replace('Keep', 'Theirs'));
    return served;
  };
  const result = await d.send({ action: 'clearSyncCache', scope: 'all' });
  expect(result.cloudCleared).toBe(false);
  expect(result.cloudError).toBe('conflict');   // 安全拒绝 ≠ 网络故障，不能报错方向
  expect(cloud.files.get(mainUrl).content).toContain('Theirs');
});

test.each(['upload', 'merge'])('%s writes when the server exposes no strong ETag', async action => {
  const cloud = makeCloud();
  const d = device('no-strong-etag-' + action, cloud);
  const keep = await d.add('1', 'Keep', 'https://keep.invalid/');
  expect((await d.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  cloud.etagMode = 'none';                    // 服务器从此不再暴露 ETag
  await d.add('1', 'Later', 'https://later.invalid/');
  const beforeModified = new Date(cloud.files.get(d.mainUrl).mtime).toUTCString();
  const result = await d.M.orchestrator[action === 'upload' ? 'uploadBookmarks' : 'mergeSync']({});
  expect(result.success).toBe(true);
  const body = d.cloud.files.get(d.mainUrl).content;
  expect(body).toContain('Later');
  expect(body).toContain('Keep');             // 既有内容不许在降档写入里被顺手丢掉
  expect(d.byId.has(keep.id)).toBe(true);
  expect(d.state.removals).toHaveLength(0);   // 降档不等于放任本地删除
  const put = mainFilePuts(d).pop();
  expect(put.headers['If-Match']).toBeUndefined();
  expect(put.headers['If-Unmodified-Since']).toBe(beforeModified);
  // 降档必须说出「降到哪一档」，只用「并发」二字无法区分「秒级校验」与「完全没保护」
  expect(result.message).toContain('改用云端修改时间做并发校验');
  expect(result.message).not.toContain('没有并发保护');
});

test.each(['upload', 'merge'])('%s falls back to If-Unmodified-Since on a weak ETag', async action => {
  const cloud = makeCloud();
  const d = device('weak-etag-' + action, cloud);
  const keep = await d.add('1', 'Keep', 'https://keep.invalid/');
  expect((await d.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  cloud.etagMode = 'weak';
  await d.add('1', 'Later', 'https://later.invalid/');
  const beforeModified = new Date(cloud.files.get(d.mainUrl).mtime).toUTCString();
  const result = await d.M.orchestrator[action === 'upload' ? 'uploadBookmarks' : 'mergeSync']({});
  expect(result.success).toBe(true);
  const put = mainFilePuts(d).pop();
  expect(put.headers['If-Match']).toBeUndefined();
  expect(put.headers['If-Unmodified-Since']).toBe(beforeModified);
  expect(d.cloud.files.get(d.mainUrl).content).toContain('Keep');
  expect(d.byId.has(keep.id)).toBe(true);
  expect(d.state.removals).toHaveLength(0);
});

test.each(['upload', 'merge'])('%s still writes but reports when the server has no version header', async action => {
  const cloud = makeCloud();
  const d = device('no-version-' + action, cloud);
  const keep = await d.add('1', 'Keep', 'https://keep.invalid/');
  expect((await d.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  cloud.etagMode = 'none';
  cloud.lastModifiedMode = 'none';
  cloud.dateMode = 'none';
  await d.add('1', 'Later', 'https://later.invalid/');
  const result = await d.M.orchestrator[action === 'upload' ? 'uploadBookmarks' : 'mergeSync']({});
  expect(result.success).toBe(true);
  const body = d.cloud.files.get(d.mainUrl).content;
  expect(body).toContain('Later');
  expect(body).toContain('Keep');
  expect(d.byId.has(keep.id)).toBe(true);
  expect(d.state.removals).toHaveLength(0);
  const put = mainFilePuts(d).pop();
  expect(put.headers['If-Match']).toBeUndefined();
  expect(put.headers['If-Unmodified-Since']).toBeUndefined();
  expect(result.message).toContain('没有并发保护');
});

test.each(['upload', 'merge'])('%s propagates a cloud tombstone at the fallback tier', async action => {
  const cloud = makeCloud();
  const d = device('fallback-tombstone-' + action, cloud);
  const bookmark = await d.add('1', 'Doomed', 'https://doomed.invalid/');
  expect((await d.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  // 另一台设备删掉了它：云端写出墓碑，但服务器只给弱 ETag
  const cloudFile = cloud.files.get(d.mainUrl);
  const key = [...d.M.xbelPath.computeJsonPathKeys(d.M.xbel.parseXbelFromString(cloudFile.content).bookmarks).values()]
    .find(pk => pk.includes('doomed.invalid'));
  cloudFile.content = d.M.xbel.chromeToXbel([{ id: '0', children: [{ id: '1', title: '书签栏', children: [] }] }], {
    tombstones: [{ key, deletedAt: d.state.now + 1, deviceId: 'other' }]
  });
  cloud.etagMode = 'weak';
  const result = await d.M.orchestrator[action === 'upload' ? 'uploadBookmarks' : 'mergeSync']({});
  expect(result.success).toBe(true);
  // 降档后删除传播必须照旧生效 —— 旧版那条「弱 ETag 一律拒绝」的用例正是在覆盖这个矩阵
  expect(d.byId.has(bookmark.id)).toBe(false);
  expect(d.state.removals.map(n => n.url)).toContain('https://doomed.invalid/');
  expect(mainFilePuts(d).pop().headers['If-Unmodified-Since']).toBeTruthy();
});

test('download needs no version identifier because it never writes to the cloud', async () => {
  const cloud = makeCloud();
  const source = device('no-etag-download-source', cloud);
  await source.add('1', 'Remote', 'https://remote-no-etag.invalid/');
  expect((await source.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  const target = device('no-etag-download-target', cloud);
  cloud.etagMode = 'none';
  cloud.lastModifiedMode = 'none';
  cloud.dateMode = 'none';
  const puts = cloud.requests.filter(r => r.method === 'PUT').length;
  const result = await target.M.orchestrator.downloadBookmarks({});
  expect(result.success).toBe(true);
  expect(target.paths().some(n => n.url === 'https://remote-no-etag.invalid/')).toBe(true);
  expect(cloud.requests.filter(r => r.method === 'PUT')).toHaveLength(puts);
});

test('fallback condition still stops a concurrent overwrite', async () => {
  const cloud = makeCloud();
  const d = device('fallback-conflict', cloud);
  const keep = await d.add('1', 'Keep', 'https://keep.invalid/');
  const other = await d.add('1', 'Other', 'https://other.invalid/');
  expect((await d.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  cloud.etagMode = 'weak';   // 服务器只给弱 ETag ⇒ 本机必须走 If-Unmodified-Since 这一档
  const modified = cloud.files.get(d.mainUrl).mtime;
  // ★ 真实的竞争窗口是「本机读完之后、写回之前」：在服务这一版 GET 的同时让另一台设备写入。
  //   客户端会在操作开始时重新 GET，所以必须在 GET 里制造竞争；在 PUT 里挂 hook 只能造出
  //   一个客户端本来就能满足的条件，那样测的是「错误路径接没接通」，不是「并发有没有被挡住」。
  cloud.hook = req => {
    if (req.method !== 'GET' || req.url !== d.mainUrl) return null;
    const served = response(200, cloud.files.get(req.url).content, cloud.files.get(req.url), cloud);
    cloud.put(req.url, cloud.files.get(req.url).content.replace('Keep', 'Theirs'));
    return served;
  };
  await d.chrome.bookmarks.update(keep.id, { title: 'Mine' });
  const result = await d.M.orchestrator.uploadBookmarks({ force: true });

  expect(result.success).toBe(false);
  expect(result.code).toBe('CLOUD_CONFLICT');
  expect(result.message).toMatch(/云端文件已更改/);
  // 对端的正文没有被覆盖，本机也没有把它自己的删除/改名落成既成事实
  expect(cloud.files.get(d.mainUrl).content).toContain('Theirs');
  expect(cloud.files.get(d.mainUrl).mtime).toBeGreaterThan(modified);
  expect(d.byId.has(keep.id) && d.byId.has(other.id)).toBe(true);
  expect(d.state.removals).toHaveLength(0);
  expect(cloud.requests.filter(r => r.method === 'PUT')).toHaveLength(2);   // 首次上传 + 被拒的这一次
});

test('a server that exposes only Date never gets If-Unmodified-Since', async () => {
  const cloud = makeCloud();
  const d = device('date-only-server', cloud);
  await d.add('1', 'Keep', 'https://keep.invalid/');
  expect((await d.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  cloud.etagMode = 'none';
  cloud.lastModifiedMode = 'none';   // 只有响应 Date，没有 Last-Modified
  expect(cloud.files.get(d.mainUrl).mtime).toBeGreaterThan(0);
  await d.add('1', 'Later', 'https://later.invalid/');
  const result = await d.M.orchestrator.uploadBookmarks({});
  expect(result.success).toBe(true);
  // 拿响应 Date（≈现在）当修改时间会得到一个永远匹配不上的条件：真实服务器必然 412，
  // 而这里因为 enforcePreconditions 打开，写一个坑条件就不可能「碰巧通过」。
  expect(mainFilePuts(d).pop().headers['If-Unmodified-Since']).toBeUndefined();
  expect(result.message).toMatch(/没有并发保护/);
});

test('a server without Last-Modified does not fake a cloud conflict', async () => {
  const cloud = makeCloud();
  const d = device('no-last-modified-conflict', cloud);
  await d.add('1', 'Keep', 'https://keep.invalid/');
  expect((await d.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  cloud.lastModifiedMode = 'none';   // 只剩响应 Date
  await d.add('1', 'Later', 'https://later.invalid/');
  // 不传 force：服务端没给修改时间时，不能把响应 Date 当「云端被别人改过」，
  // 否则这台服务器上每次非强制上传都会先跟用户吵一架。
  const result = await d.M.orchestrator.uploadBookmarks({});
  expect(result.code).not.toBe('CLOUD_CONFLICT');
  expect(result.success).toBe(true);
  expect(d.cloud.files.get(d.mainUrl).content).toContain('Later');
});

test('conditional PUT rejects weak ETag without network writes', async () => {
  const d = device('weak-put');
  await expect(d.M.webdav.putFile('https://audit.invalid/dav', 'synthetic-user', 'synthetic-password', 'sync/minibookmarks.xbel', '<xbel/>', undefined, { etag: 'W/"weak"' }))
    .rejects.toThrow(/ETag/);
  expect(d.cloud.requests).toHaveLength(0);
});

test('download import conflict never advances success baseline', async () => {
  const cloud = makeCloud(), source = device('download-conflict-source', cloud), target = device('download-conflict-target', cloud);
  await source.add('1', 'Remote', 'https://remote.invalid/');
  expect((await source.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  target.state.failCreates = info => info.url === 'https://remote.invalid/';
  const result = await target.M.orchestrator.downloadBookmarks({});
  expect(result.success).toBe(false);
  expect(result.conflictCount).toBeGreaterThan(0);
  expect(target.state.store.last_sync_at).toBeUndefined();
  expect(target.state.store.sync_snapshots?.localTree).toBeUndefined();
  expect(target.state.store.cloud_last_modified || 0).toBe(0);
});

test('upload deletion failure stops conditional cloud write', async () => {
  const cloud = makeCloud(), source = device('delete-source', cloud), target = device('delete-target', cloud);
  const bookmark = await source.add('1', 'Gone', 'https://gone.invalid/');
  expect((await source.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  expect((await target.M.orchestrator.downloadBookmarks({})).success).toBe(true);
  await source.chrome.bookmarks.remove(bookmark.id);
  expect((await source.M.orchestrator.mergeSync({})).success).toBe(true);
  const local = target.paths().find(n => n.url === 'https://gone.invalid/');
  const prior = cloud.files.get(source.mainUrl).content;
  const puts = cloud.requests.filter(r => r.method === 'PUT' && r.url === source.mainUrl).length;
  target.chrome.bookmarks.remove = (_id, cb) => { target.chrome.runtime.lastError = { message: 'Synthetic removal failure' }; cb(); target.chrome.runtime.lastError = null; };
  const result = await target.M.orchestrator.uploadBookmarks({ force: true });
  expect(result.success).toBe(false);
  expect(target.byId.has(local.id)).toBe(true);
  expect(cloud.files.get(source.mainUrl).content).toBe(prior);
  expect(cloud.requests.filter(r => r.method === 'PUT' && r.url === source.mainUrl)).toHaveLength(puts);
});

test('bridge deletion is applied to local and recorded as tombstone before cloud PUT', async () => {
  const cloud = makeCloud(), d = device('bridge-delete', cloud);
  const bookmark = await d.add('1', 'Mobile-deleted', 'https://bridge.invalid/');
  expect((await d.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  d.state.store.option_berry_enabled = true;
  d.M.berry.mergeBerryDataWithChanges = async list => ({ list: list.filter(n => String(n.id) !== bookmark.id),
    deletedIds: [bookmark.id], deletedPathKeys: ['ROOT:bar/L:https://bridge.invalid/'], complete: true, errors: [] });
  d.M.bridgePatcher.patchBridges = async () => ({ bridgeResults: { berry: { status: 'success' } }, partial: false });
  const result = await d.M.orchestrator.mergeSync({});
  expect(result.success).toBe(true);
  expect(d.paths().some(n => n.url === 'https://bridge.invalid/')).toBe(false);
  const parsed = d.M.xbel.parseXbelFromString(cloud.files.get(d.mainUrl).content);
  expect(parsed.bookmarks.some(n => n.url === 'https://bridge.invalid/')).toBe(false);
  expect(parsed.tombstones.some(t => t.key === 'ROOT:bar/L:https://bridge.invalid/')).toBe(true);
});

test.each(['import', 'precondition'])('bridge deletion snapshot remains retryable after %s failure', async failure => {
  const cloud = makeCloud(), d = device('bridge-retry-' + failure, cloud);
  const bookmark = await d.add('1', 'Mobile-deleted', 'https://retry-bridge.invalid/');
  expect((await d.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  d.state.store.option_berry_enabled = true;
  d.state.store.berry_pathkey_snapshot = ['ROOT:bar/L:https://retry-bridge.invalid/'];
  d.M.berry.mergeBerryDataWithChanges = async list => ({
    list: list.filter(n => n.url !== 'https://retry-bridge.invalid/'),
    deletedIds: list.filter(n => n.url === 'https://retry-bridge.invalid/').map(n => n.id),
    deletedPathKeys: ['ROOT:bar/L:https://retry-bridge.invalid/'], complete: true, errors: [],
    snapshotUpdates: { berry_pathkey_snapshot: [] }
  });
  const previous = cloud.files.get(d.mainUrl).content;
  if (failure === 'import') {
    const original = d.M.importer.importBookmarksFromData;
    let first = true;
    d.M.importer.importBookmarksFromData = async (...args) => first
      ? (first = false, { conflicts: [{ title: 'Mobile-deleted', error: 'write failed' }], moveFailed: 0 })
      : original(...args);
  } else {
    let first = true;
    cloud.hook = req => req.method === 'PUT' && req.url === d.mainUrl && first
      ? (first = false, response(412, 'stale')) : null;
  }
  const failed = await d.M.orchestrator.mergeSync({});
  expect(failed.success).toBe(false);
  expect(d.state.store.berry_pathkey_snapshot).toEqual(['ROOT:bar/L:https://retry-bridge.invalid/']);
  expect(cloud.files.get(d.mainUrl).content).toBe(previous);
  expect(d.paths().some(n => n.url === 'https://retry-bridge.invalid/')).toBe(true);
  const retried = await d.M.orchestrator.mergeSync({});
  expect(retried.success).toBe(true);
  expect(d.paths().some(n => n.url === 'https://retry-bridge.invalid/')).toBe(false);
  const parsed = d.M.xbel.parseXbelFromString(cloud.files.get(d.mainUrl).content);
  expect(parsed.bookmarks.some(n => n.url === 'https://retry-bridge.invalid/')).toBe(false);
  expect(parsed.tombstones.some(t => t.key === 'ROOT:bar/L:https://retry-bridge.invalid/')).toBe(true);
  expect(d.state.store.berry_pathkey_snapshot).toEqual([]);
});


test('incomplete bridge read cannot claim success or delete local state', async () => {
  const cloud = makeCloud(), d = device('bridge-incomplete', cloud);
  await d.add('1', 'Keep', 'https://keep.invalid/');
  expect((await d.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  d.state.store.option_berry_enabled = true;
  d.M.berry.mergeBerryDataWithChanges = async list => ({ list: [], deletedIds: list.map(n => n.id),
    deletedPathKeys: ['ROOT:bar/L:https://keep.invalid/'], complete: false, errors: ['read failed'] });
  const result = await d.M.orchestrator.mergeSync({});
  expect(result.partial).toBe(true);
  expect(d.paths().some(n => n.url === 'https://keep.invalid/')).toBe(true);
  expect(d.state.store.sync_status).toBe('partial');
});

test('merge rename callback failure cannot commit cloud or baseline', async () => {
  const d = device('rename-failure');
  const bookmark = await d.add('1', 'Old', 'https://rename.invalid/');
  expect((await d.M.orchestrator.uploadBookmarks({})).success).toBe(true);
  const before = d.cloud.files.get(d.mainUrl).content;
  const lastSync = d.state.store.last_sync_at;
  const puts = d.cloud.requests.filter(r => r.method === 'PUT' && r.url === d.mainUrl).length;
  const merge = d.M.merger.mergeBookmarks;
  d.M.merger.mergeBookmarks = async (...args) => ({ ...await merge(...args), remoteUpdated: true,
    renameLocalNodes: [{ id: bookmark.id, title: 'New' }] });
  d.chrome.bookmarks.update = (_id, _changes, cb) => {
    d.chrome.runtime.lastError = { message: 'Synthetic rename failure' };
    cb();
    d.chrome.runtime.lastError = null;
  };
  const result = await d.M.orchestrator.mergeSync({});
  expect(result.success).toBe(false);
  expect(d.cloud.files.get(d.mainUrl).content).toBe(before);
  expect(d.cloud.requests.filter(r => r.method === 'PUT' && r.url === d.mainUrl)).toHaveLength(puts);
  expect(d.state.store.last_sync_at).toBe(lastSync);
});

test('bridge write exception after main merge commit reports persistent partial success', async () => {
  const d = device('merge-bridge-exception');
  await d.add('1', 'Keep', 'https://bridge-write.invalid/');
  d.M.bridgePatcher.patchBridges = async () => { throw new Error('Synthetic bridge timeout'); };
  const result = await d.M.orchestrator.mergeSync({});
  expect(result.success).toBe(true);
  expect(result.partial).toBe(true);
  expect(d.cloud.files.has(d.mainUrl)).toBe(true);
  expect(d.state.store.sync_status).toBe('partial');
  expect(d.state.store.sync_bridge_results.unknown.status).toBe('failed');
});


test('bridge write failure after main commit persists partial rather than failed', async () => {
  const d = device('bridge-write');
  d.M.bridgePatcher.patchBridges = async () => ({ bridgeResults: { berry: { status: 'failed', error: 'timeout' } }, partial: true });
  const result = await d.M.orchestrator.uploadBookmarks({});
  expect(result.success).toBe(true);
  expect(result.partial).toBe(true);
  expect(d.state.store.sync_status).toBe('partial');
  expect(d.state.store.sync_partial).toBe(true);
  expect(d.state.store.sync_bridge_results.berry.status).toBe('failed');
  expect(d.cloud.files.has(d.mainUrl)).toBe(true);
});
