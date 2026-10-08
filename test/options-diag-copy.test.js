// options-diag-copy.test.js — 设置页「一键复制诊断报告」的逻辑验收（2026-10-05 用户诉求：
// 「后台运行诊断能不能加一个复制按钮，每次手动复制好慢」）。
//
// 为什么单独建这份骨架：页面脚本（options.js）在门禁里【只被解析、不被执行】
// （test/page-scripts.test.js 只防顶层重名）。而这条功能的两个关键分支——① 有
// navigator.clipboard 时的现代通道 ② 没有/被拒时的 textarea + execCommand 回退——
// 恰恰是手机宿主与桌面浏览器的差别所在，必须真的跑一遍才算验过。
//
// 做法：从 options.js 里按注释锚点切出「诊断 + 复制」那一段，在带假 DOM 的 vm 里执行。
// 切片锚点写死在下面，一旦重构改掉注释就会【立刻报错】而不是静默测空气。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'options.js'), 'utf8');
const START_ANCHOR = 'const diagHintDefault';
const END_ANCHOR = '// 「授权域名访问」按钮';

function sliceDiagCode() {
  const start = SRC.indexOf(START_ANCHOR);
  const end = SRC.indexOf(END_ANCHOR);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('options.js 里找不到「诊断 + 复制」代码段（锚点漂了：' + START_ANCHOR + ' / ' + END_ANCHOR + '）');
  }
  return SRC.slice(start, end);
}
const DIAG_CODE = sliceDiagCode();

const HTML = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');

function makeHarness({ clipboard, execResult = true, diagnose } = {}) {
  const els = {};
  const el = (id) => {
    if (!els[id]) {
      els[id] = {
        id, textContent: '', className: '', disabled: false, style: {}, handlers: {},
        addEventListener(ev, fn) { this.handlers[ev] = fn; },
      };
    }
    return els[id];
  };
  // 复制按钮的初始 disabled 来自静态 HTML（见下面那条用例），假 DOM 要照着来，
  // 否则这条用例测的是「JS 有没有把它打开」，而不是真实起点。
  el('diagCopyBtn').disabled = true;
  const created = { textareas: [], appended: 0, removed: 0 };
  const calls = { writeText: [], exec: [], focused: 0, removedNode: 0 };
  const document = {
    getElementById: (id) => el(id),
    createElement: (tag) => {
      const ta = {
        tag, value: '', style: {}, attrs: {},
        setAttribute(k, v) { this.attrs[k] = v; },
        focus() { calls.focused++; },
        select() {},
        setSelectionRange() {},
      };
      created.textareas.push(ta);
      return ta;
    },
    body: {
      appendChild(node) { created.appended++; created.lastAppended = node; },
      removeChild(node) { created.removed++; calls.removedNode++; },
    },
    execCommand: (cmd) => { calls.exec.push(cmd); return execResult; },
  };
  const ctx = {
    document,
    navigator: clipboard === null ? {} : { clipboard },
    setTimeout: () => 0,           // 提示的自动复原不跑：断言停在「已复制…」这一刻
    JSON, console,
    MiniSync: { utils: { collectDiagnostics: diagnose || (async () => ({ ok: true })) } },
  };
  vm.createContext(ctx);
  for (const file of ['lib/constants.js', 'lib/utils.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), ctx, { filename: file });
  }
  ctx.MiniSync.utils.collectDiagnostics = diagnose || (async () => ({ ok: true }));
  vm.runInContext(DIAG_CODE, ctx, { filename: 'options.js#diag' });
  return { els, el, created, calls };
}

const clickCopy = (h) => h.el('diagCopyBtn').handlers.click();
// 照真实流程造出「报告已就绪」：诊断跑完 → 报告进 diagOut + 复制按钮解禁
const setReport = (h, text) => { h.el('diagOut').textContent = text; h.el('diagCopyBtn').disabled = false; };
const clickDiag = (h) => h.el('diagBtn').handlers.click();
const flush = () => new Promise((r) => setImmediate(r));

describe('设置页：一键复制诊断报告', () => {
  test('静态 HTML：复制按钮挨着「运行后台诊断」，且默认 disabled（没有报告时点不动）', () => {
    const tag = /<button[^>]*id="diagCopyBtn"[^>]*>/.exec(HTML);
    expect(tag).toBeTruthy();
    expect(tag[0]).toContain('disabled');
    expect(HTML).toContain('id="diagOut"');
    expect(HTML).toContain('id="diagBtn"');
    // 两个按钮同款外形（设置页动作按钮统一为 .btn-mini）
    expect(HTML).toContain('class="btn-mini" id="diagBtn"');
    expect(HTML).toContain('class="btn-mini" id="diagCopyBtn"');
  });

  test('报告跑完后，复制按钮才可用（「正在诊断…」不是报告，不许被拷走）', async () => {
    let release;
    const pending = new Promise((r) => { release = r; });
    const h = makeHarness({ clipboard: { writeText: (t) => { h.calls.writeText.push(t); return Promise.resolve(); } },
                            diagnose: () => pending });
    expect(h.el('diagCopyBtn').disabled).toBe(true);      // 还没跑诊断（静态 HTML 里也是 disabled）

    const running = clickDiag(h);
    await flush();
    expect(h.el('diagCopyBtn').disabled).toBe(true);      // 正在跑，仍不可复制
    expect(h.el('diagOut').textContent).toContain('正在诊断');
    await clickCopy(h);                                   // 此刻点复制：不该把「正在诊断…」拷走
    await flush();
    expect(h.calls.writeText).toEqual([]);

    release({ probe: 1 });
    await running;
    expect(h.el('diagCopyBtn').disabled).toBe(false);
    expect(h.el('diagOut').textContent).toContain('"probe": 1');
  });

  test('★ 现代通道：navigator.clipboard 可用时用它，并如实回报「已复制（N 字）」', async () => {
    const h = makeHarness({ clipboard: { writeText: (t) => { h.calls.writeText.push(t); return Promise.resolve(); } } });
    setReport(h, '{"ok":true}');
    await clickCopy(h);
    await flush();
    expect(h.calls.writeText).toEqual(['{"ok":true}']);
    expect(h.created.textareas.length).toBe(0);            // 走现代通道就不该再造 textarea
    const hint = h.el('diagHint');
    expect(hint.className).toContain('ok');
    expect(hint.textContent).toContain('已复制');
    expect(hint.textContent).toContain('11 字');
  });

  test('★ 回退通道：clipboard 被拒/不存在（手机宿主）⇒ textarea + execCommand 仍能复制', async () => {
    const h = makeHarness({ clipboard: { writeText: () => Promise.reject(new Error('NotAllowedError')) } });
    setReport(h, '手机上的长报告'.repeat(50));
    await clickCopy(h);
    await flush();
    expect(h.created.textareas.length).toBe(1);            // 造了临时 textarea
    expect(h.created.textareas[0].value).toContain('手机上的长报告');
    expect(h.created.textareas[0].attrs.readonly).toBe(''); // readonly：避免手机弹软键盘
    expect(h.calls.exec).toEqual(['copy']);
    expect(h.created.removed).toBe(1);                      // 用完必须摘掉，别在页面上留垃圾节点
    expect(h.el('diagHint').className).toContain('ok');
  });

  test('clipboard 压根不存在（老宿主）也走回退通道', async () => {
    const h = makeHarness({ clipboard: null });
    setReport(h, 'abc');
    await clickCopy(h);
    await flush();
    expect(h.calls.exec).toEqual(['copy']);
    expect(h.el('diagHint').textContent).toContain('已复制');
  });

  test('两条通道都失败 ⇒ 如实说「复制失败」并指路手动选择（不许假装成功）', async () => {
    const h = makeHarness({ clipboard: { writeText: () => Promise.reject(new Error('denied')) }, execResult: false });
    setReport(h, 'abc');
    await clickCopy(h);
    await flush();
    const hint = h.el('diagHint');
    expect(hint.className).toContain('err');
    expect(hint.textContent).toContain('复制失败');
    expect(hint.textContent).toContain('长按');
  });

  test('诊断出错仍可复制安全的错误类别，不复制原始错误文本', async () => {
    const h = makeHarness({ clipboard: { writeText: (t) => { h.calls.writeText.push(t); return Promise.resolve(); } },
                            diagnose: () => { throw new Error('GET https://u:pw@dav.invalid/?token=secret#frag failed'); } });
    await clickDiag(h);
    await flush();
    expect(h.el('diagOut').textContent).toContain('诊断本身出错');
    expect(h.el('diagOut').textContent).not.toMatch(/u:pw|token=secret|#frag|failed/);
    expect(h.el('diagCopyBtn').disabled).toBe(false);
    await clickCopy(h);
    await flush();
    expect(h.calls.writeText[0]).toBe(h.el('diagOut').textContent);
  });
});
