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
    put(url, content, contentType) {
      const file = { content: String(content), mtime: this.clock += 5000,
        etag: '"v' + (this.requests.length + this.clock) + '"', contentType: contentType || 'text/plain' };
      this.files.set(url, file);
      return file;
    } };
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
      if (req.method === 'MKCOL') return response(405, '');
      if (req.method === 'PUT') {
        const file = cloud.put(req.url, req.body, req.headers['Content-Type']);
        return response(201, '', file);
      }
      if (req.method === 'PROPFIND') return response(207, '');
      const file = cloud.files.get(req.url);
      return file ? response(200, req.method === 'HEAD' ? '' : file.content, file) : response(404, '');
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
function response(status, body, file = {}) {
  return { ok: status >= 200 && status < 300, status,
    headers: { get(name) { const k = name.toLowerCase(); return k === 'last-modified' || k === 'date' ? new Date(file.mtime || Date.UTC(2026,9,7,12)).toUTCString() : k === 'etag' ? file.etag : null; } },
    text: async () => String(body), json: async () => JSON.parse(String(body)) };
}
module.exports = { ROOT, BG, MODULES, clone, flush, makeCloud, makeDevice, response };
