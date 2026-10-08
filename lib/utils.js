// utils.js — 工具函数集
// 所有函数必须在 IIFE 外部声明为全局函数（adapters 通过裸名调用）

var MiniSync = MiniSync || {};

// ========== 全局函数声明（importScripts 全局共享）==========

/**
 * 生成设备 ID：随机 UUID 持久化到 storage（一次生成终身不变）。
 * 不能用 os/arch/UA 哈希：UA 变化（浏览器升级/换通道）会导致身份漂移，
 * 墓碑的本端/对端判定错乱；多 Profile 场景三要素相同会撞 id。
 * 注意：调用方（storage.getDeviceId）约定「拿到即已持久化」。
 */
let deviceIdInFlight = null;
function generateDeviceId() {
  if (deviceIdInFlight) return deviceIdInFlight;
  const operation = (async () => {
    const data = await new Promise((resolve, reject) => chrome.storage.local.get(['sync_device_id'], result => {
      const error = chrome.runtime && chrome.runtime.lastError;
      if (error) reject(new Error(error.message || String(error)));
      else resolve(result || {});
    }));
    if (typeof data.sync_device_id === 'string' && data.sync_device_id) return data.sync_device_id;
    const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? 'ext_' + crypto.randomUUID()
      : 'ext_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    await new Promise((resolve, reject) => chrome.storage.local.set({ sync_device_id: id }, () => {
      const error = chrome.runtime && chrome.runtime.lastError;
      if (error) reject(new Error(error.message || String(error)));
      else resolve();
    }));
    return id;
  })();
  deviceIdInFlight = operation;
  operation.then(() => { if (deviceIdInFlight === operation) deviceIdInFlight = null; },
    () => { if (deviceIdInFlight === operation) deviceIdInFlight = null; });
  return operation;
}

function normalizeUrl(url) {
  if (!url) return '';
  try {
    let u = url.trim().replace(/\/+$/, '');
    if (/^https?:\/\//i.test(u)) {
      const obj = new URL(u);
      obj.hash = '';
      return obj.toString().replace(/\/$/, '');
    }
    return u;
  } catch (_) { return url.trim(); }
}

/**
 * HTML 转义（单一事实源）。凡是把【外部数据】拼进 innerHTML / HTML 模板的地方都必须过它：
 * 书签标题来自云端文件、浏览器书签树，属于外部数据；只有完全由本扩展写死的文案才可绕过。
 */
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 日志用的 URL 脱敏：写成 `https://user:pass@host/dav/` 的配置里带明文凭据，
 * 原样打进 console 会被用户复制出去（本扩展的诊断日志正是设计给人看的）。
 * 目标路径仍保留，userinfo、查询和片段永不进入可复制的诊断日志。
 */
function redactUrlForLog(url) {
  if (!url) return '';
  const raw = String(url);
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return /[@?#]/.test(raw) ? u.toString() : raw;
  } catch (_) {
    return raw.replace(/\/\/[^/@\s]*@/, '//[redacted]@').replace(/[?#].*$/, '');
  }
}

/** 诊断 reason 只能保留本扩展生成的固定结论，不信任宿主拼接的后缀。 */
function sanitizeDiagnosticReason(reason) {
  const fixed = [
    '本页没有 chrome.bookmarks.getTree', '本页没有 runtime.sendMessage',
    '本页没有 storage.local', '本宿主没有 runtime.getBackgroundPage（MV3 用 service worker，取不到直接句柄）',
    '宿主返回空：后台页不存在（后台从未被启动）',
    'ping 返回空（消息没被应答：后台没运行，或宿主把响应丢了）',
    'pingLegacy 返回空（return false 的同步响应被宿主丢弃）',
    'diagnose 返回空（消息没被应答：后台没运行，或宿主把响应丢了）',
    '两条路都没拿到响应', 'boot', 'not-checked', 'unknown', '到点补跑'
  ];
  if (fixed.includes(reason)) return reason;
  const timeout = /^(chrome\.bookmarks\.getTree 回调|getTree|getBackgroundPage 回调|ping|pingLegacy|diagnose) (\d{1,8}ms) (内没回来（宿主没实现）|内没回来|无响应（后台未运行或没注册处理器）|无响应)$/.exec(reason);
  if (timeout) return timeout[1] + ' ' + timeout[2] + ' ' + timeout[3];
  const structural = ['getTree 回调给的不是数组：', 'getTree 没给根节点：'];
  for (const prefix of structural) if (reason.startsWith(prefix)) return prefix.slice(0, -1);
  const errors = [
    'getTree 报错：', 'getTree 抛异常：', 'getBackgroundPage 报错：',
    'getBackgroundPage 抛异常：', 'ping 抛异常：', 'pingLegacy 抛异常：',
    'diagnose 抛异常：', '两条路都失败：', '读台账失败：',
    '读自动同步台账失败：', '读落盘台账失败：'
  ];
  for (const prefix of errors) {
    if (reason.startsWith(prefix)) return prefix + diagnosticErrorText(reason.slice(prefix.length));
  }
  return '[redacted reason]';
}

/** 诊断报告的最后一道边界：只返回匿名结构，不返回书签或任意错误原文。 */
function sanitizeDiagnosticValue(value) {
  const seen = new WeakSet();
  const visit = (input, key, errorContext) => {
    if (input == null || typeof input === 'boolean' || typeof input === 'number') return input;
    if (typeof input === 'string') {
      if (errorContext) {
        if (key === 'kind' && /^(error|warning|info)$/.test(input)) return input;
        return '[redacted error]';
      }
      if (key === 'reason') return sanitizeDiagnosticReason(input);
      return input.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, url => redactUrlForLog(url));
    }
    if (typeof input !== 'object') return undefined;
    if (seen.has(input)) return '[circular]';
    seen.add(input);
    if (Array.isArray(input)) return input.map(item => visit(item, key, errorContext));
    const result = {};
    const bookmark = Object.prototype.hasOwnProperty.call(input, 'title') &&
      (Object.prototype.hasOwnProperty.call(input, 'url') || Object.prototype.hasOwnProperty.call(input, 'children') || Object.prototype.hasOwnProperty.call(input, 'parentId'));
    for (const [field, item] of Object.entries(input)) {
      if (/sample|(?:^|_)title(?:s)?$|password|secret|token|authorization|credentials|cookie|^(?:bookmarkTree|rawTree|username|user)$/i.test(field)) continue;
      if (field === 'bucketTitle' || field === 'rootChildTitles') continue;
      if (field === 'bookmarks' && typeof item === 'object') continue;
      if (bookmark && field === 'url') continue;
      const errors = errorContext || /error|exception|stack/i.test(field) || (field === 'message' && ('error' in input || input.ok === false || input.success === false));
      result[field] = visit(item, field, errors);
    }
    return result;
  };
  return visit(value, '', false);
}

/** 保留可分类的宿主错误，未知外部错误不复制到可分享报告。 */
function diagnosticErrorText(error) {
  const text = String((error && error.message) || error || '');
  if (/not implemented/i.test(text)) return 'Not implemented';
  if (/receiving end does not exist/i.test(text)) return 'Receiving end does not exist';
  if (/permission|denied/i.test(text)) return 'Permission denied';
  if (/timeout|timed out/i.test(text)) return 'Timeout';
  return '[redacted error]';
}

/**
 * 书签路径归一化（统一规则：/ 开头、无尾部 /，非法字符抛错）
 */
function normalizeBookmarkPath(raw) {
  let p = (raw || '').trim().replace(/\\/g, '/');
  if (!p || p === '/') return '';
  if (!p.startsWith('/')) p = '/' + p;
  if (/[<>:"|?*\\]/.test(p) || /\/\//.test(p)) {
    throw new Error('路径不能包含 < > : " | ? * \\ 或连续斜杠');
  }
  const segments = p.split('/').filter(Boolean);
  for (const seg of segments) {
    if (seg === '.' || seg === '..') throw new Error('路径不能包含 . 或 .. 段');
  }
  return p.replace(/\/+$/, '');
}

function joinWebDAVUrl(baseUrl, path) {
  const base = (baseUrl || '').replace(/\/+$/, '');
  const p = (path || '').replace(/^\/+/, '');
  return base + '/' + p;
}

function getAuthHeader(username, password) {
  const raw = (username || '') + ':' + (password || '');
  // 用 encodeURIComponent → unescape 把任意 UTF-8 字符正确映射为 Latin1 字节串，
  // 再 btoa。这样密码含中文/特殊字符时也能生成与服务器一致的 Basic Auth，
  // 否则 btoa(String.fromCharCode(>255)) 会截断导致服务器返回 401。
  return 'Basic ' + btoa(unescape(encodeURIComponent(raw)));
}

async function ensureWebDAVDir(baseUrl, dirPath, username, password) {
  const segments = (dirPath || '').split('/').filter(Boolean);
  let acc = '';
  for (const seg of segments) {
    acc = acc ? acc + '/' + seg : seg;
    const fullUrl = joinWebDAVUrl(baseUrl, acc);
    try {
      const response = await fetch(fullUrl, {
        method: 'MKCOL',
        headers: { 'Authorization': getAuthHeader(username, password) }
      });
      if (response.status !== 201 && response.status !== 405) {
        console.warn(`[webdav] MKCOL ${acc}: ${response.status}`);
      }
    } catch (e) {
      console.warn(`[webdav] MKCOL 失败 (${acc}):`, e.message);
    }
  }
}

/** 扁平字段存在（包括空串）就优先，只有缺失才回退嵌套配置。 */
function resolveWebDAVConfigData(data) {
  const src = data || {};
  const cfg = src.webdav_config || {};
  const present = key => Object.prototype.hasOwnProperty.call(src, key) && src[key] !== undefined;
  const url = present('webdav_url') ? src.webdav_url : (cfg.url || '');
  const user = present('webdav_user') ? src.webdav_user : (cfg.username || '');
  const password = present('webdav_password') ? src.webdav_password : (cfg.password || '');
  let filename = cfg.filename || DEFAULT_FILENAME;
  const slash = filename.lastIndexOf('/');
  let basename = filename.slice(slash + 1) || DEFAULT_FILENAME;
  if (typeof LEGACY_DEFAULT_FILENAME === 'string' && basename === LEGACY_DEFAULT_FILENAME) basename = DEFAULT_FILENAME;
  let path = slash >= 0 ? filename.slice(0, slash) : '';
  if (present('webdav_bookmark_path')) path = normalizeBookmarkPath(src.webdav_bookmark_path);
  filename = path ? path + '/' + basename : (slash === 0 && !present('webdav_bookmark_path') ? '/' : '') + basename;
  return { url, username: user, user, password, filename };
}

/** Bind a persisted status to the resolved remote target, credentials, and local bucket. */
async function syncStatusConfigKey(data) {
  const config = resolveWebDAVConfigData(data);
  const payload = JSON.stringify({
    url: config.url, username: config.username, password: config.password,
    filename: config.filename, bucketId: String((data && data.bookmark_target_id) || '')
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function webDAVConfigPatch(config) {
  const { url, username, password, filename } = config;
  return {
    webdav_url: url, webdav_user: username, webdav_password: password,
    webdav_bookmark_path: filename.includes('/') ? filename.slice(0, filename.lastIndexOf('/')) : '',
    webdav_config: { url, username, password, filename }
  };
}

async function getWebDAVConfig() {
  const data = await new Promise((resolve, reject) => chrome.storage.local.get([
    'webdav_config', 'webdav_url', 'webdav_user', 'webdav_password', 'webdav_bookmark_path'
  ], result => {
    const error = chrome.runtime && chrome.runtime.lastError;
    if (error) reject(new Error(error.message || String(error)));
    else resolve(result || {});
  }));
  const resolved = resolveWebDAVConfigData(data);
  const patch = webDAVConfigPatch(resolved);
  if (Object.keys(patch).some(key => JSON.stringify(data[key]) !== JSON.stringify(patch[key]))) {
    await new Promise((resolve, reject) => chrome.storage.local.set(patch, () => {
      const error = chrome.runtime && chrome.runtime.lastError;
      if (error) reject(new Error(error.message || String(error)));
      else resolve();
    }));
  }
  // username 为现有 API；user 只为旧调用点兼容保留。
  return resolved;
}

/** 准备一次原子导入：目标/账户改变时不复用缺席的凭据，并暂停自动同步。 */
function prepareConfigImport(config, current) {
  const imported = config || {};
  const before = resolveWebDAVConfigData(current);
  const after = resolveWebDAVConfigData({ ...(current || {}), ...imported });
  const identity = url => {
    try { const u = new URL(url); return u.origin + '|' + u.username + '|' + u.password; }
    catch (_) { return String(url || ''); }
  };
  const identityChanged = identity(before.url) !== identity(after.url) || before.username !== after.username;
  const targetChanged = before.url !== after.url || before.filename !== after.filename || identityChanged;
  const has = key => Object.prototype.hasOwnProperty.call(imported, key);
  const clearedCredentials = [];
  if (identityChanged) {
    if (!has('webdav_user')) { after.username = after.user = ''; clearedCredentials.push('账户'); }
    if (!has('webdav_password')) { after.password = ''; clearedCredentials.push('密码'); }
  }
  const patch = { ...imported, ...webDAVConfigPatch(after) };
  if (targetChanged) patch.sync_enabled = false;
  return {
    patch, identityChanged, targetChanged, clearedCredentials,
    preview: {
      before: { url: redactUrlForLog(before.url), filename: before.filename, account: before.username },
      after: { url: redactUrlForLog(after.url), filename: after.filename, account: after.username }
    }
  };
}

async function getDeviceId() {
  return generateDeviceId();
}

async function getViaPath() {
  const data = await new Promise(resolve => chrome.storage.local.get(['via_folder_path'], resolve));
  return data.via_folder_path || '/Via';
}

// Berry 文件夹路径（设置页 berry_folder_path，默认 /berry）
async function getBerryPath() {
  const data = await new Promise(resolve => chrome.storage.local.get(['berry_folder_path'], resolve));
  return data.berry_folder_path || '/berry';
}

// Aira 文件夹路径（设置页 aira_folder_path，默认 /aira；实际文件为子目录下的 snapshot.json）
async function getAiraPath() {
  const data = await new Promise(resolve => chrome.storage.local.get(['aira_folder_path'], resolve));
  return data.aira_folder_path || '/aira';
}

async function downloadBerryBookmarks() {
  const config = await getWebDAVConfig();
  if (!config.url) return null;
  const berryPath = await getBerryPath();
  const berryUrl = joinWebDAVUrl(config.url, berryPath + '/' + BERRY_FILE);
  const response = await fetch(berryUrl, {
    method: 'GET',
    cache: 'no-store',
    headers: {
      'Authorization': getAuthHeader(config.user, config.password),
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache'
    }
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`读取 Berry 文件失败: ${response.status}`);
  return await response.json();
}

async function uploadBerryBookmarks(data) {
  const config = await getWebDAVConfig();
  if (!config.url) {
    console.warn('[sync] 🍓 Berry 写回失败: WebDAV 未配置 (config.url 为空)');
    return;
  }
  const berryPath = await getBerryPath();
  await ensureWebDAVDir(config.url, berryPath, config.user, config.password);
  const berryUrl = joinWebDAVUrl(config.url, berryPath + '/' + BERRY_FILE);
  const response = await fetch(berryUrl, {
    method: 'PUT',
    headers: {
      'Authorization': getAuthHeader(config.user, config.password),
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(data)
  });
  if (!response.ok) throw new Error(`写入 Berry 文件失败: ${response.status} (${berryUrl})`);
}


// ========== host 权限（WebDAV 域名）==========
//
// ⚠️ 平台约束（Chromium 源码 extensions/browser/api/permissions/permissions_api.cc）：
//   chrome.permissions.request() 有一道硬门 kUserGestureRequiredError ——
//   "This function must be called during a user gesture"。
//   而 runtime.onMessage 派发消息时不携带 user gesture（message_service.cc 的
//   DispatchOnMessage 没有 gesture 参数），因此【从 service worker 里申请权限必然失败】。
//   ⇒ 分工：worker 侧只用 hasHostPermission() 查询（不弹窗、任何上下文都安全）；
//          申请动作 requestHostPermission() 只能由扩展页面在按钮点击里调用。
const PERMISSION_API_TIMEOUT_MS = 15000;

/**
 * 包装回调式的权限 API：读取 chrome.runtime.lastError 把真实报错带出来，并加超时兜底。
 * 旧实现既不读 lastError 也没有超时 —— 任何 API 层失败（例如手势缺失）都会被谎报成
 * 「用户拒绝了授权」，回调压根不触发时还会让界面永久卡在「正在请求…权限」。
 */
function callPermissionApi(invoke) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(payload);
    };
    timer = setTimeout(
      () => finish({ ok: false, error: `权限接口无响应（${PERMISSION_API_TIMEOUT_MS / 1000} 秒超时）` }),
      PERMISSION_API_TIMEOUT_MS
    );
    try {
      invoke((result) => {
        const lastError = (typeof chrome !== 'undefined' && chrome.runtime) ? chrome.runtime.lastError : null;
        if (lastError) finish({ ok: false, error: lastError.message || String(lastError) });
        else finish({ ok: true, result });
      });
    } catch (e) {
      finish({ ok: false, error: (e && e.message) || String(e) });
    }
  });
}

/** WebDAV 地址 → host 权限用的 origin 匹配模式；非法地址返回 null */
function webdavOriginPattern(url) {
  try { return new URL(url).origin + '/*'; }
  catch (_) { return null; }
}

/**
 * 查询是否已拥有该 WebDAV 域名的 host 权限。
 * 只查询、不弹窗、不需要用户手势，因此在 service worker 里调用也安全。
 * @param {string} url - WebDAV 完整 URL
 * @returns {Promise<{ok: boolean, granted?: boolean, origin?: string, error?: string}>}
 */
async function hasHostPermission(url) {
  const origin = webdavOriginPattern(url);
  if (!origin) return { ok: false, code: 'BAD_URL', error: `WebDAV 地址无法解析：${url || '(空)'}` };
  const r = await callPermissionApi((cb) => chrome.permissions.contains({ origins: [origin] }, cb));
  // 两种失败语义必须区分（调用方据此决定「拦下」还是「降级放行」）：
  //   BAD_URL                    —— 地址本身非法，纯输入问题，必须拦；
  //   PERMISSION_API_UNAVAILABLE —— 权限接口本身用不了（宿主没有该 API / 没有弹窗 UI，
  //                                回调永不触发）。这类宿主靠安装清单里的 host 权限放行请求，
  //                                查询失败 ≠ 没权限，不能因此阻断同步。
  if (!r.ok) return { ok: false, code: 'PERMISSION_API_UNAVAILABLE', origin, error: r.error };
  return { ok: true, granted: r.result === true, origin };
}

/**
 * 申请 WebDAV 域名的 host 权限（已授予时 request 会立即 resolve true，无需先查询）。
 * ⚠️ 只能在【扩展页面 + 用户手势】中调用（弹窗或设置页的按钮点击处理器里）。
 *    两个平台的约束不同，实现必须同时满足：
 *    · Chromium：需要 user gesture，从 service worker 调用必然失败；
 *    · Gecko/Firefox：判定的是 windowUtils.isHandlingUserInput，它只在事件处理器
 *      【同步执行期间】为真 —— 因此这里绝不能在 request 之前 await 任何东西
 *      （哪怕一次 await，回到处理器时手势窗口已关闭，直接报
 *      "permissions.request may only be called from a user input handler"）。
 *    所以本函数不是 async：函数体同步跑到 chrome.permissions.request 这一行。
 * @param {string} url - WebDAV 完整 URL
 * @returns {Promise<boolean>} 是否获得权限；失败时抛出带真实原因的 Error
 */
function requestHostPermission(url) {
  const origin = webdavOriginPattern(url);
  if (!origin) return Promise.reject(new Error(`WebDAV 地址无法解析：${url || '(空)'}`));
  return callPermissionApi((cb) => chrome.permissions.request({ origins: [origin] }, cb)).then((r) => {
    if (!r.ok) throw new Error(r.error);
    if (r.result !== true) throw new Error(`未授权访问 ${String(origin).replace(/\/\*$/, '')}`);
    return true;
  });
}

// ====== 页面 → 后台的第二条传输带（手机端宿主的消息管道不可靠时的兜底）======
//
// 背景（手机端实测，2026-10-03）：宿主是 Gecko 系 fork，后台页（MV2 常驻）在跑，
// 但页面对后台 sendMessage 的结果是【空响应】——不是超时、不是 reject，而是
// 「消息送到了、响应值没回来」。这时页面什么都问不到，产品看着就像「后台没运行」。
//
// 兜底原理：MV2 宿主里页面可以用 chrome.runtime.getBackgroundPage() 拿到后台页的
// window，直接调后台挂的 __MiniSyncDispatchDirect（它复用的就是同一个消息处理器）。
// 这条路过的是「同进程对象引用」，不经过宿主的消息管道，所以宿主丢响应也照样能用。
//
// 取舍：正常浏览器（Chrome/Edge/Firefox）上第一条路必定成功，兜底永不触发，
// 行为与改动前逐字节一致；只有「响应为空」或「抛错」时才试兜底。

// 超时政策（每一层都必须比内层更宽松，让内层的结构化结论先到，外层只当安全网）：
//   webdav.testConnection 自身 15s（AbortController）
//   → 后台 checkConfig 外层 20s（fetch 不理会中断时也要作答）
//   → 后台直接分发器 25s
//   → 页面这层直接句柄 30s  ← 必须最大，否则「慢响应」会被我掐断
// ⚠️ 实战教训（2026-10-04 真机实测）：这层原本是 5s（与消息管道同一个值），
//    于是「连接状态」那条真实的 WebDAV 检测（>5s）被掐断，UI 显示成
//    「后台无响应：消息没有回来」——明明后台正在答，只是慢。同类错误第三例。
const BG_SEND_TIMEOUT_MS = 8000;
const BG_DIRECT_TIMEOUT_MS = 30000;

let _sendPatchState = 'not-installed';
let _lastTransport = 'none';
let _lastTransportError = null;

// ====== 传输记录：每条消息走了哪条路、花了多久 ======
// 手机端排查时最需要的一句话就是「这条消息走了哪条路、为什么这么慢」。
// 只留最近若干条，跟着 collectDiagnostics 一起出报告。
const TRANSPORT_LOG_MAX = 12;
let _transportLog = [];
// ★ 一旦确认「消息管道不回话而直连可用」，本页后续消息直接走直连 —— 不再每条都白等一个超时。
//   只在直连真的成功过一次之后才置位，桌面端（管道正常）永远走不到这里。
let _preferDirect = false;
// 消息幂等标签（见 sendMessageToBackground）
let _msgSeq = 0;
const _pageSessionId = Math.random().toString(36).slice(2, 8);

function _logTransport(entry) {
  _transportLog.push(Object.assign({ at: Date.now() }, entry));
  if (_transportLog.length > TRANSPORT_LOG_MAX) {
    _transportLog = _transportLog.slice(-TRANSPORT_LOG_MAX);
  }
}

function getTransportState() {
  return {
    patch: _sendPatchState,
    last: _lastTransport,
    lastError: _lastTransportError,
    preferDirect: _preferDirect,
    recent: _transportLog.slice()
  };
}

/** 复位传输状态（模块级状态会跨用例残留，测试与「换配置重来」都要能清零） */
function resetTransportState() {
  _lastTransport = 'none';
  _lastTransportError = null;
  _preferDirect = false;
  _transportLog = [];
}

/**
 * 取【原始】的 chrome.runtime.sendMessage。
 * 关键：装过兜底补丁后，chrome.runtime.sendMessage 就是包装函数本身，
 * 若 helper 再调它就会「自己兜自己」无限递归（实测直接爆栈 RangeError）。
 * 所以一律经这里取原函数 —— 打过补丁就从 __minisyncOrig 取回。
 * @returns {Function|null}
 */
function rawSendMessage() {
  const api = (typeof chrome !== 'undefined' && chrome.runtime) ? chrome.runtime : null;
  if (!api || typeof api.sendMessage !== 'function') return null;
  return api.sendMessage.__minisyncOrig || api.sendMessage;
}

/** 跑一次 sendMessage，把四种结局分开（ok / empty / timeout / error）——「空响应」不等于成功 */
function raceSendMessage(send, message, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ kind: 'timeout' });
    }, timeoutMs);
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
    try {
      Promise.resolve(send(message)).then(
        (v) => finish((v === undefined || v === null) ? { kind: 'empty' } : { kind: 'ok', value: v }),
        (e) => finish({ kind: 'error', error: (e && e.message) || String(e) })
      );
    } catch (e) {
      finish({ kind: 'error', error: (e && e.message) || String(e) });
    }
  });
}

/** 直接句柄：getBackgroundPage() 拿后台 window，调它的直接分发器 */
function callBackgroundDirect(message, timeoutMs) {
  return new Promise((resolve) => {
    if (!(chrome.runtime && typeof chrome.runtime.getBackgroundPage === 'function')) {
      resolve({ ok: false, reason: '本宿主没有 runtime.getBackgroundPage（MV3 用 service worker）' });
      return;
    }
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ ok: false, reason: `直接句柄 ${timeoutMs || BG_DIRECT_TIMEOUT_MS}ms 内没回（后台可能在跑慢操作）` });
    }, timeoutMs || BG_DIRECT_TIMEOUT_MS);
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    try {
      chrome.runtime.getBackgroundPage((w) => {
        const le = chrome.runtime && chrome.runtime.lastError;
        if (le) return finish({ ok: false, reason: 'getBackgroundPage 报错：' + (le.message || String(le)) });
        if (!w) return finish({ ok: false, reason: '后台页不存在（宿主没运行后台页）' });
        if (typeof w.__MiniSyncDispatchDirect !== 'function') {
          return finish({ ok: false, reason: '后台页不是我们这份脚本（没有直接分发器）' });
        }
        Promise.resolve(w.__MiniSyncDispatchDirect(message)).then(
          (v) => finish({ ok: true, value: v === undefined || v === null ? undefined : v }),
          (e) => finish({ ok: false, reason: '直接调用抛异常：' + ((e && e.message) || String(e)) })
        );
      });
    } catch (e) {
      finish({ ok: false, reason: 'getBackgroundPage 抛异常：' + ((e && e.message) || String(e)) });
    }
  });
}

/**
 * 给后台发消息：先走宿主消息管道，拿不到响应就走直接句柄。
 * 返回值语义与原来的 chrome.runtime.sendMessage 对齐：
 *   - 有响应 → 返回响应对象；
 *   - 两条路都没响应 → 返回 undefined（既有调用点会把它显示成「后台无响应」）；
 *   - 消息管道抛错且兜底也失败 → 原样抛出原来的错误（桌面端行为不变）。
 * @param {object} message
 * @param {{timeoutMs?: number, fallback?: boolean, directTimeoutMs?: number, forceMessage?: boolean}} [opts]
 */
async function sendMessageToBackground(message, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || BG_SEND_TIMEOUT_MS;
  const startedAt = Date.now();
  const action = (message && (message.action || message.type)) || '';

  // ★ 幂等标签：管道与直连是【同一条消息的两次投递】，后台按它复用第一次的结果。
  //   没有这个标签，手机端的兜底就等于把同一次同步执行两遍 —— 白等一个超时，还可能
  //   把云端写两遍（并发写同一份文件）。
  //   ⚠️ 每次都重新编号，**不沿用调用方对象上已有的标签**：调用方若复用同一个消息对象
  //   （模块级常量、循环里同一个 msg）连发两次，沿用旧标签会被后台当成「重发」直接回放
  //   上一次的结果 —— 第二次操作静默不执行。同一个逻辑操作内部的两次投递共用本 id。
  if (message && typeof message === 'object') {
    message.__msgId = _pageSessionId + '-' + (++_msgSeq);
  }

  const finish = (path, value) => {
    _logTransport({ action, path, ms: Date.now() - startedAt });
    return value;
  };

  const tryDirect = async () => {
    const d = await callBackgroundDirect(message, o.directTimeoutMs);
    if (d.ok) {
      _lastTransport = 'direct-handle';
      _lastTransportError = null;
      return { ok: true, value: d.value };
    }
    if (d.reason) {
      _lastTransport = 'none';
      _lastTransportError = d.reason;
    }
    return { ok: false };
  };

  // ★ 已经确认「消息管道不回话、直连可用」⇒ 后续消息直接走直连，
  //   不再每条都白等一整个 BG_SEND_TIMEOUT_MS（手机上这就是每次操作多等 8 秒）。
  if (_preferDirect && o.fallback !== false && o.forceMessage !== true) {
    const d = await tryDirect();
    if (d.ok) return finish('direct-handle', d.value);
    // 直连这次也不成 → 退回去试一次管道，行为不比原来差
  }

  const send = rawSendMessage();
  let firstError = null;
  let pipelineLostResponse = false;

  if (send) {
    const r = await raceSendMessage(send, message, timeoutMs);
    if (r.kind === 'ok') {
      _lastTransport = 'message';
      _lastTransportError = null;
      return finish('message', r.value);
    }
    // timeout/empty 都表示「管道把响应丢了」——消息可能已经被执行过（所以下面才需要幂等标签）
    pipelineLostResponse = (r.kind === 'timeout' || r.kind === 'empty');
    if (r.kind === 'error') firstError = new Error(r.error);
  } else {
    firstError = new Error('本页没有 runtime.sendMessage');
  }

  if (o.fallback !== false) {
    const d = await tryDirect();
    if (d.ok) {
      // 管道确实丢响应 + 直连能通 ⇒ 记住结论，本页后续消息不再白等
      if (pipelineLostResponse) _preferDirect = true;
      return finish('direct-handle', d.value);
    }
  }

  if (firstError) {
    _logTransport({ action, path: 'failed', ms: Date.now() - startedAt, err: String(firstError.message || firstError) });
    throw firstError;
  }
  _logTransport({ action, path: 'none', ms: Date.now() - startedAt, err: _lastTransportError });
  return undefined;
}

/**
 * 透明兜底：把 chrome.runtime.sendMessage 包一层，让既有调用点（promise 风格 + callback 风格）
 * 全部自动获得第二条传输带。
 * 只在扩展页面里调用（options.js / popup.js 各调一次）；后台自己不调，避免后台给自己兜底。
 * ⚠️ 赋值是否真的生效要当场核对（宿主可能把 API 属性设成只读），结果记在 _sendPatchState，
 *    并会出现在设置页诊断报告里 —— 静默失效比不生效更糟。
 * @returns {string} 打补丁后的状态
 */
function installSendMessageFallback() {
  try {
    // 保险：万一被后台误调，后台页 getBackgroundPage() 返回的就是它自己，此时不打补丁
    if (typeof window !== 'undefined' && chrome.extension &&
        typeof chrome.extension.getBackgroundPage === 'function' &&
        chrome.extension.getBackgroundPage() === window) {
      _sendPatchState = 'skipped(background-page)';
      return _sendPatchState;
    }
    if (!(chrome.runtime && typeof chrome.runtime.sendMessage === 'function')) {
      _sendPatchState = 'failed(没有 runtime.sendMessage)';
      return _sendPatchState;
    }
    if (chrome.runtime.sendMessage.__minisyncFallback) {
      _sendPatchState = 'already-installed';
      return _sendPatchState;
    }
    const orig = chrome.runtime.sendMessage;
    const wrapped = function (message, a, b) {
      const cb = (typeof a === 'function') ? a : ((typeof b === 'function') ? b : null);
      const p = sendMessageToBackground(message);
      if (cb) {
        // 兼容回调风格（chrome 的回调形式返回 undefined，失败时回调收到 undefined + lastError）
        p.then((v) => cb(v), () => cb(undefined));
        return undefined;
      }
      return p;
    };
    wrapped.__minisyncFallback = true;
    wrapped.__minisyncOrig = orig;
    chrome.runtime.sendMessage = wrapped;
    _sendPatchState = (chrome.runtime.sendMessage === wrapped) ? 'active' : 'failed(赋值未生效)';
    return _sendPatchState;
  } catch (e) {
    _sendPatchState = 'failed(' + ((e && e.message) || String(e)) + ')';
    return _sendPatchState;
  }
}

// ====== 后台响应「说人话」：绝不吞掉真实报错 ======
//
// 背景（真实缺陷）：手机端一次排查里，设置页显示「本地书签数 --（后台未响应）」、弹窗显示
// 「连接失败（SW 未就绪，请重试）」，两句话都像是「后台没运行」，但后台其实在跑 ——
// 真实原因（后台回的是 {success:false, message:'…'}，例如书签接口报错）被页面丢掉了。
// 移动端宿主千奇百怪，把真因藏起来会让人一路往错方向查，所以这里统一：
//   有后台给的原文就显示原文；确实没响应才说「无响应」，并区分开。

/** JSON 化用于展示/日志；循环引用等不可序列化时退回 String()。
 *  ⚠️ 必须在模块作用域：诊断与展示路径都要用，不能只藏在 logger 里（那会让
 *  只有在「出错要显示真因」时才执行到的那一行抛 ReferenceError）。 */
function safeStringify(o) {
  try { return JSON.stringify(o); } catch (_) { return String(o); }
}

/** 把后台对 getLocalBookmarksCount 的响应翻译成一行可读结论（含真因） */
function describeBookmarkCount(resp) {
  if (resp === undefined || resp === null || resp.noResponse === true) {
    return { ok: false, text: '--（后台无响应：消息没有回来，可能后台未运行）' };
  }
  if (resp.code === 'NO_BOOKMARKS_API') {
    return { ok: false, text: '不可用（该浏览器未开放书签 API）' };
  }
  if (resp.count != null) return { ok: true, text: resp.count + ' 条' };
  const why = resp.message || resp.error || resp.code;
  if (why) return { ok: false, text: '--（后台报错：' + why + '）' };
  if (resp.ok) return { ok: false, text: '--（后台回 ok 但没带数量，响应残缺）' };
  return { ok: false, text: '--（后台返回了无法识别的响应：' + safeStringify(resp) + '）' };
}

/** 把后台对连接/同步类请求的响应翻译成一行可读结论（含真因） */
function describeMessageFailure(resp) {
  if (resp === undefined || resp === null) {
    return '后台无响应：消息没有回来（多半是后台未运行或处理器没注册上）';
  }
  const why = resp.message || resp.error || resp.code;
  if (why) return String(why);
  return '后台返回了无法识别的响应：' + safeStringify(resp);
}

/**
 * 同步动作结果 → 状态行（文案 + 颜色级别）。
 * ★ 关键不变量：有写入失败时 resp.success 仍为 true（本地未被改动、故意不触发回滚），
 *   但【绝不能】因此显示成绿色「成功」——手机上「下载成功、书签栏空的」就是这么误导出来的。
 * @param {object} resp 后台返回的 { success, message, code, conflictCount }
 * @param {{successTag?: string, failPrefix?: string}} label 动作文案
 * @returns {{text: string, level: 'ok'|'warn'|'err'}}
 */
function describeActionStatus(resp, label) {
  const l = label || {};
  if (resp && resp.success) {
    const text = resp.message || (resp.partial ? '部分完成，其他端未全部同步' : (l.successTag || '成功'));
    return { text, level: resp.partial ? 'warn' : ((resp.conflictCount > 0) ? 'err' : 'ok') };
  }
  if (resp && resp.code === 'SYNC_BUSY') {
    // 撞上后台自动同步/其他任务占用锁：提示进行中，而非「XX失败」
    return { text: (resp && resp.message) || '同步进行中，请稍候', level: 'err' };
  }
  return { text: (l.failPrefix || '失败：') + ((resp && resp.message) || '未知错误'), level: 'err' };
}

/**
 * 识别「扁平根」宿主：根下没有任何分区文件夹（书签栏/其他书签/移动书签），
 * 全部书签都塞在唯一的一个文件夹里。实测：雨见/Gecko fork 根「雨见的收藏」下
 * 只有一个「根目录」，用户书签全在它里面。
 *
 * ⚠️ 这个文件夹是**宿主的存储容器**，不是用户的数据结构。上传时要把它的内容摊平
 * 写出去、下载时要把同名的云端节点展开，否则「容器套容器」每同步一轮多一层
 * （实测：手机上合并几次后出现 根目录/根目录/根目录，而且回写云端后逐轮加深）。
 *
 * @param {Array} rootChildren chrome.bookmarks.getTree()[0].children
 * @returns {Object|null} 扁平根的那个文件夹节点；有分区或多于一个根子节点时为 null
 */
function detectFlatRootChild(rootChildren) {
  const kids = rootChildren || [];
  const isZoneTitle = (c) => {
    const t = String((c && c.title) || '').toLowerCase();
    return FOLDER_TITLES.bookmarkBar.some(x => x.toLowerCase() === t)
      || FOLDER_TITLES.otherBookmarks.some(x => x.toLowerCase() === t)
      || FOLDER_TITLES.mobileBookmarks.some(x => x.toLowerCase() === t);
  };
  if (kids.some(c => c && !c.url && isZoneTitle(c))) return null;
  if (kids.length !== 1 || kids[0].url) return null;
  return kids[0];
}

// ================================================================
//  同步桶（sync bucket）—— floccus 的 "bookmark folder"
// ================================================================
// 语义：**本机一个文件夹**，它的子节点全集就是同步内容；这个文件夹自身不算内容
// （它是承载容器，不写进云端）。桶以外的任何节点 —— 其他收藏夹里的其它文件夹、
// 移动收藏夹、根下其它文件夹 —— **永不读、永不写、永不删**。
//
// 为什么必须有这个概念：旧模型把「根树三区」（书签栏 + 其他收藏夹 + 移动收藏夹）
// 整体当同步集合，于是用户自己放在 其他收藏夹 的东西被一起备份（用户明确说不要），
// 而为了把「扁平根宿主（手机，根下只有一个容器）」和「标准三区（桌面）」对齐，
// 又发明了 包装透明 / 分区承载 / 跨区移动 三套机器。复杂度全压在「猜这个文件夹
// 到底是不是用户数据」上，猜错一次就漏书签、乱跑、甚至误删（见
// E:/AI/Zcode/tmp/minibm-repro-findings.md 的复现记录）。单桶模型下这些猜测全部消失。
//
// 解析顺序（确定性；任一端算出同一个桶）：
//   ① opts.bucketId 显式指定（设置页下拉选过就固化，用户意图优先级最高）；
//   ② 扁平根宿主（根下唯一文件夹，雨见/可拓）⇒ 那个容器；
//   ③ 云端声明过容器名 X，且某个一级分区下有**直接**子文件夹叫 X ⇒ 那个文件夹
//      （桌面 Edge 现状：其他收藏夹/根目录 就是手机容器在本机的镜像 —— 原地采用，
//       把 268 条书签搬一遍既无必要也有风险）；
//   ④ 书签栏非空 ⇒ 书签栏（标准宿主上用户自己在用的那个）；
//   ⑤ 书签栏（即使为空）—— 标准宿主的默认落点；
//   ⑥ 根下第一个文件夹；都没有 ⇒ null（此时同步会如实报错，不再猜）。
//
// @param {Array} rootChildren chrome.bookmarks.getTree()[0].children
// @param {{bucketId?: string, declaredWrapper?: string}} [opts]
// @returns {{id: string, title: string, kind: 'flat'|'zone'|'folder'}|null}
function resolveSyncBucket(rootChildren, opts) {
  const kids = (rootChildren || []).filter(c => c && !c.url);
  if (kids.length === 0) return null;
  const o = opts || {};
  const zoneOf = (c) => {
    const t = String((c && c.title) || '').toLowerCase();
    if (FOLDER_TITLES.bookmarkBar.some(x => x.toLowerCase() === t)) return 'bar';
    if (FOLDER_TITLES.otherBookmarks.some(x => x.toLowerCase() === t)) return 'other';
    if (FOLDER_TITLES.mobileBookmarks.some(x => x.toLowerCase() === t)) return 'mobile';
    return null;
  };
  const wrap = (node, kind) => (node ? { id: String(node.id), title: String(node.title || ''), kind } : null);
  // 系统分区判定：显式指定的文件夹可能正好是书签栏/其他收藏夹/移动收藏夹 ——
  // 必须如实标成 'zone'，否则 chromeToXbel 会把「书签栏」当成容器名声明进云端元数据，
  // 别端据此把分区顶层的同名文件夹当包装折平（破坏用户数据）。
  const kindOf = (node) => {
    const id = String(node.id);
    if (id === '1' || id === '2' || id === '3') return 'zone';
    return zoneOf(node) ? 'zone' : 'folder';
  };

  // ① 显式指定（全树查找，宿主可能把书签放在更深的文件夹里；用户在下拉里选得到）
  if (o.bucketId != null && String(o.bucketId) !== '') {
    const want = String(o.bucketId);
    let found = null;
    (function find(node) {
      if (!node || found) return;
      if (!node.url && String(node.id) === want) { found = node; return; }
      for (const c of (node.children || [])) find(c);
    })({ children: kids });
    if (found) return wrap(found, kindOf(found));
  }

  // ② 扁平根宿主
  const flat = detectFlatRootChild(rootChildren);
  if (flat) return wrap(flat, 'flat');

  // ③ 云端声明过容器名 X，且某个一级分区下有**直接**子文件夹叫 X ⇒ 那个文件夹
  // （桌面 Edge 现状：其他收藏夹/根目录 就是手机容器在本机的镜像 —— 原地采用，
  //   把 268 条书签搬一遍既无必要也有风险）
  // ★ 顺序在「书签栏非空」之前：这个声明只可能由**别端真实的同步文件夹**写下
  //   （桶恰是系统分区时绝不写，见 xbel.chromeToXbel），比「书签栏恰好有内容」强得多。
  //   先认书签栏的代价是：云端内容被重新导进书签栏，与那层镜像里的同一批书签并存
  //   —— 重复 + 镜像从此不再更新，正是用户报的「书签乱跑」。
  const declared = String(o.declaredWrapper || '').trim();
  if (declared) {
    for (const z of kids) {
      const hit = (z.children || []).find(c => c && !c.url && String(c.title || '') === declared);
      if (hit) return wrap(hit, 'folder');
    }
  }

  // ④ 书签栏非空（标准宿主上用户自己在用的那个）
  const bar = kids.find(c => String(c.id) === '1' || zoneOf(c) === 'bar');
  if (bar && (bar.children || []).length > 0) return wrap(bar, 'zone');

  // ⑤ 书签栏（即使为空）—— 标准宿主的默认落点；
  // ⑥ 根下第一个文件夹；都没有 ⇒ null（此时同步会如实报错，不再猜）。
  if (bar) return wrap(bar, 'zone');
  return wrap(kids[0], 'folder');
}

// ================================================================
//  「扁平根容器名」的公共声明（双向同步的身份单一事实源）
// ================================================================
// 云端 XBEL 的 <flatRootContainer> 元数据记录「写入端那个扁平根容器的名字」。
// 各端靠它把「容器 / 容器套容器 / 云端其他区里的同名包装」统一视为**透明节点**
// （pathKey 不产生路径段），于是同一个书签在手机形态（根目录/学习）与云端/桌面
// 摊平形态（其他收藏夹/学习）下得到同一个指纹 —— 这是双向合并的前提。
//
// 为什么放在模块级：chromeTreeToList / chromeToXbel / xbelToJson 在一次合并流程里
// 被调用 8 次以上，名字一旦各调用点不一致，同一批书签就会被判成两批来回搬。
// 由「解析云端」或「本机结构（扁平根宿主）」一次写入，全流程读同一份。
let _declaredFlatRootContainer = '';

/** 写入声明（云端元数据、本机结构检测都用它）。空值忽略，便于链式兜底。 */
function setDeclaredFlatRootContainer(name) {
  const n = String(name == null ? '' : name).trim();
  if (n) _declaredFlatRootContainer = n;
  return _declaredFlatRootContainer;
}

/** 仅在还没有声明时补写（扁平根宿主本机知道自己的容器名，用来兜住「云端没有元数据」）。 */
function primeDeclaredFlatRootContainer(name) {
  if (!_declaredFlatRootContainer) setDeclaredFlatRootContainer(name);
  return _declaredFlatRootContainer;
}

function getDeclaredFlatRootContainer() { return _declaredFlatRootContainer; }

/** 测试用：清空，避免上一例的声明泄漏到下一例。 */
function resetDeclaredFlatRootContainer() {
  _declaredFlatRootContainer = '';
}

// ================================================================
//  同步桶 id 的公共声明（用户指定优先于一切自动探测）
// ================================================================
// 与 _declaredFlatRootContainer 同理必须放模块级：chromeTreeToList 在一次同步流程里
// 被 merge/快照/诊断多处调用，且拿不到异步的 storage 设置。同步开始前由 orchestrator
// 解析一次设置写进来，全流程读同一份；未设置（空）时 resolveSyncBucket 走结构自动探测。
let _syncBucketId = '';

/** 写入用户指定的同步文件夹 id（空值忽略，便于「未设置」时保持自动探测）。 */
function setSyncBucketId(id) {
  const v = String(id == null ? '' : id).trim();
  if (v) _syncBucketId = v;
  return _syncBucketId;
}

function getSyncBucketId() { return _syncBucketId; }

/** 测试 / 每次同步开始前清空。 */
function resetSyncBucketId() {
  _syncBucketId = '';
}

/**
 * 把书签树摊平成「可选写入位置」列表（floccus 那种「选一个文件夹」）。
 * 全树遍历、不只根下一层：宿主可能把书签放在更深的文件夹里，用户得能选到。
 * 手机端宿主（雨见/Gecko fork）根是扁平的、没有书签栏，只能靠用户指一个位置。
 * @param {Array} tree chrome.bookmarks.getTree 的返回值
 * @returns {Array<{value: string, label: string, path: string, depth: number}>}
 */
function buildTargetOptions(tree) {
  const root = (tree && tree[0]) || null;
  const out = [];
  if (!root) return out;
  const countUrls = (n) => {
    let u = 0;
    (function walk(x) { for (const c of (x.children || [])) { if (c.url) u++; walk(c); } })(n);
    return u;
  };
  (function walk(node, pathParts, depth) {
    for (const c of (node.children || [])) {
      if (!c || c.url) continue; // 只列文件夹（书签本身不能当写入位置）
      const title = c.title || '(无标题)';
      const path = pathParts.concat(title);
      out.push({
        value: String(c.id),
        // 层级用全角空格缩进（设置页的下拉在手机上渲染，缩进比树形控件更稳）
        label: `${'　'.repeat(depth)}${title}（${countUrls(c)} 个书签）`,
        path: path.join(' / '),
        depth
      });
      walk(c, path, depth + 1);
    }
  })(root, [], 0);
  return out;
}

/**
 * 把「存下来的写入位置」翻译成给用户看的一行说明。
 * 关键：位置 id 在书签树里找不到时必须说出来（否则用户会以为设置生效了）。
 * 查找要覆盖整棵树（用户可以选到嵌套文件夹，只在根层找会把正常选择误报成失效）。
 * @param {string} value '' = 自动
 * @param {Array} tree
 */
function describeTargetValue(value, tree) {
  const root = (tree && tree[0]) || null;
  const kids = (root && root.children) || [];
  if (!value) {
    const flat = (kids.length === 1 && !kids[0].url) ? kids[0] : null;
    return {
      value: '',
      label: '自动',
      detail: flat
        ? `自动：本机没有书签栏等分区，将写入根下唯一的文件夹「${flat.title || '(无标题)'}」`
        : '自动：按分区（书签栏/其他书签/移动书签）写入'
    };
  }
  const hit = buildTargetOptions(tree).find(o => o.value === String(value));
  if (!hit) {
    return { value: String(value), missing: true, label: '已失效', detail: `设置的位置（id=${value}）在书签树里找不到，下载会退回自动` };
  }
  return {
    value: String(value),
    label: hit.path,
    path: hit.path,
    detail: hit.depth > 0 ? `下载会写入「${hit.path}」` : `下载会写入「${hit.path}」`
  };
}

/**
 * 一键诊断：逐项探「后台是否在跑 / 宿主给了哪些能力 / 书签接口能不能真读」。
 * 设计给扩展页面调用（设置页按钮），每项都带【原始报错文本】。
 * @param {{bookmarksTimeoutMs?: number, messageTimeoutMs?: number}} [opts]
 * @returns {Promise<object>} 可直接 JSON.stringify 展示的报告
 */
async function collectDiagnostics(opts) {
  const o = opts || {};
  const bms = o.bookmarksTimeoutMs || 5000;
  const mms = o.messageTimeoutMs || 3000;

  const manifest = (chrome.runtime && chrome.runtime.getManifest) ? chrome.runtime.getManifest() : {};
  // 诊断要量的是【原始管道】：页面装过兜底补丁后 sendMessage 已被包装，这里取回原函数，
  // 否则「原始管道到底通不通」就量不出来了（补丁会把结果兜底成成功）。
  const rawSend = rawSendMessage();
  const report = {
    at: new Date().toISOString(),
    ua: (typeof navigator !== 'undefined' && navigator.userAgent) || '(无 navigator)',
    extensionId: (chrome.runtime && chrome.runtime.id) || '(未知)',
    manifestVersion: manifest.manifest_version,
    extensionVersion: manifest.version,
    manifestPermissions: manifest.permissions,
    manifestHostPermissions: manifest.host_permissions || manifest.optional_host_permissions,
    apis: {
      bookmarks: typeof chrome.bookmarks,
      bookmarksGetTree: (chrome.bookmarks && typeof chrome.bookmarks.getTree) || 'undefined',
      bookmarksOnRemoved: (chrome.bookmarks && typeof chrome.bookmarks.onRemoved) || 'undefined',
      permissions: typeof chrome.permissions,
      permissionsRequest: (chrome.permissions && typeof chrome.permissions.request) || 'undefined',
      runtimeSendMessage: (chrome.runtime && typeof chrome.runtime.sendMessage) || 'undefined',
      storageLocal: (chrome.storage && typeof chrome.storage.local) || 'undefined',
      alarms: typeof chrome.alarms,
      // ★ 光看 typeof chrome.alarms === 'object' 是不够的：手机 fork 上出现过
      //   「对象在、方法缺」的半实现，那样自动同步会静默失效而 typeof 依旧报 object。
      //   这一页有扩展权限，直接照后台同一口径探方法面，不用加任何权限。
      alarmsCreate: (chrome.alarms && typeof chrome.alarms.create) || 'undefined',
      alarmsClear: (chrome.alarms && typeof chrome.alarms.clear) || 'undefined',
      alarmsGet: (chrome.alarms && typeof chrome.alarms.get) || 'undefined',
      alarmsGetAll: (chrome.alarms && typeof chrome.alarms.getAll) || 'undefined',
      alarmsOnAlarm: (chrome.alarms && chrome.alarms.onAlarm && typeof chrome.alarms.onAlarm.addListener) || 'undefined',
      importScripts: typeof importScripts,
      action: typeof chrome.action,
      browserAction: typeof chrome.browserAction
    }
  };

  // ① 本页直接读书签（不经过后台）：能把「宿主 API 坏了」和「后台坏了」分开
  report.bookmarksProbe = await new Promise((resolve) => {
    if (!(chrome.bookmarks && typeof chrome.bookmarks.getTree === 'function')) {
      resolve({ ok: false, reason: '本页没有 chrome.bookmarks.getTree' });
      return;
    }
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ ok: false, reason: `chrome.bookmarks.getTree 回调 ${bms}ms 内没回来（宿主没实现）` });
    }, bms);
    try {
      chrome.bookmarks.getTree((tree) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const le = chrome.runtime && chrome.runtime.lastError;
        if (le) return resolve({ ok: false, reason: 'getTree 报错：' + (le.message || String(le)) });
        if (!Array.isArray(tree)) {
          return resolve({ ok: false, reason: 'getTree 回调给的不是数组：' + safeStringify(tree) });
        }
        let count = 0;
        (function walk(n) { if (!n) return; if (n.url) count++; (n.children || []).forEach(walk); })(tree[0]);
        resolve({ ok: true, roots: tree.length, count });
      });
    } catch (e) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: 'getTree 抛异常：' + ((e && e.message) || String(e)) });
    }
  });

  // ② 后台是否应答（ping）—— 响应写法为「同步 sendResponse + return true」
  report.background = await (async () => {
    if (!(chrome.runtime && chrome.runtime.sendMessage)) return { ok: false, reason: '本页没有 runtime.sendMessage' };
    try {
      const r = await Promise.race([
        rawSend({ action: 'ping' }),
        new Promise((res) => setTimeout(() => res('__TIMEOUT__'), mms))
      ]);
      if (r === '__TIMEOUT__') return { ok: false, reason: `ping ${mms}ms 无响应（后台未运行或没注册处理器）` };
      if (!r) return { ok: false, reason: 'ping 返回空（消息没被应答：后台没运行，或宿主把响应丢了）' };
      return { ok: true, response: r };
    } catch (e) {
      return { ok: false, reason: 'ping 抛异常：' + ((e && e.message) || String(e)) };
    }
  })();

  // ②b 对照探针：同样的同步响应，但监听器 return false 收尾。
  // 两个探针结果不同 ⇒ 宿主语义是「返回 false 就丢响应」（这时修法是让处理器 return true）。
  report.backgroundLegacyPing = await (async () => {
    if (!(chrome.runtime && chrome.runtime.sendMessage)) return { ok: false, reason: '本页没有 runtime.sendMessage' };
    try {
      const r = await Promise.race([
        rawSend({ action: 'pingLegacy' }),
        new Promise((res) => setTimeout(() => res('__TIMEOUT__'), mms))
      ]);
      if (r === '__TIMEOUT__') return { ok: false, reason: `pingLegacy ${mms}ms 无响应` };
      if (!r) return { ok: false, reason: 'pingLegacy 返回空（return false 的同步响应被宿主丢弃）' };
      return { ok: true, response: r };
    } catch (e) {
      return { ok: false, reason: 'pingLegacy 抛异常：' + ((e && e.message) || String(e)) };
    }
  })();

  // ③ 后台自述（能看到只有后台才知道的东西：模块加载错误、书签 API 判定…）
  //    ⚠️ 必须把「返回空」也写成对象：返回 undefined 会被 JSON.stringify 整键丢掉，
  //       于是报告里连「后台没答」这个事实都看不见（手机端实测踩过）。
  report.backgroundSelfCheck = await (async () => {
    if (!(chrome.runtime && chrome.runtime.sendMessage)) return { ok: false, reason: '本页没有 runtime.sendMessage' };
    try {
      const r = await Promise.race([
        rawSend({ action: 'diagnose' }),
        new Promise((res) => setTimeout(() => res('__TIMEOUT__'), mms))
      ]);
      if (r === '__TIMEOUT__') return { ok: false, reason: `diagnose ${mms}ms 无响应` };
      if (!r) return { ok: false, reason: 'diagnose 返回空（消息没被应答：后台没运行，或宿主把响应丢了）' };
      return r;
    } catch (e) {
      return { ok: false, reason: 'diagnose 抛异常：' + ((e && e.message) || String(e)) };
    }
  })();

  // ④ 后台页直接句柄（MV2 专属）：完全绕开消息通道。
  //    拿到 window ⇒ 后台页存在；能读到 MiniSync / __MiniSyncSelfCheck ⇒ 后台脚本真跑过。
  //    当消息通道不通时，这是唯一还能问到后台内部状态的路。
  report.backgroundPage = await new Promise((resolve) => {
    if (!(chrome.runtime && typeof chrome.runtime.getBackgroundPage === 'function')) {
      resolve({ ok: false, reason: '本宿主没有 runtime.getBackgroundPage（MV3 用 service worker，取不到直接句柄）' });
      return;
    }
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ ok: false, reason: 'getBackgroundPage 回调 3s 内没回来' });
    }, 3000);
    try {
      chrome.runtime.getBackgroundPage((w) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const le = chrome.runtime && chrome.runtime.lastError;
        if (le) return resolve({ ok: false, reason: 'getBackgroundPage 报错：' + (le.message || String(le)) });
        if (!w) return resolve({ ok: false, reason: '宿主返回空：后台页不存在（后台从未被启动）' });
        let self = null, selfErr = null;
        try { self = (typeof w.__MiniSyncSelfCheck === 'function') ? w.__MiniSyncSelfCheck() : null; }
        catch (e) { selfErr = (e && e.message) || String(e); }
        resolve({
          ok: true,
          url: (w.location && w.location.href) || '',
          hasMiniSync: !!w.MiniSync,
          moduleNames: (w.MiniSync && Object.keys(w.MiniSync)) || null,
          bgErrors: w._bgErrors || null,
          selfCheck: self,
          selfCheckError: selfErr,
          note: self ? '后台页在跑且是我们这份脚本' : '后台页存在，但没有 __MiniSyncSelfCheck（不是我们这份脚本，或脚本加载失败）'
        });
      });
    } catch (e) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: 'getBackgroundPage 抛异常：' + ((e && e.message) || String(e)) });
    }
  });

  // ⑤ 后台台账：后台把「开机登记 + 最近收到的消息」写进了 storage.local，
  //    页面侧直接读（storage 通了就一定有）。台账是空的 ⇒ 后台脚本从未执行过。
  report.backgroundLedger = await (async () => {
    if (!(chrome.storage && chrome.storage.local)) return { ok: false, reason: '本页没有 storage.local' };
    try {
      const led = await new Promise((res) => chrome.storage.local.get(['bg_boot_report', 'bg_last_message'], res));
      const boot = led.bg_boot_report || null;
      const last = led.bg_last_message || null;
      return {
        ok: true,
        bootReport: boot,
        lastMessage: last,
        note: boot
          ? `后台登记过：stage=${boot.stage}，第 ${boot.loads} 次加载，最后更新 ${new Date(boot.at).toISOString()}`
          : '台账为空：storage 里没有 bg_boot_report ⇒ 后台脚本从未执行过（不是「没应答」，是根本没跑）'
      };
    } catch (e) {
      return { ok: false, reason: '读台账失败：' + ((e && e.message) || String(e)) };
    }
  })();

  // ⑤b 自动同步台账：后台每次校准闹钟 / 每次 alarm 触发都会写一份 auto_sync_report。
  //     手机 fork 的消息通道可能整条丢响应（ping/diagnose 全落空），但 storage 是通的
  //     —— 这份台账就是「自动同步到底有没有装上、有没有触发过」唯一还能拿到的证据。
  report.autoSyncReport = await (async () => {
    if (!(chrome.storage && chrome.storage.local)) return { ok: false, reason: '本页没有 storage.local' };
    try {
      const led = await new Promise((res) => chrome.storage.local.get(['auto_sync_report'], res));
      const rep = led.auto_sync_report || null;
      if (!rep) {
        return {
          ok: true,
          report: null,
          note: 'storage 里没有 auto_sync_report ⇒ 这份后台从没跑到过自动同步那段代码（不是「没触发」，是没装上）'
        };
      }
      const al = rep.alarm || {};
      const ageMs = rep.at ? Date.now() - rep.at : null;
      const bits = [
        `syncEnabled=${rep.syncEnabled}`,
        `hasUrl=${rep.hasUrl}`,
        `interval=${rep.interval}min`,
        `alarm.action=${al.action}`,
        `alarm.exists=${al.exists}`,
        al.fireCount ? `触发过 ${al.fireCount} 次（最近 ${al.lastFireAt ? new Date(al.lastFireAt).toISOString() : '?'}）` : '从未触发过'
      ];
      if (ageMs !== null && ageMs >= 0) bits.push(`台账写于 ${Math.round(ageMs / 1000)} 秒前`);
      if (al.lastError) bits.push('最近一次报错：[redacted error]');
      return { ok: true, report: rep, note: bits.join('；') };
    } catch (e) {
      return { ok: false, reason: '读自动同步台账失败：' + ((e && e.message) || String(e)) };
    }
  })();

  // ⑥ 兜底传输带实测：宿主消息管道不回话时，直接句柄这条路能不能把响应拿回来。
  //    这一项直接回答「这台手机能不能同步」——能拿到响应就说明页面驱动得了后台。
  report.sendMessageFallback = await (async () => {
    try {
      const r = await sendMessageToBackground({ action: 'ping' }, { timeoutMs: mms });
      if (r === undefined) return { ok: false, reason: '两条路都没拿到响应' };
      return { ok: true, response: r };
    } catch (e) {
      return { ok: false, reason: '两条路都失败：' + ((e && e.message) || String(e)) };
    }
  })();
  report.transport = getTransportState();

  // ⑦ 上次落盘台账：由 orchestrator（下载）/ sync-merge（合并）在结束时写进 storage.local。
  //    这是「下载成功但书签栏里没有」最关键的一条证据——它记着这次往哪些父节点写了、
  //    有几条写入失败（create 抛错），完全不经过消息通道。
  report.downloadLedger = await (async () => {
    if (!(chrome.storage && chrome.storage.local)) return { ok: false, reason: '本页没有 storage.local' };
    try {
      const led = await new Promise((res) => chrome.storage.local.get(['last_write_report'], res));
      const rep = led.last_write_report || null;
      if (!rep) return { ok: true, report: null, note: '还没有下载/合并过（storage 里没有 last_write_report）' };
      const via = rep.via === 'merge' ? '合并' : '下载';
      return {
        ok: true,
        report: rep,
        note: rep.failedWrites > 0
          ? `上次${via}有 ${rep.failedWrites} 条写入失败`
          : `上次${via}：新增 ${rep.importedCount}，删除 ${rep.removedCount}，零失败`
      };
    } catch (e) {
      return { ok: false, reason: '读落盘台账失败：' + ((e && e.message) || String(e)) };
    }
  })();

  // ⑦ 书签树形态（只读）：本机书签到底长什么样、落盘到底写进了哪个文件夹。
  //    动机（手机实测 2026-10-04）：用户点「下载」显示成功，但书签栏里看不到任何东西。
  //    两种可能必须分开：写错了节点（同步文件夹判定错）/ 宿主压根没落盘（create 静默失败）。
  //    判据＝根节点下每个子节点的 id/标题/顺序/条数：某一支的条数突然变多就是写进去了；
  //    全都没变就是没落盘。同时给出 import.js 的判定口径（utils.resolveSyncBucket）。
  report.bookmarkTreeProbe = await new Promise((resolve) => {
    if (!(chrome.bookmarks && typeof chrome.bookmarks.getTree === 'function')) {
      resolve({ ok: false, reason: '本页没有 chrome.bookmarks.getTree' });
      return;
    }
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ ok: false, reason: `getTree ${bms}ms 内没回来` });
    }, bms);
    try {
      chrome.bookmarks.getTree((tree) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const le = chrome.runtime && chrome.runtime.lastError;
        if (le) return resolve({ ok: false, reason: 'getTree 报错：' + (le.message || String(le)) });
        if (!Array.isArray(tree) || !tree[0]) {
          return resolve({ ok: false, reason: 'getTree 没给根节点：' + safeStringify(tree) });
        }
        const root = tree[0];
        const kids = root.children || [];
        const titles = (typeof FOLDER_TITLES !== 'undefined' && FOLDER_TITLES) || {};
        const titlesAvailable = Object.keys(titles).length > 0;
        const hit = (t, list) => !!(list && list.some(x => String(x).toLowerCase() === String(t || '').toLowerCase()));
        const zone = (list) => {
          const n = kids.find(c => hit(c.title, list));
          return n ? String(n.id) : null;
        };
        const describe = (n, index) => {
          let urls = 0, folders = 0;
          (function walk(x) {
            for (const c of (x.children || [])) {
              if (c.url) urls++;
              else folders++;
              walk(c);
            }
          })(n);
          return { index, id: String(n.id), urlCount: urls, folderCount: folders };
        };
        resolve({
          ok: true,
          rootId: String(root.id),
          childCount: kids.length,
          children: kids.map(describe),
          titlesAvailable,
          zoneByTitle: {
            bar: zone(titles.bookmarkBar),
            other: zone(titles.otherBookmarks),
            mobile: zone(titles.mobileBookmarks)
          },
          zoneByPosition: {
            first: kids[0] ? String(kids[0].id) : null,
            second: kids[1] ? String(kids[1].id) : null,
            third: kids[2] ? String(kids[2].id) : null
          },
          note: titlesAvailable
            ? 'children ＝ 书签界面里的顶层节点；某个节点 urlCount 明显变多 ⇒ 同步写进去了；全都没变 ⇒ 宿主没落盘'
            : '注意：本页没拿到 FOLDER_TITLES（constants.js 没加载？）⇒ zoneByTitle 全 null 不代表标题对不上，这份命中口径不可信'
        });
      });
    } catch (e) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: 'getTree 抛异常：' + ((e && e.message) || String(e)) });
    }
  });

  return sanitizeDiagnosticValue(report);
}

// ====== 统一日志（替代散落的 console.warn/log）======
// 所有模块应使用 MiniSync.logger 而非裸 console，以便集中输出 + 持久化最近错误，
// 让用户在前端「最近操作」里能看到同步失败原因（原本静默 console.warn 用户无感知）。
MiniSync.logger = (function () {
  const MAX_PERSIST = 50;
  const LEVELS = { debug: 0, log: 1, info: 1, warn: 2, error: 3 };

  // 持久化最近日志到 storage.local（仅 warn/error 级别，供前端展示）
  async function persist(level, args) {
    try {
      const now = Date.now();
      const msg = args.map(a => (typeof a === 'string' ? a : safeStringify(a))).join(' ');

      // 融入选项页「操作日志」：复用 sync_log，使用 viewAllLogs 渲染所期望的字段结构
      //    { time, action, type, count, change }，使报错条目与成功同步流水同表展示
      const conflictData = await chrome.storage.local.get(['sync_log']);
      const syncLogs = Array.isArray(conflictData.sync_log) ? conflictData.sync_log : [];
      syncLogs.push({
        time: now,
        action: msg,
        type: level,          // 渲染时显示在「触发」列
        count: '-',
        change: level === 'error' ? 'err' : 'warn'  // 渲染时 .err/.warn 上色
      });
      while (syncLogs.length > MAX_PERSIST) syncLogs.shift();
      await chrome.storage.local.set({ sync_log: syncLogs });
    } catch (_) { /* storage 不可用时静默 */ }
  }

  function emit(level, args) {
    // 使用 install() 时保存的原始 console 函数，避免递归调用自身（否则会栈溢出并吞掉所有日志）
    const fn = console['__orig_' + level] || console[level] || console.log;
    try { fn.apply(console, args); } catch (_) {}
    if (LEVELS[level] >= LEVELS.warn) {
      // 不阻塞主流程，异步持久化
      persist(level, args);
    }
  }

  const api = {
    debug: (...a) => emit('debug', a),
    log:   (...a) => emit('log', a),
    info:  (...a) => emit('info', a),
    warn:  (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
    /** 包装全局 console，使所有散落的 console.warn/error/log 自动走 logger（统一 + 持久化） */
    install() {
      for (const lvl of ['log', 'info', 'warn', 'error', 'debug']) {
        const orig = console[lvl] ? console[lvl].bind(console) : console.log.bind(console);
        console[lvl] = (...a) => emit(lvl, a);
        // 保留原始实现引用，避免重复包装
        if (!console['__orig_' + lvl]) console['__orig_' + lvl] = orig;
      }
    }
  };
  return api;
})();

// ====== 同步互斥器：同一实例同一时刻只允许一个同步流程执行 ======
// 进程内存态；SW 重启后自动清空，陈旧 SYNCING 状态由 storage.getSyncStatus
// 的 5 分钟看门狗兜底释放。与 sync-actions.js 的持久化跨实例锁（sync_lock_at）
// 互补：跨实例靠 storage 锁，同实例排队靠这里（否则锁 TTL 过期后会出现并发）。
MiniSync.syncMutex = (function () {
  let tail = Promise.resolve();
  return {
    run(fn) {
      const task = tail.then(() => fn());
      // 链上吞掉异常，避免某个任务失败后卡死后续排队任务
      tail = task.catch(() => {});
      return task;
    }
  };
})();

// ====== 同时挂载到命名空间 ======
/** URL 归一化（跨端去重用）：小写、去协议头、去 www.、去尾斜杠。
 *  用于 home 区跨端去重：http/https、尾斜杠、www. 的差异不应视为不同书签。 */
function normalizeUrlForDedup(u) {
  return (u || '').toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

// ====== 四区（bar/other/mobile/home）分布统计，供各端日志展示映射结果 ======
/** 判定单个节点归属的四区：优先 source 字段，其次按 parentId 的虚拟容器推断 */
function zoneOf(n) {
  if (!n) return '';
  if (n.source === 'home' || n.parentId === HOME_FOLDER_ID) return 'home';
  if (n.source === 'mobile' || n.parentId === MOBILE_FOLDER_ID) return 'mobile';
  if (n.source === 'other' || n.parentId === OTHER_FOLDER_ID) return 'other';
  if (n.source === 'bar' || n.parentId === ROOT_ID) return 'bar';
  return n.source || '未知';
}

/** 统计扁平列表的四区分布（排除根容器/虚拟容器本身，它们只是挂载点不是数据）。
 *  根容器识别不依赖固定 id（'1'/'2'/'3'）：Edge 等浏览器的「其他收藏夹」根容器
 *  id 可能是任意值（如实测 id=195），按「挂虚拟根 + 标题命中系统名」判定。 */
function countByZone(list) {
  const sysTitles = [
    ...FOLDER_TITLES.bookmarkBar, ...FOLDER_TITLES.otherBookmarks, ...FOLDER_TITLES.mobileBookmarks
  ].map(k => String(k).toLowerCase());
  const c = { bar: 0, other: 0, mobile: 0, home: 0 };
  for (const n of (list || [])) {
    if (!n) continue;
    if (n.id === ROOT_ID || n.id === HOME_FOLDER_ID || n.id === MOBILE_FOLDER_ID || n.id === OTHER_FOLDER_ID) continue;
    if (n.isFolder && ['1', '2', '3'].includes(String(n.id))) continue;
    if (n.isFolder && n.parentId === ROOT_ID && sysTitles.includes((n.title || '').toLowerCase())) continue;
    const z = zoneOf(n);
    if (z in c) c[z]++;
    else c[z] = (c[z] || 0) + 1;
  }
  return c;
}

/** 四区分布的日志片段，如 "[bar:160|other:14|mobile:0|home:8]" */
// 生成四区摘要 [bar:x|other:y|mobile:z|home:w]。
// opts.includeHome=false 时省略 home 区——Aira 快照不存主页（主页直接对齐端上
// shortcuts），其 home 统计恒为 0，打印出来只有噪音。
function zoneSummary(list, opts = {}) {
  const c = countByZone(list);
  if (opts.includeHome === false) return `[bar:${c.bar}|other:${c.other}|mobile:${c.mobile}]`;
  return `[bar:${c.bar}|other:${c.other}|mobile:${c.mobile}|home:${c.home}]`;
}

// 为列表中缺少数字 _index 的节点补序号：排在同父已有节点之后（按出现顺序递增）。
// 桥接新增节点来自端上文件解析（无 _index），不补的话落盘重排会按 _index||0 把
// 它们挪到同父最前。已有合法 _index 的节点（本地树/云端 XBEL 顺序）原样保留。
function fillMissingSiblingIndex(list) {
  const maxByParent = new Map();
  for (const n of list) {
    const key = n.parentId || '__root__';
    if (typeof n._index === 'number') {
      const cur = maxByParent.get(key);
      maxByParent.set(key, cur === undefined ? n._index : Math.max(cur, n._index));
    }
  }
  for (const n of list) {
    if (typeof n._index === 'number') continue;
    const key = n.parentId || '__root__';
    const cur = maxByParent.get(key);
    const next = (cur === undefined ? -1 : cur) + 1;
    n._index = next;
    maxByParent.set(key, next);
  }
  return list;
}

/**
 * 从同步台账（storage.sync_log）里挑出「本次操作」的那一条记录。
 *
 * 手机端（雨见等 Gecko MV2 宿主）会把后台响应丢掉：消息明明送达、后台也执行了，
 * 页面却拿不到回执。这时唯一能如实回答「刚才那次到底成没成」的证据就是后台写的台账。
 * 判据必须两条同时成立：**动作一致** + **时间不早于本次点击**（留一点时钟容差）。
 * 从最新往回扫：第一个动作对上的记录如果时间对不上，说明本次还没写完 —— 返回 null，
 * 绝不能把上一次的结果当成本次的说给用户（那才是真骗人）。
 *
 * @param {Array} logs storage.sync_log
 * @param {string} action 台账里的动作名（'上传'/'下载'/'合并'）
 * @param {number} attemptedAt 本次点击的时间戳
 * @param {number} [slackMs=2000] 时钟容差
 * @returns {{success:boolean,message:string,time:number,fromLedger:true}|null}
 */
function pickSyncLogRecord(logs, action, attemptedAt, slackMs) {
  const list = Array.isArray(logs) ? logs : [];
  const since = Number(attemptedAt || 0) - (typeof slackMs === 'number' ? slackMs : 2000);
  for (let i = list.length - 1; i >= 0; i--) {
    const l = list[i];
    if (!l || l.action !== action) continue;
    if (!l.time || Number(l.time) < since) return null;
    const recovered = { success: !!l.success, message: l.message || '', time: l.time, fromLedger: true };
    for (const key of ['partial', 'conflictCount', 'bridgeResults']) {
      if (Object.prototype.hasOwnProperty.call(l, key)) recovered[key] = l[key];
    }
    return recovered;
  }
  return null;
}

/**
 * 短缓存探测（性能）：同一 key 在 ttlMs 内直接复用上次结果。
 * 手机端每次探测都要走一趟云端，页面初始化/开关切换会重复探同一份文件，重复趟数是纯浪费。
 * @param {number} ttlMs 缓存有效期
 * @param {() => number} [now] 时间源（测试可注入）
 * @returns {{run:(key:string,force:boolean,fn:Function,skipCache?:Function)=>Promise<any>, invalidate:(key?:string)=>void, size:()=>number}}
 */
function createTtlProbe(ttlMs, now) {
  const clock = typeof now === 'function' ? now : Date.now;
  const cache = new Map();
  return {
    async run(key, force, fn, skipCache) {
      const hit = cache.get(key);
      if (!force && hit && (clock() - hit.at) < ttlMs) return hit.value;
      const value = await fn();
      // skipCache(value)===true 的瞬时状态（如「同步进行中」）不进缓存，
      // 否则同步结束后会继续把过期状态显示给用户。
      if (!skipCache || !skipCache(value)) cache.set(key, { at: clock(), value });
      return value;
    },
    invalidate(key) {
      if (key === undefined) cache.clear(); else cache.delete(key);
    },
    size() { return cache.size; }
  };
}

/**
 * 并发合并 + 短缓存的一次性取数：同一时刻的多次调用共用同一条 in-flight Promise。
 * 场景：Berry/Via/Aira 三个开关各自查一次 getEndpoints，实际只需要一条请求。
 * @param {Function} fn 真正的取数函数（返回 Promise）
 * @param {number} ttlMs 命中缓存的有效期
 * @returns {(force?:boolean) => Promise<any>}
 */
function createCoalescedFetcher(fn, ttlMs) {
  let cache = null; // { at:number, promise:Promise }
  return function fetch(force) {
    if (!force && cache && (Date.now() - cache.at) < ttlMs) return cache.promise;
    const promise = Promise.resolve().then(() => fn());
    cache = { at: Date.now(), promise };
    // 失败/空结果不缓存：否则整个 TTL 窗口内每次调用都拿到同一个坏结果
    const drop = (v) => { if (v == null) cache = null; };
    promise.then(drop, () => { cache = null; });
    return promise;
  };
}

/**
 * 「按 key 的短缓存 + 在途合并」探测 —— createTtlProbe 的加强版。
 * 区别：createTtlProbe 只做缓存，同一时刻两次调用会**各发一趟**；这里把在途的 Promise 也复用掉。
 * 场景（弹窗连通性探测）：初始化与 storage.onChanged 可能同时来问同一个问题，
 * 手机端那趟 HTTP 往返很贵，而且用户看到的是「检查结束又要再检查」。
 *
 * 语义：
 *  - ttlMs 内命中缓存 ⇒ 直接给上次结果，不调 fn；
 *  - 同一 key 有在途请求 ⇒ 复用那条 Promise，不调 fn；
 *  - fn 抛错（promise reject）⇒ 不写缓存、不留痕，下次调用重新发起（失败不该被缓存 30 秒）；
 *  - skipCache(value)===true 的瞬时结果（如「同步进行中」）不写缓存；
 *  - 永远返回 Promise（调用方统一 await）。
 * @param {number} ttlMs 缓存有效期
 * @param {() => number} [now] 时间源（测试可注入）
 */
function createCoalescedProbe(ttlMs, now) {
  const clock = typeof now === 'function' ? now : Date.now;
  const cache = new Map();     // key -> { at, value }
  const inflight = new Map();  // key -> Promise
  return {
    run(key, fn, skipCache) {
      const hit = cache.get(key);
      if (hit && (clock() - hit.at) < ttlMs) return Promise.resolve(hit.value);
      const flying = inflight.get(key);
      if (flying) return flying;
      const promise = Promise.resolve().then(() => fn()).then((value) => {
        if (!skipCache || !skipCache(value)) cache.set(key, { at: clock(), value });
        return value;
      });
      inflight.set(key, promise);
      const clear = () => { if (inflight.get(key) === promise) inflight.delete(key); };
      promise.then(clear, clear);
      return promise;
    },
    invalidate(key) {
      if (key === undefined) { cache.clear(); inflight.clear(); }
      else { cache.delete(key); inflight.delete(key); }
    },
    size() { return cache.size; }
  };
}

// ====== 弹窗状态栏：先画一帧，再静默刷新 ======
//
// 真实体验缺陷（用户手机：每次点开插件面板都「一直显示正在检查配置...」）：
//   一次 checkConfig 是后台真连 WebDAV 的一整趟 HTTP 往返（内层 15s / 外层 20s 超时），
//   而弹窗每次打开都是一个新页面 —— 页面里那份 30 秒探测缓存跟着页面一起销毁，
//   于是手机端【每次】打开都要干等一趟网络才把「配置已就绪」画出来。
//   修法：把上次的肯定结论落盘（按「地址|账号|路径」分键）⇒ 打开时立刻按它渲染，
//   探测照旧跑，只是从「挡住界面」变成「静默刷新」。
// 只缓存【肯定】结论：否定结论（连不上/无响应）必须现场确认，落盘一份 30 分钟的
// 「配置未就绪」既容易误导，又会被一次网络抖动固化下来。
const CONN_CACHE_KEY = 'conn_probe_cache';
const CONN_CACHE_MAX_AGE_MS = 30 * 60 * 1000;
const CONN_CHECKING_TEXT = '正在检查配置...';

/**
 * 打开面板时先画什么。
 * @param {{key:string, ok:boolean, at:number}|undefined} cached 落盘的上次结论
 * @param {string} key 本次的配置指纹（地址|账号|路径）
 * @param {number} now
 * @returns {{text:string, level:string, fromCache:boolean}}
 */
function pickConnStatus(cached, key, now) {
  const usable = !!(cached && cached.ok && cached.key === key &&
    Number.isFinite(cached.at) && (now - cached.at) < CONN_CACHE_MAX_AGE_MS);
  if (usable) return { text: '配置已就绪', level: 'ok', fromCache: true };
  return { text: CONN_CHECKING_TEXT, level: '', fromCache: false };
}

/**
 * 这次的探测结论值不值得落盘。
 * 返回 null 的情形都不能缓存：① 没有响应（null/undefined = 宿主把消息丢了，不是「连不上」）；
 * ② 同步进行中（busy 是瞬时态，缓存下来同步结束后还在显示「进行中」）；③ 否定结论（见上）。
 * @returns {{key:string, ok:true, at:number}|null}
 */
function connCacheFromResult(result, key, now) {
  if (!result || result.busy || !result.ok) return null;
  return { key: key, ok: true, at: now };
}

/**
 * 给任意 promise 套一层硬超时，超时返回 { timedOut: true }。
 *
 * 为什么弹窗侧还要单独兜一层：宿主消息管道的最坏形态是「返回一个永不 settle 的 promise」
 * （不是抛错、也不是空响应），那样 `await` 就永远不返回，状态栏会一直停在
 * 「正在检查配置...」——正是用户手机上看到的那句话。后台自己有 20s 上限，这里再兜一层，
 * 保证界面【一定会】给出结论（超时按「没拿到结论」处理，不冒充连不上）。
 * @param {Promise<any>} promise
 * @param {number} ms
 * @returns {Promise<any>}
 */
function raceHardTimeout(promise, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true });
    }, ms);
    Promise.resolve(promise).then(
      (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, error: (e && e.message) || String(e) });
      }
    );
  });
}

/**
 * 配置备份/迁移（导出 → 在另一个浏览器导入）。
 *
 * ★ 只搬「用户配置」，绝不搬「设备身份与同步状态」：
 *   - sync_device_id 必须留在本机（两台设备同 id ⇒ 墓碑的本端/对端判定全错乱）；
 *   - 墓碑/快照/操作日志是同步过程数据，跟着云端走，不该从文件里灌回来；
 *   - bookmark_target_id / sync_bucket_id 引用的是**本机书签节点 id**，换浏览器必然失效。
 *   这些 key 一条都不导出，导入时也一律不认（白名单默认拒绝）。
 *
 * ⚠️ 导出内容含 WebDAV 明文密码：这是「搬配置」的代价，UI 上必须写清楚，
 *    文件也别往公开地方放。
 */
const BACKUP_APP = 'minibookmark-sync';
const BACKUP_KIND = 'config-backup';
const BACKUP_VERSION = 1;

// 自动同步间隔的合法区间（分钟）。UI 只给 15/30/60/120 四档，但导入的备份文件/被手工改过的
// storage 可以塞进任意数值，而它直通 chrome.alarms.create({ periodInMinutes })：
//   负数 → create 抛错（异常被吞，自动同步静默失效）；极小值 → 被浏览器夹到 1 分钟高频轮询。
// 这个区间就是那条防线，范围给得宽（1 分钟 ~ 7 天）以便将来加档位，只负责掐掉不合理的值。
const SYNC_INTERVAL_MIN = 1;
const SYNC_INTERVAL_MAX = 10080;
const SYNC_INTERVAL_DEFAULT = 30;

/**
 * 把任意来源的 sync_interval 收敛成可安全交给 chrome.alarms 的整数分钟。
 *   · 解析不出来（undefined / '' / '半小时'）→ 回默认 30；
 *   · 越界 → 夹到最近的边界（-5 → 1 分钟，1e9 → 10080 分钟）。
 * 这是「storage 里已经躺着坏值」时的最后一道防线（导入路径已在 parseConfigBackup 里
 * 把越界值直接丢掉并报给用户，正常不会走到这里的夹取分支）。
 */
function clampSyncInterval(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return SYNC_INTERVAL_DEFAULT;
  return Math.min(SYNC_INTERVAL_MAX, Math.max(SYNC_INTERVAL_MIN, n));
}

// 允许导出的 key（顺带就是导入时的白名单）：{ key: 类型 }
// 类型文法：string | boolean | url | number | number:min|max | enum:a|b
//   url         —— 非空时必须是 http(s)（与手工输入路径同口径，见 popup.js 的地址校验）
//   number:min|max —— 数值还必须落在区间内，否则当作没这一项（导入时会如实报给用户）
const BACKUP_FIELDS = {
  webdav_url: 'url',
  webdav_user: 'string',
  webdav_password: 'string',
  webdav_bookmark_path: 'string',
  berry_folder_path: 'string',
  via_folder_path: 'string',
  aira_folder_path: 'string',
  option_berry_enabled: 'boolean',
  option_berry_create_file: 'boolean',
  option_via_enabled: 'boolean',
  option_aira_enabled: 'boolean',
  sync_enabled: 'boolean',
  download_clear: 'boolean',
  sync_interval: `number:${SYNC_INTERVAL_MIN}|${SYNC_INTERVAL_MAX}`,
  sync_type: 'enum:merge|upload|download'
};

/** 组装备份对象（纯函数，便于测试与将来扩展） */
function buildConfigBackup(storageData, meta) {
  const src = storageData || {};
  const config = {};
  for (const [key, type] of Object.entries(BACKUP_FIELDS)) {
    const v = coerceBackupValue(src[key], type, false);
    if (v !== undefined) config[key] = v;
  }
  return {
    app: BACKUP_APP,
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exportedAt: new Date((meta && meta.now) || Date.now()).toISOString(),
    manifestVersion: (meta && meta.manifestVersion) || null,
    note: '含 WebDAV 明文密码，请勿公开分享',
    config
  };
}

/** 按类型归一：类型不对就当没这一项（宁缺勿错）
 *  strict=true 用于【导入文件】：只认真正的类型，不做隐式转换（"60" 不是 60）。
 *  strict=false 用于【导出本机 storage】：这里容忍数字字符串，因为下拉框写进去的就是字符串。 */
function coerceBackupValue(value, type, strict) {
  if (value === undefined || value === null) return undefined;
  if (type === 'string') return typeof value === 'string' ? value : undefined;
  if (type === 'url') {
    if (typeof value !== 'string') return undefined;
    if (value.trim() === '') return '';               // 空串＝「本机未配置」，照旧搬过去
    return /^https?:\/\//i.test(value) ? value : undefined; // 非 http(s) 与手工输入口径一致：不接受
  }
  if (type === 'boolean') return typeof value === 'boolean' ? value : undefined;
  if (type === 'number' || type.startsWith('number:')) {
    let n;
    if (typeof value === 'number' && Number.isFinite(value)) n = value;
    else if (strict) return undefined;                // 导入文件：不认数字字符串（"60" 不是 60）
    else {
      const m = Number(value);
      n = (typeof value === 'string' && value.trim() !== '' && Number.isFinite(m)) ? m : undefined;
    }
    if (n === undefined) return undefined;
    if (type.startsWith('number:')) {
      const [lo, hi] = type.slice('number:'.length).split('|').map(Number);
      if (Number.isFinite(lo) && n < lo) return undefined;
      if (Number.isFinite(hi) && n > hi) return undefined;
    }
    return n;
  }
  if (type.startsWith('enum:')) {
    const allowed = type.slice(5).split('|');
    return allowed.includes(value) ? value : undefined;
  }
  return undefined;
}

/**
 * 解析备份文件内容。
 * 默认拒绝：任何不在白名单里的键、类型不符的值一律丢弃；文件本身不像我们的备份就直接报错。
 * @param {string} text 文件内容
 * @returns {{ok:boolean, error?:string, config?:object, meta?:object, dropped?:string[]}}
 */
function parseConfigBackup(text) {
  let doc;
  try {
    doc = JSON.parse(String(text || ''));
  } catch (e) {
    return { ok: false, error: '不是有效的 JSON 文件（' + ((e && e.message) || e) + '）' };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, error: '备份文件格式不对（顶层不是对象）' };
  }
  if (doc.app !== BACKUP_APP || doc.kind !== BACKUP_KIND) {
    return { ok: false, error: '这不像是「极简书签同步」的配置文件' };
  }
  const version = Number(doc.version);
  if (!Number.isFinite(version) || version < 1) {
    return { ok: false, error: '备份文件缺少版本号' };
  }
  if (version > BACKUP_VERSION) {
    return { ok: false, error: `备份文件来自更新的版本（v${version}），请先升级扩展再导入` };
  }
  const raw = (doc.config && typeof doc.config === 'object' && !Array.isArray(doc.config)) ? doc.config : {};
  const config = {};
  const dropped = [];
  for (const key of Object.keys(raw)) {
    if (!Object.prototype.hasOwnProperty.call(BACKUP_FIELDS, key)) { dropped.push(key); continue; }
    const v = coerceBackupValue(raw[key], BACKUP_FIELDS[key], true);
    if (v === undefined) { dropped.push(key); continue; }
    config[key] = v;
  }
  if (Object.keys(config).length === 0) {
    return { ok: false, error: '备份文件里没有任何可识别的配置项', dropped };
  }
  return {
    ok: true,
    config,
    dropped,
    meta: {
      version,
      exportedAt: doc.exportedAt || null,
      manifestVersion: doc.manifestVersion || null
    }
  };
}

MiniSync.utils = {
  normalizeUrlForDedup,
  countByZone,
  zoneSummary,
  fillMissingSiblingIndex,
  generateDeviceId,
  normalizeUrl,
  normalizeBookmarkPath,
  escapeHtml,
  redactUrlForLog,
  sanitizeDiagnosticValue,
  diagnosticErrorText,
  resolveWebDAVConfigData,
  syncStatusConfigKey,
  prepareConfigImport,
  clampSyncInterval,
  SYNC_INTERVAL_MIN,
  SYNC_INTERVAL_MAX,
  SYNC_INTERVAL_DEFAULT,
  joinWebDAVUrl,
  getAuthHeader,
  ensureWebDAVDir,
  getWebDAVConfig,
  getDeviceId,
  getViaPath,
  getBerryPath,
  getAiraPath,
  downloadBerryBookmarks,
  uploadBerryBookmarks,
  requestHostPermission,
  hasHostPermission,
  describeBookmarkCount,
  describeMessageFailure,
  describeActionStatus,
  detectFlatRootChild,
  resolveSyncBucket,
  setSyncBucketId,
  getSyncBucketId,
  resetSyncBucketId,
  setDeclaredFlatRootContainer,
  primeDeclaredFlatRootContainer,
  getDeclaredFlatRootContainer,
  resetDeclaredFlatRootContainer,
  buildTargetOptions,
  describeTargetValue,
  collectDiagnostics,
  // 第二条传输带（宿主消息管道不回话时的兜底）
  sendMessageToBackground,
  installSendMessageFallback,
  getTransportState,
  resetTransportState,
  // 同步台账取证（手机端拿不到回执时如实回答）
  pickSyncLogRecord,
  // 性能：短缓存 + 并发合并（设置页探测用）
  createTtlProbe,
  createCoalescedFetcher,
  // 性能：短缓存 + 在途合并（弹窗连通性探测用：同一时刻只发一趟）
  createCoalescedProbe,
  // 弹窗状态栏的「先画一帧」策略（手机端每次打开都干等一趟 WebDAV 的修复）
  CONN_CACHE_KEY,
  CONN_CACHE_MAX_AGE_MS,
  pickConnStatus,
  connCacheFromResult,
  raceHardTimeout,
  // 配置备份/迁移
  buildConfigBackup,
  parseConfigBackup,
  BACKUP_FIELDS,
  logger: MiniSync.logger
};
