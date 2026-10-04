// config-backup.test.js — 配置导出/导入（换浏览器搬配置）
//
// 两条硬约束（比功能本身更重要）：
//   ① 绝不导出/导入设备身份（sync_device_id）—— 两台设备同 id 会让墓碑判定错乱；
//      墓碑/快照/操作日志等同步过程数据同理，跟着云端走，不从文件灌回来。
//   ② 导入默认拒绝：只认白名单里的键，类型不符就丢；不认识的键一律丢弃并如实报告。
// 另：导出内容含 WebDAV 明文密码，这是设计取舍（要能搬配置），UI 上必须写清楚。
const { loadSource } = require('./load-source');

loadSource();
const U = global.MiniSync.utils;

describe('buildConfigBackup：只搬用户配置', () => {
  const storage = {
    webdav_url: 'https://dav.example/dav/',
    webdav_user: 'pp1847531284',
    webdav_password: 'super-secret',
    webdav_bookmark_path: '/minibookmark',
    berry_folder_path: '/berry',
    via_folder_path: '/Via',
    aira_folder_path: 'aira/g3/bookmarks',
    option_berry_enabled: true,
    option_aira_enabled: false,
    sync_enabled: true,
    sync_interval: 30,
    sync_type: 'merge',
    download_clear: false,
    // —— 以下都不该出现在备份里 ——
    sync_device_id: 'ext_should-never-leave-this-device',
    bookmark_target_id: '1234',
    sync_bucket_id: '2',
    sync_tombstones: [{ pathKey: 'x' }],
    sync_snapshots: { localTree: [] },
    sync_log: [{ action: '上传' }],
    sync_endpoints: { berry: {} },
    last_sync_at: 1700000000000,
    ever_connected: true
  };

  test('包含全部用户配置项', () => {
    const b = U.buildConfigBackup(storage, { manifestVersion: '2.1.0', now: 1700000000000 });
    expect(b.app).toBe('minibookmark-sync');
    expect(b.kind).toBe('config-backup');
    expect(b.version).toBe(1);
    expect(b.manifestVersion).toBe('2.1.0');
    expect(b.config.webdav_url).toBe('https://dav.example/dav/');
    expect(b.config.webdav_password).toBe('super-secret');
    expect(b.config.option_berry_enabled).toBe(true);
    expect(b.config.sync_interval).toBe(30);
    expect(b.config.sync_type).toBe('merge');
  });

  test('设备身份与同步过程数据一项都不导出（同 id 会让墓碑判定错乱）', () => {
    const b = U.buildConfigBackup(storage, {});
    const flat = JSON.stringify(b);
    expect(b.config.sync_device_id).toBeUndefined();
    expect(b.config.bookmark_target_id).toBeUndefined();
    expect(b.config.sync_bucket_id).toBeUndefined();
    expect(b.config.sync_tombstones).toBeUndefined();
    expect(b.config.sync_snapshots).toBeUndefined();
    expect(b.config.sync_log).toBeUndefined();
    expect(b.config.sync_endpoints).toBeUndefined();
    expect(b.config.last_sync_at).toBeUndefined();
    expect(b.config.ever_connected).toBeUndefined();
    expect(flat).not.toContain('should-never-leave-this-device');
  });

  test('缺失的项不写空值（不会用 undefined 覆盖别端设置）', () => {
    const b = U.buildConfigBackup({ webdav_url: 'https://x/' }, {});
    expect(Object.keys(b.config)).toEqual(['webdav_url']);
  });

  test('类型不符的值当没这一项（宁缺勿错）', () => {
    const b = U.buildConfigBackup({ sync_interval: '三十', option_berry_enabled: 'yes', sync_type: 'nope' }, {});
    expect(b.config.sync_interval).toBeUndefined();
    expect(b.config.option_berry_enabled).toBeUndefined();
    expect(b.config.sync_type).toBeUndefined();
  });
});

describe('parseConfigBackup：默认拒绝', () => {
  const good = () => U.buildConfigBackup({
    webdav_url: 'https://dav.example/dav/',
    webdav_user: 'u',
    webdav_password: 'p',
    webdav_bookmark_path: '/minibookmark',
    option_via_enabled: true,
    sync_interval: 60,
    sync_type: 'download'
  }, { manifestVersion: '2.1.0' });

  test('正常备份能解析出全部项', () => {
    const r = U.parseConfigBackup(JSON.stringify(good()));
    expect(r.ok).toBe(true);
    expect(r.config.webdav_url).toBe('https://dav.example/dav/');
    expect(r.config.option_via_enabled).toBe(true);
    expect(r.config.sync_interval).toBe(60);
    expect(r.config.sync_type).toBe('download');
    expect(r.meta.manifestVersion).toBe('2.1.0');
  });

  test('不是 JSON / 不是我们的文件 ⇒ 明确报错，不写任何东西', () => {
    expect(U.parseConfigBackup('这根本不是 json').ok).toBe(false);
    expect(U.parseConfigBackup('').ok).toBe(false);
    expect(U.parseConfigBackup('[]').ok).toBe(false);
    expect(U.parseConfigBackup(JSON.stringify({ hello: 'world' })).ok).toBe(false);
    const wrongApp = good(); wrongApp.app = 'other-addon';
    expect(U.parseConfigBackup(JSON.stringify(wrongApp)).error).toContain('不像是');
  });

  test('版本比本机新 ⇒ 拒绝，不让老版本瞎解释新格式', () => {
    const b = good(); b.version = 99;
    const r = U.parseConfigBackup(JSON.stringify(b));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('更新的版本');
  });

  test('文件里塞了白名单外的键（含 sync_device_id）⇒ 一律丢弃并如实报出来', () => {
    const b = good();
    b.config.sync_device_id = 'attacker-supplied-id';
    b.config.sync_tombstones = [{ pathKey: 'evil' }];
    b.config.bookmark_target_id = '999';
    const r = U.parseConfigBackup(JSON.stringify(b));
    expect(r.ok).toBe(true);
    expect(r.config.sync_device_id).toBeUndefined();
    expect(r.config.sync_tombstones).toBeUndefined();
    expect(r.config.bookmark_target_id).toBeUndefined();
    expect(r.dropped.sort()).toEqual(['bookmark_target_id', 'sync_device_id', 'sync_tombstones']);
    expect(JSON.stringify(r.config)).not.toContain('attacker-supplied-id');
  });

  test('值类型不符 ⇒ 丢弃该键（不做任何隐式转换）', () => {
    const b = good();
    b.config.sync_interval = '60';
    b.config.option_via_enabled = 1;
    b.config.sync_type = 'delete-everything';
    const r = U.parseConfigBackup(JSON.stringify(b));
    expect(r.ok).toBe(true);
    expect(r.config.sync_interval).toBeUndefined();
    expect(r.config.option_via_enabled).toBeUndefined();
    expect(r.config.sync_type).toBeUndefined();
    expect(r.config.webdav_url).toBe('https://dav.example/dav/'); // 其余照常
  });

  test('没有任何可识别配置项 ⇒ 报错（空文件不许把本机配置清空）', () => {
    const b = good();
    b.config = { sync_device_id: 'x', last_sync_at: 1 };
    const r = U.parseConfigBackup(JSON.stringify(b));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('没有任何可识别的配置项');
  });

  test('往返一致：导出 → 导入得到同一份配置', () => {
    const src = {
      webdav_url: 'https://dav.example/dav/', webdav_user: 'u', webdav_password: 'p',
      webdav_bookmark_path: '/minibookmark', berry_folder_path: '/berry', via_folder_path: '/Via',
      aira_folder_path: 'aira/g3/bookmarks', option_berry_enabled: true, option_berry_create_file: true,
      option_via_enabled: false, option_aira_enabled: true, sync_enabled: true, download_clear: true,
      sync_interval: 120, sync_type: 'upload'
    };
    const r = U.parseConfigBackup(JSON.stringify(U.buildConfigBackup(src, {})));
    expect(r.ok).toBe(true);
    expect(r.config).toEqual(src);
  });
});

// ⚠️ 这一组的存在理由：导入是「覆盖本机配置」的操作，而文件是用户可以手改的。
//    sync_interval 直通 chrome.alarms.create({ periodInMinutes })，坏值没有边界检查
//    就会一路走到底：负数让 create 抛错（异常被吞＝自动同步静默失效），
//    极小值被浏览器夹到 1 分钟（远超 UI 允许的高频轮询）。
describe('导入边界：越界/异种的值不许写进本机配置', () => {
  const backup = (config) => JSON.stringify({
    app: 'minibookmark-sync', kind: 'config-backup', version: 1, config
  });

  test('同步间隔越界（负数 / 0 / 超上限）⇒ 丢弃并如实报出来', () => {
    for (const bad of [-5, 0, 1e9]) {
      const r = U.parseConfigBackup(backup({ sync_interval: bad, sync_type: 'merge' }));
      expect(r.ok).toBe(true);
      expect(r.config.sync_interval).toBeUndefined();
      expect(r.config.sync_type).toBe('merge'); // 其余项照常
      expect(r.dropped).toContain('sync_interval');
    }
  });

  test('区间内的间隔正常放行（含 UI 没提供的档位）', () => {
    for (const ok of [1, 15, 45, 120, U.SYNC_INTERVAL_MAX]) {
      const r = U.parseConfigBackup(backup({ sync_interval: ok }));
      expect(r.config.sync_interval).toBe(ok);
    }
  });

  test('WebDAV 地址非 http(s)（file:/javascript:/错字）⇒ 丢弃，与手工输入同口径', () => {
    for (const bad of ['file:///C:/dav/', 'javascript:alert(1)', 'dav.example.com/dav/', 'ftp://x/']) {
      const r = U.parseConfigBackup(backup({ webdav_url: bad, webdav_user: 'u' }));
      expect(r.config.webdav_url).toBeUndefined();
      expect(r.dropped).toContain('webdav_url');
      expect(r.config.webdav_user).toBe('u');
    }
  });

  test('空地址是合法值（表示本机未配置），http 与 https 都放行', () => {
    expect(U.parseConfigBackup(backup({ webdav_url: '' })).config.webdav_url).toBe('');
    expect(U.parseConfigBackup(backup({ webdav_url: 'http://nas.local/dav/' })).config.webdav_url)
      .toBe('http://nas.local/dav/');
    expect(U.parseConfigBackup(backup({ webdav_url: 'HTTPS://DAV.EXAMPLE/' })).config.webdav_url)
      .toBe('HTTPS://DAV.EXAMPLE/');
  });

  test('非字符串的 webdav_url（数字/对象）也丢弃', () => {
    for (const bad of [123, {}, ['https://x/'], true]) {
      expect(U.parseConfigBackup(backup({ webdav_url: bad, webdav_user: 'u' })).config.webdav_url)
        .toBeUndefined();
    }
  });
});

// 后台 setupAutoSyncAlarm 直接用这个函数把 storage 里的值收敛成可交给 chrome.alarms 的整数。
// 它是最后一道防线：即使坏值已经躺在 storage 里（旧版本写下的、手工改的），也不能变成坏 alarm。
describe('clampSyncInterval：交给 chrome.alarms 前必须收敛', () => {
  test('合法值原样返回（含字符串形态，storage 里两种都出现过）', () => {
    expect(U.clampSyncInterval(30)).toBe(30);
    expect(U.clampSyncInterval('60')).toBe(60);
    expect(U.clampSyncInterval(1)).toBe(1);
  });

  test('负数/0 被抬到下限（不会以负周期调 create）', () => {
    expect(U.clampSyncInterval(-5)).toBe(U.SYNC_INTERVAL_MIN);
    expect(U.clampSyncInterval(0)).toBe(U.SYNC_INTERVAL_MIN);
  });

  test('超大值被压到上限', () => {
    expect(U.clampSyncInterval(1e9)).toBe(U.SYNC_INTERVAL_MAX);
  });

  test('解析不出来（缺失/空串/垃圾）⇒ 回默认 30', () => {
    expect(U.clampSyncInterval(undefined)).toBe(U.SYNC_INTERVAL_DEFAULT);
    expect(U.clampSyncInterval('')).toBe(U.SYNC_INTERVAL_DEFAULT);
    expect(U.clampSyncInterval('半小时')).toBe(U.SYNC_INTERVAL_DEFAULT);
    expect(U.clampSyncInterval(null)).toBe(U.SYNC_INTERVAL_DEFAULT);
  });

  test('默认值本身落在合法区间内（常量之间不许互相打架）', () => {
    expect(U.SYNC_INTERVAL_DEFAULT).toBeGreaterThanOrEqual(U.SYNC_INTERVAL_MIN);
    expect(U.SYNC_INTERVAL_DEFAULT).toBeLessThanOrEqual(U.SYNC_INTERVAL_MAX);
  });
});

// 排查日志是设计给用户【复制出来贴在公开地方求助】的，所以它不许带凭据。
describe('redactUrlForLog：诊断日志里的 URL 必须脱敏', () => {
  test('地址里内嵌的账号密码被替换掉，路径与查询串保留', () => {
    const out = U.redactUrlForLog('https://user:secret123@dav.example/dav/子目录?x=1');
    expect(out).not.toContain('secret123');
    expect(out).not.toContain('user');
    expect(out).toContain('dav.example');
    expect(out).toContain('/dav/'); // 排查「路径尾部有杂质」靠的就是这一段
  });

  test('没有凭据的地址原样返回（排查用的空格/全角字符不能被顺手吃掉）', () => {
    expect(U.redactUrlForLog('https://dav.example/dav/ x/')).toBe('https://dav.example/dav/ x/');
    expect(U.redactUrlForLog('')).toBe('');
  });

  test('new URL 解析不了的地址（含全角字符）走正则兜底，也不漏密码', () => {
    const out = U.redactUrlForLog('https://user:secret123@dav.example／ｄａｖ/');
    expect(out).not.toContain('secret123');
  });
});

// XSS 面的单一事实源：所有把外部数据拼进 innerHTML 的地方都靠它。
describe('escapeHtml：HTML 转义单一事实源', () => {
  test('五个危险字符全部转义，且顺序正确（& 必须最先）', () => {
    expect(U.escapeHtml('<script>alert("x")</script>'))
      .toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(U.escapeHtml("a & b'c")).toBe('a &amp; b&#39;c');
    // 关键：不能把已经转义出的 &lt; 再转一次成 &amp;lt;
    expect(U.escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  test('null/undefined 返回空串，数字照转', () => {
    expect(U.escapeHtml(null)).toBe('');
    expect(U.escapeHtml(undefined)).toBe('');
    expect(U.escapeHtml(0)).toBe('0');
  });
});
