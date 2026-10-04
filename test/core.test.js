// core.test.js — 覆盖 URL 规范化与 WebDAV 配置读取的回归防护
//
// 这两个点都曾引发真实 bug：
//  - normalizeUrl 不一致会让本地/远程同一 URL 的 pathKey 对不上，导致重复创建或误删；
//  - getWebdavConfig 返回字段名漂移（user vs username）曾直接导致 401 认证失败。

const { loadSource } = require('./load-source');

// 在加载源码前，预置 chrome.storage 的最小 stub（storage.js 顶层不调用它，
// 仅 getWebdavConfig 运行时调用；这里 stub 以便断言返回字段）。
global.chrome = global.chrome || {
  storage: {
    local: {
      _store: {},
      get(keys, cb) {
        const out = {};
        const list = Array.isArray(keys) ? keys : Object.keys(keys || {});
        for (const k of list) out[k] = this._store[k];
        cb(out);
        return Promise.resolve(out);
      },
      set(data, cb) { Object.assign(this._store, data); cb && cb(); return Promise.resolve(); },
      remove(keys, cb) { for (const k of keys) delete this._store[k]; cb && cb(); return Promise.resolve(); },
    },
  },
};

loadSource();
const normalizeUrl = global.MiniSync.xbel.normalizeUrl;
const getWebdavConfig = global.MiniSync.storage.getWebdavConfig;

describe('xbel.normalizeUrl — URL 规范化', () => {
  test('去除尾部斜杠', () => {
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com');
  });

  test('去除 hash', () => {
    expect(normalizeUrl('https://example.com/a#frag')).toBe('https://example.com/a');
  });

  test('保留查询参数', () => {
    expect(normalizeUrl('https://example.com/a?x=1')).toBe('https://example.com/a?x=1');
  });

  test('非 http(s) 协议原样处理（去尾斜杠）', () => {
    expect(normalizeUrl('ftp://host/dir/')).toBe('ftp://host/dir');
  });

  test('空 URL 返回空串', () => {
    expect(normalizeUrl('')).toBe('');
    expect(normalizeUrl(null)).toBe('');
  });

  test('非法 URL 兜底返回 trim 后原值', () => {
    expect(normalizeUrl('not a url')).toBe('not a url');
  });
});

describe('storage.getWebdavConfig — 返回字段一致性（防 401 回归）', () => {
  beforeEach(() => {
    chrome.storage.local._store = {};
  });

  test('新格式 webdav_config 优先，且返回字段名为 username', async () => {
    chrome.storage.local._store = {
      webdav_config: {
        url: 'https://dav.example.com',
        username: 'alice',
        password: 'secret',
        filename: '/bk/my-bookmarks.xbel',
      },
    };
    const cfg = await getWebdavConfig();
    expect(cfg.username).toBe('alice');
    expect(cfg.password).toBe('secret');
    expect(cfg.url).toBe('https://dav.example.com');
    expect(cfg.filename).toBe('/bk/my-bookmarks.xbel');
  });

  test('旧默认主文件名（带路径）自动迁移为 minibookmarks.xbel 并持久化', async () => {
    chrome.storage.local._store = {
      webdav_url: 'https://dav.example.com',
      webdav_user: 'alice',
      webdav_password: 'secret',
      webdav_bookmark_path: '/minibookmark',
      webdav_config: {
        url: 'https://dav.example.com',
        username: 'alice',
        password: 'secret',
        filename: '/minibookmark/bookmarks.xbel',
      },
    };
    const cfg = await getWebdavConfig();
    expect(cfg.filename).toBe('/minibookmark/minibookmarks.xbel');
    // 迁移结果已写回存储，无需每次重新迁移
    expect(chrome.storage.local._store.webdav_config.filename).toBe('/minibookmark/minibookmarks.xbel');
  });

  test('旧默认主文件名（裸名）自动迁移为 minibookmarks.xbel 并持久化', async () => {
    chrome.storage.local._store = {
      webdav_config: {
        url: 'https://dav.example.com',
        username: 'alice',
        password: 'secret',
        filename: 'bookmarks.xbel',
      },
    };
    const cfg = await getWebdavConfig();
    expect(cfg.filename).toBe('minibookmarks.xbel');
    expect(chrome.storage.local._store.webdav_config.filename).toBe('minibookmarks.xbel');
  });

  test('旧格式独立 key 回退，且返回字段名为 username', async () => {
    chrome.storage.local._store = {
      webdav_url: 'https://dav2.example.com',
      webdav_user: 'bob',
      webdav_password: 'pw',
    };
    const cfg = await getWebdavConfig();
    expect(cfg.username).toBe('bob');
    expect(cfg.password).toBe('pw');
    expect(cfg.url).toBe('https://dav2.example.com');
  });

  test('关键断言：返回对象必须含 username 字段（曾因缺此字段导致 401）', async () => {
    chrome.storage.local._store = {
      webdav_config: { url: 'https://x', username: 'u', password: 'p' },
    };
    const cfg = await getWebdavConfig();
    expect(Object.prototype.hasOwnProperty.call(cfg, 'username')).toBe(true);
    expect(cfg.username).toBe('u');
    // 不允许出现旧的 user 字段导致调用方取 username 为 undefined
    expect(cfg.username).toBeTruthy();
  });

  test('未配置时返回空字符串而非 undefined', async () => {
    const cfg = await getWebdavConfig();
    expect(cfg.username).toBe('');
    expect(cfg.password).toBe('');
    expect(cfg.url).toBe('');
  });
});
