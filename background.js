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
if (HAS_BOOKMARKS_API && chrome.bookmarks.onRemoved && chrome.bookmarks.onMoved) {

// 书签删除监听：将本地删除写入墓碑，使删除能传播到云端
chrome.bookmarks.onRemoved.addListener((id, removeInfo) => {
  handleBookmarkRemoved(id, removeInfo).catch(e =>
    console.warn('[MiniSync] 删除监听处理失败（忽略）:', e.message)
  );
});

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
    const subIds = new Set();
    (function collect(n) {
      if (n) { subIds.add(String(n.id)); (n.children || []).forEach(collect); }
    })(moveInfo && moveInfo.node);
    const affected = new Set();
    for (const [nid, pk] of prevPKMap) {
      if (subIds.has(String(nid))) affected.add(pk);
    }

    // 2. 刷新快照到移动后，取该子树的新 pathKey（新位置历史上如有墓碑一并清除）
    await MiniSync.orchestrator.saveLocalSnapshot();
    const newData = await MiniSync.storage.getLocal([STORAGE_KEYS.SNAPSHOTS]);
    const newTree = (newData[STORAGE_KEYS.SNAPSHOTS] && newData[STORAGE_KEYS.SNAPSHOTS].localTree) || [];
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
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm || alarm.name !== SYNC_ALARM) return;
  const status = await MiniSync.storage.getSyncStatus();
  if (status.status === SYNCING) {
    return;
  }
  try {
    const result = await runAutoSync();
    if (result && result.success === false) {
      console.warn('[MiniSync] 自动同步未完成:', result.message || result.code || '未知原因');
    }
  } catch (e) {
    console.error('[MiniSync] 自动同步失败:', e.message);
  }
});

// 启动崩溃恢复：本地书签为空且存在备份时自动恢复
chrome.runtime.onStartup.addListener(async () => {
  try {
    await startupRecovery();
  } catch (e) {
    console.error('[MiniSync] 启动恢复检查失败:', e.message);
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
          bookmarkCount = { ok: false, error: (e && e.message) || String(e) };
        }
        const cfg = await MiniSync.storage.getLocal(['webdav_url', 'sync_enabled']);
        const perm = cfg.webdav_url
          ? await MiniSync.utils.hasHostPermission(cfg.webdav_url)
          : { ok: true, skipped: true };
        return {
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
          webdavUrl: cfg.webdav_url || '',
          syncEnabled: !!cfg.sync_enabled,
          permissionQuery: perm,       // 权限接口可用性（不可用会带超时原文）
          moduleErrors: _bgErrors.slice(-10)
        };
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
        if (restored && restored.restored > 0) {
          return {
            ok: true,
            success: true,
            message: `已从备份恢复 ${restored.restored} 条书签`,
            restored: restored.restored
          };
        }
        return { ok: false, success: false, message: '没有可用的备份数据' };
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
        if (scope === 'all') {
          // 清除全部设备：上传空墓碑到云端
          try {
            const config = await MiniSync.webdav.getWebDAVConfig();
            if (config.url) {
              // 下载当前 XBEL，清空 tombstones 和 snapshots，写回（endpoints 随 xbelToJson→jsonToXbel 往返保留）
              const xbelStr = await MiniSync.webdav.getFile(config.url, config.username, config.password, config.filename);
              if (xbelStr) {
                const pluginData = MiniSync.xbel.xbelToJson(xbelStr);
                pluginData.tombstones = [];
                pluginData.snapshots = {};
                pluginData.lastModified = Date.now();
                const newXbel = MiniSync.xbel.jsonToXbel(pluginData);
                await MiniSync.webdav.putFile(config.url, config.username, config.password, config.filename, newXbel);
              }
            }
          } catch (e) {
            cloudCleared = false;
            console.warn('[sync] 清除云端墓碑失败:', e.message);
          }
        } else {
          // 清除当前设备：从云端过滤掉当前设备的墓碑，保留其他设备的
          try {
            const config = await MiniSync.webdav.getWebDAVConfig();
            if (config.url) {
              const xbelStr = await MiniSync.webdav.getFile(config.url, config.username, config.password, config.filename);
              if (xbelStr) {
                const pluginData = MiniSync.xbel.xbelToJson(xbelStr);
                if (pluginData.tombstones && Array.isArray(pluginData.tombstones)) {
                  // 过滤掉当前设备的墓碑
                  pluginData.tombstones = pluginData.tombstones.filter(t => t.deviceId !== devId);
                }
                pluginData.lastModified = Date.now();
                const newXbel = MiniSync.xbel.jsonToXbel(pluginData);
                await MiniSync.webdav.putFile(config.url, config.username, config.password, config.filename, newXbel);
              }
            }
          } catch (e) {
            cloudCleared = false;
            console.warn('[sync] 过滤云端当前设备墓碑失败:', e.message);
          }
        }

        // ★ 修复：返回值补 success 字段。popup 判定 result.success，
        //   此前只返回 {ok:true} 导致两个清理按钮永远显示「重置失败：未知错误」。
        return { ok: true, success: true, scope, cloudCleared };
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
 * 根据配置创建/清除自动同步 alarm
 */
async function setupAutoSyncAlarm() {
  const r = await MiniSync.storage.getLocal(['sync_enabled', 'sync_interval', 'webdav_url']);
  const enabled = !!r.sync_enabled;
  // ★ 必须夹取：这个值可以由导入的备份文件/被手工改过的 storage 直通这里，
  //   负数会让 chrome.alarms.create 抛错（自动同步静默失效），极小值会被夹到 1 分钟高频轮询。
  const interval = MiniSync.utils.clampSyncInterval(r.sync_interval);
  const configured = !!r.webdav_url;
  await chrome.alarms.clear(SYNC_ALARM);
  if (enabled && configured) {
    await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: interval });
  }
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
  if (restored && restored.restored > 0) {
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
