// 测试辅助：在 Node 下加载依赖全局 MiniSync / importScripts 共享作用域的源码。
// 这些文件用 `var MiniSync = MiniSync || {}` 和顶层 `var ROOT_ID` 等声明，
// 依赖「全局作用域共享」。用 vm.runInThisContext 在全局上下文执行即可还原该行为。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

function loadFile(rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  // 以全局上下文运行，使 var 声明与 MiniSync 挂载生效（等价于浏览器 importScripts）
  vm.runInThisContext(code, { filename: rel });
}

// 按 background.js 中的真实加载顺序（依赖关系）
const ORDER = [
  'lib/constants.js',
  'lib/utils.js',
  'lib/update.js',
  'model/xbel.js',
  'model/xbel-path.js',
  'model/tombstone.js',
  'core/storage.js',
  'lib/merge.js',
  'core/sync-input.js',
  'core/sync-merge.js',
  'core/sync-orchestrator.js',
];

let loaded = false;

/** 加载全部源码到全局 MiniSync（幂等） */
function loadSource() {
  if (loaded) return;
  // 预置最小全局 MiniSync，避免首行 `MiniSync = MiniSync || {}` 在严格上下文报错
  if (typeof global.MiniSync === 'undefined') {
    global.MiniSync = {};
  }
  for (const f of ORDER) loadFile(f);
  loaded = true;
}

module.exports = { loadSource, ROOT };
