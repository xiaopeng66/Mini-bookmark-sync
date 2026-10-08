'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const ROOT = path.resolve(__dirname, '../..');
const BG = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const MODULES = [...BG.match(/importScripts\(([\s\S]*?)\);/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); },
  async emit(...args) { for (const fn of this.listeners) await fn(...args); } });
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };

function makeCloud() {
  return { files: new Map(), requests: [], hook: null, clock: Date.UTC(2026, 9, 7, 12),
    // 真实服务器的并发标识能力差异（坚果云/部分移动端宿主拿不到可用的强 ETag）正是
    // 「写入能否成立」的前提条件，测试必须能如实造出来，否则回归会再次漏网。
    etagMode: 'strong',        // 'strong' | 'weak' | 'none'
    lastModifiedMode: 'full',  // 'full' | 'none'
    dateMode: 'full',          // 'full' | 'none' —— 与 Last-Modified 分开，才能造出「只给 Date」的服务器
    // ★ 默认按真实服务器语义检查 PUT 预条件。不检查的话，测试只能看客户端「发了什么头」，
    //   发一个永远匹配不上的条件（例如拿响应 Date 当修改时间、或丢掉了亚秒精度）也会全绿。
    enforcePreconditions: true,
    // ★ 响应 Date 是「服务器当前时间」，与文件 mtime 是两回事：日期头随每次请求前进，
    //   而 mtime 只在写入时变。两者混同的话，「拿 Date 当修改时间去比对」这种错误
    //   在测试里永远撞不出来（旧骨架正是如此）。
    serverTick: 0,
    serverNow() { this.serverTick += 1; return new Date(this.clock + this.serverTick * 1000).toUTCString(); },
    put(url, content, contentType) {
      const file = { content: String(content), mtime: this.clock += 5000,
        etag: '"v' + (this.requests.length + this.clock) + '"', contentType: contentType || 'text/plain' };
      this.files.set(url, file);
      return file;
    } };
}

/** 按 cloud 的 etagMode / lastModifiedMode / dateMode 决定本次响应暴露哪些版本头。 */
function responseHeaders(file, cloud) {
  const etagMode = cloud ? cloud.etagMode : 'strong';
  const lastModifiedMode = cloud ? cloud.lastModifiedMode : 'full';
  const dateMode = cloud ? cloud.dateMode : 'full';
  const lastModifiedStamp = new Date(file.mtime || Date.UTC(2026, 9, 7, 12)).toUTCString();
  // 每次构造响应都向服务器时钟要一次「现在」（也正因此只在 response() 里调用一次）。
  const dateStamp = cloud && typeof cloud.serverNow === 'function'
    ? cloud.serverNow() : lastModifiedStamp;
  return { get(name) {
    const k = String(name).toLowerCase();
    if (k === 'etag') {
      if (etagMode === 'none' || !file.etag) return null;
      return etagMode === 'weak' ? 'W/' + file.etag : file.etag;
    }
    if (k === 'last-modified') return lastModifiedMode === 'none' ? null : lastModifiedStamp;
    if (k === 'date') return dateMode === 'none' ? null : dateStamp;
    return null;
  } };
}

/**
 * 真实服务器的预条件判定（RFC 7232）。命中返回状态码，否则 null。
 * HTTP 日期只有秒精度，所以比较的是截断到秒的 mtime —— 这正是真实服务端的口径，
 * 也正因为如此，「客户端发出的时间必须与服务器给的一致」才会被真正检验。
 */
function preconditionFailure(headers, current) {
  const ifMatch = headers['If-Match'];
  const ifNoneMatch = headers['If-None-Match'];
  const ifUnmodified = headers['If-Unmodified-Since'];
  if (ifMatch !== undefined) return (!current || ifMatch !== current.etag) ? 412 : null;
  if (ifNoneMatch !== undefined) return (ifNoneMatch === '*' && current) ? 412 : null;
  if (ifUnmodified !== undefined) {
    // 资源不存在时 RFC 7232 要求忽略该条件；存在则比较秒级修改时间
    if (!current) return null;
    const known = Date.parse(ifUnmodified);
    return Number.isNaN(known) ? null : (Math.floor(current.mtime / 1000) * 1000 > known ? 412 : null);
  }
  return null;
}

function makeDevice(name, cloud = makeCloud(), opts = {}) {
  let id = 1000;
  const state = {
    now: Date.UTC(2026, 9, 7, 12), failCreates: null, failStorageKeys: new Set(),
    logs: [], writes: [], updates: [], removals: [], timers: new Set(),
    store: {
      sync_device_id: 'audit-' + name, webdav_url: 'https://audit.invalid/dav',
      webdav_user: 'synthetic-user', webdav_password: 'synthetic-password',
      webdav_bookmark_path: '/sync', bookmark_target_id: '1', sync_enabled: false,
      option_berry_enabled: false, option_via_enabled: false, option_aira_enabled: false,
      ...opts.store
    },
    root: { id: '0', title: '', children: [
      { id: '1', title: '书签栏', parentId: '0', children: [] },
      { id: '2', title: '其他书签', parentId: '0', children: [] },
      { id: '3', title: '移动设备书签', parentId: '0', children: [] },
    ] },
  };
  const byId = new Map();
  const index = n => { byId.set(String(n.id), n); for (const c of n.children || []) index(c); };
  const unindex = n => { byId.delete(String(n.id)); for (const c of n.children || []) unindex(c); };
  index(state.root);
  const runtime = { id: 'synthetic-extension', lastError: null,
    getManifest: () => ({ manifest_version: 3, version: '2.1.0', permissions: ['bookmarks', 'storage', 'alarms'] }),
    getURL: rel => 'chrome-extension://synthetic-extension/' + rel,
    onMessage: event(), onInstalled: event(), onStartup: event(), sendMessage() { return Promise.resolve(); } };
  function result(cb, value) { if (cb) { cb(clone(value)); return undefined; } return Promise.resolve(clone(value)); }
  function fail(cb, message) {
    if (cb) { runtime.lastError = { message }; cb(); runtime.lastError = null; return undefined; }
    return Promise.reject(new Error(message));
  }
  const local = {
    get(keys, cb) {
      const list = keys == null ? Object.keys(state.store) : Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
      const out = {};
      for (const key of list) if (key in state.store) out[key] = clone(state.store[key]);
      return result(cb, out);
    },
    set(data, cb) {
      if (Object.keys(data).some(k => state.failStorageKeys.has(k))) return fail(cb, 'QUOTA_BYTES quota exceeded');
      state.writes.push(clone(data)); Object.assign(state.store, clone(data)); return result(cb);
    },
    remove(keys, cb) { for (const key of Array.isArray(keys) ? keys : [keys]) delete state.store[key]; return result(cb); }
  };
  const bookmarks = {
    onRemoved: event(), onMoved: event(),
    getTree(cb) { return result(cb, [state.root]); },
    get(ids, cb) {
      const values = (Array.isArray(ids) ? ids : [ids]).map(i => byId.get(String(i))).filter(Boolean);
      if (!values.length) return fail(cb, 'Bookmark not found');
      return result(cb, values);
    },
    getChildren(parentId, cb) { return result(cb, byId.get(String(parentId))?.children || []); },
    create(info, cb) {
      if (state.failCreates && state.failCreates(info)) return fail(cb, 'Synthetic bookmark write failure');
      const parent = byId.get(String(info.parentId));
      if (!parent || parent.url) return fail(cb, 'Parent bookmark folder does not exist');
      const node = { id: name + '-' + ++id, parentId: String(parent.id), title: info.title || '', dateAdded: state.now };
      if (info.url) node.url = info.url; else node.children = [];
      const children = parent.children ||= [];
      children.splice(typeof info.index === 'number' ? Math.min(info.index, children.length) : children.length, 0, node);
      byId.set(node.id, node); return result(cb, node);
    },
    move(nodeId, info, cb) {
      const node = byId.get(String(nodeId));
      if (!node || ['0','1','2','3'].includes(String(nodeId))) return fail(cb, 'Cannot move this bookmark');
      const parent = byId.get(String(info.parentId || node.parentId));
      if (!parent || parent.url) return fail(cb, 'Parent bookmark folder does not exist');
      for (let p = parent; p; p = byId.get(String(p.parentId))) if (p.id === node.id) return fail(cb, 'Cannot move folder into itself');
      const old = byId.get(String(node.parentId));
      old.children = old.children.filter(n => n.id !== node.id);
      parent.children ||= [];
      parent.children.splice(typeof info.index === 'number' ? Math.min(info.index, parent.children.length) : parent.children.length, 0, node);
      node.parentId = parent.id; return result(cb, node);
    },
    update(nodeId, changes, cb) {
      const node = byId.get(String(nodeId));
      if (!node) return fail(cb, 'Bookmark not found');
      Object.assign(node, clone(changes)); state.updates.push({ id: String(nodeId), changes: clone(changes) });
      return result(cb, node);
    },
    remove(nodeId, cb) { return remove(nodeId, cb, false); },
    removeTree(nodeId, cb) { return remove(nodeId, cb, true); }
  };
  function remove(nodeId, cb, recursive) {
    const node = byId.get(String(nodeId));
    if (!node || ['0','1','2','3'].includes(String(nodeId))) return fail(cb, 'Cannot remove this bookmark');
    if (!recursive && node.children?.length) return fail(cb, 'Cannot remove non-empty folder');
    const parent = byId.get(String(node.parentId));
    parent.children = parent.children.filter(n => n.id !== node.id);
    state.removals.push(clone(node)); unindex(node); return result(cb);
  }
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [state.now])); } static now() { return state.now; } }
  const chrome = { runtime, bookmarks, storage: { local, onChanged: event() },
    permissions: { contains(info, cb) { return result(cb, true); }, request(info, cb) { return result(cb, true); } },
    action: { setIcon() { return Promise.resolve(); } } };
  const sandbox = { chrome, Date: Clock, URL, TextEncoder, TextDecoder, AbortController, crypto: webcrypto,
    btoa: s => Buffer.from(s, 'binary').toString('base64'), atob: s => Buffer.from(s, 'base64').toString('binary'),
    console: Object.fromEntries(['log','warn','error','info','debug'].map(level => [level, (...args) => state.logs.push({ level, text: args.map(String).join(' ') })])),
    setTimeout(fn, ms) { const t = setTimeout(fn, ms); t.unref(); state.timers.add(t); return t; },
    clearTimeout(t) { clearTimeout(t); state.timers.delete(t); },
    setInterval(fn, ms) { const t = setInterval(fn, ms); t.unref(); state.timers.add(t); return t; },
    clearInterval(t) { clearInterval(t); state.timers.delete(t); },
    navigator: { userAgent: 'Synthetic desktop audit runtime' }, addEventListener() {},
    fetch: async (url, init = {}) => {
      const req = { device: name, url: String(url), method: init.method || 'GET', headers: clone(init.headers || {}), body: init.body };
      cloud.requests.push(req);
      if (cloud.hook) { const handled = await cloud.hook(req, state); if (handled) return handled; }
      if (req.method === 'MKCOL') return response(405, '', {}, cloud);
      if (req.method === 'PUT') {
        const failed = cloud.enforcePreconditions
          ? preconditionFailure(req.headers, cloud.files.get(req.url)) : null;
        if (failed) return response(failed, 'precondition failed', {}, cloud);
        const file = cloud.put(req.url, req.body, req.headers['Content-Type']);
        return response(201, '', file, cloud);
      }
      if (req.method === 'PROPFIND') return response(207, '', {}, cloud);
      const file = cloud.files.get(req.url);
      return file ? response(200, req.method === 'HEAD' ? '' : file.content, file, cloud) : response(404, '', {}, cloud);
    }
  };
  sandbox.self = sandbox; sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const rel of MODULES) vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
  if (opts.background) vm.runInContext(BG, sandbox, { filename: 'background.js' });
  const M = sandbox.MiniSync;
  M.utils.setSyncBucketId(state.store.bookmark_target_id || '1');
  function paths() {
    const rows = [];
    (function walk(n, chain) {
      const next = n.id === '0' ? chain : [...chain, n.title];
      if (n.url) rows.push({ id: n.id, path: next.join('/'), url: n.url });
      for (const c of n.children || []) walk(c, next);
    })(state.root, []);
    return rows;
  }
  return { name, state, byId, chrome, sandbox, M, cloud, paths,
    mainUrl: state.store.webdav_url + '/sync/minibookmarks.xbel',
    async add(parentId, title, url) { return bookmarks.create({ parentId, title, ...(url ? { url } : {}) }); },
    async send(message) { return new Promise(resolve => runtime.onMessage.listeners[0](message, { id: runtime.id }, resolve)); },
    close() { for (const t of state.timers) clearTimeout(t); state.timers.clear(); } };
}
function response(status, body, file = {}, cloud = null) {
  return { ok: status >= 200 && status < 300, status,
    headers: responseHeaders(file, cloud),
    text: async () => String(body), json: async () => JSON.parse(String(body)) };
}
module.exports = { ROOT, BG, MODULES, clone, flush, makeCloud, makeDevice, response, preconditionFailure };
