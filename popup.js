// 手机浏览器宿主（可拓/雨见这类 Android Gecko fork）：弹窗面板宽度 = 设备宽度，
// 不能沿用桌面的 320px 定宽（否则只占左边一条、右侧留一大片空白）。给 <html> 挂 .host-mobile
// 交给 popup.html 的 CSS 铺满；桌面环境永远不挂，所以桌面弹窗尺寸不受影响。
// 判定规则与 AdGuard 的 UserAgent.getIsAndroid 同源：先排除桌面级环境
// （userAgentData.mobile === false，对应「Android 上开着桌面版的浏览器」），再看 UA 里的 Android。
// 必须同步执行——本脚本在 </body> 前同步跑，首帧就带类，否则会先按 320px 画一帧再跳宽。
(function markMobilePopupHost() {
  try {
    const ua = navigator.userAgent || '';
    const desktopClass = !!(navigator.userAgentData && navigator.userAgentData.mobile === false);
    if (!desktopClass && /\bAndroid\b/i.test(ua)) {
      document.documentElement.classList.add('host-mobile');
    }
  } catch (_) { /* 判定失败就退回首帧即 320px 的桌面行为 */ }
})();

// 统一全局日志（散落 console 自动走 MiniSync.logger，并持久化最近错误供前端展示）
if (typeof MiniSync !== 'undefined' && MiniSync.logger && MiniSync.logger.install) MiniSync.logger.install();
// 本弹窗的 chrome.runtime.sendMessage 走「消息管道 + 直接句柄」双传输带：
// 手机端 fork 上出现过「消息送到了但响应没回来」，装了兜底后本弹窗所有既有调用点自动受益。
if (typeof MiniSync !== 'undefined' && MiniSync.utils && MiniSync.utils.installSendMessageFallback) {
  MiniSync.utils.installSendMessageFallback();
}

// 视图元素
const homeView = document.getElementById('homeView');
const configView = document.getElementById('configView');

// 主页元素
const connBadge = document.getElementById('connBadge');
const domainText = document.getElementById('domainText');
const subInfo = document.getElementById('subInfo');
const lastSyncBox = document.getElementById('lastSyncBox');
const lastSyncTime = document.getElementById('lastSyncTime');
const autoSyncTag = document.getElementById('autoSyncTag');
const openConfigBtn = document.getElementById('openConfigBtn');
const uploadBtn = document.getElementById('uploadBtn');
const downloadBtn = document.getElementById('downloadBtn');
const syncBtn = document.getElementById('syncBtn');
const statusDiv = document.getElementById('status');
const footerRow = document.getElementById('footerRow');
const addConfigBtn = document.getElementById('addConfigBtn');
const homeCard = document.getElementById('homeCard');
const emptyHero = document.getElementById('emptyHero');


// 支持 hover 显示/隐藏
const sponsorBtn = document.getElementById('sponsorBtn');
const sponsorArea = document.getElementById('sponsorArea');
let sponsorHideTimer = null;
let savedStatusText = null;
let savedStatusBarClass = null;

function showSponsor() {
  if (sponsorHideTimer) { clearTimeout(sponsorHideTimer); sponsorHideTimer = null; }
  if (sponsorArea) sponsorArea.classList.add('show');
  if (statusDiv) {
    if (savedStatusText === null) {
      savedStatusText = statusDiv.textContent;
      savedStatusBarClass = statusDiv.parentElement ? statusDiv.parentElement.className : null;
    }
    statusDiv.textContent = '感谢支持！';
  }
}
function hideSponsor() {
  if (sponsorHideTimer) clearTimeout(sponsorHideTimer);
  sponsorHideTimer = setTimeout(() => {
    if (sponsorArea) sponsorArea.classList.remove('show');
    if (statusDiv && savedStatusText !== null) {
      statusDiv.textContent = savedStatusText;
      if (savedStatusBarClass !== null && statusDiv.parentElement) {
        statusDiv.parentElement.className = savedStatusBarClass;
      }
      savedStatusText = null;
      savedStatusBarClass = null;
    }
  }, 150);
}

const sponsorText = document.getElementById('sponsorText');
if (sponsorBtn && sponsorArea) {
  sponsorBtn.addEventListener('mouseenter', showSponsor);
  sponsorBtn.addEventListener('mouseleave', hideSponsor);
  sponsorArea.addEventListener('mouseenter', showSponsor);
  sponsorArea.addEventListener('mouseleave', hideSponsor);
  // 图标和区域点击都跳转
  sponsorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    window.open('https://jagshen.github.io/Mini-bookmark-sync/support.html', '_blank');
  });
}
const backBtn = document.getElementById('backBtn');
const saveBtn = document.getElementById('saveBtn');
const testConnectionBtn = document.getElementById('testConnectionBtn');
const clearConfigBtn = document.getElementById('clearConfigBtn');
const syncEnabledCb = document.getElementById('syncEnabled');
const intervalSelect = document.getElementById('intervalSelect');
const syncTypeSelect = document.getElementById('syncTypeSelect');
const configStatusBar = document.getElementById('configStatus');
const configStatus = document.getElementById('configStatusText');
const openOptionsLink = document.getElementById('openOptionsLink');
const syncOptions = document.getElementById('syncOptions');

// 普通方式设置状态栏文本与样式（替代原 defineProperty 黑魔法）：
// 文本写入 configStatus 本身，className 应用到父容器 configStatusBar，
// 文本非空时隐藏「打开设置」链接。
function setConfigStatus(text, cls) {
  configStatus.textContent = text || '';
  configStatusBar.className = cls || 'status-bar';
  if (openOptionsLink) openOptionsLink.style.display = text ? 'none' : '';
}

// 同步启用 checkbox 切换时展开/折叠选项
syncEnabledCb.addEventListener('change', () => {
  if (syncEnabledCb.checked) {
    syncOptions.classList.remove('hide');
  } else {
    syncOptions.classList.add('hide');
  }
});

// 配置表单：输入即缓存草稿
// 用户在配置页的任何改动都会自动写入 chrome.storage.local[webdav_config_draft]，
// 即使没点「保存」就关闭弹窗，下次打开配置页也会回填。
function bindDraftAutosave() {
  const textFields = ['webdav_url', 'webdav_user', 'webdav_password', 'webdav_path'];
  textFields.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', scheduleDraftSave);
  });
  syncEnabledCb.addEventListener('change', scheduleDraftSave);
  intervalSelect.addEventListener('change', scheduleDraftSave);
  syncTypeSelect.addEventListener('change', scheduleDraftSave);
}

// 输入框聚焦提示
function bindFieldHints() {
  const pathInput = document.getElementById('webdav_path');
  const pathHint = document.getElementById('pathHint');
  if (pathInput && pathHint) {
    pathInput.addEventListener('focus', () => pathHint.classList.add('show'));
    pathInput.addEventListener('blur', () => pathHint.classList.remove('show'));
  }
  const urlInput = document.getElementById('webdav_url');
  if (urlInput) {
    urlInput.addEventListener('input', updateInsecureUrlHint);
    urlInput.addEventListener('change', updateInsecureUrlHint);
  }
  updateInsecureUrlHint();
}

// 明文 http 告警：Basic 认证头（账号/应用密码）与云端文件在网络上是明文的。
// 「密码仅存储在本地」这句话说的是存储侧，不含传输侧，两者容易被读成同一件事。
// 只提示、不阻断保存——局域网自建 NAS 确实可能只有 http。
function updateInsecureUrlHint() {
  const hint = document.getElementById('insecureUrlHint');
  const input = document.getElementById('webdav_url');
  if (!hint || !input) return;
  hint.classList.toggle('hide', !/^http:\/\//i.test(input.value.trim()));
}

// 密码显示/隐藏切换
function bindPasswordToggle() {
  const btn = document.getElementById('togglePasswordBtn');
  const input = document.getElementById('webdav_password');
  if (!btn || !input) return;
  btn.addEventListener('click', () => {
    const showing = input.type === 'text';
    if (showing) {
      input.type = 'password';
      btn.textContent = '👁';
      btn.title = '显示密码';
      btn.setAttribute('aria-label', '显示密码');
      btn.setAttribute('aria-pressed', 'false');
    } else {
      input.type = 'text';
      btn.textContent = '🙈';
      btn.title = '隐藏密码';
      btn.setAttribute('aria-label', '隐藏密码');
      btn.setAttribute('aria-pressed', 'true');
    }
  });
}

// 把密码输入框恢复到隐藏状态（用于离开配置页、保存后等场景）
function resetPasswordVisibility() {
  const btn = document.getElementById('togglePasswordBtn');
  const input = document.getElementById('webdav_password');
  if (input) input.type = 'password';
  if (btn) {
    btn.textContent = '👁';
    btn.title = '显示密码';
    btn.setAttribute('aria-label', '显示密码');
    btn.setAttribute('aria-pressed', 'false');
  }
}

// ========== 工具函数 ==========

// 自定义确认模态框（替代 window.confirm）
function openConfirm(opts) {
  const {
    title = '确认操作',
    body = '',
    okText = '确定',
    cancelText = '取消',
    danger = true,
    icon = '!',
    buttons = null,
    showClose = false
  } = opts || {};

  const overlay = document.getElementById('confirmModal');
  const titleEl = document.getElementById('confirmTitle');
  const bodyEl = document.getElementById('confirmBody');
  const iconEl = document.getElementById('confirmIcon');
  const okBtn = document.getElementById('confirmOkBtn');
  const cancelBtn = document.getElementById('confirmCancelBtn');
  const closeBtn = document.getElementById('confirmCloseBtn');

  if (!overlay || !okBtn || !cancelBtn) {
    return Promise.resolve(window.confirm((title ? title + '\n\n' : '') + body.replace(/<[^>]+>/g, '')));
  }

  titleEl.textContent = title;
  // body 按【受信 HTML】渲染（本文件里几个调用点都靠 <span class="note-inline"> 排版）。
  // ⚠️ 契约：凡是要把外部数据（云端返回值、书签标题、文件内容）拼进来，必须过
  //    MiniSync.utils.escapeHtml —— 这里不做转义过滤。
  bodyEl.innerHTML = body;
  iconEl.textContent = icon;

  // 关闭按钮显隐
  if (closeBtn) {
    closeBtn.classList.toggle('show', showClose);
  }

  // 按钮模式：自定义多按钮 或 默认双按钮
  const useCustom = buttons && Array.isArray(buttons) && buttons.length > 0;
  const actionContainer = okBtn.parentElement;

  if (useCustom) {
    // 隐藏默认双按钮
    okBtn.classList.add('hide');
    cancelBtn.classList.add('hide');
    // 创建自定义按钮
    const customBtns = [];
    for (const cfg of buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'modal-btn ' + (cfg.style === 'danger' ? 'modal-btn-danger' : 'modal-btn-cancel');
      btn.textContent = cfg.text;
      btn.dataset.value = cfg.value;
      actionContainer.appendChild(btn);
      customBtns.push(btn);
    }
  } else {
    okBtn.textContent = okText;
    cancelBtn.textContent = cancelText;
    okBtn.className = 'modal-btn ' + (danger ? 'modal-btn-danger' : 'modal-btn-cancel');
    okBtn.classList.remove('hide');
    cancelBtn.classList.remove('hide');
  }

  return new Promise((resolve) => {
    const cleanup = (result) => {
      if (document.activeElement && overlay.contains(document.activeElement)) {
        try { document.activeElement.blur(); } catch (_) {}
      }
      overlay.classList.remove('show');
      overlay.setAttribute('aria-hidden', 'true');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      if (closeBtn) closeBtn.removeEventListener('click', onClose);
      overlay.removeEventListener('click', onOverlay);
      document.removeEventListener('keydown', onKey);
      // 清理自定义按钮
      if (useCustom) {
        const extras = actionContainer.querySelectorAll('button[data-value]');
        extras.forEach(b => b.remove());
        okBtn.classList.remove('hide');
        cancelBtn.classList.remove('hide');
      }
      resolve(result);
    };

    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onClose = () => cleanup(null);
    const onOverlay = (e) => { if (e.target === overlay) cleanup(null); };
    const onKey = (e) => {
      if (e.key === 'Escape') cleanup(null);
      else if (!useCustom && e.key === 'Enter') cleanup(true);
    };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    if (closeBtn) closeBtn.addEventListener('click', onClose);
    overlay.addEventListener('click', onOverlay);
    document.addEventListener('keydown', onKey);

    // 自定义按钮事件绑定
    if (useCustom) {
      const extras = actionContainer.querySelectorAll('button[data-value]');
      extras.forEach(btn => {
        btn.addEventListener('click', () => cleanup(btn.dataset.value));
      });
    }

    overlay.classList.add('show');
    overlay.setAttribute('aria-hidden', 'false');
    // 聚焦到第一个按钮（自定义或取消），避免误触确认
    setTimeout(() => {
      const first = actionContainer.querySelector('button:not(.hide)');
      if (first) first.focus();
    }, 50);
  });
}

// 解析域名（从 WebDAV URL 提取 host）
function parseHost(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.host;
  } catch (e) {
    return url.replace(/^https?:\/\//, '').split('/')[0];
  }
}

// "上次同步"文案：绝对时间 + 相对时间括号
function formatLastSyncText(ts) {
  if (!ts) return '从未';
  const now = new Date();
  const then = new Date(ts);
  const diffMs = now.getTime() - ts;
  const diffSec = Math.max(0, Math.floor(diffMs / 1000));
  const pad = (n) => String(n).padStart(2, '0');

  // 绝对时间部分始终显示
  const absolute =
    `${then.getFullYear()}-${pad(then.getMonth() + 1)}-${pad(then.getDate())} ` +
    `${pad(then.getHours())}:${pad(then.getMinutes())}`;

  // 按自然日算"今天/昨天/前天"
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.floor((startOfDay(now) - startOfDay(then)) / 86400000);

  let rel = '';
  if (diffSec < 5) {
    rel = '刚刚';
  } else if (diffSec < 60) {
    rel = `${diffSec}秒前`;
  } else if (diffSec < 3600) {
    rel = `${Math.floor(diffSec / 60)}分钟前`;
  } else if (dayDiff === 0) {
    rel = '今天';
  } else if (dayDiff === 1) {
    rel = '昨天';
  } else if (dayDiff === 2) {
    rel = '前天';
  } else {
    rel = ''; // 超过前天不显示括号
  }

  return rel ? `${absolute}（${rel}）` : absolute;
}

function renderLastSync(ts) {
  lastSyncTime.innerText = formatLastSyncText(ts);
  if (ts) lastSyncBox.classList.remove('never');
  else lastSyncBox.classList.add('never');
}

function renderAutoSync(enabled, interval, type) {
  if (enabled) {
    const typeLabel = type === 'upload' ? '上传' : type === 'download' ? '下载' : '合并';
    autoSyncTag.innerText = `每 ${interval || 30} 分钟${typeLabel}`;
    autoSyncTag.classList.remove('off');
  } else {
    autoSyncTag.innerText = '自动同步未启用(右上角启用)';
    autoSyncTag.classList.add('off');
  }
}

// 渲染右上角滑块开关
function renderBadge(configured, enabled) {
  // DOM 结构固定：<span class="auto-switch"><span class="switch-label">…</span><span class="switch-track">…</span></span>
  const label = connBadge.querySelector('.switch-label');
  if (!configured) {
    if (label) label.innerText = '';
    connBadge.className = 'auto-switch off disabled';
    connBadge.title = '请先完成 WebDAV 配置';
    connBadge.setAttribute('aria-checked', 'false');
    return;
  }
  if (enabled) {
    if (label) label.innerText = '同步中';
    connBadge.className = 'auto-switch';
    connBadge.setAttribute('aria-checked', 'true');
    connBadge.title = '点击关闭自动同步';
  } else {
    if (label) label.innerText = '';
    connBadge.className = 'auto-switch off';
    connBadge.setAttribute('aria-checked', 'false');
    connBadge.title = '点击启用自动同步';
  }
}

// 从云端拉取 endpoints 配置（开关状态、文件夹路径）写回本地 storage。
// 这一趟在后台是「整份 XBEL 下载 + 解析」，手机端很贵，所以有两道约束：
// ① 本地四个键齐全时直接不请求 —— 设置页 initSwitch 自己定了「本地已有用户选择就以本地为准」，
//    本地齐全时这次云端覆盖本来就什么也不会变，纯多一趟下载；
// ② 回填也只补本地缺失的键：option_via_enabled / option_berry_enabled 是同步核心会读的值
//    （core/sync-orchestrator.js、core/sync-merge.js），拿云端旧值盖掉用户刚改的选择
//    会让下一次同步走错桥接分支。
const ENDPOINT_MIRROR_KEYS = [
  'option_berry_enabled', 'option_via_enabled', 'berry_folder_path', 'via_folder_path'
];
async function syncEndpointsFromCloud() {
  try {
    const r = await chrome.storage.local.get(
      ['webdav_url', 'webdav_user', 'webdav_password'].concat(ENDPOINT_MIRROR_KEYS)
    );
    if (!r.webdav_url || !r.webdav_user || !r.webdav_password) return;
    if (ENDPOINT_MIRROR_KEYS.every((k) => r[k] !== undefined)) return;   // 本地齐全，不用问云端
    const result = await chrome.runtime.sendMessage({
      action: 'getEndpoints',
      webdavUrl: r.webdav_url,
      webdavUser: r.webdav_user,
      webdavPassword: r.webdav_password,
      webdavPath: r.webdav_bookmark_path
    });
    if (!result || !result.ok || !result.endpoints) return;
    // background 已按 deviceId 解包，这里直接拿扁平结构
    const eps = result.endpoints;
    const toSet = {};
    if (eps.berry) {
      toSet.option_berry_enabled = !!eps.berry.enabled;
      if (eps.berry.folder) toSet.berry_folder_path = eps.berry.folder;
    }
    if (eps.via) {
      toSet.option_via_enabled = !!eps.via.enabled;
      if (eps.via.folder) toSet.via_folder_path = eps.via.folder;
    }
    if (Object.keys(toSet).length > 0) {
      // 只补本地缺失的键（见函数头两条约束）
      const patch = {};
      for (const [k, v] of Object.entries(toSet)) {
        if (r[k] === undefined) patch[k] = v;
      }
      if (Object.keys(patch).length > 0) await chrome.storage.local.set(patch);
    }
  } catch (e) {
    // 静默失败，非关键路径
  }
}

// 根据配置完整度切换主页展示
function renderHome(cfg) {
  const configured = !!(cfg.webdav_url && cfg.webdav_user && cfg.webdav_password);
  const host = parseHost(cfg.webdav_url);

  // 支持标签：根据 berry/via/aira 开关动态显示
  const supportTag = document.getElementById('supportTag');
  if (supportTag) {
    const parts = [];
    if (cfg.option_berry_enabled === true) parts.push('Berry');
    if (cfg.option_via_enabled === true) parts.push('Via');
    if (cfg.option_aira_enabled === true) parts.push('Aira');
    supportTag.textContent = parts.length > 0 ? '｜支持' + parts.join('/') : '';
  }

  if (configured) {
    domainText.innerText = '极简同步，书签随身带';
    subInfo.innerText = `${cfg.webdav_user || ''}@${host}`;

    homeCard.classList.remove('hide');
    emptyHero.classList.add('hide');
    footerRow.classList.add('hide');

    uploadBtn.disabled = false;
    downloadBtn.disabled = false;
    syncBtn.disabled = false;
  } else {
    // 未配置：隐藏卡片，露出标题区 + 「+ 添加配置」按钮
    homeCard.classList.add('hide');
    emptyHero.classList.remove('hide');
    footerRow.classList.remove('hide');

    uploadBtn.disabled = true;
    downloadBtn.disabled = true;
    syncBtn.disabled = true;
  }
  return configured;
}

function setStatus(text, type) {
  statusDiv.innerText = text || '';
  // 仅改 status-bar 的类（.err / .ok 控制 .status-text 颜色）
  statusDiv.parentElement.className = 'status-bar' + (type ? ' ' + type : '');
}

// ★ 后台任务进行中时的状态栏轮询：popup 二次打开后，若上传/下载/合并仍在后台
//   进行，每秒查一次状态，任务结束（success/failed）时把状态栏刷成完成信息。
//   popup 关闭时定时器随页面销毁，无需清理。
//   since：本次点击的时间戳。给了它就必须「后台终态时间晚于本次点击」才算本次结果，
//   否则会把上一轮的成功当成本次成功（假成功比不显示更坏）。
let statusPollTimer = null;
// 轮询上限：约 45 秒。手机端宿主可能连 getStatus 的响应一起丢，那样 st 永远是 null，
// 会一秒一次地转到天荒地老，而且 statusPollTimer 非空还会挡住后续点击的轮询。
// 到点就如实收尾（不猜成功/失败），并把定时器彻底放掉。
const STATUS_POLL_MAX_TICKS = 45;
function startStatusPolling(action, since) {
  if (statusPollTimer) return; // 已在轮询
  let ticks = 0;
  const stop = () => { clearInterval(statusPollTimer); statusPollTimer = null; };
  statusPollTimer = setInterval(async () => {
    let st = null;
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'getStatus' });
      st = resp && resp.data;
    } catch (_) { /* SW 重启等，下个周期再查 */ }
    if (!st || st.status === 'syncing') {
      // 仍在进行；查不到（宿主丢响应）也算「还没结果」，超时就收尾
      if (++ticks >= STATUS_POLL_MAX_TICKS) {
        stop();
        setSyncBtnBusy(action, false);
        setStatus('仍未拿到后台结果（可能还在跑），稍后可再点一次或重新打开本面板', 'warn');
      }
      return;
    }
    stop();
    // 任务结束：恢复该任务的按钮（与 runSyncActionGuarded 的 finally 行为一致）
    setSyncBtnBusy(action, false);
    const label = SYNC_ACTION_LABELS[action] || { successTag: '同步成功', failPrefix: '同步失败：' };
    const fresh = !since || (st.lastSyncTime && st.lastSyncTime >= since - 2000);
    if (st.status === 'partial' && fresh) {
      setStatus(st.error || st.message || '主文件已同步，手机桥接部分失败', 'warn');
      const { last_sync_at, last_sync_count } = await chrome.storage.local.get(['last_sync_at', 'last_sync_count']);
      renderLastSync(last_sync_at);
      renderProgressLine(last_sync_count, undefined, 'warn');
    } else if (st.status === 'success' && fresh) {
      setStatus('✓ ' + label.successTag, 'ok');
      const { last_sync_at, last_sync_count } = await chrome.storage.local.get(['last_sync_at', 'last_sync_count']);
      renderLastSync(last_sync_at);
      renderProgressLine(last_sync_count, undefined, 'ok');
    } else if (st.status === 'failed' && fresh) {
      setStatus(label.failPrefix + (st.error || '未知错误'), 'err');
    } else if (since) {
      // 后台没有本次操作的记录：如实说清楚，别让用户以为「成功了」或「什么都没发生」
      setStatus('后台没有本次操作的记录，可再点一次重试', 'warn');
      renderProgressLine(null);
    } else {
      // idle：任务被手动操作覆盖等 → 重走正常初始化检测
      updateHomeStatus();
    }
  }, 1000);
}

// ★ 连通性探测：30 秒短缓存 + 在途合并（实现在 lib/utils.js，那里有单测）。
//   为什么必须有：① 手机端一次 checkConfig 是后台真连 WebDAV 的一整趟 HTTP 往返（后台里
//   还套了 15s/20s 超时），重复探测就是让用户干等；② 探测成功后会写 ever_connected，而那条
//   写入会触发下面的 storage.onChanged 再调一次 updateHomeStatus —— 用户看到的就是
//   「检查结束又要再检查」（第二轮答完才真正停下）。
//   key uses the opaque resolved configuration identity, including credentials and basename.
//   「同步进行中」是瞬时态，按 skipCache 不进缓存（否则同步结束后还在显示进行中）。
const STATUS_PROBE_TTL = 30000;
let _statusProbe = MiniSync.utils.createCoalescedProbe(STATUS_PROBE_TTL);
async function statusProbeKey(r) {
  try { return await MiniSync.utils.syncStatusConfigKey(r); }
  catch (_) { return null; } // Without a reliable identity, probe without caching.
}

// 状态栏显示规则：未配置不显示；已配置则异步测试连接。
// 「打开时先画一帧、探测结果静默刷新」的策略在 lib/utils.js（pickConnStatus /
// connCacheFromResult），那里有单测 —— 弹窗本身没有测试环境，逻辑不留在这一层。
// ⚠️ 名字必须与 lib/utils.js 的顶层 const 不同名：两个都是经典脚本、共享同一个全局
//    词法作用域，重名会让 popup.js 整个解析失败（页面脚本全死、滑块点不动）。
const CONN_CACHE_STORAGE_KEY = MiniSync.utils.CONN_CACHE_KEY;
// 连通性探测的硬上限：后台自己 20s 收尾，这里给到 25s；超过就按「没拿到结论」收场
const CONN_PROBE_HARD_MS = 25000;

function renderConnResult(ok) {
  if (ok) setStatus('配置已就绪', 'ok');
  else { setStatus('配置未就绪'); renderProgressLine(null); }
}

// 同步任务进行中（二次打开/自动同步占用）：显示与手动点击一致的文案，三个按钮同样禁用，
// 并启动轮询——任务结束后状态栏刷成完成信息、恢复按钮。
function renderBusySync(action) {
  const busyLabel = SYNC_ACTION_LABELS[action];
  setStatus(busyLabel ? busyLabel.running : '同步进行中，请稍候...');
  setSyncBtnBusy(action, true);
  startStatusPolling(action);
}

async function updateHomeStatus() {
  if (homeView.classList.contains('hide')) return;
  const probe = _statusProbe;
  const isCurrent = () => probe === _statusProbe && !homeView.classList.contains('hide');
  const r = await chrome.storage.local.get([
    'webdav_url', 'webdav_user', 'webdav_password', 'webdav_bookmark_path', 'webdav_config', 'bookmark_target_id',
    'last_sync_count', 'ever_connected', CONN_CACHE_STORAGE_KEY,
    'sync_status', 'sync_error', 'sync_action', 'sync_status_config_key'
  ]);
  if (!isCurrent()) return;
  const configured = !!(r.webdav_url && r.webdav_user && r.webdav_password);
  if (!configured) {
    setStatus('');
    renderProgressLine(null);
    return;
  }

  if (r.sync_status === 'syncing') {
    renderBusySync(r.sync_action);
    return;
  }
  let partialMatchesConfig = false;
  if (r.sync_status === 'partial' && r.sync_status_config_key) {
    try { partialMatchesConfig = r.sync_status_config_key === await MiniSync.utils.syncStatusConfigKey(r); }
    catch (_) { /* Cannot associate this result with the current configuration. */ }
  }
  if (!isCurrent()) return;
  if (partialMatchesConfig) {
    setStatus(r.sync_error || '主文件已同步，手机桥接部分失败', 'warn');
    renderProgressLine(r.last_sync_count, undefined, 'warn');
    return;
  }

  const probeKey = await statusProbeKey(r);
  if (!isCurrent()) return;
  const first = MiniSync.utils.pickConnStatus(probeKey ? r[CONN_CACHE_STORAGE_KEY] : null, probeKey, Date.now());
  setStatus(first.text, first.level || undefined);
  renderProgressLine(null);

  // 通过 background 发请求检查连通性，避免 popup 触发 HTTP 认证弹窗。
  // ⚠️ 外面再套一层硬超时：宿主若返回一个永不 settle 的 promise，状态栏会永远停在
  //    「正在检查配置...」（用户手机的原始症状）；超时按「没拿到结论」处理，不冒充连不上。
  let result = null;
  try {
    const request = () => MiniSync.utils.raceHardTimeout(
      chrome.runtime.sendMessage({
        action: 'checkConfig',
        webdavUrl: r.webdav_url,
        webdavUser: r.webdav_user,
        webdavPassword: r.webdav_password,
        webdavPath: r.webdav_bookmark_path
      }),
      CONN_PROBE_HARD_MS
    );
    result = probeKey ? await probe.run(probeKey, request,
      (v) => !isCurrent() || !!(v && (v.busy || v.timedOut))) : await request();
  } catch (e) {
    // SW 未就绪等场景
    result = null;
  }
  if (!isCurrent()) return;
  if (result && result.ok) {
    setStatus('配置已就绪', 'ok');
    // 只在真正变化时写：写同一个值也会触发 storage.onChanged，白跑一趟探测
    if (!r.ever_connected) await chrome.storage.local.set({ ever_connected: true });
  } else if (result && result.busy) {
    renderBusySync(result.action);
  } else {
    setStatus('配置未就绪');
    renderProgressLine(null);
  }
  // 落盘「下次打开可以立刻画出来」的那份结论（否定结论与无响应都不落，见 utils 里的说明）
  const entry = probeKey && MiniSync.utils.connCacheFromResult(result, probeKey, Date.now());
  if (entry && isCurrent()) await chrome.storage.local.set({ [CONN_CACHE_STORAGE_KEY]: entry });
}

// 显示/隐藏操作记录行（level='ok'/'err' 时同色，手机上「成了没有」一眼可见）
function renderProgressLine(count, diff, level) {
  const el = document.getElementById('progressLine');
  if (!el) return;
  el.classList.remove('ok', 'err');
  if (level === 'ok') el.classList.add('ok');
  else if (level === 'err') el.classList.add('err');
  if (count === null || count === undefined || count === '') {
    el.classList.add('hide');
    el.innerText = '';
    return;
  }
  el.classList.remove('hide');
  if (count) {
    let text = level === 'ok' ? '✓ 操作记录：' : '操作记录：';
    if (typeof diff === 'number') {
      if (diff > 0) {
        text += `添加了 ${diff} 条，`;
      } else if (diff < 0) {
        text += `删除了 ${Math.abs(diff)} 条，`;
      } else {
        text += `无变化，`;
      }
    }
    text += `共 ${count} 条书签`;
    el.innerText = text;
  } else {
    el.innerText = '';
    el.classList.add('hide');
  }
}

// 视图切换
function showHome() {
  // 离开配置页时把密码恢复为隐藏，避免下次打开还是明文
  resetPasswordVisibility();
  configView.classList.add('hide');
  homeView.classList.remove('hide');
  loadAll();
}
function showConfig() {
  resetPasswordVisibility();
  homeView.classList.add('hide');
  configView.classList.remove('hide');
  loadConfigForm();
}

openConfigBtn.onclick = showConfig;
addConfigBtn.onclick = showConfig;
backBtn.onclick = showHome;

// ========== 数据加载 ==========
async function loadAll() {
  const result = await chrome.storage.local.get([
    'webdav_url',
    'webdav_user',
    'webdav_password',
    'last_sync_at',
    'sync_enabled',
    'sync_interval',
    'sync_type',
    'ever_connected',
    'test_passed',       // 旧字段，迁移用
    'option_berry_enabled',
    'option_via_enabled'
  ]);

  // 迁移：旧字段 test_passed → ever_connected
  if (result.test_passed === true && !result.ever_connected) {
    await chrome.storage.local.set({ ever_connected: true });
    result.ever_connected = true;
  }

  const configured = renderHome(result);
  renderLastSync(result.last_sync_at);
  renderAutoSync(!!result.sync_enabled, result.sync_interval, result.sync_type);
  renderBadge(configured, !!result.sync_enabled);
  updateHomeStatus();

  // 配置已就绪：从云端拉取 endpoints 配置写回本地，使多端开关状态同步
  if (configured) {
    syncEndpointsFromCloud();
  }
}

// ========== 配置表单草稿 ==========
const DRAFT_KEY = 'webdav_config_draft';
let draftSaveTimer = null;
// 进入配置页时 storage 里"已保存"的基线值，用于对比当前表单是否 dirty
let savedBaseline = null;

// 收集当前表单值
function collectFormValues() {
  return {
    webdav_url: document.getElementById('webdav_url').value,
    webdav_user: document.getElementById('webdav_user').value,
    webdav_password: document.getElementById('webdav_password').value,
    webdav_bookmark_path: document.getElementById('webdav_path').value,
    sync_enabled: syncEnabledCb.checked,
    sync_interval: parseInt(intervalSelect.value, 10) || 30,
    sync_type: syncTypeSelect.value || 'merge'
  };
}

// 判断草稿是否与已保存配置有实质差异
function draftDiffersFromSaved(draft, saved) {
  if (!draft) return false;
  const normPath = (p) => normalizeBookmarkPathSafe(p);
  return (
    (draft.webdav_url || '') !== (saved.webdav_url || '') ||
    (draft.webdav_user || '') !== (saved.webdav_user || '') ||
    (draft.webdav_password || '') !== (saved.webdav_password || '') ||
    normPath(draft.webdav_bookmark_path) !== normPath(saved.webdav_bookmark_path) ||
    !!draft.sync_enabled !== !!saved.sync_enabled ||
    (draft.sync_interval || 30) !== (saved.sync_interval || 30) ||
    (draft.sync_type || 'merge') !== (saved.sync_type || 'merge')
  );
}

// 防抖写入草稿
function scheduleDraftSave() {
  // UI 立即反馈，不等防抖
  updateDirtyUI();

  if (draftSaveTimer) clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(async () => {
    const draft = collectFormValues();
    draft._ts = Date.now();
    try {
      await chrome.storage.local.set({ [DRAFT_KEY]: draft });
    } catch (e) {
      // 忽略存储异常，草稿非关键路径
    }
  }, 300);
}

// 清除草稿（保存成功或用户主动清除时调用）
async function clearDraft() {
  if (draftSaveTimer) {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
  }
  try {
    await chrome.storage.local.remove(DRAFT_KEY);
  } catch (e) { /* ignore */ }
}

// ========== 脏态 UI ==========
function fieldIsDirty(key, current, baseline) {
  if (!baseline) return false;
  const a = current[key];
  const b = baseline[key];
  if (key === 'webdav_bookmark_path') {
    return normalizeBookmarkPathSafe(a) !== normalizeBookmarkPathSafe(b);
  }
  if (key === 'sync_enabled') return !!a !== !!b;
  if (key === 'sync_interval') return (a || 30) !== (b || 30);
  if (key === 'sync_type') return (a || 'merge') !== (b || 'merge');
  return (a || '') !== (b || '');
}

// 刷新脏态 UI
function updateDirtyUI() {
  if (!savedBaseline) return;
  const current = collectFormValues();

  const fieldMap = {
    webdav_url: document.getElementById('webdav_url'),
    webdav_user: document.getElementById('webdav_user'),
    webdav_password: document.getElementById('webdav_password'),
    webdav_bookmark_path: document.getElementById('webdav_path'),
    sync_interval: intervalSelect,
    sync_type: syncTypeSelect
  };

  let anyDirty = false;
  for (const key of Object.keys(fieldMap)) {
    const el = fieldMap[key];
    if (!el) continue;
    const dirty = fieldIsDirty(key, current, savedBaseline);
    el.classList.toggle('dirty-field', dirty);
    if (dirty) anyDirty = true;
  }

  // syncEnabled 的高亮挂在父 row 上
  const syncRow = document.getElementById('syncEnabledRow');
  const syncDirty = fieldIsDirty('sync_enabled', current, savedBaseline);
  if (syncRow) syncRow.classList.toggle('dirty-field', syncDirty);
  if (syncDirty) anyDirty = true;

  // 保存按钮脉冲
  saveBtn.classList.toggle('dirty', anyDirty);
}

async function loadConfigForm() {
  const result = await chrome.storage.local.get([
    'webdav_url',
    'webdav_user',
    'webdav_password',
    'webdav_bookmark_path',
    'sync_enabled',
    'sync_interval',
    'sync_type',
    DRAFT_KEY
  ]);

  const saved = {
    webdav_url: result.webdav_url || '',
    webdav_user: result.webdav_user || '',
    webdav_password: result.webdav_password || '',
    webdav_bookmark_path: result.webdav_bookmark_path || '/minibookmark',
    sync_enabled: !!result.sync_enabled,
    sync_interval: result.sync_interval || 30,
    sync_type: result.sync_type || 'merge'
  };
  // ★ 存量脏值自愈：此前误把文件名当文件夹保存的（如 /minibookmarks.xbel），
  //   打开配置页时自动纠正为目录并写回，避免双层嵌套路径。
  const savedPathFix = sanitizeFolderPathInput(saved.webdav_bookmark_path);
  if (savedPathFix.corrected) {
    saved.webdav_bookmark_path = savedPathFix.path;
    try { chrome.storage.local.set({ webdav_bookmark_path: savedPathFix.path }).catch(() => {}); } catch (_) {}
  }
  // 记录基线用于脏态对比
  savedBaseline = { ...saved };

  const draft = result[DRAFT_KEY];
  const hasDraft = draft && draftDiffersFromSaved(draft, saved);
  const source = hasDraft ? draft : saved;

  document.getElementById('webdav_url').value = source.webdav_url || '';
  document.getElementById('webdav_user').value = source.webdav_user || '';
  document.getElementById('webdav_password').value = source.webdav_password || '';
  document.getElementById('webdav_path').value = source.webdav_bookmark_path || '';
  syncEnabledCb.checked = !!source.sync_enabled;
  intervalSelect.value = String(source.sync_interval || 30);
  syncTypeSelect.value = source.sync_type || 'merge';
  updateInsecureUrlHint();

  // 根据同步启用状态展开/折叠同步选项
  if (syncEnabledCb.checked) {
    syncOptions.classList.remove('hide');
  } else {
    syncOptions.classList.add('hide');
  }

  if (hasDraft) {
    setConfigStatus('已恢复表单数据，点击保存生效，或点击右上角清除。', 'status-bar ok');
  } else {
    setConfigStatus('', 'status-bar');
  }

  // 根据当前填充值刷新脏态提示（草稿场景下会直接高亮）
  updateDirtyUI();

  // 更新清空/重置按钮的 title（根据配置是否已保存）
  const deleteBtn = document.getElementById('deleteConfigBtn');
  if (saved.webdav_url) {
    clearConfigBtn.title = '重置同步缓存';
    if (deleteBtn) deleteBtn.classList.remove('hide');
  } else {
    clearConfigBtn.title = '清空配置表单';
    if (deleteBtn) deleteBtn.classList.add('hide');
  }
}

// ========== 配置页动作：统一保存 ==========
saveBtn.onclick = async () => {
  const url = document.getElementById('webdav_url').value.trim();
  const user = document.getElementById('webdav_user').value.trim();
  const password = document.getElementById('webdav_password').value;
  const rawPath = document.getElementById('webdav_path').value.trim();
  const enabled = syncEnabledCb.checked;
  const interval = parseInt(intervalSelect.value, 10);
  const syncType = syncTypeSelect.value || 'merge';

  if (!url || !user || !password) {
    setConfigStatus('请填写完整的 WebDAV 地址、用户名和应用密码', 'status-bar err');
    return;
  }

  // 验证路径非空（至少指定一个文件夹）
  if (!rawPath || rawPath === '/') {
    setConfigStatus('请填写云端同步文件夹路径，如 /minibookmark', 'status-bar err');
    return;
  }

  // 验证 WebDAV URL 格式
  if (!/^https?:\/\/.+/.test(url)) {
    setConfigStatus('WebDAV 地址必须以 http:// 或 https:// 开头', 'status-bar err');
    return;
  }

  // 域名授权：必须在【任何 await 之前】同步发起（手势窗口要求，见 utils.requestHostPermission），
  // 但【不 await 结果】。原因：不实现授权弹窗的宿主（Gecko 系移动端浏览器）回调永不触发，
  // 早期版本 await 它、失败就 return，于是配置根本存不下来 —— 用户症状是「保存不成功」。
  // 权限是全局状态、与 storage 无关，先落盘再申请没有任何副作用。
  let permWarnLater = '';
  let saveDone = false;
  MiniSync.utils.requestHostPermission(url).then(
    () => {},
    (permErr) => {
      permWarnLater = (permErr && permErr.message) || '未知原因';
      if (saveDone) setConfigStatus('已保存；域名授权未完成（' + permWarnLater + '）', 'status-bar');
    }
  );

  // 用 MiniSync.utils.normalizeBookmarkPath 做安全校验（避免与 utils.js 全局声明重名）
  try {
    MiniSync.utils.normalizeBookmarkPath(rawPath);
  } catch (e) {
    setConfigStatus(e.message, 'status-bar err');
    return;
  }
  // ★ 文件夹路径防呆：误填文件名（如 /minibookmarks.xbel）自动剥去文件名段，
  //   只保留目录部分——否则会拼出双层嵌套路径（/minibookmarks.xbel/minibookmarks.xbel）。
  const sanitized = sanitizeFolderPathInput(rawPath);
  const path = sanitized.path;
  if (sanitized.corrected) {
    document.getElementById('webdav_path').value = path;
    setConfigStatus('已自动纠正：该框应填文件夹路径（如 /minibookmark），已为你去掉文件名部分', 'status-bar ok');
  }

  // 保存配置（不重置 ever_connected，连接是否成功过是独立记录）
  // ★ 双写补全：此前只写扁平 key 不写 webdav_config——清空重配后后台「规范化补写」
  //   会写入 filename=裸文件名、账号密码全空的残缺嵌套，getWebDAVConfig 读 filename
  //   取嵌套值优先 → 用户填的路径被无视 → PUT 落到 WebDAV 根目录（坚果云 404）。
  //   现按 storage.setWebdavConfig 同一口径双写，并保留当前文件名。
  const currentConfig = MiniSync.utils.resolveWebDAVConfigData(await chrome.storage.local.get([
    'webdav_config', 'webdav_url', 'webdav_user', 'webdav_password', 'webdav_bookmark_path'
  ]));
  const normPath = path.replace(/\/+$/, '') || '';
  const basename = currentConfig.filename.slice(currentConfig.filename.lastIndexOf('/') + 1) || DEFAULT_FILENAME;
  const filename = normPath ? normPath + '/' + basename : basename;
  await chrome.storage.local.set({
    webdav_config: { url, username: user, password, filename },
    webdav_url: url,
    webdav_user: user,
    webdav_password: password,
    webdav_bookmark_path: normPath,
    sync_enabled: enabled,
    sync_interval: interval,
    sync_type: syncType
  });

  await chrome.runtime.sendMessage({ action: 'updateSyncInterval' });

  // 保存成功后清除草稿
  await clearDraft();

  // 基线更新为刚保存的值，脏态清零
  savedBaseline = {
    webdav_url: url,
    webdav_user: user,
    webdav_password: password,
    webdav_bookmark_path: normPath,
    sync_enabled: enabled,
    sync_interval: interval,
    sync_type: syncType
  };
  updateDirtyUI();

  saveDone = true;
  // 用户刚改过配置：作废探测缓存，回主页时立刻重新测一次（30 秒缓存不该挡住刚改的配置）
  _statusProbe.invalidate();
  await chrome.storage.local.remove(CONN_CACHE_STORAGE_KEY);   // 落盘那份「上次结论」同样作废
  setConfigStatus(
    permWarnLater ? ('已保存；域名授权未完成（' + permWarnLater + '）') : '已保存',
    permWarnLater ? 'status-bar' : 'status-bar ok'
  );

  setTimeout(showHome, 400);
};

clearConfigBtn.onclick = async () => {
  // 判断配置是否已保存（storage 中有 webdav_url）
  const stored = await chrome.storage.local.get(['webdav_url']);
  const hasConfig = !!(stored.webdav_url);

  if (hasConfig) {
    // ====== 配置已保存：选择清除范围 ======
    const scope = await openConfirm({
      title: '选择清除设备缓存，重建同步？',
      body: '<span class="note">本地书签和配置不受影响</span>',
      showClose: true,
      buttons: [
        { text: '清除全部设备', value: 'all', style: 'danger' },
        { text: '清除当前设备', value: 'current', style: 'cancel' }
      ]
    });
    if (!scope) return;
    setConfigStatus('正在清除...', 'status-bar');
    const result = await new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'clearSyncCache', scope }, resolve);
    });
    if (result && result.success) {
      if (result.cloudCleared === false) {
        setConfigStatus('✓ 本地缓存已清除（云端清理失败，请检查网络后重试）', 'status-bar ok');
      } else {
        setConfigStatus('✓ 同步缓存已清除', 'status-bar ok');
      }
    } else {
      setConfigStatus('重置失败：' + (result && result.message || '未知错误'));
      configStatusBar.className = 'status-bar err';
    }
  } else {
    // ====== 配置未保存：清空表单 ======
    document.getElementById('webdav_url').value = '';
    document.getElementById('webdav_user').value = '';
    document.getElementById('webdav_password').value = '';
    document.getElementById('webdav_path').value = '';
    syncEnabledCb.checked = false;
    intervalSelect.value = '30';
    syncTypeSelect.value = 'merge';
    syncOptions.classList.add('hide');
    updateInsecureUrlHint();

    // 同时清除未保存草稿，避免下次打开又被恢复
    await clearDraft();

    // 刷新脏态 UI：若基线里本来有值，现在被清空就会整排高亮提示需要点保存
    updateDirtyUI();

    setConfigStatus('已清空表单（点击「保存」后生效）', 'status-bar ok');
  }
};

// ========== 清空配置（强操作：需确认） ==========
const deleteConfigBtn = document.getElementById('deleteConfigBtn');
if (deleteConfigBtn) {
  deleteConfigBtn.onclick = async () => {
    const ok = await openConfirm({
      title: '清空极简配置？',
      body: '此操作不可撤销。<span class="note-inline">本地书签不受影响</span>',
      okText: '清空',
      cancelText: '取消',
      danger: true,
      icon: '⚠'
    });
    if (!ok) return;

    await chrome.storage.local.remove([
      // ★ 嵌套配置对象必须一并删除：getWebDAVConfig 在扁平 key 缺失时会从
      //   webdav_config 自动补写回 webdav_url 等扁平 key（「规范化」逻辑），
      //   漏删会导致清空后旧配置复活（早年双写引入的回归）。
      'webdav_config',
      'webdav_url',
      'webdav_user',
      'webdav_password',
      'webdav_bookmark_path',
      'sync_enabled',
      'sync_interval',
      'sync_type',
      'ever_connected',
      // 同步状态（实际使用的 key，旧列表里的 last_sync_at/count 是老版 key，保留兼容）
      'sync_status',
      'sync_error',
      'last_sync_time',
      'sync_action',
      'last_sync_at',
      'last_sync_count',
      // 快照/墓碑/端点/日志（与 clearSyncCache 对齐，确保彻底清空）
      'sync_snapshots',
      'sync_tombstones',
      'sync_endpoints',
      'sync_move_intents',
      'sync_log',
      'berry_pathkey_snapshot',
      'via_pathkey_snapshot',
      'aira_pathkey_snapshot',
      '_is_non_chrome_browser',
      'bookmark_snapshot_v2',
      'cloud_snapshot_v1',
      'cloud_last_modified',
      'sync_lock_at',
      'local_backup_before_import',
      'non_chrome_browser_detected',
      DRAFT_KEY
    ]);

    // 通知 background 按新配置重建 alarm（无配置会自动关闭定时器）
    try { await chrome.runtime.sendMessage({ action: 'updateSyncInterval' }); } catch (e) { /* ignore */ }

    // 清表单、清草稿、清基线
    document.getElementById('webdav_url').value = '';
    document.getElementById('webdav_user').value = '';
    document.getElementById('webdav_password').value = '';
    document.getElementById('webdav_path').value = '';
    syncEnabledCb.checked = false;
    intervalSelect.value = '30';
    syncTypeSelect.value = 'merge';
    syncOptions.classList.add('hide');
    updateInsecureUrlHint();
    savedBaseline = null;
    if (draftSaveTimer) { clearTimeout(draftSaveTimer); draftSaveTimer = null; }

    // 回到主页，renderHome 会因为无配置自动切到创建页
    showHome();
  };
}

// ========== 配置页「测试连接」按钮 ==========
testConnectionBtn.onclick = async () => {
  const url = document.getElementById('webdav_url').value.trim();
  const user = document.getElementById('webdav_user').value.trim();
  const password = document.getElementById('webdav_password').value;
  const rawPath = document.getElementById('webdav_path').value.trim();

  if (!url || !user || !password) {
    setConfigStatus('请填写完整的 WebDAV 地址、用户名和应用密码', 'status-bar err');
    return;
  }
  if (!rawPath || rawPath === '/') {
    setConfigStatus('请填写云端同步文件夹路径，如 /minibookmark', 'status-bar err');
    return;
  }
  if (!/^https?:\/\/.+/.test(url)) {
    setConfigStatus('WebDAV 地址必须以 http:// 或 https:// 开头', 'status-bar err');
    return;
  }

  // 域名授权：同样在 await 之前同步发起、且不阻塞测试（理由见保存分支的注释）。
  // 能不能真的用由下面这次真实请求决定；失败信息带真实原因，不再被权限预检掩盖。
  MiniSync.utils.requestHostPermission(url).catch(() => {});

  // 归一化路径用于实际测试（normalize 内部已做安全校验，非法会抛错）
  let path;
  try {
    path = MiniSync.utils.normalizeBookmarkPath(rawPath);
  } catch (e) {
    setConfigStatus(e.message, 'status-bar err');
    return;
  }

  setConfigStatus('正在测试连接...');
  // 走 background 测试连接，避免 popup 弹 HTTP 认证框；传原始路径让 background 做 normalize
  const result = await chrome.runtime.sendMessage({
    action: 'testConnection',
    webdavUrl: url,
    webdavUser: user,
    webdavPassword: password,
    webdavPath: rawPath
  });
  if (result && result.success) {
    setConfigStatus(result.message, 'status-bar ok');
    await chrome.storage.local.set({ ever_connected: true });
  } else {
    // 把后台返回的原始报错显示出来；确实没响应才说「无响应」——
    // 旧写法一律显示「SW 未就绪」，会把真正的失败原因（书签接口/网络/鉴权）全藏起来。
    setConfigStatus('连接失败：' + MiniSync.utils.describeMessageFailure(result), 'status-bar err');
  }
};

// 仅用于 UI 比较（脏态、草稿 diff）：容忍非法输入，不抛错
function normalizeBookmarkPathSafe(raw) {
  try { return MiniSync.utils.normalizeBookmarkPath(raw); }
  catch (_) { return '__INVALID__:' + (raw || ''); }
}

/**
 * 「云端同步文件夹」输入防呆：该框的语义是【文件夹路径】（如 /minibookmark）。
 * 若用户误把文件名当路径填入（如 /minibookmarks.xbel），保存后会拼出双层嵌套
 * （/minibookmarks.xbel/minibookmarks.xbel）。此处检测常见书签文件后缀并自动
 * 剥去文件名段，只保留目录部分。返回 { path, corrected }。
 */
function sanitizeFolderPathInput(raw) {
  let p = (raw || '').trim();
  if (!p) return { path: '', corrected: false };
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/\/+$/, '');
  const FILE_RE = /\.(xbel|json|html|txt)$/i;
  let corrected = false;
  if (FILE_RE.test(p)) {
    const idx = p.lastIndexOf('/');
    p = idx > 0 ? p.slice(0, idx) : '';
    corrected = true;
  }
  return { path: p, corrected };
}

// 手动同步：统一走 background，确保与自动同步共享同一把互斥锁
// 操作记录文案映射
const SYNC_ACTION_LABELS = {
  upload:   { running: '正在上传...',   successTag: '上传成功', failPrefix: '上传失败：' },
  download: { running: '正在下载...',   successTag: '下载成功', failPrefix: '下载失败：' },
  merge:    { running: '正在合并两端...', successTag: '合并成功', failPrefix: '合并失败：' }
};

async function runSyncAction(action) {
  const label = SYNC_ACTION_LABELS[action];
  const attemptedAt = Date.now();
  setStatus(label.running);
  renderProgressLine(null);
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ action });
  } catch (e) {
    // popup 在消息回来前被关闭、SW 异常等场景
    setStatus(label.failPrefix + (e.message || String(e)), 'err');
    return;
  }

  // ★ 后台没回响应（手机端宿主会丢响应）：不要张口就报「失败：未知错误」——
  //   去后台写下的操作台账里核实这一次到底成没成。台账里也没有 ⇒ 如实说「没拿到回执」，
  //   然后轮询后台状态，等它给出结论。
  if (!resp) {
    const recovered = await recoverSyncResultFromLedger(action, attemptedAt);
    if (!recovered) {
      setStatus('已发出，但没拿到后台回执（可能仍在后台进行）', 'warn');
      startStatusPolling(action, attemptedAt);
      return;
    }
    resp = recovered;
    const recoveredStatus = MiniSync.utils.describeActionStatus(recovered, label);
    applySyncResult(action, label, {
      text: recoveredStatus.text + '（后台台账）',
      level: recoveredStatus.level
    }, recovered);
    return;
  }

  // 上传冲突：询问用户是否强制覆盖（1.0.4 对齐：显示云端修改时间）
  if (action === 'upload' && resp && !resp.success && resp.code === 'CLOUD_CONFLICT') {
    const cloudTime = resp.remoteModified ? MiniSync.utils.escapeHtml(new Date(resp.remoteModified).toLocaleString()) : '最近';
    const ok = await openConfirm({
      title: '检测到云端更新',
      body: `云端文件在 ${cloudTime} 被其他设备修改过。<br>是否强制用本地书签覆盖云端？<br><span class="note-inline">覆盖后云端数据将被替换</span>`,
      okText: '强制覆盖',
      cancelText: '取消',
      danger: true,
      icon: '!'
    });
    if (!ok) {
      setStatus('已取消上传', 'err');
      return;
    }
    setStatus('正在强制覆盖...');
    try {
      resp = await chrome.runtime.sendMessage({ action: 'upload', force: true });
    } catch (e) {
      setStatus(label.failPrefix + (e.message || String(e)), 'err');
      return;
    }
  }
  // 状态行单源化：有写入失败时显示成红色（不能因为 success=true 就报绿「成功」）
  applySyncResult(action, label, MiniSync.utils.describeActionStatus(resp, label), resp);

  // 安全阀触发提醒：云端数据差异较大，询问是否使用历史备份恢复
  if (resp && resp.safetyValve) {
    const restore = await openConfirm({
      title: '检测到云端数据差异较大',
      body: '已跳过异常删除，当前同步结果可能不完整。<br>是否使用历史备份恢复书签？',
      okText: '恢复备份',
      cancelText: '忽略'
    });
    if (restore) {
      setStatus('正在恢复历史备份...');
      const restoreResp = await new Promise(resolve => {
        chrome.runtime.sendMessage({ action: 'restoreFromBackup' }, resolve);
      });
      if (restoreResp && restoreResp.success) {
        setStatus('✓ 已从历史备份恢复', 'ok');
        const r = await chrome.storage.local.get(['last_sync_count']);
        renderProgressLine(r.last_sync_count, undefined, 'ok');
      } else {
        setStatus('恢复失败：' + (restoreResp && restoreResp.message || '无可用备份'), 'err');
      }
    }
  }
}

// 同步结果落地：状态行 + 上次同步时间 + 进度行。
// ★ 成功的提示必须一眼可见（手机上就问「成了没有」）：成功统一加 ✓ 前缀，
//   进度行同色；失败保持红色原文，绝不把失败糊成成功。
async function applySyncResult(action, label, st, resp) {
  setStatus(st.level === 'ok' ? '✓ ' + st.text : st.text, st.level);
  const { last_sync_at, last_sync_count } = await chrome.storage.local.get(['last_sync_at', 'last_sync_count']);
  renderLastSync(last_sync_at);
  // 合并/上传/下载都显示操作记录总数；合并不展示新增/删除明细，仅显示共 X 条书签
  const displayCount = (resp && resp.bookmarkCount) || last_sync_count;
  if (action === 'merge') {
    renderProgressLine(displayCount, undefined, st.level);
  } else {
    renderProgressLine(displayCount, resp && resp.diff, st.level);
  }
}

// 同步结果台账读取（后台写进 storage 的 sync_log）：消息通道不回话时，靠它如实分辨成败。
// ⚠️ 只认「同一个动作、且在本次点击之后写下」的那条记录。存储里有条成功记录不等于本次成功
//    （可能是上一轮的），没有本次证据就宁可说「没拿到回执」。
const SYNC_LOG_ACTION = { upload: '上传', download: '下载', merge: '合并' };
async function recoverSyncResultFromLedger(action, attemptedAt) {
  let data;
  try {
    data = await chrome.storage.local.get(['sync_log']);
  } catch (_) {
    return null;
  }
  const logs = (data && data.sync_log) || [];
  // 判据（动作一致 + 时间不早于本次点击）单源在 lib/utils.js：与测试共用同一份实现，
  // 免得「测试过的判据」和「真在跑的判据」是两套。
  return MiniSync.utils.pickSyncLogRecord(logs, SYNC_LOG_ACTION[action], attemptedAt);
}

// ★ 任务进行中：仅禁用对应动作的那一个按钮（外观不变灰，仅禁用光标），
//   悬停 title 显示对应任务（「上传进行中」「下载进行中」「合并进行中」）。
//   其他按钮不禁用——点击会被重入守卫拦下并提示「同步进行中，请稍候」。
const SYNC_BTN_BUSY_TITLE = { upload: '上传进行中', download: '下载进行中', merge: '合并进行中' };
function setSyncBtnBusy(action, busy) {
  const btn = action === 'upload' ? uploadBtn : action === 'download' ? downloadBtn : syncBtn;
  if (!btn) return;
  if (busy) {
    if (!btn.dataset.title) btn.dataset.title = btn.title; // 保存原标题
    btn.title = SYNC_BTN_BUSY_TITLE[action] || '同步进行中';
  } else if (btn.dataset.title) {
    btn.title = btn.dataset.title; // 还原
  }
  btn.disabled = busy;
}
let syncActionRunning = false;
async function runSyncActionGuarded(action) {
  if (syncActionRunning) {
    setStatus('同步进行中，请稍候', 'err');
    return;
  }
  syncActionRunning = true;
  setSyncBtnBusy(action, true);
  try {
    await runSyncAction(action);
  } finally {
    syncActionRunning = false;
    setSyncBtnBusy(action, false);
  }
}
uploadBtn.onclick   = () => runSyncActionGuarded('upload');
downloadBtn.onclick = () => runSyncActionGuarded('download');
syncBtn.onclick     = () => runSyncActionGuarded('merge');

// ========== 徽标点击：切换自动同步 ==========
connBadge.onclick = async () => {
  // 未配置时不允许切换
  if (connBadge.classList.contains('disabled')) {
    setStatus('请先完成 WebDAV 配置', 'err');
    return;
  }
  const r = await chrome.storage.local.get(['sync_enabled']);
  const next = !r.sync_enabled;
  await chrome.storage.local.set({ sync_enabled: next });
  // 通知 background 重建 alarm（启用/停用定时器）
  // 启用时不立即同步：统一等间隔到点由 alarm 触发
  try { await chrome.runtime.sendMessage({ action: 'updateSyncInterval' }); } catch (e) {}
};

// ========== 监听 storage 变化 ==========
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const configChanged = ['webdav_url', 'webdav_user', 'webdav_password',
    'webdav_bookmark_path', 'webdav_config', 'bookmark_target_id'].some(key => changes[key]);
  if (configChanged) {
    // Replace synchronously: an old in-flight promise can outlive invalidate().
    _statusProbe.invalidate();
    const probe = _statusProbe = MiniSync.utils.createCoalescedProbe(STATUS_PROBE_TTL);
    if (!homeView.classList.contains('hide')) {
      setStatus('正在检查配置...');
      renderProgressLine(null);
    }
    chrome.storage.local.remove(CONN_CACHE_STORAGE_KEY).catch(() => {}).then(() => {
      if (probe === _statusProbe) loadAll();
    });
  }
  if (changes.last_sync_at) {
    renderLastSync(changes.last_sync_at.newValue);
  }
  if (changes.last_sync_count) {
    // 不在此处渲染操作记录，由 runSyncAction 的 sendResponse 回调统一渲染（带 diff）
  }
  if (changes.ever_connected && !configChanged) {
    updateHomeStatus();
  }
  if (changes.sync_enabled || changes.sync_interval || changes.sync_type) {
    chrome.storage.local.get(
      ['sync_enabled', 'sync_interval', 'sync_type', 'webdav_url', 'webdav_user', 'webdav_password']
    ).then((r) => {
      renderAutoSync(!!r.sync_enabled, r.sync_interval, r.sync_type);
      const configured = !!(r.webdav_url && r.webdav_user && r.webdav_password);
      renderBadge(configured, !!r.sync_enabled);
    });
  }
});

// "上次同步"仅在 popup 打开时计算一次，不做实时读秒刷新
// 下次打开 popup 自然会重新计算相对时间

// 入口
bindDraftAutosave();
bindPasswordToggle();
bindFieldHints();
loadAll();

// 跳转到选项页（配置详情页）
if (openOptionsLink) {
  openOptionsLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}
