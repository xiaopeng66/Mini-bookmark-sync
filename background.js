// ====== Step 0: 初始化 MiniSync 命名空间 ======
var MiniSync = MiniSync || {};

// ====== Step 1: 加载所有模块 ======
// ⚠️ 两种宿主加载方式不同，都要能跑：
//   · MV3 service worker（Chrome/Edge）—— 有 importScripts，靠它按序加载；
//   · MV2 事件页（Firefox/Gecko 系宿主，如可拓/雨见这类用 Gecko 扩展引擎的浏览器）
//     —— 是普通文档，没有 importScripts；那些文件由 manifest 的 background.scripts
//     按同一顺序加载，这里必须跳过。
//   背景：Gecko 系宿主不支持 MV3 的 background.service_worker（清单校验直接报
//   "background.service_worker is currently disabled. Add background.scripts."），
//   在那种宿主上 MV3 包的【后台从不运行】：界面能打开，但书签数恒为 0、
//   设备 ID 永不生成、同步完全不可能。
if (typeof importScripts === 'function') {
  importScripts(
    'lib/constants.js',
    'lib/utils.js',
    'model/xbel.js',
    'model/xbel-path.js',
    'model/tombstone.js',
    'lib/webdav.js',
    'adapters/browser-detect.js',
    'adapters/edge-adapter.js',
    'adapters/berry-adapter.js',
    'adapters/via-adapter.js',
    'adapters/aira-adapter.js',
    'core/bridge-patcher.js',
    'core/storage.js',
    'lib/import.js',
    'lib/merge.js',
    'core/sync-input.js',
    'core/sync-merge.js',
    'core/sync-orchestrator.js',
    'lib/sync-actions.js'
  );
}

// 工具栏图标 API：MV3 是 chrome.action，MV2 是 chrome.browserAction
const ACTION_API = (typeof chrome !== 'undefined') ? (chrome.action || chrome.browserAction || null) : null;
// 书签 API 是否可用：部分移动端分支的扩展宿主根本不向扩展开放书签接口。
// 这种情况必须让设置页显示「不可用」，而不是伪装成「0 条」——否则排查时分不清
// 「浏览器没给 API」和「书签真的是空的」。
const HAS_BOOKMARKS_API = (typeof chrome !== 'undefined') && !!chrome.bookmarks && typeof chrome.bookmarks.getTree === 'function';
// 定时器 API 是否可用：同样是「宿主可能没给」的接口。没有它自动同步就只剩手动一条路，
// 必须如实报给用户（诊断报告里能看到），而不是静默地什么都不做。
// ★ 只要求【真正必需】的两项：create（挂定时器）与 onAlarm.addListener（收到到点通知）。
//   clear/get 属于「有更好、没有也不影响主功能」，各自 best-effort，不能因为缺它就把
//   整个自动同步判死（手机上「有 alarms 对象但实现不全」比「完全没有」更常见）。
const HAS_ALARMS_API = (typeof chrome !== 'undefined') && !!chrome.alarms &&
  typeof chrome.alarms.create === 'function' &&
  !!chrome.alarms.onAlarm && typeof chrome.alarms.onAlarm.addListener === 'function';
// 定时器最后一次校准的结果（诊断报告直接读它）：手机端「自动同步到底有没有挂上」看这里。
// 额外记账：定时器到底响过没有（fireCount）、最后一次补跑为什么没跑（lastCatchUp.reason）——
// 手机端 console 读不到，这两项是唯一能区分「没挂上」与「挂上了但没响」的证据。
var _autoAlarm = {
  reason: 'not-checked', wanted: null, apiAvailable: HAS_ALARMS_API,
  exists: null, periodInMinutes: null, action: 'not-checked', at: null,
  fireCount: 0, lastFireAt: null, catchUpCount: 0, lastCatchUp: null, lastError: null
};

// ====== Step 1.5: 统一全局日志（散落的 console 自动走 MiniSync.logger，并持久化最近错误）======
if (MiniSync.logger && MiniSync.logger.install) MiniSync.logger.install();

// 加载期/运行期错误留痕：宿主形态千奇百怪（移动端 fork），后台一旦「半死」，
// 页面上只能看到「后台未响应」。这里把错误收集起来，由 diagnose 一并报出去。
var _bgErrors = [];
if (typeof self !== 'undefined' && self.addEventListener) {
  self.addEventListener('error', (e) => {
    _bgErrors.push({ at: Date.now(), kind: 'error', message: String((e && e.message) || e) });
    if (_bgErrors.length > 20) _bgErrors.shift();
    persistBootReport('runtime-error');
  });
  self.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    _bgErrors.push({ at: Date.now(), kind: 'unhandledrejection', message: String((r && r.message) || r) });
    if (_bgErrors.length > 20) _bgErrors.shift();
    persistBootReport('unhandled-rejection');
  });
}

// ====== 开机登记 + 消息台账（★ 不依赖消息通道的排查凭据）======
// 背景：手机端 Gecko fork 上出现过「后台答过一次消息、之后所有消息都无响应」的现象。
// 而消息通道一旦不通，就再也问不出「后台到底有没有跑起来、消息有没有到过、崩在哪一步」——
// 于是把状态写进 storage.local（storage 在页面侧是通的），页面直接读。
// ⚠️ 这里不要引用 HAS_BOOKMARKS_API 等 const：本函数在脚本最开始就会被调用，
//    那时它们还在 TDZ 里，typeof 也会抛 ReferenceError；直接问 chrome 更稳。
var _bgBoot = { scriptAt: Date.now(), loads: 0, stage: 'script-start' };
var _bgLastMessage = null;
var _bgMsgCount = 0;

function persistBootReport(stage) {
  try {
    if (stage === 'script-start') _bgBoot.loads = (_bgBoot.loads || 0) + 1;
    _bgBoot.stage = stage;
    const manifest = (chrome.runtime && chrome.runtime.getManifest) ? chrome.runtime.getManifest() : {};
    chrome.storage.local.set({
      bg_boot_report: {
        at: Date.now(),
        scriptAt: _bgBoot.scriptAt,
        loads: _bgBoot.loads || 1,
        stage: stage,
        version: manifest.version,
        manifestVersion: manifest.manifest_version,
        id: (chrome.runtime && chrome.runtime.id) || null,
        ua: (typeof navigator !== 'undefined' && navigator.userAgent) || '(无 navigator)',
        importScripts: typeof importScripts,
        hasBookmarksApi: !!(chrome.bookmarks && typeof chrome.bookmarks.getTree === 'function'),
        hasActionApi: !!(chrome.action || chrome.browserAction),
        msgCount: _bgMsgCount || 0,
        lastMessage: _bgLastMessage,
        errors: (_bgErrors || []).slice(-10)
      }
    }, () => { void chrome.runtime.lastError; });
  } catch (_) { /* 诊断能力不该拖垮后台：存储不可用就算了 */ }
}

function recordIncoming(type) {
  try {
    _bgMsgCount = (_bgMsgCount || 0) + 1;
    _bgLastMessage = { type: type, at: Date.now(), total: _bgMsgCount };
    chrome.storage.local.set({ bg_last_message: _bgLastMessage }, () => { void chrome.runtime.lastError; });
  } catch (_) {}
}

// ====== 消息重放台账 ======
// 背景：同一条消息可能被投递两次 —— 页面先走宿主消息管道（后台执行完了，但响应被宿主丢掉），
// 页面侧超时后再走直接句柄兜底。两次都要经过 onRuntimeMessage，没有台账的话同一次同步
// 就会【执行两遍】：白等一个超时、云端被并发写两次，UI 还只能看到第二遍的结果。
// 页面侧给每条消息打了 __msgId（同一个 id 会随两次投递一起来），这里按它复用第一次的结果：
// 第二次投递只拿结果，绝不重跑处理器。
const MSG_LEDGER_TTL_MS = 60000;
const MSG_LEDGER_MAX = 40;
const _msgLedger = new Map(); // msgId -> { at:number, promise:Promise }
let _msgLedgerReplays = 0;

function ledgerLookup(id) {
  const now = Date.now();
  // 顺手清理过期项（Map 保持小尺寸，不必额外定时器）
  for (const [k, v] of _msgLedger) {
    if (now - v.at > MSG_LEDGER_TTL_MS) _msgLedger.delete(k);
  }
  return _msgLedger.get(id) || null;
}

persistBootReport('script-start');

// ====== Step 2: 注册 Chrome 事件监听 ======

// 安装/更新后按配置重建自动同步定时器
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // 设置默认配置
    chrome.storage.local.set({
      sync_status: IDLE,
      last_sync_time: null,
      sync_error: ''
    });
  }
  // 安装/更新后按配置重建自动同步定时器
  setupAutoSyncAlarm().catch((e) => console.warn('[MiniSync] 设置自动同步失败:', e.message));
});

// ⚠️ 书签类监听必须整段放在 HAS_BOOKMARKS_API 守卫内：宿主不开放书签 API 时
//    chrome.bookmarks.onRemoved 是 undefined，裸调用会在【加载期】抛异常，
//    导致后面的 onMessage 处理器注册不上 —— 表现是设置页「后台未响应」、
//    弹窗按钮全无反应，比单纯「不能用」更难排查。
if (HAS_BOOKMARKS_API && chrome.bookmarks.onRemoved) {

// 书签删除监听：将本地删除写入墓碑，使删除能传播到云端
chrome.bookmarks.onRemoved.addListener((id, removeInfo) => {
  handleBookmarkRemoved(id, removeInfo).catch(e =>
    console.warn('[MiniSync] 删除监听处理失败（忽略）:', e.message)
  );
});

}

if (HAS_BOOKMARKS_API && chrome.bookmarks.onMoved) {
// 书签移动监听：移动（同/跨文件夹）会使相关墓碑失效，及时清除防止误删。
// 背景：① 部分浏览器（实测 Edge）对移动操作也会派发 onRemoved，「挪动的书签」
//   被写入墓碑后，下一轮合并会按墓碑把它删除（表现为「挪动后书签消失」）；
//   ② 即使只有 onMoved，旧路径上的墓碑残留也会误杀后来出现在同路径的节点。
chrome.bookmarks.onMoved.addListener((id, moveInfo) => {
  (async () => {
    const curStatus = await MiniSync.storage.getSyncStatus();
    if (curStatus.status === SYNCING) return; // 落盘自身的移动不产生也不清理墓碑
    const data = await MiniSync.storage.getLocal([STORAGE_KEYS.TOMBSTONES]);
    const tombstones = data[STORAGE_KEYS.TOMBSTONES] || [];

    // 1. 移动前快照：取该子树的旧 pathKey
    const snapData = await MiniSync.storage.getLocal([STORAGE_KEYS.SNAPSHOTS]);
    const prevTree = (snapData[STORAGE_KEYS.SNAPSHOTS] && snapData[STORAGE_KEYS.SNAPSHOTS].localTree) || [];
    const prevPKMap = prevTree.length > 0 ? MiniSync.xbelPath.computeJsonPathKeys(prevTree) : new Map();
    const currentTree = await MiniSync.syncInput.getChromeTree();
    const newTree = MiniSync.merger.chromeTreeToList(currentTree);
    const subIds = new Set([String(id)]);
    for (const list of [prevTree, newTree]) {
      let changed = true;
      while (changed) {
        changed = false;
        for (const node of list) {
          if (subIds.has(String(node.parentId)) && !subIds.has(String(node.id))) {
            subIds.add(String(node.id));
            changed = true;
          }
        }
      }
    }
    const affected = new Set();
    for (const [nid, pk] of prevPKMap) {
      if (subIds.has(String(nid))) affected.add(pk);
    }

    // 只观察移动后路径，不提交尚未成功同步的基线。
    if (newTree.length > 0) {
      const newPKMap = MiniSync.xbelPath.computeJsonPathKeys(newTree);
      for (const [nid, pk] of newPKMap) {
        if (subIds.has(String(nid))) affected.add(pk);
      }
    }

    // 3. ★ 记录移动意图：合并时据此判定本端是移动「发起方」（本地即最新状态，不迁移）。
    //    显式意图标记不依赖跨端时钟（服务器时间/本机时间口径不一致，曾导致接收端被
    //    误判为发起端，表现为「挪动书签后另一端合并不跟随」）。
    if (affected.size > 0) {
      const intentsData = await MiniSync.storage.getLocal(['sync_move_intents']);
      const intents = intentsData.sync_move_intents || {};
      const devId = await MiniSync.storage.getDeviceId();
      const ts = Date.now();
      for (const pk of affected) intents[pk] = { time: ts, deviceId: devId };
      await MiniSync.storage.setLocal({ sync_move_intents: intents });
    }

    // 4. 清理相关墓碑（有墓碑才清）
    if (tombstones.length) {
      const filtered = tombstones.filter(t => !affected.has(t.key));
      if (filtered.length !== tombstones.length) {
        await MiniSync.storage.setLocal({ [STORAGE_KEYS.TOMBSTONES]: filtered });
        console.log(`[MiniSync] 书签移动：清理相关墓碑 ${tombstones.length - filtered.length} 条`);
      }
    }

    // 5. 防抖触发一次合并，让移动尽快传播（与 onRemoved 的处理一致）。
    //    若只依赖下个自动同步周期（默认 30 分钟）：① 移动要等最长一个间隔才传播；
    //    ② 一旦合并时超出移动意图 TTL，本端会被判为「接收方」，把本次移动
    //    迁回云端旧位置（表现为「挪动书签后自动同步，书签又跑回原处」）。
    if (affected.size > 0) {
      const moveCfg = await MiniSync.storage.getLocal(['sync_enabled', 'webdav_url']);
      if (moveCfg.sync_enabled && moveCfg.webdav_url) {
        if (_moveDebounceTimer) clearTimeout(_moveDebounceTimer);
        _moveDebounceTimer = setTimeout(async () => {
          _moveDebounceTimer = null;
          try {
            const status = await MiniSync.storage.getSyncStatus();
            if (status.status === SYNCING) return;
            await runAutoSync();
          } catch (e) {
            console.warn('[MiniSync] 移动监听触发合并失败（忽略）:', e.message);
          }
        }, MOVE_DEBOUNCE_MS);
      }
    }
  })().catch(e =>
    console.warn('[MiniSync] 移动监听清理墓碑失败（忽略）:', e.message)
  );
});

} // end if (HAS_BOOKMARKS_API && onRemoved && onMoved)

// ====== 工具栏图标状态徽章 ======
// 三态徽章（叠加在右下角，风格同系统 DevicePicker 徽章）：
//   ok    绿色勾：WebDAV 配置完整且上次同步未失败
//   unset 灰色勾：WebDAV 配置不完整（未配置好）
//   error 黄色叹号：配置完整但上次同步失败
// 同步进行中（SYNCING）保持当前徽章不变，避免「黄→绿→黄」来回闪跳。
const ACTION_ICONS = {
  ok:    { 16: 'icons/status-ok-16.png',    32: 'icons/status-ok-32.png' },
  unset: { 16: 'icons/status-unset-16.png', 32: 'icons/status-unset-32.png' },
  error: { 16: 'icons/status-error-16.png', 32: 'icons/status-error-32.png' }
};
let _currentIconState = null;
let _iconDebounceTimer = null;

/** 计算应有的图标状态；返回 null 表示「保持现状」（同步进行中） */
async function computeIconState() {
  const config = await MiniSync.storage.getWebdavConfig();
  if (!config.url || !config.username || !config.password) return 'unset';
  const status = await MiniSync.storage.getSyncStatus();
  if (status.status === SYNCING) return null;   // 同步中：保持现状
  if (status.status === FAILED) return 'error';
  return 'ok';                                   // success / idle（已配置即视为正常）
}

/** 按状态切换工具栏图标（100ms 防抖合并批量写入；相同状态跳过） */
async function updateActionIcon() {
  if (_iconDebounceTimer) clearTimeout(_iconDebounceTimer);
  _iconDebounceTimer = setTimeout(async () => {
    _iconDebounceTimer = null;
    try {
      const state = await computeIconState();
      if (!state || state === _currentIconState) return;
      _currentIconState = state;
      if (!ACTION_API) return; // MV2/MV3 都没有（极端宿主）：跳过，不影响同步
      await ACTION_API.setIcon({ path: ACTION_ICONS[state] });
    } catch (e) {
      console.warn('[MiniSync] 更新工具栏图标失败（忽略）:', e.message);
    }
  }, 100);
}

// 配置或同步状态落盘变化 → 刷新图标（覆盖：保存配置、同步成功/失败、清除配置）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const watched = ['sync_status', 'sync_error', 'webdav_config', 'webdav_url', 'webdav_user', 'webdav_password'];
  if (watched.some(k => k in changes)) updateActionIcon();
});

// SW 每次唤醒执行顶层代码时校准一次，保证图标与存储状态一致
updateActionIcon();

// ====== 自动同步定时器 ======
// ⚠️ alarms API 必须整段守卫：宿主不给这个 API 时 chrome.alarms 是 undefined，
//    裸注册 onAlarm 会在【加载期】抛异常，后面 onMessage 处理器就注册不上 ——
//    表现和「后台没运行」一模一样（本文件顶部书签监听踩过同一个坑）。
//    定时器本体在主流程之外，由 ensureAutoSyncAlarm() 按需重建，见文件下方。
if (HAS_ALARMS_API) {
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (!alarm || alarm.name !== SYNC_ALARM) return;
    _autoAlarm = Object.assign({}, _autoAlarm, {
      fireCount: (_autoAlarm.fireCount || 0) + 1,
      lastFireAt: Date.now(),
      lastFireName: alarm.name
    });
    await persistAutoSyncReport();
    await runAutoSyncSafely({ from: 'alarm' });
  });
}

// ★ 每次后台被唤醒（MV3 service worker 启动 / MV2 后台页加载 / 浏览器启动）都校准一次定时器。
//   为什么必须在【顶层】做：chrome.alarms 不跨浏览器会话保留（MDN），手机端 Gecko 系宿主
//   每次重启浏览器都会丢掉定时器；只在 onInstalled / 保存配置时建的话，手机端自动同步
//   在重启后就永久失效（桌面 Chromium 自己会保留 alarms，所以一直看不出问题）。
//   ensure（而不是 force）⇒ 定时器健在且间隔没变时不动它，绝不重置倒计时。
//
// ⚠️ 校准与补跑必须是【两个独立的失败域】：宿主给了一个「能创建但会抛错」的 alarms 时，
//    校准失败若把补跑一起带走，自动同步就彻底没有了 —— 而补跑恰恰是这种宿主上唯一的
//    自动同步路径。用户手机上就是这么「装了新版还是不自动同步」的。
(async () => {
  try {
    await ensureAutoSyncAlarm('boot');
  } catch (e) {
    _autoAlarm = Object.assign({}, _autoAlarm, { lastError: 'ensure: ' + ((e && e.message) || String(e)) });
    console.warn('[MiniSync] 启动校准自动同步定时器失败:', e && e.message);
  }
  try {
    // 浏览器关着的那段时间没人能跑自动同步：唤醒时把错过的那一次补上（宿主没有
    // alarms API、或 alarms 不响时，这也是唯一能让自动同步动起来的路径）。
    await catchUpMissedAutoSync();
  } catch (e) {
    _autoAlarm = Object.assign({}, _autoAlarm, { lastError: 'catch-up: ' + ((e && e.message) || String(e)) });
    console.warn('[MiniSync] 启动补跑自动同步失败:', e && e.message);
  }
  await persistAutoSyncReport();
})();

// 启动崩溃恢复：本地书签为空且存在备份时自动恢复
chrome.runtime.onStartup.addListener(async () => {
  try {
    await startupRecovery();
  } catch (e) {
    console.error('[MiniSync] 启动恢复检查失败:', e.message);
  }
  // 浏览器启动是新会话：定时器必须在这里补建一次（顶层那次可能早于 storage 就绪）
  try {
    await ensureAutoSyncAlarm('startup');
  } catch (e) {
    console.warn('[MiniSync] 启动重建自动同步定时器失败:', e.message);
  }
  // 同样独立失败域：补跑不依赖定时器有没有挂上
  try {
    await catchUpMissedAutoSync();
  } catch (e) {
    console.warn('[MiniSync] 启动补跑自动同步失败:', e.message);
  }
});

// ★ 同步任务（上传/下载/合并）进行中判定：供检测类消息短路，
//   避免检测请求与进行中的同步并发访问云端、互相干扰。
// 返回 { busy, action }：action 为任务类型，供前端显示「XX进行中」。
async function getSyncBusyInfo() {
  try {
    const s = await MiniSync.storage.getSyncStatus();
    if (s && s.status === SYNCING) return { busy: true, action: s.action || 'merge' };
    return { busy: false };
  } catch (_) {
    return { busy: false };
  }
}

// 给任意 promise 套一个硬超时：移动端 fork 上 AbortController 未必生效
//（webdav.testConnection 的 15s 中断就成了空话），那样后台会永远不回消息，
// 页面上只能看到一句「后台无响应」。有了它，后台至少能给出「多慢/为什么」的结论。
function withTimeout(promise, ms, timeoutMessage) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ success: false, timedOut: true, message: timeoutMessage });
    }, ms);
    Promise.resolve(promise).then(
      (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); },
      (e) => { if (done) return; done = true; clearTimeout(timer); resolve({ success: false, message: (e && e.message) || String(e) }); }
    );
  });
}

// 消息路由（兼容旧格式 action + 新格式 type）
// ⚠️ 写成具名函数而不是内联箭头：__MiniSyncDispatchDirect（见文件下方）要复用同一份分发逻辑。
function onRuntimeMessage(message, sender, sendResponse) {
  if (!message) return false;

  // 兼容旧格式：action 字段
  const msgType = message.type || message.action;
  if (!msgType) return false;

  // 消息台账：每收到一条就记一次（写进 storage，页面侧可读）。
  // 这是「消息到底有没有到后台」的唯一凭据 —— 消息通道不回话时，只能靠它分辨
  // 「后台没收到」和「收到了但没答」。
  recordIncoming(msgType);

  // ★ 重放台帐：同一条消息的第二次投递（兜底重发）只取第一次的结果，绝不重复执行
  const ledgerId = (message && typeof message.__msgId === 'string' && message.__msgId) ? message.__msgId : null;
  if (ledgerId) {
    const hit = ledgerLookup(ledgerId);
    if (hit) {
      _msgLedgerReplays++;
      // 第一次那次可能还在跑：这里等它出结果，然后把同一个结果回给兜底那条路。
      // ⚠️ 先 settle 台账再调 sendResponse —— 后者可能在「消息端口已关闭」时抛错，
      //    不能让一个已经拿到结果的请求因为这个抛错而永远挂着。
      hit.promise.then(
        (r) => { try { sendResponse(r); } catch (_) { /* 端口已关：结果已在台账里，忽略 */ } },
        () => sendResponse({ success: false, message: '重放上次结果失败' })
      );
      return true;
    }
    if (_msgLedger.size >= MSG_LEDGER_MAX) {
      const oldest = _msgLedger.keys().next().value;
      if (oldest !== undefined) _msgLedger.delete(oldest);
    }
    let settle;
    const p = new Promise((resolve) => { settle = resolve; });
    _msgLedger.set(ledgerId, { at: Date.now(), promise: p });
    // 包一层 sendResponse：任何一次回应都会把结果连同台账一起落定
    const origSend = sendResponse;
    sendResponse = (r) => { settle(r); try { origSend(r); } catch (_) { /* 见上 */ } };
  }

  switch (msgType) {
    // 新格式 / 旧格式兼容
    case 'upload':
      handleAsyncResponse(sendResponse, () =>
        MiniSync.actions.uploadBookmarks({
          ...(message.options || {}),
          ...(message.force !== undefined ? { force: message.force } : {})
        })
      );
      return true;

    case 'DOWNLOAD_BOOKMARKS':
    case 'download':
      handleAsyncResponse(sendResponse, () =>
        MiniSync.actions.downloadBookmarks(message.options)
      );
      return true;

    case 'MERGE_SYNC':
    case 'merge':
      handleAsyncResponse(sendResponse, () =>
        MiniSync.actions.mergeSync(message.options)
      );
      return true;

    case 'GET_STATUS':
    case 'getStatus':
      handleAsyncResponse(sendResponse, async () => {
        const status = await MiniSync.storage.getSyncStatus();
        return { success: true, data: status };
      });
      return true;

    case 'GET_CONFIG':
    case 'getConfig':
      handleAsyncResponse(sendResponse, async () => {
        const config = await MiniSync.storage.getWebdavConfig();
        return { success: true, data: config };
      });
      return true;

    case 'SAVE_CONFIG':
    case 'saveConfig':
      handleAsyncResponse(sendResponse, async () => {
        await MiniSync.storage.setWebdavConfig(message.config);
        return { success: true, message: '配置已保存' };
      });
      return true;

    case 'GET_ENDPOINTS':
    case 'getEndpoints':
      handleAsyncResponse(sendResponse, async () => {
      // 如果传了 webdavUrl，说明是从云端读取（popup.js），需按 deviceId 解包
        if (message.webdavUrl) {
          const config = await MiniSync.webdav.getWebDAVConfig();
          if (!config.url) return { ok: false, message: '未配置 WebDAV' };
          const xbelStr = await MiniSync.webdav.getFile(config.url, config.username, config.password, config.filename);
          if (!xbelStr) return { ok: false, message: '无法读取 XBEL' };
          const pluginData = MiniSync.xbel.parseXbelFromString(xbelStr);
          if (!pluginData) return { ok: false, message: 'XBEL 解析失败' };
          const allDeviceEps = pluginData.endpoints || {};
          const devId = await MiniSync.storage.getDeviceId();
      // 兼容旧格式：如果 endpoints 不是按设备分（直接是 {berry:{},via:{}}），直接返回
          const isLegacyFormat = !allDeviceEps[devId] && (allDeviceEps.berry || allDeviceEps.via);
          const myEps = isLegacyFormat ? allDeviceEps : (allDeviceEps[devId] || {});
          return { ok: true, endpoints: myEps };
        }
      // 否则返回本地数据（options.js 使用，本地已是扁平格式）
        const data = await MiniSync.storage.getLocal(['sync_endpoints']);
        return { ok: true, endpoints: data.sync_endpoints || {} };
      });
      return true;

    case 'SAVE_ENDPOINTS':
    case 'saveEndpoints':
      handleAsyncResponse(sendResponse, async () => {
        await MiniSync.storage.setLocal({ sync_endpoints: message.endpoints });
        return { ok: true, message: '端点配置已保存' };
      });
      return true;

    // ---- 旧版辅助消息（完整实现）----

    // 测试 WebDAV 连接（使用 popup 传入的参数）
    case 'testConnection':
      handleAsyncResponse(sendResponse, async () => {
        // 优先使用 popup 传入的参数（用户刚输入的新值）
        const testUrl = message.webdavUrl || '';
        const testUser = message.webdavUser || '';
        const testPass = message.webdavPassword || '';
        // 路径暂不用于连接测试，仅记录

        if (!testUrl) {
          return { success: false, message: '请先填写 WebDAV 地址' };
        }

        const config = { url: testUrl, username: testUser, password: testPass };
        const result = await MiniSync.actions.testConnection(config);
        return {
          success: result.success,
          code: result.code,
          message: result.success ? result.message : ('连接失败: ' + (result.message || '未知错误'))
        };
      });
      return true;

    // 检查配置连通性（真实访问云端，而非仅本地完整性判断）
    case 'checkConfig':
      handleAsyncResponse(sendResponse, async () => {
        // ★ 同步进行中跳过连通性检测（前端显示「XX进行中」，不报失败/未就绪）
        const busyInfo = await getSyncBusyInfo();
        if (busyInfo.busy) return { ok: false, busy: true, action: busyInfo.action, message: '同步进行中，已跳过检测' };
        const config = await MiniSync.storage.getWebdavConfig();
        if (!config.url || !config.username || !config.password) {
          return {
            ok: false,
            hasUrl: !!config.url,
            hasAuth: !!(config.username && config.password),
            error: '未配置 WebDAV 地址、用户名或密码'
          };
        }
        // 真实连接测试（自带 15s 超时，含权限守门）
        // ⚠️ 外面再套一层 20s 硬超时：宿主若不理会 AbortController，
        //    里层永不返回，后台就永远不回消息（页面只能显示「后台无响应」）。
        const result = await withTimeout(
          MiniSync.actions.testConnection({
            url: config.url,
            username: config.username,
            password: config.password
          }),
          20000,
          'WebDAV 连接测试 20s 未返回（宿主可能不支持请求中断，请检查网络或地址）'
        );
        if (!result || !result.success) {
          return {
            ok: false,
            hasUrl: !!config.url,
            hasAuth: true,
            // code='NEED_PERMISSION' 时前端要显示「授权域名访问」按钮（授权必须在页面手势里做）
            code: (result && result.code) || undefined,
            error: (result && result.message) || '连接失败'
          };
        }
        // 连接成功后附带检查同步文件是否存在
        let fileExists = false;
        try {
          fileExists = !!(await MiniSync.webdav.checkFileExists(config.filename));
        } catch (_) { /* 文件检查失败不影响连接判断 */ }
        return {
          ok: true,
          hasUrl: !!config.url,
          hasAuth: true,
          hasPath: !!config.filename && config.filename !== DEFAULT_FILENAME,
          isCustomPath: config.filename !== DEFAULT_FILENAME,
          fileExists: fileExists
        };
      });
      return true;

    // 后台是否活着（最轻量的探针：不碰任何宿主 API）
    // ⚠️ 响应必须「同步 sendResponse + return true」：某些移动端 fork 上，
    //    监听器返回 false 时会把紧随其后的同步响应一起丢掉（手机实测「ping 返回空」）。
    //    返回 true 在 Chromium / Gecko 上都是合法的（响应已发出，通道随即关闭）。
    case 'ping':
      sendResponse({
        ok: true,
        at: Date.now(),
        version: (chrome.runtime.getManifest ? chrome.runtime.getManifest().version : null),
        manifestVersion: (chrome.runtime.getManifest ? chrome.runtime.getManifest().manifest_version : null),
        hasBookmarksApi: HAS_BOOKMARKS_API,
        hasActionApi: !!ACTION_API,
        transport: 'ping'
      });
      return true;

    // 同上，但故意沿用「同步 sendResponse + return false」的旧写法。
    // 这是给诊断用的对照探针：两个探针结果不同 ⇒ 该宿主的响应语义是「返回 false 就丢响应」。
    case 'pingLegacy':
      sendResponse({ ok: true, at: Date.now(), transport: 'pingLegacy-sync-return-false' });
      return false;

    // 后台自述诊断：只报后台这一侧才知道的事实（页面侧另有 collectDiagnostics）
    case 'diagnose':
      handleAsyncResponse(sendResponse, async () => {
        const manifest = chrome.runtime.getManifest ? chrome.runtime.getManifest() : {};
        let bookmarkCount = null;
        try {
          bookmarkCount = { ok: true, count: await countLocalBookmarks() };
        } catch (e) {
          bookmarkCount = { ok: false, code: HAS_BOOKMARKS_API ? 'BOOKMARKS_API_FAILED' : 'NO_BOOKMARKS_API', error: (e && e.message) || String(e) };
        }
        const cfg = await MiniSync.storage.getLocal(['webdav_url', 'sync_enabled']);
        const perm = cfg.webdav_url
          ? await MiniSync.utils.hasHostPermission(cfg.webdav_url)
          : { ok: true, skipped: true };
        return MiniSync.utils.sanitizeDiagnosticValue({
          ok: true,
          at: new Date().toISOString(),
          extensionId: chrome.runtime.id,
          extensionVersion: manifest.version,
          manifestVersion: manifest.manifest_version,
          manifestPermissions: manifest.permissions,
          manifestHostPermissions: manifest.host_permissions || manifest.optional_host_permissions,
          ua: (typeof navigator !== 'undefined' && navigator.userAgent) || '(无 navigator)',
          // ⚠️ 不能用 typeof importScripts 判断：手机端 fork 连普通扩展页面都暴露 importScripts，
          //    会把 MV2 页面误标成 mv3-service-worker。真凭据只有 manifest_version。
          backgroundType: (manifest.manifest_version === 3) ? 'mv3-service-worker' : 'mv2-background-page',
          bootStage: _bgBoot.stage,
          bootLoads: _bgBoot.loads,
          msgCount: _bgMsgCount || 0,
          lastMessage: _bgLastMessage,
          globals: {
            importScripts: typeof importScripts,
            action: typeof chrome.action,
            browserAction: typeof chrome.browserAction,
            bookmarks: typeof chrome.bookmarks,
            bookmarksOnRemoved: (chrome.bookmarks && typeof chrome.bookmarks.onRemoved) || 'undefined',
            permissions: typeof chrome.permissions,
            alarms: typeof chrome.alarms,
            storageLocal: !!(chrome.storage && chrome.storage.local)
          },
          hasBookmarksApi: HAS_BOOKMARKS_API,
          bookmarkCount,               // ★ 书签接口能不能真读，这里带原始报错
          // ★ 自动同步定时器实况：手机端「明明开了自动同步却从不自动跑」看这一项就能定性
          //   （exists=false / apiAvailable=false 都能直接读出来，不必再猜）。
          autoAlarm: await describeAutoAlarm(),
          autoSyncNextAt: (await MiniSync.storage.getLocal(['auto_sync_next_at'])).auto_sync_next_at || null,
          webdavUrl: cfg.webdav_url || '',
          syncEnabled: !!cfg.sync_enabled,
          permissionQuery: perm,       // 权限接口可用性（不可用会带超时原文）
          moduleErrors: _bgErrors.slice(-10)
        });
      });
      return true;

    // 获取本地书签数量（后台统计避免页面直读 getTree 卡顿）
    case 'getLocalBookmarksCount':
      handleAsyncResponse(sendResponse, async () => {
        // 宿主未开放书签 API：明确上报，设置页据此显示「不可用」而不是「0 条」
        if (!HAS_BOOKMARKS_API) {
          return { ok: false, code: 'NO_BOOKMARKS_API', message: '当前浏览器未向扩展开放书签 API' };
        }
        // 读得到就报数量；读不到必须把【原始报错】一起回去（页面据此显示真因，
        // 不能再统一显示成「后台未响应」——那会让人以为后台没运行）
        try {
          return { ok: true, count: await countLocalBookmarks() };
        } catch (e) {
          const msg = (e && e.message) || String(e);
          return {
            ok: false,
            code: msg === 'NO_BOOKMARKS_API' ? 'NO_BOOKMARKS_API' : 'BOOKMARKS_API_FAILED',
            message: msg
          };
        }
      });
      return true;

    // 获取/生成设备 ID（确保首次打开即生成）
    case 'getDeviceId':
      handleAsyncResponse(sendResponse, async () => {
        const deviceId = await MiniSync.storage.getDeviceId();
        return { deviceId };
      });
      return true;

    // 检查远程文件是否存在
    case 'checkFileExists':
      handleAsyncResponse(sendResponse, async () => {
        // ★ 同步进行中跳过文件状态检测（前端保持中性显示，不误报待初始化/异常）
        const busyInfo2 = await getSyncBusyInfo();
        if (busyInfo2.busy) return { exists: false, folderExists: true, busy: true, action: busyInfo2.action, message: '同步进行中，已跳过检测' };
        const p = normalizeBookmarkPath(message.path || '');
        const f = message.file || message.filePath || DEFAULT_FILENAME;
        const filePath = p ? p + '/' + f : f;
        const exists = await MiniSync.webdav.checkFileExists(filePath);
        return { exists: !!exists, folderExists: true };
      });
      return true;

    // 校验并（必要时）强制创建本地 home 文件夹（现名「移动端主页」，原「Berry主页」）。
    // 仅在「其他收藏夹」下查找标题匹配 FOLDER_TITLES.berryHome 的文件夹；
    // 不存在则在「其他收藏夹」(id='2') 下创建；命中旧名则自动迁移改名。
    // 返回真实文件夹 id。
    case 'ensureBerryHome':
      handleAsyncResponse(sendResponse, async () => {
        const titles = (MiniSync.constants && MiniSync.constants.FOLDER_TITLES) || FOLDER_TITLES;
        const berryTitles = (titles.berryHome || ['移动端主页']).map(t => String(t).toLowerCase());
        const standardTitle = (titles.berryHome && titles.berryHome[0]) || '移动端主页';
        let tree;
        try { tree = await chrome.bookmarks.getTree(); } catch (e) { return { ok: false, error: e.message }; }
        const root = tree && tree[0];
        const other = (root.children || []).find(c =>
          String(c.id) === '2' || (titles.otherBookmarks || []).some(t => String(t).toLowerCase() === String(c.title || '').toLowerCase()));
        if (other) {
          const existing = (other.children || []).find(c =>
            !c.url && berryTitles.includes(String(c.title || '').toLowerCase()));
          if (existing) {
            // 存量迁移：旧名「Berry主页」→ 新名「移动端主页」。
            // 容器标题不参与 pathKey（home 区由 HOME_FOLDER_ID 虚拟根归一为 ROOT:home），
            // update 仅改标题、不动树结构，改名不影响同步口径。
            let renamed = false;
            if (String(existing.title || '') !== standardTitle) {
              try {
                await chrome.bookmarks.update(String(existing.id), { title: standardTitle });
                renamed = true;
              } catch (e) {
                console.warn('[MiniSync] home 文件夹改名迁移失败（忽略）:', e.message);
              }
            }
            return { ok: true, created: false, renamed, folderId: String(existing.id) };
          }
          try {
            const created = await chrome.bookmarks.create({ parentId: String(other.id), title: standardTitle });
            return { ok: true, created: true, folderId: String(created.id) };
          } catch (e) {
            return { ok: false, error: e.message };
          }
        }
        return { ok: false, error: '未找到「其他收藏夹」容器' };
      });
      return true;

    // 列出远程目录
    case 'listFolders':
      handleAsyncResponse(sendResponse, async () => {
        const config = await MiniSync.storage.getWebdavConfig();
        if (!config.url) return [];
        try {
          const items = await MiniSync.webdav.listWebDAVDir(config.url, '', config.username, config.password);
          return items.filter(item => item.isDirectory).map(item => item.name);
        } catch (e) {
          console.warn('[MiniSync] listFolders 失败:', e.message);
          return [];
        }
      });
      return true;

    // 设置端点开关
    case 'setEndpointSwitch':
      handleAsyncResponse(sendResponse, async () => {
        const data = await MiniSync.storage.getLocal(['sync_endpoints']);
        const eps = data.sync_endpoints || {};
        if (eps[message.key]) {
          eps[message.key].enabled = !!message.enabled;
          await MiniSync.storage.setLocal({ sync_endpoints: eps });
        }
        return { ok: true };
      });
      return true;

    // 设置端点文件夹路径
    case 'setEndpointFolder':
      handleAsyncResponse(sendResponse, async () => {
        const data = await MiniSync.storage.getLocal(['sync_endpoints']);
        const eps = data.sync_endpoints || {};
        if (eps[message.key]) {
          eps[message.key].folder = message.folder || '';
          await MiniSync.storage.setLocal({ sync_endpoints: eps });
        }
        return { ok: true };
      });
      return true;

    // 从备份恢复（安全阀弹窗「从历史备份恢复」）
    case 'restoreFromBackup':
      handleAsyncResponse(sendResponse, async () => {
        const restored = await MiniSync.orchestrator.restoreLocalBackup();
        if (restored && restored.ok && restored.restored > 0 && !(restored.conflicts && restored.conflicts.length)) {
          return {
            ok: true,
            success: true,
            message: `已从备份恢复 ${restored.restored} 条书签`,
            restored: restored.restored
          };
        }
        return { ok: false, success: false,
          message: restored && restored.restored > 0 ? '备份恢复未完成，已保留备份，请检查后重试' : '没有可用的备份数据',
          restored: (restored && restored.restored) || 0,
          conflicts: (restored && restored.conflicts) || [] };
      });
      return true;

    // 同步间隔更新（开启/关闭自动同步定时器）
    case 'updateSyncInterval':
      handleAsyncResponse(sendResponse, async () => {
        await setupAutoSyncAlarm();
        return { ok: true };
      });
      return true;

    // 清除同步缓存（区分当前设备 / 全部设备）
    case 'clearSyncCache':
      handleAsyncResponse(sendResponse, async () => {
        const scope = message.scope || 'current';
        const devId = await MiniSync.storage.getDeviceId();

      // 始终清除本地缓存
      // 注意补全此前遗漏的 key：aira_pathkey_snapshot（Aira 删除检测快照）、
      // _is_non_chrome_browser（浏览器类型缓存）——遗漏会导致「清除后重建同步」
      // 仍带旧快照；同步状态键一并复位，避免残留 SYNCING/旧错误信息。
        await MiniSync.storage.removeLocal([
          STORAGE_KEYS.CLOUD_LAST_MODIFIED,
          STORAGE_KEYS.SNAPSHOTS,
          STORAGE_KEYS.TOMBSTONES,
          'berry_pathkey_snapshot',
          'via_pathkey_snapshot',
          'aira_pathkey_snapshot',
          (MiniSync.browserDetect && MiniSync.browserDetect.NON_CHROME_CACHE_KEY) || '_is_non_chrome_browser',
          'sync_status',
          'sync_error',
          'last_sync_time'
        ]);

      // 根据范围处理云端墓碑
        // 云端无文件/未配置视为无需清理（cloudCleared=true）；仅网络等异常才标记 false
        let cloudCleared = true;
        // 云端写入的保护级别说明（见 lib/webdav.js 的分层）；以及失败原因分类
        // ——「别的设备刚写过」是安全拒绝，不能说成网络故障。
        let cloudNote = '';
        let cloudError = '';
        if (scope === 'all') {
          // 清除全部设备：上传空墓碑到云端
          try {
            const config = await MiniSync.webdav.getWebDAVConfig();
            if (config.url) {
              // 下载当前 XBEL，清空 tombstones 和 snapshots，写回（endpoints 随 xbelToJson→jsonToXbel 往返保留）
              // ★ 正文与版本取自同一次 GET：这是全局共享的 XBEL，不带条件地写回会把
              //   别的设备刚同步上去的内容整份抹掉（旧实现正是不带任何条件的 putFile）。
              const version = await MiniSync.webdav.getFileVersion(config.url, config.username, config.password, config.filename);
              if (version.content) {
                const pluginData = MiniSync.xbel.xbelToJson(version.content);
                pluginData.tombstones = [];
                pluginData.snapshots = {};
                pluginData.lastModified = Date.now();
                const newXbel = MiniSync.xbel.jsonToXbel(pluginData);
                const putResult = await MiniSync.webdav.putFile(config.url, config.username, config.password, config.filename, newXbel, undefined,
                  MiniSync.webdav.versionWriteCondition(version));
                cloudNote = MiniSync.webdav.writeProtectionNote(putResult.protection);
              }
            }
          } catch (e) {
            cloudCleared = false;
            cloudError = e.code === 'CLOUD_CONFLICT' ? 'conflict' : 'error';
            console.warn('[sync] 清除云端墓碑失败:', e.message);
          }
        } else {
          // 清除当前设备：从云端过滤掉当前设备的墓碑，保留其他设备的
          try {
            const config = await MiniSync.webdav.getWebDAVConfig();
            if (config.url) {
              const version = await MiniSync.webdav.getFileVersion(config.url, config.username, config.password, config.filename);
              if (version.content) {
                const pluginData = MiniSync.xbel.xbelToJson(version.content);
                if (pluginData.tombstones && Array.isArray(pluginData.tombstones)) {
                  // 过滤掉当前设备的墓碑
                  pluginData.tombstones = pluginData.tombstones.filter(t => t.deviceId !== devId);
                }
                pluginData.lastModified = Date.now();
                const newXbel = MiniSync.xbel.jsonToXbel(pluginData);
                const putResult = await MiniSync.webdav.putFile(config.url, config.username, config.password, config.filename, newXbel, undefined,
                  MiniSync.webdav.versionWriteCondition(version));
                cloudNote = MiniSync.webdav.writeProtectionNote(putResult.protection);
              }
            }
          } catch (e) {
            cloudCleared = false;
            cloudError = e.code === 'CLOUD_CONFLICT' ? 'conflict' : 'error';
            console.warn('[sync] 过滤云端当前设备墓碑失败:', e.message);
          }
        }

        // ★ 修复：返回值补 success 字段。popup 判定 result.success，
        //   此前只返回 {ok:true} 导致两个清理按钮永远显示「重置失败：未知错误」。
        return { ok: true, success: true, scope, cloudCleared, cloudError, note: cloudNote };
      });
      return true;

    default:
      sendResponse({ success: false, message: `未知消息类型: ${msgType}` });
      return false;
  }
}

chrome.runtime.onMessage.addListener(onRuntimeMessage);

// 监听器已注册 ⇒ 记一笔「后台已就绪」。
persistBootReport('ready');

// ★ 直接句柄自检（不经过消息通道）
// 设置页可以用 chrome.runtime.getBackgroundPage() 拿到本页 window 直接调用本函数。
// 当「消息不回话」时，这是唯一还能问到后台内部状态的路：后台到底加载到哪一步、
// 模块齐不齐、有没有报错、收到过哪些消息。返回纯数据（可 JSON 序列化）。
try {
  const bgGlobal = (typeof window !== 'undefined') ? window : self;

  bgGlobal.__MiniSyncSelfCheck = function () {
    return {
      ok: true,
      at: Date.now(),
      bootStage: _bgBoot.stage,
      bootLoads: _bgBoot.loads,
      scriptAt: _bgBoot.scriptAt,
      version: (chrome.runtime.getManifest ? chrome.runtime.getManifest().version : null),
      manifestVersion: (chrome.runtime.getManifest ? chrome.runtime.getManifest().manifest_version : null),
      moduleNames: (typeof MiniSync !== 'undefined' && MiniSync) ? Object.keys(MiniSync) : null,
      hasBookmarksApi: HAS_BOOKMARKS_API,
      hasActionApi: !!ACTION_API,
      msgCount: _bgMsgCount || 0,
      lastMessage: _bgLastMessage,
      // 重放台账：>0 说明页面侧的兜底重发被成功去重（同一次同步没有跑两遍）
      msgLedgerReplays: _msgLedgerReplays,
      msgLedgerSize: _msgLedger.size,
      hasOnMessageListener: !!(chrome.runtime && chrome.runtime.onMessage),
      // ★ 自动同步实况：用户手机日志里消息通道是半死的（ping/diagnose 全「返回空」），
      //   但这一节是页面用 getBackgroundPage() 直接读的，照样能看见 —— 所以定时器的
      //   能力面、有没有响过、上次补跑为什么没跑，都必须挂在这里。
      autoSync: {
        hasAlarmsApi: HAS_ALARMS_API,
        alarmsSurface: describeAlarmsSurface(),
        state: _autoAlarm
      },
      errors: _bgErrors.slice(-20)
    };
  };

  // ★ 直接分发通道（第二条传输带，同样不经过宿主的消息管道）
  // 页面侧 sendMessage 收不到响应时，可用 getBackgroundPage() 拿到本页 window 调这里。
  // 实现就是复用【同一个】onRuntimeMessage：把 sendResponse 换成 resolve，
  // 并且【完全不看监听器的返回值】—— 这正是它比宿主消息管道更可靠的地方：
  // 某些移动端 fork 会丢掉「监听器返回 false」时的同步响应（手机实测 ping 返回空）。
  bgGlobal.__MiniSyncDispatchDirect = function (message) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ success: false, code: 'DIRECT_TIMEOUT', message: '直接调用 25s 未返回（后台可能在跑慢操作）' });
      }, 25000);
      const send = (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      let ret;
      try {
        ret = onRuntimeMessage(message, { id: 'direct-handle', direct: true }, send);
      } catch (e) {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve({ success: false, code: 'DIRECT_THREW', message: (e && e.message) || String(e) });
        return;
      }
      // 同步处理器返回 false 且没给响应（例如消息里没有 type/action）⇒ 当场定性，
      // 别让页面干等 15s。异步处理器一律返回 true，所以这条不会误伤它们。
      if (ret !== true && !settled) {
        send({ success: false, code: 'DIRECT_NO_RESPONSE', message: '后台没给响应（同步处理器未回值）' });
      }
    });
  };
} catch (_) { /* 自检/直接通道挂不上不该拖垮后台 */ }

/**
 * 统一异步消息处理
 */
function handleAsyncResponse(sendResponse, asyncFn) {
  asyncFn()
    .then(result => sendResponse(result))
    .catch(error => {
      console.error('[MiniSync] 处理失败:', error);
      sendResponse({ success: false, message: error.message || '未知错误' });
    });
}

// 自动同步与启动恢复

/**
 * 只读地描述定时器现状（诊断用；不改任何状态）。
 * 「想要的」（配置）与「实际有的」（宿主）分开报，用户一眼能看出是配置没开还是定时器没挂上。
 */
async function describeAutoAlarm() {
  const r = await MiniSync.storage.getLocal(['sync_enabled', 'sync_interval', 'webdav_url']);
  const interval = MiniSync.utils.clampSyncInterval(r.sync_interval);
  const a = HAS_ALARMS_API ? await alarmGet(SYNC_ALARM) : null;
  return {
    apiAvailable: HAS_ALARMS_API,
    alarmsSurface: describeAlarmsSurface(),
    wanted: !!(r.sync_enabled && r.webdav_url),
    syncEnabled: !!r.sync_enabled,
    hasUrl: !!r.webdav_url,
    interval: interval,
    exists: !!a,
    periodInMinutes: a ? a.periodInMinutes : null,
    last: _autoAlarm            // 最近一次校准的结论（action=created/kept/recreated/cleared/idle/error/no-alarms-api）
  };
}

/**
 * 宿主到底给了 alarms 的哪几项能力（手机 fork 常有「对象在、方法缺」的半实现）。
 * 只读探测，不调用任何会改状态的方法。
 * @returns {{create:boolean, clear:boolean, get:boolean, onAlarm:boolean, getAll:boolean}|null}
 */
function describeAlarmsSurface() {
  if (typeof chrome === 'undefined' || !chrome.alarms) return null;
  const f = (o, k) => !!(o && typeof o[k] === 'function');
  return {
    create: f(chrome.alarms, 'create'),
    clear: f(chrome.alarms, 'clear'),
    get: f(chrome.alarms, 'get'),
    getAll: f(chrome.alarms, 'getAll'),
    onAlarm: !!(chrome.alarms.onAlarm && typeof chrome.alarms.onAlarm.addListener === 'function')
  };
}

/**
 * 读一个 alarm 的现状。宿主差异全在这里吃掉：
 *   · MV3 / 新版宿主 → chrome.alarms.get 返回 Promise；
 *   · 旧式回调宿主 → 走回调；
 *   · 两样都不给 → 短超时后按「不知道」返回，绝不把后台挂死。
 * @returns {Promise<{periodInMinutes:number}|null>}
 */
function alarmGet(name) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (a) => { if (!settled) { settled = true; resolve(a || null); } };
    try {
      if (!HAS_ALARMS_API || typeof chrome.alarms.get !== 'function') return done(null);
      const maybe = chrome.alarms.get(name, (a) => { void chrome.runtime.lastError; done(a); });
      if (maybe && typeof maybe.then === 'function') maybe.then(done, () => done(null));
      setTimeout(() => done(null), 1000);
    } catch (_) {
      done(null);
    }
  });
}

/**
 * 清一个 alarm。与 alarmGet 一样把宿主差异吃掉：没有 clear 就当没这回事，
 * 只是「下次校准会再 create 一次」——绝不能因为缺 clear 就把自动同步判死。
 * @returns {Promise<boolean>} 是否真的清掉了
 */
async function alarmClear(name) {
  try {
    if (typeof chrome === 'undefined' || !chrome.alarms || typeof chrome.alarms.clear !== 'function') return false;
    const maybe = chrome.alarms.clear(name, () => { void chrome.runtime.lastError; });
    if (maybe && typeof maybe.then === 'function') await maybe;
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 校准自动同步定时器：把「配置想要的」与「宿主现在的」对齐。
 * 本函数【绝不抛异常】（宿主的 alarms 调用可能直接抛），出错记进 _autoAlarm.lastError。
 * @param {string} reason         触发来源（boot / startup / install / config-change / diagnose），只进诊断
 * @param {boolean} [opts.force]  true = 无条件重建（配置刚改过，新间隔要立刻生效）；
 *                                false = 只在缺失/间隔不符时重建 —— **定时器健在时绝不动它**，
 *                                否则每次后台唤醒都会把倒计时重置，间隔设 30 分钟却永远等不到。
 * @returns {Promise<{wanted:boolean, exists:boolean, periodInMinutes:number|null, action:string}>}
 */
async function ensureAutoSyncAlarm(reason, opts) {
  const force = !!(opts && opts.force);
  const r = await MiniSync.storage.getLocal(['sync_enabled', 'sync_interval', 'webdav_url']);
  const wanted = !!(r.sync_enabled && r.webdav_url);
  // ★ 必须夹取：这个值可以由导入的备份文件/被手工改过的 storage 直通这里，
  //   负数会让 chrome.alarms.create 抛错（自动同步静默失效），极小值会被夹到 1 分钟高频轮询。
  const interval = MiniSync.utils.clampSyncInterval(r.sync_interval);

  let action = 'no-alarms-api';
  let exists = false;
  let periodInMinutes = null;
  let opError = null;

  if (HAS_ALARMS_API) {
    const current = await alarmGet(SYNC_ALARM);
    exists = !!current;
    periodInMinutes = current ? current.periodInMinutes : null;
    const mismatch = !exists || !(Math.abs((periodInMinutes || 0) - interval) < 0.01);
    try {
      if (!wanted) {
        if (exists) {
          await alarmClear(SYNC_ALARM);
          exists = false;
          periodInMinutes = null;
          action = 'cleared';
        } else {
          action = 'idle';          // 本来就没有，无需动作（也不必去 clear：白记一笔「已清除」会误导排查）
        }
      } else if (force || mismatch) {
        action = exists ? 'recreated' : 'created';
        if (exists) await alarmClear(SYNC_ALARM);
        await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: interval });
        exists = true;
        periodInMinutes = interval;
      } else {
        action = 'kept';            // 健在且间隔一致：绝不动它，免得把倒计时重置
      }
    } catch (e) {
      // ★ 绝不把异常抛给调用方：宿主可能给了个「调用就抛」的 alarms（手机 fork 上有），
      //   抛出去会让启动流程在补跑之前中断 —— 那才是真正把自动同步弄没的那个环节。
      //   这里如实记下来，功能上退化成「只剩补跑」，但不会连补跑一起丢。
      opError = (e && e.message) || String(e);
      action = 'error';
      console.warn('[MiniSync] 校准自动同步定时器出错（退化为仅补跑）:', opError);
    }
  }

  _autoAlarm = {
    reason: reason || 'unknown',
    wanted: wanted,
    apiAvailable: HAS_ALARMS_API,
    exists: exists,
    periodInMinutes: periodInMinutes,
    action: action,
    at: Date.now(),
    fireCount: _autoAlarm.fireCount || 0,
    lastFireAt: _autoAlarm.lastFireAt || null,
    catchUpCount: _autoAlarm.catchUpCount || 0,
    lastCatchUp: _autoAlarm.lastCatchUp || null,
    lastError: opError || _autoAlarm.lastError || null
  };
  return _autoAlarm;
}

/**
 * 把自动同步的实况落盘（`auto_sync_report`），供设置页直接读 storage 展示。
 *
 * 为什么不能只靠 diagnose 消息：手机端宿主会把消息响应丢掉（用户这份日志里
 * `ping` / `diagnose` 全是「返回空」），而 storage 读取是好的 —— 把实况放进 storage，
 * 诊断报告才能在「消息通道半死」的宿主上照样看得见。
 */
async function persistAutoSyncReport() {
  try {
    const r = await MiniSync.storage.getLocal(['sync_enabled', 'webdav_url', 'sync_interval', 'last_sync_at', 'auto_sync_next_at']);
    await MiniSync.storage.setLocal({
      auto_sync_report: {
        at: Date.now(),
        syncEnabled: !!r.sync_enabled,
        hasUrl: !!r.webdav_url,
        interval: MiniSync.utils.clampSyncInterval(r.sync_interval),
        lastSyncAt: r.last_sync_at || null,
        nextAt: r.auto_sync_next_at || null,
        alarm: _autoAlarm
      }
    });
  } catch (_) { /* 诊断不该拖垮后台 */ }
}

/**
 * 根据配置创建/清除自动同步 alarm。
 * 原语义是「无条件重建」（配置刚改过，必须立刻按新间隔跑），保留为 setupAutoSyncAlarm。
 */
async function setupAutoSyncAlarm() {
  return ensureAutoSyncAlarm('config-change', { force: true });
}

/**
 * 跑一次自动同步，带状态短路与错误兜底（alarm 事件与「错过补跑」共用同一份，
 * 避免两条路各写一遍）。
 *
 * ★ 页面内互斥（2026-10-05）：同一份后台里绝不允许两轮自动同步同时进行。
 *   背景是用户手机上真实发生的一幕：浏览器启动时【顶层启动段】与 onStartup 都会
 *   触发补跑，两趟都读到「已到点」，一起冲进同步锁 —— 输的那趟自旋 8 秒后拿到
 *   SYNC_BUSY，往日志里写下「自动同步未完成: 同步进行中，请稍候」。用户看到的
 *   是「同步失败报错」，其实同步跑成了，只是被自己的第二趟撞了一下。
 *   锁挡得住并发，但挡不住这种自撞：这里在更外层先合流，第二趟直接搭第一趟的车。
 * @param {{from:'alarm'|'catch-up'}} [opts] 触发来源，只进日志与下次时间台账
 */
let _autoSyncInFlight = null;
function runAutoSyncSafely(opts) {
  if (_autoSyncInFlight) return _autoSyncInFlight;
  const p = _doRunAutoSyncSafely(opts)
    .then((r) => { _autoSyncInFlight = null; return r; },
      (e) => { _autoSyncInFlight = null; throw e; });
  _autoSyncInFlight = p;
  return p;
}

async function _doRunAutoSyncSafely(opts) {
  try {
    const status = await MiniSync.storage.getSyncStatus();
    if (status.status === SYNCING) return;   // 上一轮还在跑，本轮跳过（不并发写云端）
    const result = await runAutoSync();
    // 记下次该跑的时间：关着的窗口由 catchUpMissedAutoSync 补，开着的时候由 alarm 到点跑
    const cfg = await MiniSync.storage.getLocal(['sync_interval']);
    const interval = MiniSync.utils.clampSyncInterval(cfg.sync_interval);
    await MiniSync.storage.setLocal({ auto_sync_next_at: Date.now() + interval * 60000 });
    if (result && result.success === false) {
      // SYNC_BUSY = 别处（手动点击 / 本轮乱序的另一趟）正在同步，是正常并发而不是失败：
      // 报成「未完成」只会让人以为坏了。真正的失败照旧告警。
      if (result.code === 'SYNC_BUSY' || result.busy) {
        console.log('[MiniSync] 自动同步已有一轮在跑，本轮跳过（正常并发，不是失败）');
      } else {
        console.warn('[MiniSync] 自动同步未完成:', result.message || result.code || '未知原因');
      }
    }
  } catch (e) {
    console.error('[MiniSync] 自动同步失败:', e.message);
  }
}

/**
 * 把「浏览器关着时错过的那一次」补上。
 * 背景：alarm 只在浏览器开着的时候才会响；手机端用户往往一天才开一次浏览器，
 * 靠 alarm 根本等不到那一轮。这里在后台每次唤醒时核对一次「本该跑的时间」，
 * 到点就补跑一轮。宿主连 alarms API 都没有时，这更是唯一的自动同步路径。
 *
 * 不猜的时刻：没有任何「上次同步 / 下次该跑」台账时（例如刚升级上来）什么都不做，
 * 等第一轮 alarm 自己把台账建立起来，绝不因为升级装完就突然同步一次。
 * @returns {Promise<{ran:boolean, dueAt?:number, reason?:string}>}
 */
let _catchUpInFlight = null;
async function catchUpMissedAutoSync() {
  // ★ 同一份后台里只允许一趟补跑判定：浏览器启动时【顶层启动段】与 onStartup 会同时
  //   进来，两趟都在「把下次时间推到未来」之前就读到同一个旧台账 —— 那道写入屏障挡不住
  //   这种并发（都先读、后写），于是两趟一起冲同步锁，输的那趟 8 秒后报「同步进行中，
  //   请稍候」。这里按在途合并合流：第二趟直接复用第一趟的结论。
  if (_catchUpInFlight) return _catchUpInFlight;
  const p = _doCatchUpMissedAutoSync()
    .then((r) => { _catchUpInFlight = null; return r; },
      (e) => { _catchUpInFlight = null; throw e; });
  _catchUpInFlight = p;
  return p;
}

async function _doCatchUpMissedAutoSync() {
  const r = await MiniSync.storage.getLocal([
    'sync_enabled', 'webdav_url', 'sync_interval', 'auto_sync_next_at', 'last_sync_at'
  ]);
  // 每次判定都记账：「没跑」的理由（未开启 / 没台账 / 还没到点）必须留在诊断里 ——
  // 手机端 console 读不到，这是唯一能区分「没挂上」和「挂上了但不用跑」的证据。
  const note = (ran, reason, extra) => {
    _autoAlarm = Object.assign({}, _autoAlarm, {
      catchUpCount: (_autoAlarm.catchUpCount || 0) + (ran ? 1 : 0),
      lastCatchUp: Object.assign({ at: Date.now(), ran: !!ran, reason: reason || null }, extra || {})
    });
    return Object.assign({ ran: !!ran, reason: reason || undefined }, extra || {});
  };
  if (!(r.sync_enabled && r.webdav_url)) {
    return note(false, '未开启或未配置', { syncEnabled: !!r.sync_enabled, hasUrl: !!r.webdav_url });
  }
  const intervalMs = MiniSync.utils.clampSyncInterval(r.sync_interval) * 60000;
  // 台账缺失时用「上次同步 + 一个间隔」推算；连上次同步都没有就不猜
  const dueAt = r.auto_sync_next_at || (r.last_sync_at ? r.last_sync_at + intervalMs : null);
  if (!dueAt) return note(false, '没有可推算的台账', { lastSyncAt: r.last_sync_at || null });
  if (Date.now() < dueAt) return note(false, '还没到点', { dueAt: dueAt });
  // ★ 先把下次时间推到未来，再真跑：并发的第二次唤醒（顶层 + onStartup 可能同时进来）
  //   看到的是未来时间，不会把同一轮跑两遍。
  await MiniSync.storage.setLocal({ auto_sync_next_at: Date.now() + intervalMs });
  note(true, '到点补跑', { dueAt: dueAt });
  await runAutoSyncSafely({ from: 'catch-up' });
  return { ran: true, dueAt: dueAt };
}

/**
 * 执行一次自动同步（按用户选择的同步模式）
 * @returns {Promise<Object>}
 */
async function runAutoSync() {
  const r = await MiniSync.storage.getLocal(['sync_type', 'sync_enabled', 'webdav_url']);
  if (!r.sync_enabled) return { ok: true, skipped: true, message: '自动同步未开启' };
  if (!r.webdav_url) return { ok: true, skipped: true, message: '未配置 WebDAV' };
  const mode = r.sync_type || MERGE_MODE;
  const fn = {
    [UPLOAD_MODE]: () => MiniSync.actions.uploadBookmarks({ auto: true }),
    [DOWNLOAD_MODE]: () => MiniSync.actions.downloadBookmarks({ auto: true }),
    [MERGE_MODE]: () => MiniSync.actions.mergeSync({ auto: true })
  }[mode];
  if (!fn) return { ok: false, message: `未知同步模式: ${mode}` };
  return fn();
}

// 统计本地书签数量（含所有文件夹下的 URL 节点）
// ⚠️ 必须带超时：移动端 fork 上实测存在「getTree 是函数、但回调永不触发」的情况，
//    没有超时的话消息永远不回，页面只能显示「后台未响应」，真因完全看不出来。
const BOOKMARKS_QUERY_TIMEOUT_MS = 5000;
function countLocalBookmarks() {
  return new Promise((resolve, reject) => {
    if (!HAS_BOOKMARKS_API) {
      reject(new Error('NO_BOOKMARKS_API'));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`chrome.bookmarks.getTree 回调 ${BOOKMARKS_QUERY_TIMEOUT_MS}ms 内没回来（宿主没实现该接口）`));
    }, BOOKMARKS_QUERY_TIMEOUT_MS);
    try {
      chrome.bookmarks.getTree((tree) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const le = chrome.runtime.lastError; // 主动读掉，避免「Unchecked runtime.lastError」
        if (le) {
          reject(new Error('bookmarks.getTree 报错：' + (le.message || String(le))));
          return;
        }
        if (!Array.isArray(tree)) {
          reject(new Error('bookmarks.getTree 回调给的不是数组：' + JSON.stringify(tree)));
          return;
        }
        let count = 0;
        (function walk(node) {
          if (!node) return;
          if (node.url) count++;
          (node.children || []).forEach(walk);
        })(tree[0]);
        resolve(count);
      });
    } catch (e) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('bookmarks.getTree 抛异常：' + ((e && e.message) || String(e))));
      }
    }
  });
}

// 启动崩溃恢复：检测到本地书签为空且存在备份时自动恢复
async function startupRecovery() {
  const data = await MiniSync.storage.getLocal([STORAGE_KEYS.LOCAL_BACKUP]);
  const backup = data[STORAGE_KEYS.LOCAL_BACKUP];
  if (!Array.isArray(backup) || backup.length === 0) return;
  const currentCount = await countLocalBookmarks();
  if (currentCount > 0) {
    return;
  }
  console.warn(`[MiniSync] 检测到本地书签为空，正在从备份恢复 ${backup.length} 条书签...`);
  const restored = await MiniSync.orchestrator.restoreLocalBackup();
  if (restored && restored.ok && restored.restored > 0 && !(restored.conflicts && restored.conflicts.length)) {
    // 恢复成功后清理备份，避免下次启动重复恢复同一份数据
    await MiniSync.storage.removeLocal([STORAGE_KEYS.LOCAL_BACKUP]);
  }
}

// 初始化

// 启动时为删除监听构建初始本地快照（若尚无）
MiniSync.orchestrator.saveLocalSnapshot().catch(e =>
  console.warn('[MiniSync] 初始化本地快照失败（忽略）:', e.message)
);

// 删除监听处理函数

// 防抖：多次连续删除只在静默期结束后触发一次合并
let _removeDebounceTimer = null;
const REMOVE_DEBOUNCE_MS = 3000;

// 防抖：移动（拖拽产生连续 onMoved）只在静默期结束后触发一次合并
let _moveDebounceTimer = null;
const MOVE_DEBOUNCE_MS = 3000;

// 处理本地书签删除：收集被删子树所有节点的 pathKey，写入 sync_tombstones。
async function handleBookmarkRemoved(id, removeInfo) {
  if (!removeInfo || !removeInfo.node) return;

  // ★ 防御：部分浏览器（实测 Edge）对「移动书签」也会派发 onRemoved。此时节点
  //   只是换了个位置、仍然存在于书签树中——绝不能写墓碑，否则下一轮合并会按
  //   墓碑把它删除（表现为「挪动书签后书签消失」）。写墓碑前先确认节点确实不存在。
  const stillThere = await new Promise((resolve) => {
    try {
      chrome.bookmarks.get(String(id), (results) => {
        void chrome.runtime.lastError;
        resolve(Array.isArray(results) && results.length > 0);
      });
    } catch (_) {
      resolve(false);
    }
  });
  if (stillThere) {
    console.warn('[MiniSync] onRemoved 触发但节点仍存在（判定为移动事件），跳过墓碑');
    return;
  }

  // 同步进行中的删除（由合并/下载落盘自身产生）不写墓碑，避免循环回写
  const curStatus = await MiniSync.storage.getSyncStatus();
  if (curStatus.status === SYNCING) {
    return;
  }

  // 1. 从删除前快照取 pathKey 映射
  const snapData = await MiniSync.storage.getLocal([STORAGE_KEYS.SNAPSHOTS]);
  const snapshots = snapData[STORAGE_KEYS.SNAPSHOTS];
  const prevTree = (snapshots && snapshots.localTree) || [];
  let prevPKMap = new Map();
  if (prevTree.length > 0) {
    prevPKMap = MiniSync.xbelPath.computeJsonPathKeys(prevTree);
  }

  // 2. 收集被删子树所有节点 id（含子孙）
  const removedIds = [];
  (function collect(node) {
    if (!node) return;
    removedIds.push(node.id);
    (node.children || []).forEach(collect);
  })(removeInfo.node);

  // 3. 取这些 id 在删除前的 pathKey，写入墓碑
  const newlyDeleted = new Set();
  for (const rid of removedIds) {
    const pk = prevPKMap.get(rid);
    if (pk) newlyDeleted.add(pk);
  }

  if (newlyDeleted.size > 0) {
    const existing = (await MiniSync.storage.getLocal([STORAGE_KEYS.TOMBSTONES]))[STORAGE_KEYS.TOMBSTONES] || [];
    const devId = await MiniSync.storage.getDeviceId();
    const merged = MiniSync.tombstone.mergeTombstones(existing, newlyDeleted, null, devId);
    await MiniSync.storage.setLocal({ [STORAGE_KEYS.TOMBSTONES]: merged });
  }

  // 4. 刷新本地快照（删除后当前树）
  await MiniSync.orchestrator.saveLocalSnapshot();

  // 5. 防抖触发一次合并，把墓碑推上云并消费云端墓碑
  const cfg = await MiniSync.storage.getLocal(['sync_enabled', 'webdav_url']);
  if (!cfg.sync_enabled || !cfg.webdav_url) {
    return;
  }
  if (_removeDebounceTimer) clearTimeout(_removeDebounceTimer);
  _removeDebounceTimer = setTimeout(async () => {
    _removeDebounceTimer = null;
    try {
      const status = await MiniSync.storage.getSyncStatus();
      if (status.status === SYNCING) {
        return;
      }
      await runAutoSync();
    } catch (e) {
      console.warn('[MiniSync] 删除监听触发合并失败（忽略）:', e.message);
    }
  }, REMOVE_DEBOUNCE_MS);
}
