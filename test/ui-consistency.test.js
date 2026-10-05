// ui-consistency.test.js — 界面上「同一套东西长同一副样子」的守护（2026-10-05 用户诉求：
// 「把设置界面上边的三个按钮（返回/清空配置/清空表单）重新优化 UI，跟插件主页界面的按钮风格统一」）。
//
// 为什么值得一条门禁：这类「风格统一」的改动最容易在后续小改里被悄悄改回去
// （加个按钮顺手写回自己的样式），而页面级缺陷既有门禁全部看不见
// （见 page-scripts.test.js 记录的前车之鉴：测试全绿、页面却是坏的）。
// 这里只钉「结构契约」（用哪个基类、有没有图标、旧的独立样式是否清干净），
// 具体像素由真浏览器复核兜底。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const POPUP = read('popup.html');
const OPTIONS = read('options.html');

/** 取某个 id 的 <button ...> 开标签 */
function btnTag(html, id) {
  const m = new RegExp('<button[^>]*id="' + id + '"[^>]*>').exec(html);
  if (!m) throw new Error('找不到按钮 #' + id);
  return m[0];
}
/** 取某个 id 按钮的整段内容（开标签到 </button>） */
function btnHtml(html, id) {
  const start = html.indexOf('<button' + btnTag(html, id).slice('<button'.length));
  const end = html.indexOf('</button>', start);
  return html.slice(start, end);
}
const classOf = (html, id) => (/(?:^|\s)class="([^"]*)"/.exec(btnTag(html, id)) || [])[1] || '';

describe('界面一致性：主页与配置视图的按钮同一套外形', () => {
  test('配置视图顶栏三个按钮（返回/清空配置/清空表单）＝主页图标按钮的同款基类', () => {
    for (const id of ['backBtn', 'clearConfigBtn', 'deleteConfigBtn']) {
      const cls = classOf(POPUP, id).split(/\s+/);
      expect(cls, id + ' 必须用 .btn 基类').toContain('btn');
      expect(cls, id + ' 必须用 .icon-btn（与主页下载/上传/同步同款几何）').toContain('icon-btn');
    }
    // 主页那三个图标按钮就是这套基类（改配置视图时必须还是同一套）
    for (const id of ['downloadBtn', 'uploadBtn', 'syncBtn']) {
      const cls = classOf(POPUP, id).split(/\s+/);
      expect(cls).toContain('btn');
      expect(cls).toContain('icon-btn');
    }
  });

  test('三个按钮的图标是内联 SVG（不再是 ← / 🗑 / ✕ 字符字形）', () => {
    for (const id of ['backBtn', 'clearConfigBtn', 'deleteConfigBtn']) {
      const html = btnHtml(POPUP, id);
      expect(html, id + ' 必须有内联图标').toContain('<svg');
      expect(html, id + ' 的 svg 要和主页图标同一画法').toContain('stroke="currentColor"');
      expect(html, id + ' 不该再是裸字符字形').not.toMatch(/>\s*[←🗑✕]\s*<\/(button|svg)/);
    }
    expect(POPUP).not.toContain('>←<');
    expect(POPUP).not.toContain('>🗑<');
    expect(POPUP).not.toContain('>✕<');
  });

  test('危险语义只靠配色修饰类，且旧的两套独立样式已删干净（不留死 CSS）', () => {
    expect(classOf(POPUP, 'clearConfigBtn')).toContain('danger');
    expect(classOf(POPUP, 'deleteConfigBtn')).toContain('danger-strong');
    // 两种危险配色必须一眼分得开（红描边 vs 实红底）
    expect(POPUP).toContain('.btn.icon-btn.danger {');
    expect(POPUP).toContain('.btn.icon-btn.danger-strong {');
    expect(POPUP).not.toContain('.icon-danger {');
    expect(POPUP).not.toContain('.icon-danger-strong {');
  });

  test('设置页的诊断两个按钮同款（.btn-mini），外形与主页 .btn 一致', () => {
    expect(classOf(OPTIONS, 'diagBtn')).toContain('btn-mini');
    expect(classOf(OPTIONS, 'diagCopyBtn')).toContain('btn-mini');
    // 同形：圆角 6、1px 灰边（与 popup .btn 的规则同口径）
    const rule = /\.btn-mini\s*\{([^}]*)\}/.exec(OPTIONS);
    expect(rule).toBeTruthy();
    expect(rule[1]).toContain('border-radius: 6px');
    expect(rule[1]).toContain('border: 1px solid #d1d5db');
  });
});
