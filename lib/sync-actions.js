// sync-actions.js — 同步动作层（统一入口）
// 职责：
//   1. 权限守门：所有 WebDAV 操作前统一请求域名访问授权
//   2. 互斥锁：防止并发同步
//   3. 重试：网络抖动时自动重试（默认 1 次）
//   4. 日志：统一写入操作日志

MiniSync.actions = (function() {

// ========== 权限守门 ==========

/**
 * 确保 WebDAV 域名访问权限已授权（Chrome 必须授权才能 fetch 外部 URL）
 *
 * ⚠️ 这里【只查询、不申请】。本模块运行在 service worker 里，而
 * chrome.permissions.request() 需要用户手势（runtime.onMessage 不携带 gesture），
 * 在 worker 中申请必然失败。旧实现直接调 requestHostPermission，于是每次
 * checkConfig（打开设置页/弹窗都会触发）都在 worker 里发起一次注定失败的申请，
 * 表现为「一直在请求 WebDAV 域名访问权限、一直成功不了」。
 * 申请动作统一交给扩展页面：popup 的「测试连接/保存」按钮、设置页的「授权域名访问」按钮。
 *
 * @param {string} url - WebDAV 地址
 * @returns {Promise<{ok: boolean, code?: string, error?: string}>}
 */
async function ensurePermission(url) {
  if (!url) return { ok: false, code: 'NO_URL', error: '未配置 WebDAV 地址' };
  const r = await MiniSync.utils.hasHostPermission(url);
  if (!r.ok) {
    // 权限接口本身不可用（Gecko 系宿主、以及未实现运行时权限弹窗的移动端分支：
    // chrome.permissions.* 的回调永不触发，只会等到超时）。
    // ⚠️ 这种情况绝不能阻断同步：这些宿主靠【安装时声明的 host 权限】放行请求，
    //    权限查询失败 ≠ 没有权限。旧写法在这里 return 失败，会让这类宿主永远同步不了，
    //    而且报错还看不出真因。改为放行，让真正的网络请求去决定成败。
    //    注意：地址非法（BAD_URL）不属于这类情况，仍按失败拦下 —— 见下方分支。
    if (r.code === 'PERMISSION_API_UNAVAILABLE') {
      return { ok: true, degraded: true, warning: r.error };
    }
    return { ok: false, code: 'PERMISSION_CHECK_FAILED', error: r.error };
  }
  if (!r.granted) {
    return {
      ok: false,
      code: 'NEED_PERMISSION',
      error: `尚未授权访问 ${String(r.origin).replace(/\/\*$/, '')}：请在扩展弹窗点「测试连接」，或到设置页点「授权域名访问」后再试`
    };
  }
  return { ok: true };
}

// ========== 互斥锁 ==========
// 用 storage.local 的 sync_lock_at 时间戳实现「跨实例锁」。
// 注意：MV3 下 Service Worker 会被随时销毁重建，内存级的 _syncing 变量无法跨
// 实例存活，alarm 自动同步与手动点击可能真正并发跑两次同步。因此锁必须落到
// 持久化存储，且带 TTL 自动过期（防止异常退出后锁永久卡死）。
const SYNC_LOCK_TTL = 2 * 60 * 1000; // 锁最长持有 2 分钟（足够一次同步完成）

/**
 * 尝试获取跨实例互斥锁
 * @returns {Promise<boolean>} true=拿到锁；false=已有其他实例在同步
 */
async function acquireSyncLock() {
  try {
    const data = await MiniSync.storage.getLocal(['sync_lock_at']);
    const now = Date.now();
    const holder = data.sync_lock_at || 0;
    // 旧锁已过期 → 视为无人持有，可直接抢占
    if (holder && now - holder < SYNC_LOCK_TTL) {
      return false;
    }
    await MiniSync.storage.setLocal({ sync_lock_at: now });
    // 二次确认：抢占后立刻回读，确保我们写的时间戳仍是「最新」的（避免极端并发双写）
    const verify = await MiniSync.storage.getLocal(['sync_lock_at']);
    if (verify.sync_lock_at === now) return true;
    return false;
  } catch (_) {
    // 存储读取异常时，宁可放行（同步失败可重试），也不阻断用户
    return true;
  }
}

/** 释放互斥锁 */
async function releaseSyncLock() {
  try {
    await MiniSync.storage.setLocal({ sync_lock_at: 0 });
  } catch (_) { /* 忽略 */ }
}

/**
 * 带互斥锁执行同步
 * - 锁带 TTL（见 SYNC_LOCK_TTL），异常退出也不会永久卡死
 * - 拿不到锁时做短暂自旋重试（默认最多 ~8s），覆盖「打开桥接开关瞬间触发的合并」
 *   与「用户紧接着手动点击上传」撞锁的场景，避免误报「同步进行中，请稍候」
 * - 自旋仍拿不到（同步确实还在跑且超过容忍时长）才返回失败提示
 */
const LOCK_SPIN_TIMES = 16;   // 重试次数
const LOCK_SPIN_WAIT = 500;   // 每次间隔 ms（16 * 500 = 8s）

async function withLock(fn, options) {
  let locked = false;
  for (let i = 0; i < LOCK_SPIN_TIMES; i++) {
    locked = await acquireSyncLock();
    if (locked) break;
    await new Promise(r => setTimeout(r, LOCK_SPIN_WAIT));
  }
  if (!locked) {
    // code=SYNC_BUSY：前端据此提示「进行中」而非「失败」（自旋 ~8s 仍未拿到锁）
    return { success: false, code: 'SYNC_BUSY', message: '同步进行中，请稍候' };
  }
  try {
    return await fn(options);
  } finally {
    await releaseSyncLock();
  }
}

// ========== 重试 ==========

/**
 * 带重试的执行（失败后等待递增时间再试）
 * @param {Function} fn - 异步函数
 * @param {*} options - 参数
 * @param {number} [maxRetries=1] - 最大重试次数
 */
async function withRetry(fn, options, maxRetries) {
  maxRetries = maxRetries || 1;
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(options);
    } catch (e) {
      lastError = e;
      if (attempt < maxRetries) {
        console.warn(`[sync] 第 ${attempt + 1} 次失败: ${e.message}，${1}s 后重试...`);
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

// ========== 日志 ==========

/**
 * 写入操作日志到 storage.local['sync_log']（保留最近 50 条）
 */
async function appendSyncLog(action, success, message, trigger) {
  try {
    const data = await MiniSync.storage.getLocal(['sync_log']);
    const logs = Array.isArray(data.sync_log) ? data.sync_log : [];
    logs.push({
      action: action,
      success: success,
      message: message || '',
      trigger: trigger || '手动',
      time: Date.now()
    });
    await MiniSync.storage.setLocal({ sync_log: logs.slice(-50) });
    } catch (e) {
    console.warn('[sync] 写入操作日志失败:', e.message);
    }
    }

// ========== 对外接口 ==========

/**
 * 上传书签到云端
 */
async function uploadBookmarks(options) {
  return withLock(async (opts) => {
    // 权限守门
    const config = await MiniSync.storage.getWebdavConfig();
    const perm = await ensurePermission(config.url);
    if (!perm.ok) return { success: false, code: perm.code, message: perm.error };

    const result = await withRetry(
      (o) => MiniSync.orchestrator.uploadBookmarks(o),
      opts, 1
    );
    if (result.success) {
      const bmCount = result.bookmarkCount || result.count || 0;
      await appendSyncLog('上传', true, `${bmCount} 条`, opts && opts.auto ? '自动' : '手动');
    } else {
      await appendSyncLog('上传', false, result.message || '上传失败', opts && opts.auto ? '自动' : '手动');
    }
    return result;
  }, options);
}

/**
 * 从云端下载书签并导入
 */
async function downloadBookmarks(options) {
  return withLock(async (opts) => {
    // 权限守门
    const config = await MiniSync.storage.getWebdavConfig();
    const perm = await ensurePermission(config.url);
    if (!perm.ok) return { success: false, code: perm.code, message: perm.error };

    const result = await withRetry(
      (o) => MiniSync.orchestrator.downloadBookmarks(o),
      opts, 1
    );
    if (result.success) {
      const bmCount = result.bookmarkCount || result.totalCount || 0;
      const parts = [];
      if (result.importedCount > 0) parts.push(`新增 ${result.importedCount}`);
      if (result.removedCount > 0) parts.push(`删除 ${result.removedCount}`);
      const logMsg = `${bmCount} 条（${parts.length ? parts.join('、') : '已是最新'}）`;
      if (result.conflictCount > 0) {
        // 写入失败必须进操作记录：否则「一条都没落地」在手机上会显示成成功
        const first = (result.conflictSamples && result.conflictSamples[0]) || '';
        await appendSyncLog('下载', false, `${result.conflictCount} 条没能写入本地：${first}`, opts && opts.auto ? '自动' : '手动');
      } else {
        await appendSyncLog('下载', true, logMsg, opts && opts.auto ? '自动' : '手动');
      }
    } else {
      await appendSyncLog('下载', false, result.message || '下载失败', opts && opts.auto ? '自动' : '手动');
    }
    return result;
  }, options);
}

/**
 * 合并同步（双向）
 */
async function mergeSync(options) {
  return withLock(async (opts) => {
    // 权限守门
    const config = await MiniSync.storage.getWebdavConfig();
    const perm = await ensurePermission(config.url);
    if (!perm.ok) return { success: false, code: perm.code, message: perm.error };

    const result = await withRetry(
      (o) => MiniSync.orchestrator.mergeSync(o),
      opts, 1
    );
    if (result.success && result.stats) {
      const s = result.stats;
      const bmCount = result.bookmarkCount || 0;
      const folderCount = result.folderCount || 0;
      // 同步记录/界面与上传/下载保持同一格式："X 条"（书签数量列，不含文件夹）
      const totalCount = bmCount + folderCount;
      // 增量：本次落盘实际新建/删除（含云端独有节点与桥接注入），便于核对总数变化
      const parts = [];
      if (result.importedCount > 0) parts.push(`新增 ${result.importedCount}`);
      if (result.removedCount > 0) parts.push(`删除 ${result.removedCount}`);
      console.log(`[sync] 🔄 合并成功: ${totalCount} 条数据 (${bmCount} 书签 + ${folderCount} 文件夹)${parts.length ? ' [' + parts.join('、') + ']' : ''}`);
      if (result.conflictCount > 0) {
        const first = (result.conflictSamples && result.conflictSamples[0]) || '';
        await appendSyncLog('合并', false, `${result.conflictCount} 条没能写入本地：${first}`, opts && opts.auto ? '自动' : '手动');
      } else {
        await appendSyncLog('合并', true, `${bmCount} 条`, opts && opts.auto ? '自动' : '手动');
      }
    } else if (!result.success) {
      await appendSyncLog('合并', false, result.message || '合并失败', opts && opts.auto ? '自动' : '手动');
    }
    return result;
  }, options);
}

return {
  uploadBookmarks,
  downloadBookmarks,
  mergeSync,
  ensurePermission,
  testConnection: async function(config) {
    // 权限守门
    const perm = await ensurePermission(config.url);
    if (!perm.ok) return { success: false, code: perm.code, message: perm.error };
    return MiniSync.webdav.testConnection(config);
  }
};

})();
