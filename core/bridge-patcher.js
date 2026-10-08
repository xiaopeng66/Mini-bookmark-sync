// core/bridge-patcher.js — Berry/Via 桥接写回
//
// 调度 Berry 和 Via 浏览器的书签文件写回。
// 从 sync-orchestrator.js 拆出，职责单一。
//
// ⚠️ 必须用 IIFE 包裹所有声明

MiniSync.bridgePatcher = (function() {

/**
 * Berry/Via/Aira 桥接写回（按开关执行，失败不阻断主流程）
 * 每个桥接只写回自己的列表，互不被其他桥接数据污染。
 * @param {Object} lists - { berryList, viaList, airaList }
 * @param {Object} opts - { berryOn, viaOn, airaOn }
 * @returns {Promise<{bridgeResults:Object,partial:boolean}>}
 */
async function patchBridges(lists, opts) {
  const berryList = (lists && lists.berryList) || [];
  const viaList = (lists && lists.viaList) || [];
  const airaList = (lists && lists.airaList) || [];
  const berryOn = opts ? opts.berryOn : false;
  const viaOn = opts ? opts.viaOn : false;
  const airaOn = opts ? opts.airaOn : false;
  // ★ 覆盖语义（上传路径）：airaRebuild=true → Aira snapshot 以桌面列表全量重建；
  //   airaHomeAlign=true → personalization 主页以桌面 home 为准对齐。
  //   合并路径不传这两个值，保持「吸收端上新增」语义。
  const airaRebuild = !!(opts && opts.airaRebuild);
  const airaHomeAlign = !!(opts && opts.airaHomeAlign);

  const skipped = () => ({ status: 'skipped' });
  const bridgeResults = { berry: skipped(), viaHtml: skipped(), viaFavorites: skipped(), aira: skipped(), airaHome: skipped() };
  const failure = e => ({ status: 'failed', error: e && e.message ? e.message : String(e) });
  const status = value => value && ['success', 'skipped', 'failed'].includes(value.status)
    ? value : { status: 'failed', error: '桥接写回未返回有效状态' };

  // Berry：必须显式开启（=== true 才启用），避免 undefined 时误开
  if (berryOn) {
    try {
      bridgeResults.berry = status(await MiniSync.berry.patchBerryFile(berryList));
    } catch (e) {
      bridgeResults.berry = failure(e);
      console.warn('[sync] Berry 写回失败:', e.message);
    }
  }
  // Via：默认关闭（=== true 才启用）
  if (viaOn) {
    try {
      const result = await MiniSync.via.patchViaFile(viaList);
      bridgeResults.viaHtml = status(result && result.html);
      bridgeResults.viaFavorites = status(result && result.favorites);
    } catch (e) {
      bridgeResults.viaHtml = failure(e);
      bridgeResults.viaFavorites = failure(e);
      console.warn('[sync] Via 写回失败:', e.message);
    }
  }
  // Aira：默认关闭（=== true 才启用），与 Via 同策略
  if (airaOn) {
    // 覆盖判定：上传路径恒重建（airaRebuild）；或一次性开关 aira_rebuild_once（兼容保留）
    let rebuildAira = airaRebuild;
    let oneShotRebuild = false;
    if (!rebuildAira) {
      try {
        oneShotRebuild = (await chrome.storage.local.get(['aira_rebuild_once']))['aira_rebuild_once'] === true;
        if (oneShotRebuild) {
          rebuildAira = true;
          console.log('[sync] 🤖 Aira 文件重建模式：以桌面列表为准重建 snapshot');
        }
      } catch (e) { /* ignore */ }
    }
    try {
      bridgeResults.aira = status(await MiniSync.aira.patchAiraFile(airaList, { rebuild: rebuildAira }));
      if (oneShotRebuild && bridgeResults.aira.status === 'success') {
        await chrome.storage.local.remove('aira_rebuild_once');
      }
    } catch (e) {
      bridgeResults.aira = failure(e);
      console.warn('[sync] Aira 写回失败:', e.message);
    }
    try {
      bridgeResults.airaHome = status(await MiniSync.aira.patchAiraPersonalization(airaList, { align: airaHomeAlign }));
    } catch (e) {
      bridgeResults.airaHome = failure(e);
      console.warn('[sync] Aira 主页写回失败:', e.message);
    }
  }
  return { bridgeResults, partial: Object.values(bridgeResults).some(result => result.status === 'failed') };
}

return { patchBridges };

})();
