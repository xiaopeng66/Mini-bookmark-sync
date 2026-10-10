// lib/update.js — 检查稳定发布并定位当前宿主的安装包。
// 安装由浏览器处理；API 不可用时回退 Atom，无法确认版本就返回失败。

MiniSync.update = (function() {

const REPO = 'xiaopeng66/Mini-bookmark-sync';
const RELEASES_PAGE = 'https://github.com/' + REPO + '/releases';
const ATOM_URL = 'https://github.com/' + REPO + '/releases.atom';
const API_URL = 'https://api.github.com/repos/' + REPO + '/releases/latest';
const CHECK_TIMEOUT_MS = 15000;
const OVERALL_TIMEOUT_MS = 30000;
const ASSET_PREFIX = 'minibookmark-sync-';

// ========== 版本号比较 ==========

/** 版本号 → 数字段数组（忽略前置 v；非数字段当 0，'2.2.1.1' → [2,2,1,1]） */
function versionParts(text) {
  return String(text == null ? '' : text).trim().replace(/^v/i, '').split('.')
    .map((seg) => {
      const n = parseInt(seg, 10);
      return Number.isFinite(n) ? n : 0;
    });
}

/** 逐段数字比较：a<b 返回 -1，相等 0，a>b 返回 1（2.2.1.1 > 2.2.1，2.2.2 > 2.2.1.1） */
function compareVersions(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) {
    const left = x[i] || 0;
    const right = y[i] || 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * 常驻后台变体的版本号是「源码版本 + .1」（tools/build_packages.py 的 persistent_ver）。
 * 直接拿它和发布标签比会得出「本机 2.2.2.1 比发布版 v2.2.2 还新」的假结论 ——
 * 用户会看到「本机比发布版更新」而以为不用升级。只在当前【就是】常驻变体时去掉这截 .1。
 * 该变体永远是 <源码版本>.1，所以剥掉一段是精确的，不会误伤真实版本号。
 */
function channelVersion(version, variant) {
  const text = String(version == null ? '' : version).trim();
  if (variant === 'gecko-mv2-persistent' && /\.\d+$/.test(text)) {
    return text.replace(/\.\d+$/, '');
  }
  return text;
}

// ========== 宿主形态 → 该装哪个包 ==========

/**
 * 从本扩展清单判断当前宿主形态。
 *  · update_url 在 ⇒ 商店版：浏览器自己会更新，手动下载是多余的（源码清单里只有商店版带它，
 *    旁加载/暂存时 tools 会把它去掉 —— tools/build_packages.py、tools/stage_edge_unpacked.py）
 *  · manifest_version 3 ⇒ 桌面 Chromium 旁加载（crx/zip）
 *  · manifest_version 2 ⇒ Gecko 系（手机端/桌面 Firefox），persistent 与否再分两种包
 */
function selectHostVariant(manifest) {
  const m = manifest || {};
  if (m.update_url) return 'store';
  if (m.manifest_version === 3) return 'chromium-sideload';
  if (m.background && m.background.persistent === true) return 'gecko-mv2-persistent';
  return 'gecko-mv2';
}

/** 宿主形态的中文名（设置页「当前版本」那一行用） */
function variantText(variant) {
  return {
    'store': '商店版',
    'chromium-sideload': '桌面旁加载版',
    'gecko-mv2': 'Gecko 事件页变体',
    'gecko-mv2-persistent': '手机常驻后台变体'
  }[variant] || '未知形态';
}

/**
 * 安装包文件名（与 tools/build_packages.py / tools/verify_release.py 的产物契约一一对应）。
 * 注意常驻变体的文件名里嵌的是 <版本>.1 —— 这个 .1 是构建脚本加的，不是我们编的。
 */
function assetName(variant, version) {
  const ver = String(version == null ? '' : version).trim();
  if (!ver) return null;
  if (variant === 'chromium-sideload') return ASSET_PREFIX + ver + '-chromium-sideload.zip';
  if (variant === 'gecko-mv2') return ASSET_PREFIX + ver + '-gecko-mv2.xpi';
  if (variant === 'gecko-mv2-persistent') return ASSET_PREFIX + ver + '.1-gecko-mv2-persistent.xpi';
  return null;  // 商店版没有手动安装包
}

function releaseTag(version) {
  return 'v' + String(version == null ? '' : version).trim();
}

/** 按发布标签 + 文件名拼出下载地址（发布页的资产路径就是 releases/download/<tag>/<file>） */
function assetUrl(variant, version) {
  const name = assetName(variant, version);
  if (!name) return null;
  return 'https://github.com/' + REPO + '/releases/download/' + releaseTag(version) + '/' + name;
}

// ========== 发布信息解析（纯文本进、对象出，便于单测）==========

function stableVersion(tag) {
  const text = String(tag == null ? '' : tag).trim();
  return /^v?\d+(?:\.\d+)*$/i.test(text) ? text.replace(/^v/i, '') : null;
}

// 只接受本仓库发布路径；同时用于新响应和缓存结果。
function safeReleaseUrl(url, download) {
  const text = String(url || '');
  const prefix = RELEASES_PAGE + (download ? '/download/' : '');
  if (!text.startsWith(prefix) || /[\s\\?#]/.test(text)) return null;
  const rest = text.slice(prefix.length);
  if (download) return /^v?\d+(?:\.\d+)*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(rest) ? text : null;
  return !rest || /^\/tag\/v?\d+(?:\.\d+)*$/i.test(rest) ? text : null;
}

function releaseFromTag(tag, url, published, assets) {
  const clean = stableVersion(tag);
  if (!clean) return null;
  return {
    tag: 'v' + clean,
    version: clean,
    url: safeReleaseUrl(url, false) || (RELEASES_PAGE + '/tag/v' + clean),
    published: published || null,
    assets: Array.isArray(assets) ? assets : []
  };
}

// Atom 按发布时间遍历：id/link 提供标签，缺标签时才用合法数字 title。
function parseAtomFeed(xml) {
  const entries = String(xml || '').match(/<entry\b[^>]*>[\s\S]*?<\/entry>/g) || [];
  for (const body of entries) {
    const id = (/<id>[^<]*\/([^/<]+)<\/id>/.exec(body) || [])[1];
    const links = body.match(/<link\b[^>]*>/g) || [];
    let href = null;
    let linkTag = null;
    for (const link of links) {
      const value = (/\bhref=["']([^"']+)["']/.exec(link) || [])[1];
      const tag = value && value.startsWith(RELEASES_PAGE + '/tag/') ? value.slice((RELEASES_PAGE + '/tag/').length) : null;
      if (tag != null) { href = value; linkTag = tag; break; }
    }
    const title = (/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/.exec(body) || [])[1];
    const tag = id || linkTag || title;
    if (!stableVersion(tag) || (linkTag && !stableVersion(linkTag))) continue;
    const published = (/<updated>([\s\S]*?)<\/updated>/.exec(body) || [])[1] || null;
    return releaseFromTag(tag, href, published, null);
  }
  return null;
}

function parseApiRelease(json) {
  const obj = json || {};
  if (obj.draft || obj.prerelease || !stableVersion(obj.tag_name)) return null;
  const assets = (Array.isArray(obj.assets) ? obj.assets : [])
    .filter((a) => a && a.name && safeReleaseUrl(a.browser_download_url, true))
    .map((a) => ({ name: String(a.name), url: a.browser_download_url }));
  return releaseFromTag(obj.tag_name, obj.html_url || null, obj.published_at || null, assets);
}

/**
 * 从发布页给的资产清单里挑出当前宿主要的那一个。
 * 先按精确文件名找；找不到再按后缀找 —— 构建脚本哪天改了前缀（minibookmark-sync-）也还能命中。
 * 注意 '-gecko-mv2.xpi' 不会误配 '-gecko-mv2-persistent.xpi'（后者结尾是 -persistent.xpi）。
 */
function pickAsset(assets, variant, version) {
  const list = Array.isArray(assets) ? assets : [];
  if (!list.length) return null;
  const exact = assetName(variant, version);
  if (exact) {
    const hit = list.find((a) => a.name === exact);
    if (hit) return hit;
  }
  const suffix = {
    'chromium-sideload': '-chromium-sideload.zip',
    'gecko-mv2': '-gecko-mv2.xpi',
    'gecko-mv2-persistent': '-gecko-mv2-persistent.xpi'
  }[variant];
  if (!suffix) return null;
  return list.find((a) => a.name.endsWith(suffix)) || null;
}

// ========== 带超时的请求 ==========

function shortError(error) {
  const text = String((error && error.message) || error || '').replace(/\s+/g, ' ').trim();
  return text.length > 120 ? text.slice(0, 120) + '…' : text;
}

// 超时覆盖 headers 和 body；即使宿主缺 abort 或 fetch 忽略 signal 也能结束等待。
async function request(doFetch, url, timeoutMs, init, readBody) {
  const ms = timeoutMs == null ? CHECK_TIMEOUT_MS : timeoutMs;
  if (ms <= 0) throw new Error('检查超时');
  const controller = (typeof AbortController === 'function') ? new AbortController() : null;
  const options = Object.assign({ redirect: 'follow' }, init || {});
  if (controller) options.signal = controller.signal;
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('请求超时'));
      if (controller) { try { controller.abort(); } catch (_) {} }
    }, ms);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await doFetch(url, options);
        const body = response && response.ok && readBody ? await response[readBody]() : null;
        return { response, body };
      })(),
      timeout
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 点下载之前先探一次安装包在不在：构造出来的地址 404 比「点开一看是 404」诚实得多。
 * 只有能【确认不存在】才撤下下载按钮；探不动（宿主不支持 HEAD、请求被挡、超时）如实记 unknown，
 * 按钮照给但界面会写明「未能预先确认」—— 不许把「不知道」说成「没问题」。
 */
async function probeAsset(doFetch, url, timeoutMs) {
  try {
    const { response: resp } = await request(doFetch, url, timeoutMs, { method: 'HEAD' });
    if (!resp) return { state: 'unknown', note: '宿主没有返回探测结果' };
    if (resp.ok) return { state: 'ok', note: '' };
    if (resp.status === 404 || resp.status === 410) return { state: 'missing', note: 'HTTP ' + resp.status };
    return { state: 'unknown', note: 'HTTP ' + resp.status };
  } catch (e) {
    return { state: 'unknown', note: shortError(e) };
  }
}

// ========== 检查更新 ==========

// API → Atom → 必要时 HEAD。单次 15 秒，整个检查默认 30 秒。
// fetchImpl、timeoutMs、overallTimeoutMs、skipProbe 可由测试注入。
async function checkForUpdate(options) {
  const opts = options || {};
  const deadline = Date.now() + (opts.overallTimeoutMs == null ? OVERALL_TIMEOUT_MS : opts.overallTimeoutMs);
  const remaining = () => Math.min(opts.timeoutMs == null ? CHECK_TIMEOUT_MS : opts.timeoutMs, deadline - Date.now());
  // 注入优先（显式传 null = 模拟「宿主没有 fetch」）；否则包一层再调，
  // 既避开「方法被摘出来后 this 不对」，也不用 globalThis ——
  // 老宿主（Gecko 57~64，清单里 strict_min_version 就是 57.0）根本没有 globalThis。
  const doFetch = ('fetchImpl' in opts)
    ? opts.fetchImpl
    : ((typeof fetch === 'function') ? ((url, init) => fetch(url, init)) : null);
  const variant = opts.variant || selectHostVariant(opts.manifest || {});
  const current = String(opts.current == null ? '' : opts.current).trim();
  const result = {
    ok: false,
    code: null,
    error: '',
    current: current,
    channel: channelVersion(current, variant),
    variant: variant,
    latest: null,
    tag: null,
    releaseUrl: RELEASES_PAGE,
    published: null,
    state: null,          // newer / current / local-ahead
    source: null,         // api / atom
    assetName: null,
    assetUrl: null,
    probe: 'skipped',     // ok / missing / unknown / listed / skipped
    probeNote: '',
    checkedAt: Date.now()
  };
  if (!doFetch) {
    result.code = 'NO_FETCH';
    result.error = '当前宿主没有 fetch 接口，无法联网检查';
    return result;
  }

  // ① releases API（有资产清单）→ ② releases.atom（无鉴权、不限流）
  const failures = [];
  let release = null;
  try {
    const { response: resp, body } = await request(doFetch, API_URL, remaining(), null, 'json');
    if (resp && resp.ok) {
      release = parseApiRelease(body);
      if (release) result.source = 'api';
      else failures.push('releases API：返回内容无法解析');
    } else {
      failures.push('releases API：HTTP ' + ((resp && resp.status) || '未知'));
    }
  } catch (e) {
    failures.push('releases API：' + shortError(e));
  }
  if (!release) {
    try {
      const { response: resp, body } = await request(doFetch, ATOM_URL, remaining(), null, 'text');
      if (resp && resp.ok) {
        release = parseAtomFeed(body);
        if (release) result.source = 'atom';
        else failures.push('releases.atom：返回内容无法解析');
      } else {
        failures.push('releases.atom：HTTP ' + ((resp && resp.status) || '未知'));
      }
    } catch (e) {
      failures.push('releases.atom：' + shortError(e));
    }
  }
  if (!release) {
    result.code = 'UNREACHABLE';
    result.error = failures.join('；');
    return result;
  }

  result.latest = release.version;
  result.tag = release.tag;
  result.releaseUrl = release.url || result.releaseUrl;
  result.published = release.published;
  result.ok = true;

  const cmp = compareVersions(result.channel, release.version);
  result.state = cmp < 0 ? 'newer' : (cmp === 0 ? 'current' : 'local-ahead');
  if (result.state !== 'newer') return result;

  // 有新版本才去定位安装包
  const listed = pickAsset(release.assets, variant, release.version);
  if (listed) {
    result.assetName = listed.name;
    result.assetUrl = listed.url;
    result.probe = 'listed';   // 发布页自己给的地址，不需要再探
    return result;
  }
  const built = assetUrl(variant, release.version);
  if (!built) return result;   // 商店版：没有手动包
  result.assetName = assetName(variant, release.version);
  result.assetUrl = built;
  if (opts.skipProbe) return result;
  const probe = await probeAsset(doFetch, built, remaining());
  result.probe = probe.state;
  result.probeNote = probe.note;
  // 404 就不给下载按钮 —— 宁可让用户去发布页挑，也不给一个必然失败的按钮
  if (probe.state === 'missing') result.assetUrl = null;
  return result;
}

// ========== 结果 → 界面文案（纯函数：诚实与否在这里被钉死，也在这里被单测）==========

function describeUpdate(result) {
  const r = Object.assign({}, result || {});
  r.releaseUrl = safeReleaseUrl(r.releaseUrl, false) || RELEASES_PAGE;
  r.assetUrl = safeReleaseUrl(r.assetUrl, true);
  const variant = r.variant || 'gecko-mv2';
  const mobile = (variant === 'gecko-mv2' || variant === 'gecko-mv2-persistent');
  const view = { tone: 'info', headline: '', detail: '', download: null, link: null };

  if (!r.ok) {
    const reason = {
      NO_FETCH: '当前宿主没有联网接口',
      UNREACHABLE: '网络够不到发布页',
      BAD_RELEASE: '发布页没有可用的版本信息'
    }[r.code] || '未知原因';
    view.tone = 'err';
    view.headline = '检查更新失败：' + reason;
    view.detail = (r.error ? '原因：' + r.error + '。' : '') + '可以打开下面的发布页手动下载最新版。';
    view.link = { label: '打开发布页', url: r.releaseUrl || RELEASES_PAGE };
    return view;
  }

  const dateText = r.published ? ('（' + String(r.published).slice(0, 10) + '）') : '';

  if (r.state === 'current') {
    view.tone = 'ok';
    view.headline = '已是最新版本（v' + (r.channel || r.current) + '）';
    view.detail = '本机 ' + (r.current || '(未知)') + ' 与发布页一致，不需要更新。';
    return view;
  }

  if (r.state === 'local-ahead') {
    view.tone = 'ok';
    view.headline = '本机版本（' + r.current + '）比发布页（' + r.tag + '）更新';
    view.detail = '本机装的是比发布页更新的版本（开发版，或刚装上的常驻变体），不需要更新。';
    return view;
  }

  // state === 'newer'
  view.tone = 'ok';
  view.headline = '发现新版本 ' + r.tag + dateText;
  const parts = [];
  if (r.assetUrl) {
    parts.push('点「下载并安装」获取 ' + r.assetName + '。');
    parts.push(mobile
      ? '仅在宿主支持安装时，下载完成后由浏览器弹出安装确认；扩展没有安装扩展的权限。未签名 XPI 可能无法安装；只有以相同扩展 ID 覆盖安装，配置才有望保留，建议先导出备份。'
      : '桌面旁加载版请解压到原目录再点「重新加载」。宿主支持以相同扩展 ID 覆盖安装时，配置才有望保留，建议先导出备份。');
    if (r.probe === 'unknown') {
      parts.push('⚠️ 未能预先确认这个安装包是否就位（' + (r.probeNote || '探测无结果') + '）：若点开是 404，请到发布页手动选择。');
    }
  } else if (r.probe === 'missing') {
    parts.push('这一版没有 ' + r.assetName + ' 这个安装包（已确认不存在），请到发布页手动选择。');
    parts.push(mobile
      ? '手机端（可拓/雨见等 Gecko 宿主）选 gecko-mv2-persistent.xpi；手机 Firefox 选 gecko-mv2.xpi。'
      : '桌面 Edge / Chrome 选 chromium-sideload.zip，桌面上要带 -persistent 的是手机用的包，别装错。');
  } else {
    parts.push('本版由浏览器商店管理更新，通常不需要手动安装；要手动装请到发布页选择对应安装包。');
  }
  view.detail = parts.join('');
  if (r.assetUrl) view.download = { label: '下载并安装', url: r.assetUrl };
  view.link = { label: '打开发布页', url: r.releaseUrl || RELEASES_PAGE };
  return view;
}

/** 检查结果 → 一行小结（设置页的 hint 行；带颜色语义）*/
function updateStatusText(result) {
  const r = result || {};
  if (!r.ok) return '检查失败，详见下方说明';
  if (r.state === 'newer') return '有新版本 ' + r.tag;
  if (r.state === 'local-ahead') return '本机版本比发布页更新';
  return '已是最新版本';
}

return {
  REPO,
  RELEASES_PAGE,
  ATOM_URL,
  API_URL,
  CHECK_TIMEOUT_MS,
  versionParts,
  compareVersions,
  channelVersion,
  selectHostVariant,
  variantText,
  assetName,
  releaseTag,
  assetUrl,
  releaseFromTag,
  parseAtomFeed,
  parseApiRelease,
  pickAsset,
  probeAsset,
  checkForUpdate,
  describeUpdate,
  updateStatusText
};

})();
