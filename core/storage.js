// storage.js — 统一存储封装
// 封装 chrome.storage.local / session 读写，为同步编排层提供统一异步接口

MiniSync.storage = (function() {

/** 从 storage.local 批量读取 */
async function getLocal(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => {
      resolve(result || {});
    });
  });
}

/** 写入 storage.local */
async function setLocal(data) {
  return new Promise((resolve) => {
    chrome.storage.local.set(data, () => {
      resolve();
    });
  });
}

/** 删除 storage.local 中的指定 keys */
async function removeLocal(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.remove(keys, () => {
      resolve();
    });
  });
}

/** 读取 WebDAV 配置（优先新格式 webdav_config，回退旧格式独立 key）
 *  直接转发到 MiniSync.utils.getWebDAVConfig，避免 storage 与 utils 两份实现
 *  字段漂移（曾因 utils 版返回 user 而调用方用 username 导致 401）。 */
async function getWebdavConfig() {
  return MiniSync.utils.getWebDAVConfig();
}

/** 写入 WebDAV 配置（双写：嵌套 webdav_config + 扁平 key 同步落盘）
 *  扁平 key 是全库读取的权威源（popup/background 9+ 处直读、扁平优先解析），
 *  只写嵌套会被旧扁平值遮蔽——保存成功但读取不生效。 */
async function setWebdavConfig(config) {
  const c = config || {};
  const filename = c.filename || DEFAULT_FILENAME;
  const path = filename.includes('/') ? filename.slice(0, filename.lastIndexOf('/')) : '';
  await setLocal({
    webdav_config: c,
    webdav_url: c.url || '',
    webdav_user: c.username || '',
    webdav_password: c.password || '',
    webdav_bookmark_path: path
  });
}

/** 获取设备 ID（不存在则自动生成） */
async function getDeviceId() {
  const data = await getLocal(['sync_device_id']);
  if (data.sync_device_id) return data.sync_device_id;
  const id = await generateDeviceId();
  await setLocal({ sync_device_id: id });
  return id;
}

/** 读取同步状态（SYNCING 超过 5 分钟自动释放） */
async function getSyncStatus() {
  const data = await getLocal(['sync_status', 'last_sync_time', 'sync_error', 'sync_action']);
  let status = data.sync_status || IDLE;

  // SYNCING 超时自动释放（5分钟）
  if (status === SYNCING && data.last_sync_time) {
    const elapsed = Date.now() - data.last_sync_time;
    if (elapsed > 5 * 60 * 1000) {
      console.warn('[storage] SYNCING 超时释放，已卡住', Math.round(elapsed / 1000), '秒');
      status = IDLE;
      await setLocal({ sync_status: IDLE });
    }
  }

  return {
    status: status,
    lastSyncTime: data.last_sync_time || null,
    error: data.sync_error || '',
    // 任务类型（upload/download/merge）：前端据此显示「XX进行中」
    action: data.sync_action || ''
  };
}

/** 写入同步状态 */
async function setSyncStatus(status) {
  const update = { sync_status: status.status };
  if (status.error !== undefined) update.sync_error = status.error;
  if (status.action !== undefined) update.sync_action = status.action;
  if (status.status === SYNCING) update.last_sync_time = Date.now();
  else if (status.status === SUCCESS) update.last_sync_time = Date.now();
  await setLocal(update);
}

return {
  getLocal,
  setLocal,
  removeLocal,
  getWebdavConfig,
  setWebdavConfig,
  getDeviceId,
  getSyncStatus,
  setSyncStatus
};

})();
