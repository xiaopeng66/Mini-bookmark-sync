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
 * @returns {Promise<void>}
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

  let wroteBerry = false, wroteVia = false, wroteAira = false, wroteAiraHome = false;

  // Berry：必须显式开启（=== true 才启用），避免 undefined 时误开
  if (berryOn) {
    try {
      await MiniSync.berry.patchBerryFile(berryList);
      wroteBerry = true;
    } catch (e) {
      console.warn('[sync] Berry 写回失败:', e.message);
    }
  }
  // Via：默认关闭（=== true 才启用）
  if (viaOn) {
    try {
      await MiniSync.via.patchViaFile(viaList);
      wroteVia = true;
    } catch (e) {
      console.warn('[sync] Via 写回失败:', e.message);
    }
  }
  // Aira：默认关闭（=== true 才启用），与 Via 同策略
  if (airaOn) {
    // 覆盖判定：上传路径恒重建（airaRebuild）；或一次性开关 aira_rebuild_once（兼容保留）
    let rebuildAira = airaRebuild;
    if (!rebuildAira) {
      try {
        const flag = (await chrome.storage.local.get(['aira_rebuild_once']))['aira_rebuild_once'];
        if (flag === true) {
          rebuildAira = true;
          await chrome.storage.local.remove('aira_rebuild_once');
          console.log('[sync] 🤖 Aira 文件重建模式：以桌面列表为准重建 snapshot');
        }
      } catch (e) { /* ignore */ }
    }
    try {
      await MiniSync.aira.patchAiraFile(airaList, { rebuild: rebuildAira });
      wroteAira = true;
    } catch (e) {
      console.warn('[sync] Aira 写回失败:', e.message);
    }
    try {
      await MiniSync.aira.patchAiraPersonalization(airaList, { align: airaHomeAlign });
      wroteAiraHome = true;
    } catch (e) {
      console.warn('[sync] Aira 主页写回失败:', e.message);
    }
  }
}

return { patchBridges };

})();
