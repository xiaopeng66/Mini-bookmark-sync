// options.js - 设置页面脚本
// 统一全局日志（散落 console 自动走 MiniSync.logger，并持久化最近错误供前端展示）
if (typeof MiniSync !== 'undefined' && MiniSync.logger && MiniSync.logger.install) MiniSync.logger.install();
// 本页的 chrome.runtime.sendMessage 走「消息管道 + 直接句柄」双传输带：
// 手机端 fork 上出现过「消息送到了但响应没回来」，装了兜底后本页所有既有调用点自动受益。
if (typeof MiniSync !== 'undefined' && MiniSync.utils && MiniSync.utils.installSendMessageFallback) {
  MiniSync.utils.installSendMessageFallback();
}
// 运行在 options 页面上下文（非 Service Worker）
// 通过 <script src="lib/constants.js"> 加载，常量在 MiniSync.constants 命名空间中

// ========== 从命名空间读取常量（兼容 fallback）==========
var _C = (typeof MiniSync !== 'undefined' && MiniSync.constants) || {};
var DEVICE_ID_KEY = _C.DEVICE_ID_KEY || 'sync_device_id';
var PLUGIN_FILE = _C.DEFAULT_FILENAME || 'minibookmarks.xbel';
var BERRY_FILE = _C.BERRY_FILE || 'bookmarks.json';
var VIA_FILE = _C.VIA_FILE || 'bookmarks.html';
var AIRA_FILE = _C.AIRA_FILE || 'snapshot.json';

// HTML 转义统一走 lib/utils.js 的单一事实源（外部数据拼进 innerHTML 必须过它）
var esc = function (s) {
  return (typeof MiniSync !== 'undefined' && MiniSync.utils && MiniSync.utils.escapeHtml)
    ? MiniSync.utils.escapeHtml(s)
    : String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
};

// ========== WebDAV 配置读取（统一入口，消除新旧格式兼容逻辑散落三处）==========
// 共享配置解析负责扁平/嵌套一致性及旧默认文件名迁移。
async function readWebDAVConfig() {
  const config = await MiniSync.utils.getWebDAVConfig();
  const filename = config.filename || PLUGIN_FILE;
  const path = filename.includes('/') ? filename.slice(0, filename.lastIndexOf('/')) : '';
  return { url: config.url, user: config.username, pass: config.password, filename, path, configured: !!(config.url && config.username) };
}

// ========== 配置 Keys ==========
const SETTINGS_KEYS = {
  berryEnabled: 'option_berry_enabled',
  berryCreateFile: 'option_berry_create_file',
  airaEnabled: 'option_aira_enabled'
};

// ========== 探测性能：短缓存 + 并发合并 ==========
// 纯逻辑实现放在 lib/utils.js（可单测）；这里只把本页的具体调用绑上去。
//
// ① 云端端点：Berry/Via/Aira 三个开关各查一次 getEndpoints，同一时刻会打出 3 条完全相同的
//    请求。手机端每次请求都要走高延迟链路，重复请求是纯浪费 —— 合并成同一条 Promise，
//    并在 30 秒内复用。
// ② 云端文件状态：页面一打开要探测 6 处（连接 / 主文件 / Berry / Via / Aira×2），开关切换与
//    文件夹改选又会重复探同一份文件。30 秒内复用结果；force=true 用于「用户刚改过配置」
//    这类必须看最新值的场景。「同步进行中」是瞬时状态，不缓存。
const ENDPOINTS_TTL_MS = 30000;
const STATUS_TTL_MS = 30000;

const fetchEndpoints = MiniSync.utils.createCoalescedFetcher(
  () => Promise.resolve(chrome.runtime.sendMessage({ action: 'getEndpoints' }))
    .then((resp) => (resp && resp.ok ? resp : null))
    .catch(() => null),
  ENDPOINTS_TTL_MS
);

const _statusProbe = MiniSync.utils.createTtlProbe(STATUS_TTL_MS);
function cachedProbe(key, force, fn, skipCache) {
  return _statusProbe.run(key, force, fn, skipCache);
}

// 开关工具（云端为权威来源）
function initSwitch(el, storageKey, defaultVal, onChange, endpointKey) {
  if (!el) return;

  // 先用本地值快速渲染，再从云端同步覆盖
  chrome.storage.local.get([storageKey], (r) => {
    const localVal = r[storageKey] !== undefined ? !!r[storageKey] : defaultVal;
    el.classList.toggle('on', localVal);
    if (onChange) onChange(localVal, 'initial');
  });

  // 从云端读取状态并同步回本地，但仅在本地没有用户显式设置时才覆盖。
  // 避免用户手动关闭的开关被云端旧状态重新打开。
  if (endpointKey) {
    // 三个开关共用同一条 getEndpoints（见 fetchEndpoints）
    fetchEndpoints().then((resp) => {
      if (!resp) return;
      const ep = resp.endpoints[endpointKey];
      if (ep && ep.enabled !== undefined) {
        chrome.storage.local.get([storageKey], (lr) => {
          if (lr[storageKey] !== undefined) return; // 本地已有用户选择，以本地为准
          const cloudVal = !!ep.enabled;
          el.classList.toggle('on', cloudVal);
          chrome.storage.local.set({ [storageKey]: cloudVal });
          if (onChange) onChange(cloudVal, 'cloud-sync');
        });
      }
    });
  }

  el.addEventListener('click', () => {
    // Aira 开关：双文件（书签 + 主页）未就绪时禁用，不允许启用
    if (storageKey === 'option_aira_enabled' && el.classList.contains('disabled')) {
      const tag = document.getElementById('airaFileTag');
      if (tag) tag.innerHTML = '<span class="dot"></span>请先在移动端同步一次 Aira 书签后再启用';
      return;
    }
    const isOn = el.classList.toggle('on');
    chrome.storage.local.set({ [storageKey]: isOn });

    // 写入云端（通过 background，供 Berry/Via 设备读取）
    if (endpointKey) {
      chrome.runtime.sendMessage(
        { action: 'setEndpointSwitch', key: endpointKey, enabled: isOn },
        (resp) => {
          if (!resp || !resp.ok) {
            console.error(`[options] 云端开关状态保存失败: ${resp && resp.message || '未知错误'}`);
          }
        }
      );
    }

    if (onChange) onChange(isOn, 'user-click');
  });
}

// ========== 初始化开关 ==========
const berrySwitch = document.getElementById('berrySwitch');
const berrySettings = document.getElementById('berrySettings');

initSwitch(berrySwitch, SETTINGS_KEYS.berryEnabled, false, (isOn, source) => {
  if (!isOn) return;
  // 只在「用户亲手打开开关」时才校验/创建本地「移动端主页」文件夹：
  // 页面初始化与云端状态覆盖这两条路径每次都建，会凭空造出一个空的移动端主页
  // （用户没往主页里放任何东西时，它不该存在）。
  // 注意：校验/创建不会触发同步，需用户手动点上传/下载/合并才会生效。
  if (source !== 'user-click') return;
  chrome.runtime.sendMessage({ action: 'ensureBerryHome' }, (resp) => {
    if (!resp || !resp.ok) {
      console.warn('[options] 校验/创建 Berry主页失败:', resp && resp.error);
    }
  });
  checkBerryFile(true);
}, 'berry');

const viaSwitch = document.getElementById('viaSwitch');
const viaSettings = document.getElementById('viaSettings');

initSwitch(viaSwitch, 'option_via_enabled', false, (isOn, source) => {
  // 页面初始化那条路径由 loadPage 统一探测，这里不重复发请求
  if (isOn && source === 'user-click') checkViaFile(true);
  // 注意：开关只保存配置，不自动触发同步。需用户手动点上传/下载/合并才会生效。
}, 'via');

const airaSwitch = document.getElementById('airaSwitch');
const airaSettings = document.getElementById('airaSettings');

initSwitch(airaSwitch, 'option_aira_enabled', false, (isOn, source) => {
  // 页面初始化那条路径由 loadPage 统一探测（Aira 开关能否启用取决于探测结果，必须探）
  if (isOn && source === 'user-click') checkAiraFile(true);
  // 注意：开关只保存配置，不自动触发同步。需用户手动点上传/下载/合并才会生效。
  // 若 WebDAV 上尚无 Aira 文件，状态区会显示「待初始化：请先在移动端同步一次」，
  // 且 patchAiraFile 会跳过（deviceId 须与移动端一致，移动端强校验），不会自动创建。
}, 'aira');

// 桌面端（Chrome/Edge）自动同步开关
const desktopSwitch = document.getElementById('desktopSwitch');
const desktopSettings = document.getElementById('desktopSettings');

function updateAutoSyncOverview(enabled, interval, type) {
  const el = document.getElementById('autoSync');
  if (!el) return;
  el.classList.remove('ok', 'warn');
  if (enabled) {
    const typeMap = { merge: '合并', upload: '上传', download: '下载' };
    el.textContent = `每 ${interval || 30} 分钟${typeMap[type] || '合并'}`;
    el.classList.add('ok');
  } else {
    el.textContent = '未启用';
    el.classList.add('warn');
  }
}

initSwitch(desktopSwitch, 'sync_enabled', false, (isOn, source) => {
  // 同步概览里的“自动同步”状态
  chrome.storage.local.get(['sync_interval', 'sync_type']).then(r => {
    updateAutoSyncOverview(isOn, r.sync_interval, r.sync_type);
  });
  // 通知后台重建/拆除定时 alarm（启用时不立即同步：统一等间隔到点由 alarm 触发）
  // 'initial' 只是页面用本地值快速渲染，不代表用户改过配置，不必打这一枪
  if (source !== 'initial') chrome.runtime.sendMessage({ action: 'updateSyncInterval' }).catch(() => {});
});

// 监听 storage 变化，保持多页面开关状态一致
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.sync_enabled) {
    const enabled = !!changes.sync_enabled.newValue;
    if (desktopSwitch) desktopSwitch.classList.toggle('on', enabled);
    chrome.storage.local.get(['sync_interval', 'sync_type']).then(r => {
      updateAutoSyncOverview(enabled, r.sync_interval, r.sync_type);
    });
  }
  if (changes.sync_interval || changes.sync_type) {
    chrome.storage.local.get(['sync_enabled', 'sync_interval', 'sync_type']).then(r => {
      updateAutoSyncOverview(!!r.sync_enabled, r.sync_interval, r.sync_type);
    });
  }
});

// ========== 安全设值工具 ==========
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
  return el;
}

/**
 * 带重试的书签数查询（应对后台冷启动）
 * @returns {Promise<{count?: number|null, code?: string}>}
 *   code='NO_BOOKMARKS_API' 表示宿主没向扩展开放书签接口（重试无意义，直接上报）
 */
async function queryBookmarkCountWithRetry(maxRetries = 2) {
  let lastResp;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const resp = await Promise.race([
        chrome.runtime.sendMessage({ action: 'getLocalBookmarksCount' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('超时')), 8000))
      ]);
      lastResp = resp;
      if (resp && resp.code) return { code: resp.code, message: resp.message }; // 宿主未开放书签 API / 书签接口报错
      const count = resp && resp.count;
      if (count != null) return { count };
    } catch (e) {
      // 后台休眠/通道关闭等，静默重试
      lastResp = undefined;
    }
    if (attempt < maxRetries) await new Promise(r => setTimeout(r, 800));
  }
  // 彻底失败：把最后一个响应的原文交给调用方，别再统一说成「后台没响应」
  if (lastResp && (lastResp.message || lastResp.error)) {
    return { code: 'BACKEND_ERROR', message: lastResp.message || lastResp.error };
  }
  // ⚠️ 这里必须用显式哨兵：以前返回 {count:null}，展示层会把它当成
  //    「后台返回了无法识别的响应：{"count":null}」——把我自己的内部值当成后台的回应报给用户，
  //    恰恰掩盖了「消息根本没回来」这个事实。
  return { noResponse: true };
}

// ========== 加载页面数据 ==========
async function loadPage() {
  const r = await chrome.storage.local.get([
    'last_sync_at', DEVICE_ID_KEY, 'sync_enabled', 'sync_interval', 'sync_type'
  ]);

  // --- WebDAV 配置（统一入口，兼容新旧格式并自动迁移）---
  const { url: webdavUrl, user: webdavUser, pass: webdavPass, path: webdavPath, configured } = await readWebDAVConfig();
  setText('webdavType', webdavUrl || '未配置');
  setText('accountInfo', webdavUser || '未配置');
  // 设备 ID：不存在时主动生成
  let deviceId = r[DEVICE_ID_KEY];
  if (!deviceId) {
    try {
      const dResp = await chrome.runtime.sendMessage({ action: 'getDeviceId' });
      if (dResp && dResp.deviceId) {
        deviceId = dResp.deviceId;
        await chrome.storage.local.set({ [DEVICE_ID_KEY]: deviceId });
      }
    } catch (_) { /* SW 未就绪时静默 */ }
  }
  setText('deviceId', deviceId || '未生成');

  // 浏览器支持卡片：有配置才显示
  const browserCard = document.getElementById('browserCard');
  if (browserCard) browserCard.style.display = configured ? '' : 'none';

  // 同步概览：未配置时连接状态/自动同步/操作日志置灰（本地书签数不灰）
  const grayRows = ['connRow', 'autoSyncRow', 'lastActionRow'];
  for (const id of grayRows) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('row-disabled', !configured);
  }

  // 桌面端自动同步开关：未配置时禁止操作，并显示为关闭
  if (desktopSwitch) {
    desktopSwitch.classList.toggle('disabled', !configured);
    if (!configured) desktopSwitch.classList.remove('on');
  }

  // --- 同步概览 ---
  // 本地书签数（后台统计 + 重试）。三种失败要分开显示，否则排查时分不清原因：
  //   NO_BOOKMARKS_API   = 这个浏览器没把书签接口给扩展（换扩展/换浏览器才有解）
  //   BACKEND_ERROR      = 后台回了，但书签接口读失败（把后台给的原文显示出来）
  //   没有响应            = 后台没运行 / 处理器没注册上
  try {
    const bc = await queryBookmarkCountWithRetry();
    const d = MiniSync.utils.describeBookmarkCount(bc);
    setText('localCount', d.text);
  } catch (e) {
    setText('localCount', '--（异常：' + ((e && e.message) || e) + '）');
  }

  // 自动同步
  updateAutoSyncOverview(!!r.sync_enabled, r.sync_interval, r.sync_type);

  // 连接状态 + 云端文件状态 + 最近操作
  // ★ 并发执行：每一步都要往云端走一趟，串行 6 趟在手机上就是 6 个来回；
  //   并发后总耗时约等于最慢的那一趟（探测结果本身有 30 秒缓存，见 cachedProbe）。
  await Promise.all([
    checkConnection(),
    checkCloudStatus(),
    loadLastAction(),
    checkBerryFile(),
    checkViaFile(),
    checkAiraFile()
  ]);

  // 填充桌面端云端文件夹路径
  const chromeFolderEl = document.getElementById('chromeFolder');
  if (chromeFolderEl) {
    chromeFolderEl.textContent = webdavPath || '/minibookmark';
  }
  // Berry/Via/Aira 文件夹路径由各自的 checkXFile 统一设置（含默认路径写回）

  // 应用密码显示/隐藏初始化
  initAppPasswordToggle(webdavPass);
}

// 应用密码显示/隐藏初始化
function initAppPasswordToggle(password) {
  const valueEl = document.getElementById('appPassword');
  const btn = document.getElementById('toggleAppPasswordBtn');
  if (!valueEl || !btn) return;

  const realPassword = password || '';
  let showing = false;

  function update() {
    if (showing) {
      valueEl.textContent = realPassword || '未配置';
      valueEl.style.letterSpacing = '0';
      btn.textContent = '🙈';
      btn.title = '隐藏密码';
    } else {
      valueEl.textContent = realPassword ? '********' : '未配置';
      valueEl.style.letterSpacing = '2px';
      btn.textContent = '👁';
      btn.title = '显示密码';
    }
  }

  btn.addEventListener('click', () => {
    showing = !showing;
    update();
  });

  update();
}

// 连接检测（force=true 跳过 30 秒缓存，用于「刚授权完」「刚改过配置」这类场景）
async function checkConnection(force) {
  const el = document.getElementById('connStatus');
  if (!el) return;
  const grantBtn = document.getElementById('grantPermBtn');
  if (grantBtn) grantBtn.style.display = 'none';
  el.textContent = '检测中...';
  el.className = 'overview-value';

  // WebDAV 配置（统一入口，兼容新旧格式）
  const { url, user, pass, path, configured: cfgOk } = await readWebDAVConfig();
  if (!url || !user) {
    el.textContent = '未配置';
    el.className = 'overview-value warn';
    return;
  }
  try {
    const result = await cachedProbe(
      'conn:' + url + '|' + user, force,
      () => chrome.runtime.sendMessage({
        action: 'checkConfig',
        webdavUrl: url,
        webdavUser: user,
        webdavPassword: pass,
        webdavPath: path
      }),
      // 「同步进行中」是瞬时状态，缓存下来会在同步结束后继续显示「上传进行中...」
      (r) => r && r.busy
    );
    if (result && result.ok) {
      el.textContent = '已连接';
      el.className = 'overview-value ok';
    } else if (result && result.busy) {
      // 同步任务进行中跳过检测：显示对应任务，不报失败
      const BUSY_TEXT = { upload: '上传进行中...', download: '下载进行中...', merge: '合并进行中...' };
      el.textContent = BUSY_TEXT[result.action] || '同步中...';
      el.className = 'overview-value';
    } else if (result && result.code === 'NEED_PERMISSION') {
      // 缺 host 授权。授权只能由扩展页面在用户点击里发起（worker 里申请必然失败），
      // 所以这里不能自动重试，必须把按钮交给用户点。
      connUrlForGrant = url;
      el.textContent = '缺少域名访问授权';
      el.className = 'overview-value warn';
      if (grantBtn) grantBtn.style.display = '';
    } else {
      // 把后台给的原文显示出来（「连接失败」四个字会把真因藏住，排障时最要命）
      el.textContent = MiniSync.utils.describeMessageFailure(result);
      el.className = 'overview-value err';
    }
  } catch (e) {
    el.textContent = '异常: ' + e.message;
    el.className = 'overview-value err';
  }
}

// 待授权的 WebDAV 地址（由 checkConnection 在发现缺权限时填入）
let connUrlForGrant = '';

// 「运行后台诊断」：页面侧自查 + 后台自述，合成一份可直接截图/复制的报告。
// 关键：失败项必须带原始报错文本，不能只写「失败」。
const diagHintDefault = '排查同步问题时点它，把报告复制发出去';

// 一键复制：报告是长 JSON，手机上手选复制非常费劲。
// 两条通道：① navigator.clipboard（桌面 Chromium 一定有；部分手机宿主没有/权限被拒）
//          ② 临时 textarea + execCommand('copy')（不要求安全上下文，手机端最稳）
async function copyPlainText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* 落到 textarea 通道 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-2000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    if (ta.setSelectionRange) ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch (e) {
    return false;
  }
}

document.getElementById('diagCopyBtn')?.addEventListener('click', async () => {
  const out = document.getElementById('diagOut');
  const hint = document.getElementById('diagHint');
  const btn = document.getElementById('diagCopyBtn');
  // 没报告 / 正在诊断时按钮是 disabled 的（真浏览器不会派发 click），这里再拦一道：
  // 不许把「正在诊断…」这种占位文本当报告拷走。
  if (btn && btn.disabled) return;
  const text = (out && out.textContent) || '';
  if (!text.trim()) return;
  const ok = await copyPlainText(text);
  if (hint) {
    hint.className = 'diag-hint ' + (ok ? 'ok' : 'err');
    hint.textContent = ok
      ? '已复制（' + text.length + ' 字），直接粘贴即可'
      : '复制失败：请长按上面的报告手动选择复制';
    if (ok) {
      setTimeout(() => { hint.className = 'diag-hint'; hint.textContent = diagHintDefault; }, 3000);
    }
  }
});

document.getElementById('diagBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('diagBtn');
  const copyBtn = document.getElementById('diagCopyBtn');
  const hint = document.getElementById('diagHint');
  const out = document.getElementById('diagOut');
  if (!btn || !out) return;
  btn.disabled = true;
  if (copyBtn) copyBtn.disabled = true;      // 「正在诊断…」不是报告，别让复制按钮把它拷走
  if (hint) { hint.className = 'diag-hint'; hint.textContent = diagHintDefault; }
  out.style.display = '';
  out.textContent = '正在诊断…（最长约 10 秒）';
  try {
    const report = await MiniSync.utils.collectDiagnostics();
    report.pageSide = { note: '以上为设置页自身探测；backgroundSelfCheck 为后台自述' };
    out.textContent = JSON.stringify(report, null, 2);
  } catch (e) {
    out.textContent = '诊断本身出错：' + MiniSync.utils.diagnosticErrorText(e);
  } finally {
    btn.disabled = false;
    if (copyBtn) copyBtn.disabled = !out.textContent.trim();
  }
});

// 「授权域名访问」按钮：此处运行在设置页（独立标签页）+ 用户点击 ⇒ 具备 user gesture，
// 权限申请才有意义；弹窗/worker 里申请拿不到授权。
document.getElementById('grantPermBtn')?.addEventListener('click', async () => {
  const el = document.getElementById('connStatus');
  const btn = document.getElementById('grantPermBtn');
  if (!connUrlForGrant || !el) return;
  btn.disabled = true;
  el.textContent = '正在请求授权...';
  el.className = 'overview-value';
  try {
    await MiniSync.utils.requestHostPermission(connUrlForGrant);
    connUrlForGrant = '';
    await checkConnection(true); // 刚拿到授权，必须绕开缓存重测
  } catch (e) {
    el.textContent = '授权失败: ' + ((e && e.message) || '未知原因');
    el.className = 'overview-value err';
  } finally {
    btn.disabled = false;
  }
});

// 云端文件状态（通过 background 检测）
async function checkCloudStatus(force) {
  const el = document.getElementById('cloudStatus');
  if (!el) return;
  const { path, filename } = await readWebDAVConfig();
  if (!path) {
    el.classList.remove('on');
    el.innerHTML = '<span class="dot"></span>未配置';
    return;
  }
  const file = filename.slice(filename.lastIndexOf('/') + 1);

  try {
    const result = await cachedProbe(
      'cloud:' + filename, force,
      () => chrome.runtime.sendMessage({ action: 'checkFileExists', path, file }),
      (r) => r && r.busy
    );
    if (result && result.busy) { el.classList.remove('on'); el.innerHTML = '<span class="dot"></span>同步中'; return; }
    if (result && result.exists) {
      el.classList.add('on');
      el.innerHTML = '<span class="dot"></span>正常';
    } else {
      el.classList.remove('on');
      el.innerHTML = '<span class="dot"></span>待初始化';
    }
  } catch (e) {
    el.classList.remove('on');
    el.innerHTML = '<span class="dot"></span>异常';
  }
}

// Berry 文件状态（通过 background 检测）
async function checkBerryFile(force) {
  const tag = document.getElementById('berryFileTag');
  const pathEl = document.getElementById('berryFolderPath');
  if (!tag) return;
  const cfg = await chrome.storage.local.get(['berry_folder_path']);
  const path = normalizeBookmarkPath(cfg.berry_folder_path || '/berry');
  if (!path) return;

  try {
    const result = await cachedProbe(
      'berry:' + path, force,
      () => chrome.runtime.sendMessage({ action: 'checkFileExists', path, file: BERRY_FILE }),
      (r) => r && r.busy
    );
    if (result && result.busy) { tag.classList.remove('on'); tag.innerHTML = '<span class="dot"></span>同步中'; return; }
    if (result && result.exists) {
      tag.classList.add('on');
      tag.innerHTML = '<span class="dot"></span>正常';
      if (pathEl) pathEl.textContent = path;
    } else if (result && !result.folderExists) {
      tag.classList.remove('on');
      tag.innerHTML = '<span class="dot"></span>文件夹不存在';
      if (pathEl) pathEl.textContent = '请先创建或选择 Berry 书签所在文件夹';
    } else {
      tag.classList.remove('on');
      tag.innerHTML = '<span class="dot"></span>待初始化';
      if (pathEl) pathEl.textContent = path;
    }
  } catch (e) {
    tag.classList.remove('on');
    tag.innerHTML = '<span class="dot"></span>检测失败';
  }
}

// Via 文件状态（通过 background 检测）
async function checkViaFile(force) {
  const tag = document.getElementById('viaFileTag');
  const pathEl = document.getElementById('viaFolderPath');
  if (!tag) return;
  const cfg = await chrome.storage.local.get(['via_folder_path']);
  const path = normalizeBookmarkPath(cfg.via_folder_path || '/Via');
  if (!path) return;

  try {
    const result = await cachedProbe(
      'via:' + path, force,
      () => chrome.runtime.sendMessage({ action: 'checkFileExists', path, file: VIA_FILE }),
      (r) => r && r.busy
    );
    if (result && result.exists) {
      tag.classList.add('on');
      tag.innerHTML = '<span class="dot"></span>正常';
      if (pathEl) pathEl.textContent = path;
    } else if (result && !result.folderExists) {
      tag.classList.remove('on');
      tag.innerHTML = '<span class="dot"></span>文件夹不存在';
      if (pathEl) pathEl.textContent = '请先创建或选择 Via 书签所在文件夹';
    } else {
      tag.classList.remove('on');
      tag.innerHTML = '<span class="dot"></span>待初始化';
      if (pathEl) pathEl.textContent = path;
    }
  } catch (e) {
    tag.classList.remove('on');
    tag.innerHTML = '<span class="dot"></span>检测失败';
  }
}

// Aira 文件状态（通过 background 检测，书签 + 主页两个文件独立显示）
async function checkAiraFile(force) {
  const tag = document.getElementById('airaFileTag');       // 书签文件状态
  const persTag = document.getElementById('airaPersTag');  // 主页文件状态
  const pathEl = document.getElementById('airaFolderPath');
  const persPathEl = document.getElementById('airaPersFolderPath');
  const sw = document.getElementById('airaSwitch');
  if (!tag || !persTag) return;
  const cfg = await chrome.storage.local.get(['aira_folder_path']);
  // storage 未存过时，用默认路径并写回；旧值 '/aira' 自动迁移到 'aira/g3/bookmarks'
  let raw = cfg.aira_folder_path || 'aira/g3/bookmarks';
  if (raw === '/aira') raw = 'aira/g3/bookmarks';
  const path = normalizeBookmarkPath(raw);
  if (!path) return;
  if (!cfg.aira_folder_path || cfg.aira_folder_path === '/aira') {
    await chrome.storage.local.set({ aira_folder_path: path.replace(/^\/+/, '') });
  }

  // 主页文件 personalization：aira/g2/personalization（与 aira-adapter.getAiraPersonalizationPath 同算法）
  const segs = path.split('/').filter(Boolean);
  const root = segs.length >= 3 && segs[segs.length - 2] === 'g3' && segs[segs.length - 1] === 'bookmarks'
    ? segs.slice(0, -2).join('/') || 'aira'
    : segs[0] || 'aira';
  const persPath = (path.startsWith('/') ? '/' : '') + root + '/g2/personalization';

  const setAiraDisabled = (disabled) => {
    if (!sw) return;
    if (disabled) sw.classList.add('disabled');
    else sw.classList.remove('disabled');
  };

  try {
    // ★ 两个文件并发探测：第二个 HEAD 原来等第一个回来才发，白等一趟
    const [result, persResult] = await Promise.all([
      cachedProbe(
        'aira:' + path, force,
        () => chrome.runtime.sendMessage({ action: 'checkFileExists', path, file: AIRA_FILE }),
        (r) => r && r.busy
      ),
      cachedProbe(
        'airapers:' + persPath, force,
        () => chrome.runtime.sendMessage({ action: 'checkFileExists', path: persPath, file: 'snapshot.json' }),
        (r) => r && r.busy
      )
    ]);
    // 同步进行中时，保留开关意图，稍后重新探测。
    if ((result && result.busy) || (persResult && persResult.busy)) {
      tag.classList.remove('on');
      tag.innerHTML = '<span class="dot"></span>同步中';
      persTag.classList.remove('on');
      persTag.innerHTML = '<span class="dot"></span>同步中';
      return;
    }
    const bookmarksOk = !!(result && result.exists);
    const persOk = !!(persResult && persResult.exists);

    // 书签文件状态
    if (bookmarksOk) {
      tag.classList.add('on');
      tag.innerHTML = '<span class="dot"></span>正常';
      if (pathEl) pathEl.textContent = path;
      if (persPathEl) persPathEl.textContent = persPath;
    } else if (result && !result.folderExists) {
      tag.classList.remove('on');
      tag.innerHTML = '<span class="dot"></span>文件夹不存在';
      if (pathEl) pathEl.textContent = '请先创建或选择 Aira 书签所在文件夹';
    } else {
      tag.classList.remove('on');
      tag.innerHTML = '<span class="dot"></span>待初始化（请先在移动端同步一次 Aira 书签）';
    }

    // 主页文件状态
    if (persOk) {
      persTag.classList.add('on');
      persTag.innerHTML = '<span class="dot"></span>正常';
    } else {
      persTag.classList.remove('on');
      persTag.innerHTML = '<span class="dot"></span>待初始化（请先在移动端同步一次 Aira 书签）';
    }

    // 可用性只控制是否可点击；不能覆盖用户已保存的启用偏好。
    setAiraDisabled(!(bookmarksOk && persOk));
  } catch (e) {
    tag.classList.remove('on');
    tag.innerHTML = '<span class="dot"></span>检测失败';
    persTag.classList.remove('on');
    persTag.innerHTML = '<span class="dot"></span>检测失败';
    setAiraDisabled(true);
  }
}

// 最近一次操作
async function loadLastAction() {
  const el = document.getElementById('lastActionInfo');
  if (!el) return;
  const r = await chrome.storage.local.get(['sync_log']);
  const logs = r.sync_log || [];
  if (logs.length === 0) {
    el.textContent = '暂无记录';
    return;
  }
  const last = logs[logs.length - 1];
  const d = new Date(last.time);
  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const timeStr = isToday
    ? `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`
    : `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  // logger 捕获条目（type=warn/error）统一显示「操作失败」
  const isLoggerEntry = last.type === 'warn' || last.type === 'error';
  const actionName = isLoggerEntry ? '操作失败' : (last.action || '同步') + '操作';
  // actionName 目前只可能取自固定几个动作名（'上传/下载/合并' + '操作'、'操作失败'），
  // 但它是外部可写 storage（sync_log）里的字段——按「外部数据」对待，照样转义。
  el.innerHTML = `<span class="action-time">${timeStr}</span> <span class="action-name">${esc(actionName)}</span>`;
}

// 日志展开
const logExpand = document.getElementById('logExpand');
const viewAllBtn = document.getElementById('viewAllLogs');
const clearLogsBtn = document.getElementById('clearLogsBtn');

// 复制错误详情（事件委托：日志内容每次重渲染，监听绑容器）
let _copyToastTimer = null;
function showCopyToast(msg) {
  const t = document.getElementById('copyToast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_copyToastTimer);
  _copyToastTimer = setTimeout(() => t.classList.remove('show'), 1500);
}
if (logExpand) {
  logExpand.addEventListener('click', async (e) => {
    const btn = e.target.closest('.copy-btn');
    if (!btn) return;
    const text = btn.getAttribute('data-copy') || '';
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (_) {
      // 降级兜底：clipboard API 不可用时用 execCommand
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0;';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch (_) { ok = false; }
    }
    if (ok) {
      btn.classList.add('copied');
      setTimeout(() => btn.classList.remove('copied'), 1200);
      showCopyToast('已复制错误详情');
    } else {
      showCopyToast('复制失败，请手动选择文本复制');
    }
  });
}

// 清除操作日志
if (clearLogsBtn) {
  clearLogsBtn.addEventListener('click', async () => {
    await chrome.storage.local.remove('sync_log');
    const el = document.getElementById('lastActionInfo');
    if (el) el.textContent = '暂无记录';
    if (logExpand) {
      logExpand.innerHTML = '';
      logExpand.classList.remove('show');
    }
    if (viewAllBtn) viewAllBtn.textContent = '查看全部';
  });
}

if (viewAllBtn) {
  viewAllBtn.addEventListener('click', async () => {
    if (!logExpand) return;
    // toggle 展开/收起
    if (logExpand.classList.contains('show')) {
      logExpand.classList.remove('show');
      viewAllBtn.textContent = '查看全部';
      return;
    }
    const r = await chrome.storage.local.get(['sync_log']);
    const logs = r.sync_log || [];

    if (logs.length === 0) {
      logExpand.innerHTML = '<div class="log-empty">暂无记录</div>';
    } else {
      const recent = logs.slice(-5).reverse();
      logExpand.innerHTML = `<div class="log-header"><span>操作时间</span><span>执行动作</span><span>执行类型</span><span>书签数量</span><span>书签变化</span></div>` +
        recent.map(log => {
        const d = new Date(log.time);
        const pad = n => String(n).padStart(2, '0');
        const time = `${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        // 日志条目两类：
        //   结构化同步记录：{ action:'上传/下载/合并', success, message, trigger }
        //   logger 捕获：    { action:<日志全文>, type:'warn'|'error', count:'-', change:'warn'/'err' }
        // 失败类（logger 捕获 / success=false）统一显示「操作失败」：
        // 错误内容放「书签变化」列（截断+悬浮），行尾复制按钮可复制完整详情；成功条目无按钮。
        const isLogger = log.type === 'warn' || log.type === 'error';
        let action, count = '--', change = '--', changeClass = '', lvl = '', tooltip = '', isFailure = false;
        if (isLogger) {
          action = '操作失败';
          tooltip = log.action || '';
          lvl = 'lvl-err';
          change = log.action || '--';
          changeClass = 'err';
          isFailure = true;
        } else if (log.success === false) {
          action = '操作失败';
          tooltip = log.message || '';
          change = log.message || '--';
          changeClass = 'err';
          lvl = 'lvl-err';
          isFailure = true;
        } else {
          action = (log.action || '同步') + '操作';
          if (log.message) {
            const m = log.message.match(/^(\d+)\s*条/);
            if (m) count = m[1] + ' 条';
            const c = log.message.match(/\(([+-]\d+)\)/);
            if (c) change = c[1];
          }
          changeClass = change === '--' ? '' : change.startsWith('+') ? 'ok' : change.startsWith('-') ? 'err' : '';
          if (change === '--') change = '无变化';
        }
        const triggerText = isFailure ? '--' : (log.trigger || '手动');
        const copyBtn = isFailure && tooltip
          ? `<svg class="copy-btn" data-copy="${esc(tooltip)}" viewBox="0 0 16 16" width="12" height="12" title="复制错误详情"><rect x="5" y="5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`
          : '';
        return `<div class="log-item ${lvl}">
          <span class="log-time">${time}</span>
          <span class="log-action">${esc(action)}</span>
          <span class="log-trigger">${esc(triggerText)}</span>
          <span class="log-count">${esc(count)}</span>
          <span class="log-change ${changeClass}" title="${isFailure ? esc(tooltip) : ''}">${isFailure ? `<span class="log-err-text">${esc(change)}</span>` : esc(change)}${copyBtn}</span>
        </div>`;
      }).join('');
    }
    logExpand.classList.add('show');
    viewAllBtn.textContent = '收起';
  });
}

// 通用：列出 WebDAV 根目录下的文件夹（通过 background）
async function listWebDAVFolders() {
  try {
    const { url, user, pass } = await readWebDAVConfig();
    if (!url || !user) return [];

    // background.js 的 listFolders 直接返回字符串数组
    const result = await chrome.runtime.sendMessage({
      action: 'listFolders',
      webdavUrl: url,
      webdavUser: user,
      webdavPassword: pass
    });
    // 兼容两种返回格式
    if (Array.isArray(result)) return result;
    return (result && result.folders) || [];
  } catch (e) {
    console.error('[options] 列出文件夹失败:', e.message);
    return [];
  }
}

// 通用：文件夹选择器初始化
function initFolderPicker(opts) {
  const { pathEl, selectWrap, selectEl, btn, storageKey, defaultPath, fileConst, checkFn, disabled } = opts;
  if (!pathEl || !selectWrap || !selectEl || !btn) return;
  if (disabled) { btn.disabled = true; return; }

  let picking = false;

  btn.addEventListener('click', async () => {
    if (!picking) {
      // 进入选择模式：列出文件夹填充 select
      picking = true;
      btn.textContent = '加载中...';
      const folders = await listWebDAVFolders();
      selectEl.innerHTML = '';
      if (folders.length === 0) {
        selectEl.innerHTML = '<option value="">无可用文件夹</option>';
      } else {
        const current = pathEl.textContent;
        for (const f of folders) {
          const opt = document.createElement('option');
          opt.value = f;
          opt.textContent = f;
          if (f === current) opt.selected = true;
          selectEl.appendChild(opt);
        }
      }
      pathEl.style.display = 'none';
      selectWrap.classList.add('show');
      btn.textContent = '确定';
      btn.classList.add('save');
    } else {
      // 确定：保存选择
      picking = false;
      const val = selectEl.value;
      selectWrap.classList.remove('show');
      pathEl.style.display = 'inline';
      btn.textContent = '修改';
      btn.classList.remove('save');

      if (storageKey === 'webdav_bookmark_path') {
        const current = await MiniSync.utils.getWebDAVConfig();
        const filename = current.filename.slice(current.filename.lastIndexOf('/') + 1) || PLUGIN_FILE;
        const folder = val ? normalizeBookmarkPath(val) : '';
        await chrome.storage.local.set({
          webdav_bookmark_path: folder,
          webdav_config: {
            url: current.url, username: current.username, password: current.password,
            filename: folder ? folder + '/' + filename : filename
          }
        });
        pathEl.textContent = folder || defaultPath;
      } else if (val) {
        pathEl.textContent = val;
        await chrome.storage.local.set({ [storageKey]: val });
      } else {
        await chrome.storage.local.remove(storageKey);
        pathEl.textContent = defaultPath;
      }

      // 同步写入云端 endpoints 的 folder（仅 Berry/Via 需要）
      if (fileConst) {
        try {
          const key = storageKey.replace('_folder_path', '');
          await chrome.runtime.sendMessage({ action: 'setEndpointFolder', key, folder: val || null, file: fileConst });
        } catch (e) {
          console.error(`[options] 写入 endpoints 失败:`, e.message);
        }
      }

      if (checkFn) checkFn(true); // 刚改过文件夹，必须看最新状态（跳过 30 秒缓存）
    }
  });
}

// ========== Berry 文件夹选择器 ==========
initFolderPicker({
  pathEl: document.getElementById('berryFolderPath'),
  selectWrap: document.getElementById('berryFolderSelect'),
  selectEl: document.getElementById('berryFolderOptions'),
  btn: document.getElementById('berryFolderBtn'),
  storageKey: 'berry_folder_path',
  defaultPath: '/berry',
  fileConst: BERRY_FILE,
  checkFn: checkBerryFile
});

// ========== Via 文件夹选择器 ==========
initFolderPicker({
  pathEl: document.getElementById('viaFolderPath'),
  selectWrap: document.getElementById('viaFolderSelect'),
  selectEl: document.getElementById('viaFolderOptions'),
  btn: document.getElementById('viaFolderBtn'),
  storageKey: 'via_folder_path',
  defaultPath: '/Via',
  fileConst: VIA_FILE,
  checkFn: checkViaFile
});
// ========== Aira 文件夹为写死路径（aira/g3/bookmarks 与 aira/g2/personalization 联动），无需文件夹选择器 ==========
// ========== 桌面端（Chrome/Edge）文件夹选择器 ==========
initFolderPicker({
  pathEl: document.getElementById('chromeFolder'),
  selectWrap: document.getElementById('chromeFolderSelect'),
  selectEl: document.getElementById('chromeFolderOptions'),
  btn: document.getElementById('chromeFolderBtn'),
  storageKey: 'webdav_bookmark_path',
  defaultPath: '/minibookmark',
  checkFn: checkCloudStatus
});

// ========== 下载写入位置（扁平根宿主必需：宿主根下没有书签栏时按标题匹配必然失败） ==========
async function initBookmarkTargetPicker() {
  const sel = document.getElementById('targetSelect');
  const hint = document.getElementById('targetHint');
  if (!sel || !hint) return;
  const readTree = () => new Promise((res) => {
    if (!(chrome.bookmarks && typeof chrome.bookmarks.getTree === 'function')) return res([]);
    try { chrome.bookmarks.getTree((t) => res(Array.isArray(t) ? t : [])); }
    catch (e) { res([]); }
  });
  const render = async () => {
    const tree = await readTree();
    const stored = (await chrome.storage.local.get(['bookmark_target_id'])).bookmark_target_id || '';
    const opts = MiniSync.utils.buildTargetOptions(tree);
    sel.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = '自动';
    sel.appendChild(auto);
    for (const o of opts) {
      const el = document.createElement('option');
      el.value = o.value;
      el.textContent = o.label;
      sel.appendChild(el);
    }
    // 存下来的位置若已不在书签树里，下拉里补一个选项，避免浏览器把 value 清成空（静默变成"自动"）
    if (stored && !opts.some(o => o.value === String(stored))) {
      const stale = document.createElement('option');
      stale.value = String(stored);
      stale.textContent = `（已失效：${stored}）`;
      sel.appendChild(stale);
    }
    sel.value = stored;
    const d = MiniSync.utils.describeTargetValue(stored, tree);
    hint.textContent = d.detail;
    hint.style.color = d.missing ? '#dc2626' : '#9ca3af';
  };
  sel.addEventListener('change', async () => {
    await chrome.storage.local.set({ bookmark_target_id: sel.value || '' });
    await render();
  });
  await render();
}

// 「下载重建」开关：下载前先清空本地书签，再按云端重建。
// 默认关闭 —— 破坏性操作不替用户决定；扁平根宿主上它也是清理「同名容器层层嵌套」的手段。
let clearHintOffText = null;   // HTML 里那段「关闭时…」文案，只取一次（重入时别再取到开启态文案）
async function initDownloadClearToggle() {
  const box = document.getElementById('clearCheckbox');
  const hint = document.getElementById('clearHint');
  if (!box || !hint) return;
  const stored = (await chrome.storage.local.get(['download_clear'])).download_clear;
  box.checked = !!stored;
  // 「关闭」那一段以 options.html 的静态文案为唯一来源（先读下来再交给 paint）。
  // 两处各写一份时 HTML 改了说法而 JS 没跟上，加载时的 paint() 反而把过期说法盖回去。
  if (clearHintOffText === null) clearHintOffText = hint.textContent;
  const offText = clearHintOffText;
  const paint = () => {
    hint.textContent = box.checked
      ? '开启：每次下载都会先清空本地书签再按云端重建（手机上手动加的书签也会被清掉）。'
      : offText;
    hint.style.color = box.checked ? '#dc2626' : '#9ca3af';
  };
  paint();
  box.addEventListener('change', async () => {
    await chrome.storage.local.set({ download_clear: !!box.checked });
    paint();
  });
}

// ========== 配置备份 / 迁移 ==========
// 导出：把「用户配置」写成一个 JSON 文件；导入：校验后覆盖本机同名配置。
// 白名单在 lib/utils.js 的 BACKUP_FIELDS（导出用它取键、导入用它过滤），单一事实源。
function setBackupResult(text, level) {
  const el = document.getElementById('backupResult');
  if (!el) return;
  el.style.display = text ? '' : 'none';
  el.className = 'backup-result' + (level ? ' ' + level : '');
  el.textContent = text || '';
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

document.getElementById('exportConfigBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('exportConfigBtn');
  if (!btn) return;
  btn.disabled = true;
  setBackupResult('');
  try {
    const keys = Object.keys(MiniSync.utils.BACKUP_FIELDS);
    const data = await chrome.storage.local.get(keys);
    const manifestVersion = (chrome.runtime.getManifest ? chrome.runtime.getManifest().version : null);
    const backup = MiniSync.utils.buildConfigBackup(data, { manifestVersion });
    const n = Object.keys(backup.config).length;
    // 本卡现在未配置也能看到 ⇒ 先拦掉「导出 0 项」那种空文件（建卡时此路径不可达，独立成卡后才出现）
    if (n === 0) {
      setBackupResult('本机还没有可导出的配置：先把 WebDAV 地址和账号填上，再来导出。', '');
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    downloadTextFile('minibookmark-sync-config-' + stamp + '.json', JSON.stringify(backup, null, 2));
    setBackupResult('已导出 ' + n + ' 项配置。在别的浏览器打开本页 → 「导入配置」选这个文件即可（文件含密码，注意保管）。', 'ok');
  } catch (e) {
    setBackupResult('导出失败：' + ((e && e.message) || e), 'err');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('importConfigBtn')?.addEventListener('click', () => {
  const file = document.getElementById('importConfigFile');
  if (!file) return;
  file.value = ''; // 允许连续导入同一个文件
  file.click();
});

document.getElementById('importConfigFile')?.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  setBackupResult('');
  let text = '';
  try {
    text = await file.text();
  } catch (err) {
    setBackupResult('读取文件失败：' + ((err && err.message) || err), 'err');
    return;
  }
  const parsed = MiniSync.utils.parseConfigBackup(text);
  if (!parsed.ok) {
    setBackupResult('导入失败：' + parsed.error, 'err');
    return;
  }
  const current = await chrome.storage.local.get(
    ['webdav_config', 'webdav_url', 'webdav_user', 'webdav_password', 'webdav_bookmark_path', 'sync_enabled']
  );
  let prepared;
  try { prepared = MiniSync.utils.prepareConfigImport(parsed.config, current); }
  catch (err) {
    setBackupResult('导入失败：' + ((err && err.message) || err), 'err');
    return;
  }
  const keys = Object.keys(parsed.config);
  const preview = keys.map(k => '· ' + k).join('\n');
  const target = prepared.preview;
  const targetPreview = '\n\n当前目标：' + target.before.url + ' / ' + target.before.filename + '（账户：' + (target.before.account || '未设置') + '）' +
    '\n导入后目标：' + target.after.url + ' / ' + target.after.filename + '（账户：' + (target.after.account || '未设置') + '）' +
    (prepared.identityChanged ? '\n目标或账户变更：备份中未提供的凭据/密码将清空。' : '') +
    (prepared.targetChanged ? '\n自动同步将暂停，检查目标和凭据后请手动启用。' : '');
  const droppedNote = (parsed.dropped && parsed.dropped.length)
    ? '\n\n已忽略 ' + parsed.dropped.length + ' 项不认识的设置：' + parsed.dropped.join('、')
    : '';
  const ok = window.confirm(
    '导入这份配置？\n\n' +
    '来自：v' + (parsed.meta.manifestVersion || '?') + '（导出于 ' + (parsed.meta.exportedAt || '未知时间') + '）\n' +
    '将覆盖本机以下 ' + keys.length + ' 项配置：\n' + preview + targetPreview + droppedNote +
    '\n\n书签数据和本机设备身份不受影响。'
  );
  if (!ok) {
    setBackupResult('已取消导入。', '');
    return;
  }
  try {
    await chrome.storage.local.set(prepared.patch);
    // 自动同步开关/间隔可能变了 ⇒ 让后台重建定时器
    chrome.runtime.sendMessage({ action: 'updateSyncInterval' }).catch(() => {});
    setBackupResult('导入成功，正在刷新页面…', 'ok');
    setTimeout(() => { try { location.reload(); } catch (_) { /* 刷新失败也要留住成功提示 */ } }, 900);
  } catch (err) {
    setBackupResult('写入配置失败：' + ((err && err.message) || err), 'err');
  }
});

// ========== 版本更新 ==========
// 检查、展示并缓存结果；下载链接由浏览器直接导航。
const updateHintDefault = '点「检查更新」查询发布页有没有新版本';
const UPDATE_CHECK_KEY = 'update_last_check';
let updateGeneration = 0;

function updateManifest() {
  try {
    return (chrome.runtime && chrome.runtime.getManifest) ? (chrome.runtime.getManifest() || {}) : {};
  } catch (_) {
    return {};
  }
}

function updateCardEls() {
  return {
    cur: document.getElementById('updateCurrent'),
    btn: document.getElementById('updateCheckBtn'),
    dl: document.getElementById('updateDownloadBtn'),
    hint: document.getElementById('updateHint'),
    detail: document.getElementById('updateDetail'),
    relRow: document.getElementById('updateReleaseRow'),
    rel: document.getElementById('updateReleaseLink')
  };
}

function updateVersionLine() {
  const manifest = updateManifest();
  const variant = MiniSync.update.selectHostVariant(manifest);
  return 'v' + (manifest.version || '未知') + '（' + MiniSync.update.variantText(variant) + '）';
}

function updateTimeText(ts) {
  const d = new Date(ts || Date.now());
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** 把检查结果画到卡片上；note 是额外一行（上次检查时间这类） */
function renderUpdateResult(result, note) {
  const els = updateCardEls();
  if (!els.hint || !els.detail) return;
  const view = MiniSync.update.describeUpdate(result);
  // 结论上色：失败红、成功绿、进行中灰 —— 与诊断卡同一套语义
  els.hint.className = 'diag-hint ' + (view.tone === 'err' ? 'err' : (view.tone === 'ok' ? 'ok' : ''));
  els.hint.textContent = MiniSync.update.updateStatusText(result);
  const lines = [];
  if (view.headline) lines.push('<b>' + MiniSync.utils.escapeHtml(view.headline) + '</b>');
  if (view.detail) lines.push(MiniSync.utils.escapeHtml(view.detail));
  if (note) lines.push('<span style="color:#9ca3af;">' + MiniSync.utils.escapeHtml(note) + '</span>');
  els.detail.innerHTML = lines.join('<br>');
  els.detail.style.display = lines.length ? '' : 'none';
  const updateDownloadUrl = (view.download && view.download.url) || '';
  if (els.dl) {
    if (updateDownloadUrl) {
      els.dl.href = updateDownloadUrl;
      els.dl.textContent = view.download.label;
      els.dl.style.display = '';
    } else {
      els.dl.style.display = 'none';
      els.dl.removeAttribute('href');
    }
  }
  if (els.relRow && els.rel) {
    if (view.link) {
      els.rel.href = view.link.url;
      els.rel.textContent = view.link.label;
      els.relRow.style.display = '';
    } else {
      els.relRow.style.display = 'none';
    }
  }
}

// 在 click 的同步调用栈申请可选权限；已有 required host 的构建包无需申请。
function requestUpdatePermissions(manifest) {
  const hosts = (manifest.host_permissions || []).concat(manifest.permissions || []);
  const origins = ['https://api.github.com/*', 'https://github.com/*'].filter((origin) => {
    const host = origin.slice('https://'.length, -2);
    return !hosts.some((pattern) => pattern === '<all_urls>' || pattern === '*://*/*'
      || pattern === 'https://*/*' || pattern === origin || pattern === '*://' + host + '/*');
  });
  if (!origins.length || !chrome.permissions || typeof chrome.permissions.request !== 'function') return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    try {
      const pending = chrome.permissions.request({ origins }, (granted) => {
        const error = chrome.runtime && chrome.runtime.lastError;
        if (error) reject(new Error(error.message || String(error)));
        else resolve(granted === true);
      });
      if (pending && typeof pending.then === 'function') pending.then((granted) => resolve(granted === true), reject);
    } catch (error) { reject(error); }
  });
}

document.getElementById('updateCheckBtn')?.addEventListener('click', async () => {
  const els = updateCardEls();
  if (!els.btn || els.btn.disabled) return;
  const manifest = updateManifest();
  updateGeneration++;
  els.btn.disabled = true;
  if (els.dl) { els.dl.style.display = 'none'; els.dl.removeAttribute('href'); }
  if (els.relRow) els.relRow.style.display = 'none';
  if (els.hint) { els.hint.className = 'diag-hint'; els.hint.textContent = '正在申请更新检查权限…'; }
  if (els.detail) { els.detail.style.display = 'none'; els.detail.innerHTML = ''; }
  try {
    let result;
    try {
      // 不在 request 前 await contains，避免丢失用户手势。
      const granted = await requestUpdatePermissions(manifest);
      if (!granted) throw new Error('未获准访问 GitHub，无法检查更新');
      if (els.hint) els.hint.textContent = '正在检查（最长约 30 秒）…';
      result = await MiniSync.update.checkForUpdate({
        current: manifest.version || '', manifest,
        variant: MiniSync.update.selectHostVariant(manifest)
      });
    } catch (e) {
      result = { ok: false, code: 'UNEXPECTED', error: (e && e.message) || String(e),
                 releaseUrl: MiniSync.update.RELEASES_PAGE, checkedAt: Date.now() };
    }
    let note = '检查时间：' + updateTimeText(result.checkedAt);
    try {
      const patch = {};
      patch[UPDATE_CHECK_KEY] = result;
      await chrome.storage.local.set(patch);
      note += '；结果已记住，重开本页仍能看到';
    } catch (e) {
      note += '；未能保存本次结果：' + ((e && e.message) || String(e));
    }
    renderUpdateResult(result, note);
  } finally {
    els.btn.disabled = false;
  }
});

/** 页面加载：画出当前版本，并在本机版本没变的前提下恢复上次的检查结果 */
async function initUpdateCard() {
  const els = updateCardEls();
  if (!els.cur || !MiniSync.update || updateGeneration) return;
  const generation = updateGeneration;
  els.cur.textContent = updateVersionLine();
  // 提示行先归一成初始态：下面无论走「恢复上次结果」还是「作废」，
  // 都不会把上一轮（或上一版）的结论留在页面上。
  if (els.hint) { els.hint.className = 'diag-hint'; els.hint.textContent = updateHintDefault; }
  const manifest = updateManifest();
  try {
    const data = await chrome.storage.local.get([UPDATE_CHECK_KEY]);
    if (generation !== updateGeneration) return;
    const last = data && data[UPDATE_CHECK_KEY];
    // 本机版本或宿主形态变了（刚装过新版）⇒ 上次结论作废，
    // 否则会一直停在「发现新版本 v2.2.2」这种过期判断上
    if (!last || last.current !== (manifest.version || '')
        || last.variant !== MiniSync.update.selectHostVariant(manifest)) return;
    renderUpdateResult(last, '上次检查：' + updateTimeText(last.checkedAt));
  } catch (_) { /* 读不到就当从来没检查过 */ }
}

// ========== 初始化 ==========
loadPage();
initBookmarkTargetPicker();
initDownloadClearToggle();
initUpdateCard();
