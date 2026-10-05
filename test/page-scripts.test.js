// page-scripts.test.js — 共享同一个全局词法作用域的脚本，顶层声明不许重名
//
// 真实事故（2026-10-05 我引入的一次回归）：lib/utils.js 与本项目的其它模块
// 【刻意不用 IIFE 包裹】（见 lib/utils.js 顶部注释：「所有函数必须在 IIFE 外部声明为
// 全局函数」）。于是经典脚本的顶层 const/let 全都落进【同一个全局词法作用域】。
// 我给 lib/utils.js 加了 `const CONN_CACHE_KEY`，又在 popup.js 里写了同名的
// `const CONN_CACHE_KEY = MiniSync.utils.CONN_CACHE_KEY;` ⇒ 浏览器解析 popup.js 时
// 直接 SyntaxError ⇒ popup.js 整个文件一行都不执行：滑块保留静态 HTML 的
// `class="auto-switch off"`（显示成「自动同步关闭」）、点击没有任何 onclick
// （怎么点都「打不开」）、状态栏与按钮全部失灵。
//
// 这个缺陷【既有门禁全都看不见】：node --check 与 vitest 都是逐个文件加载，
// markers 只做子串匹配，文件级单测也不加载页面脚本。
// 这里照浏览器的方式，把「同一个页面 / 后台里一起加载的脚本」拼成一个程序解析一遍：
// 顶层 const/let/class 重名是【早期错误】，解析阶段就会抛。
//
// 覆盖三处共享作用域：popup.html、options.html（各自的 <script src> + 内联脚本）、
// 以及 MV3 service worker 的 importScripts(...) 列表（同样是一个全局作用域）。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripDot = (p) => p.replace(/^\.\//, '');

/** 页面：按文档顺序取脚本；内联脚本也共享同一作用域，按出现位置插进去 */
function pageScriptParts(htmlFile) {
  const html = read(htmlFile);
  const parts = [];
  let inline = 0;
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const src = /src\s*=\s*["']([^"']+)["']/.exec(m[1] || '');
    const inlineCode = (m[2] || '').trim();
    if (src) parts.push({ name: stripDot(src[1]), code: read(stripDot(src[1])) });
    else if (inlineCode) parts.push({ name: htmlFile + '#inline' + (++inline), code: inlineCode });
  }
  return parts;
}

/** background 的 importScripts 列表（MV3 worker 里这些文件共享一个全局作用域） */
function backgroundScriptParts() {
  const bg = read('background.js');
  const start = bg.indexOf('importScripts(');
  const body = bg.slice(start + 'importScripts('.length, bg.indexOf(')', start));
  const list = body
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  return list.map((f) => ({ name: f, code: read(f) })).concat([{ name: 'background.js', code: bg }]);
}

/** 拼成一个程序：插入分号，避免上一文件末尾与下一文件开头被 ASI 粘连 */
function concatParts(parts) {
  return parts.map((p) => '//==== ' + p.name + '\n' + p.code + '\n;\n').join('');
}

function expectParses(parts, label) {
  try {
    new vm.Script(concatParts(parts), { filename: label });
  } catch (e) {
    throw new Error(
      label + '：' + e.name + ': ' + e.message +
      '\n  参与同一作用域的脚本：' + parts.map((p) => p.name).join(', ') +
      '\n  多数情况是两个脚本各自在顶层声明了同一个 const/let —— 换个名字，' +
      '或把其中一个挪进 IIFE/函数里。'
    );
  }
}

describe('页面/后台的脚本共享同一个全局词法作用域：顶层声明不许重名', () => {
  const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));

  test('仓库里确实有页面要检查（防止本文件因为找不到 html 而空跑变绿）', () => {
    expect(pages.length).toBeGreaterThan(0);
  });

  for (const page of pages) {
    test(page + ' 的脚本整体解析通过（重名 const/let 会让整页脚本一行都不执行）', () => {
      const parts = pageScriptParts(page);
      expect(parts.length).toBeGreaterThan(0);
      expectParses(parts, page);
    });
  }

  test('后台 importScripts 列表 + background.js 整体解析通过', () => {
    const parts = backgroundScriptParts();
    expect(parts.length).toBeGreaterThan(5);
    expect(parts.map((p) => p.name)).toContain('lib/utils.js');
    expectParses(parts, 'background');
  });

  test('popup.js 与 lib/utils.js 没有同名顶层常量（本次事故的直接守护）', () => {
    const topNames = (src) => {
      const names = new Set();
      for (const line of src.split('\n')) {
        const m = /^(?:const|let)\s+([A-Za-z_$][\w$]*)/.exec(line);
        if (m) names.add(m[1]);
      }
      return names;
    };
    const clash = [...topNames(read('lib/utils.js'))].filter((n) => topNames(read('popup.js')).has(n));
    expect(clash).toEqual([]);
  });
});
