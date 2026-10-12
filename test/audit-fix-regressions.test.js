// audit-fix-regressions.test.js — 审计（2026-10-11）缺陷修复的回归守护。
//
// 每个用例对应报告里一项已复现的缺陷；断言的是**修复后的正确行为**，
// 因此这些用例在修复前会红、修复后必须常绿。任何一条变红都表示该缺陷回来了。
const { loadSource } = require('./load-source');
const { makeCloud, makeDevice, clone, flush, response } = require('./helpers/audit-harness.cjs');

loadSource();

const devices = [];
function device(...args) { const d = makeDevice(...args); devices.push(d); return d; }
afterEach(() => { for (const d of devices.splice(0)) d.close(); });

const urls = d => d.paths().map(n => n.url).sort();
const run = (d, action, options = {}) =>
  d.M.orchestrator[{ upload: 'uploadBookmarks', download: 'downloadBookmarks', merge: 'mergeSync' }[action]](options);

describe('XBEL 解析：合法形态必须可读，损坏输入必须 fail-closed', () => {
  const wrap = body => '<xbel version="1.0"><folder><title>书签栏</title>' + body
    + '</folder><folder><title>其他收藏夹</title></folder>'
    + '<folder><title>移动收藏夹</title></folder></xbel>';

  test('属性前换行/制表符的合法 XBEL 不会被漏读为空', () => {
    const xbel = global.MiniSync.xbel;
    const canonical = wrap('<bookmark href="https://a.invalid/"><title>A</title></bookmark>');
    expect(xbel.xbelToJson(canonical).bookmarks.length).toBe(1);
    // 回归点：旧扫描器只找字面量 `<bookmark `，这两种合法写法被读成零节点，
    // 空设备合并随即把云端书签清空。
    expect(xbel.xbelToJson(canonical.replace(/<bookmark /g, '<bookmark\n ')).bookmarks.length).toBe(1);
    expect(xbel.xbelToJson(canonical.replace(/<bookmark /g, '<bookmark\t')).bookmarks.length).toBe(1);
  });

  test('自闭合书签被正确解析（且不与后一条书签串味）', () => {
    const parsed = global.MiniSync.xbel.xbelToJson(wrap(
      '<bookmark href="https://one.invalid/"/>'
      + '<bookmark href="https://two.invalid/"><title>Two</title></bookmark>'));
    expect(parsed.bookmarks.map(b => [b.url, b.title])).toEqual([
      ['https://one.invalid/', 'https://one.invalid/'],
      ['https://two.invalid/', 'Two']
    ]);
  });

  test('CDATA 内的书签文字不被当作真书签导入', () => {
    const parsed = global.MiniSync.xbel.xbelToJson(wrap(
      '<bookmark href="https://real.invalid/"><title>Real</title></bookmark>'
      + '<desc><![CDATA[<bookmark href="https://not-real.invalid/"><title>Text</title></bookmark>]]></desc>'));
    expect(parsed.bookmarks.map(b => b.url)).toEqual(['https://real.invalid/']);
  });

  test('实体只在 XML 边界解码一次：字面 &lt; 不被二次解释，数字实体支持非 BMP', () => {
    const parsed = global.MiniSync.xbel.xbelToJson(wrap(
      '<bookmark href="https://q.invalid/p?literal=&amp;lt;mode"><title>X&#128512;</title></bookmark>'));
    // 回归点：链式 replace 会把 `&amp;lt;` 解成 `&lt;` 再解成 `<`，用户地址被改写。
    expect(parsed.bookmarks[0].url).toBe('https://q.invalid/p?literal=&lt;mode');
    expect(parsed.bookmarks[0].title).toBe('X\u{1F600}');
  });
});

describe('手机桥接：读取不完整绝不允许覆盖手机文件', () => {
  test('Berry 读取失败：未合并的手机独有书签不被写回覆盖', async () => {
    const d = device('reg-berry-read', makeCloud(), { store: { option_berry_enabled: true } });
    await d.add('1', 'Desktop', 'https://desktop.invalid/');
    // 先把桌面状态同步上云（此时 Berry 文件还不存在）。
    expect((await run(d, 'upload')).success).toBe(true);
    const file = 'https://audit.invalid/dav/berry/bookmarks.json';
    // 手机端随后新增了一条**只在手机上有**的书签：还没被任何一轮合并读进来。
    d.cloud.put(file, JSON.stringify({ schemaVersion: 2, data: [
      { id: 'p1', title: 'PhoneOnly', url: 'https://phone.invalid/', parentId: 'root', isFolder: false, source: 'bar' }
    ] }), 'application/json');
    const before = d.cloud.files.get(file).content;
    // 本轮让**第一次 GET 失败**（读入阶段），之后的请求恢复正常：
    // 这样「读失败后是否还敢写回」是唯一变量。
    let gets = 0;
    d.cloud.hook = req => (req.method === 'GET' && req.url === file && ++gets === 1)
      ? response(503, 'synthetic-read-failure') : null;
    const result = await run(d, 'merge');
    // 回归点：旧实现读失败后仍用桌面列表覆盖 ⇒ 手机端唯一副本被抹掉，且报告里只有一句
    // 「部分失败」，用户根本不知道手机书签已经没了。
    expect(result.partial).toBe(true);
    expect(d.cloud.files.get(file).content).toBe(before);
    expect(d.cloud.files.get(file).content).toContain('https://phone.invalid/');
  });

  test('Via 缺少 favorites.txt 时仍保留并同步 HTML 里的书签', async () => {
    const d = device('reg-via-nofav', makeCloud(), { store: { option_via_enabled: true } });
    const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<H1>Bookmarks</H1>\n<DL><p>\n'
      + '<DT><A HREF="https://phone-only.invalid">PhoneOnly</A>\n</DL><p>\n';
    d.cloud.put('https://audit.invalid/dav/Via/bookmarks.html', html, 'text/html');
    // favorites.txt 不存在（404）——主页文件缺失不等于整份 Via 读取失败
    const result = await run(d, 'merge');
    expect(result.success).toBe(true);
    expect(urls(d)).toContain('https://phone-only.invalid');
    expect(d.cloud.files.get('https://audit.invalid/dav/Via/bookmarks.html').content)
      .toContain('https://phone-only.invalid');
  });

  test('Via 合法 HTML 写法（属性顺序/单引号）不被当成删除快照', async () => {
    for (const link of ['<A ADD_DATE="1700000000" HREF="https://a.invalid">A</A>', "<A HREF='https://a.invalid'>A</A>"]) {
      const d = device('reg-via-html', makeCloud(), { store: { option_via_enabled: true } });
      await d.add('1', 'A', 'https://a.invalid');
      d.cloud.put('https://audit.invalid/dav/Via/favorites.txt', '', 'text/plain');
      const good = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<H1>Bookmarks</H1>\n<DL><p>\n'
        + '<DT><A HREF="https://a.invalid">A</A>\n</DL><p>\n';
      d.cloud.put('https://audit.invalid/dav/Via/bookmarks.html', good, 'text/html');
      // 先正常同步一轮：此时删除基线里记下了这个书签。
      expect((await run(d, 'merge')).partial).toBe(false);
      expect(d.state.store.via_pathkey_snapshot.length).toBeGreaterThan(0);
      // 手机端把同一条书签换成等价但书写不同的合法 HTML。
      d.cloud.put('https://audit.invalid/dav/Via/bookmarks.html',
        '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<H1>Bookmarks</H1>\n<DL><p>\n<DT>' + link + '\n</DL><p>\n', 'text/html');
      d.state.now += 60000;
      const result = await run(d, 'merge');
      // 回归点：正则写死 `<A HREF="` 时这些合法写法读不到书签，删除检测把它们当手机端删除，
      // 本地与主 XBEL 一起被删（必须两轮才对基线生效，所以这里必须有第一轮铺垫）。
      expect(result.success).toBe(true);
      expect(urls(d)).toContain('https://a.invalid');
      expect(d.cloud.files.get(d.mainUrl).content).toContain('https://a.invalid');
    }
  });

  test('Via 保留 URL fragment 与非 BMP 实体', async () => {
    const d = device('reg-via-url', makeCloud(), { store: { option_via_enabled: true } });
    d.cloud.put('https://audit.invalid/dav/Via/favorites.txt', '', 'text/plain');
    d.cloud.put('https://audit.invalid/dav/Via/bookmarks.html',
      '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<H1>Bookmarks</H1>\n<DL><p>\n'
      + '<DT><A HREF="https://app.invalid/#/inbox">&#128512;</A>\n</DL><p>\n', 'text/html');
    await run(d, 'merge');
    const landed = d.byId.get('1').children.find(n => String(n.url).startsWith('https://app.invalid'));
    // 回归点：旧 normalizeUrl 清 hash（地址被截断），fromCharCode 截断非 BMP 码点。
    expect(landed.url).toBe('https://app.invalid/#/inbox');
    expect(landed.title).toBe('\u{1F600}');
  });

  test('Berry 环形父链被拒绝，本机书签不丢', async () => {
    const d = device('reg-berry-cycle', makeCloud(), { store: { option_berry_enabled: true } });
    await d.add('1', 'A', 'https://a.invalid/');
    expect((await run(d, 'upload')).success).toBe(true);
    d.cloud.put('https://audit.invalid/dav/berry/bookmarks.json', JSON.stringify({ schemaVersion: 2, data: [
      { id: 'ca', title: 'CycleA', parentId: 'cb', isFolder: true },
      { id: 'cb', title: 'CycleB', parentId: 'ca', isFolder: true }
    ] }), 'application/json');
    const result = await run(d, 'merge');
    // 回归点：环形父链让 pathKey 全塌成 ROOT:cyclic，被读成「手机端删光了」。
    expect(result.partial).toBe(true);
    expect(urls(d)).toContain('https://a.invalid/');
  });

  test('Aira bookmarkItems 结构损坏被拒绝，本机书签不丢', async () => {
    const d = device('reg-aira-bad', makeCloud(), { store: { option_aira_enabled: true } });
    await d.add('1', 'A', 'https://a.invalid/');
    const g3 = 'https://audit.invalid/dav/aira/g3/bookmarks/snapshot.json';
    const goodSnapshot = {
      version: 2, deviceId: 'phone', snapshot: {
        bookmarkFolders: [{ id: 'browser_root_toolbar', parentId: null, title: '书签栏', type: 'bookmark-folder' }],
        bookmarkItems: [{ id: 'p1', type: 'bookmark-item', parentId: 'browser_root_toolbar', title: 'A', url: 'https://a.invalid/' }],
        bookmarkOrders: [], tombstones: [] }
    };
    d.cloud.put(g3, JSON.stringify(goodSnapshot), 'application/json');
    // 先正常同步一轮，让删除基线记下这条书签 —— 否则损坏数据也无删除历史可用。
    expect((await run(d, 'merge')).partial).toBe(false);
    expect((d.state.store.aira_pathkey_snapshot || []).length).toBeGreaterThan(0);
    // 手机端文件结构损坏：根表正常、items 变成对象。
    d.cloud.put(g3, JSON.stringify({ ...goodSnapshot, snapshot: { ...goodSnapshot.snapshot, bookmarkItems: { not: 'an array' } } }), 'application/json');
    d.state.now += 60000;
    const result = await run(d, 'merge');
    // 回归点：对象被静默当成空 items，删除检测判定「手机端删光了」，本机与云端书签被清空。
    expect(result.success).toBe(true);
    expect(urls(d)).toContain('https://a.invalid/');
    expect(d.cloud.files.get(d.mainUrl).content).toContain('https://a.invalid/');
  });

  test('切换手机目录后不复用旧文件的删除基线', async () => {
    for (const kind of ['berry', 'via']) {
      const d = device('reg-fswitch-' + kind, makeCloud(), { store: { [`option_${kind}_enabled`]: true } });
      await d.add('1', 'A', 'https://a.invalid');
      const empty = kind === 'berry'
        ? JSON.stringify({ schemaVersion: 2, data: [] })
        : '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<H1>Bookmarks</H1>\n<DL><p>\n</DL><p>\n';
      const file = kind === 'berry'
        ? 'https://audit.invalid/dav/berry/bookmarks.json'
        : 'https://audit.invalid/dav/Via/bookmarks.html';
      // 旧目录里**有**这条书签 ⇒ 同步后删除基线里记下它（这是被误复用的那份历史）。
      if (kind === 'berry') {
        d.cloud.put(file, JSON.stringify({ schemaVersion: 2, data: [
          { id: 'p1', title: 'A', url: 'https://a.invalid', parentId: 'root', isFolder: false, source: 'bar' }
        ] }), 'application/json');
      } else {
        d.cloud.put('https://audit.invalid/dav/Via/favorites.txt', '', 'text/plain');
        d.cloud.put(file, '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<H1>Bookmarks</H1>\n<DL><p>\n'
          + '<DT><A HREF="https://a.invalid">A</A>\n</DL><p>\n', 'text/html');
      }
      expect((await run(d, 'merge')).partial).toBe(false);
      expect((d.state.store[`${kind}_pathkey_snapshot`] || []).length).toBeGreaterThan(0);
      // 换成另一个空目录：新文件里没有任何书签，但那是「新文件还没有内容」，
      // 绝不是「手机端删光了」。
      if (kind === 'berry') {
        d.state.store.berry_folder_path = '/new-phone';
        d.cloud.put('https://audit.invalid/dav/new-phone/bookmarks.json', empty, 'application/json');
      } else {
        d.state.store.via_folder_path = '/new-phone';
        d.cloud.put('https://audit.invalid/dav/new-phone/bookmarks.html', empty, 'text/html');
        d.cloud.put('https://audit.invalid/dav/new-phone/favorites.txt', '', 'text/plain');
      }
      d.state.now += 60000;
      const result = await run(d, 'merge');
      // 回归点：旧基线跨文件复用 ⇒ 新空文件被判成「手机端删光了」，本地与主 XBEL 一起被删。
      expect(result.success).toBe(true);
      expect(urls(d)).toContain('https://a.invalid');
      expect(d.cloud.files.get(d.mainUrl).content).toContain('https://a.invalid');
    }
  });
});

describe('回滚：只撤销本事务写集，保护用户并发新增', () => {
  test('上传冲突回滚不删除同步期间用户新建的书签', async () => {
    const d = device('reg-rollback', makeCloud());
    await d.add('1', 'Before', 'https://before.invalid/');
    expect((await run(d, 'upload')).success).toBe(true);
    let newId;
    let triggered = false;
    d.cloud.hook = async (req) => {
      if (req.method !== 'PUT' || req.url !== d.mainUrl || triggered) return null;
      triggered = true;
      // 另一设备写入云端 ⇒ 强 ETag 条件失败（412）
      d.cloud.put(req.url, d.cloud.files.get(req.url).content.replace('Before', 'Other device'));
      newId = (await d.add('1', 'Created while PUT pending', 'https://late-user-edit.invalid/')).id;
      return null;
    };
    const result = await run(d, 'upload');
    expect(result.code).toBe('CLOUD_CONFLICT');
    // 回归点：替换式回滚把备份之外的用户新增当成半成品删掉（备份里没有它 ⇒ 永久丢失）。
    expect(d.byId.has(newId)).toBe(true);
    expect(urls(d)).toContain('https://late-user-edit.invalid/');
  });

  test('导入失败回滚仍清掉半成品、保留既有本地书签', async () => {
    const cloud = makeCloud();
    const src = device('reg-rb-src', cloud), dst = device('reg-rb-dst', cloud);
    await src.add('1', 'Remote good', 'https://good.invalid/');
    await src.add('1', 'Remote blocked', 'https://blocked.invalid/');
    expect((await run(src, 'upload')).success).toBe(true);
    await dst.add('1', 'Local keep', 'https://local-keep.invalid/');
    dst.state.failCreates = info => info.url === 'https://blocked.invalid/';
    const result = await run(dst, 'download');
    expect(result.success).toBe(false);
    expect(urls(dst)).toContain('https://local-keep.invalid/');
  });
});

describe('目标隔离：一轮同步只有一个远端目标与一个本地落点', () => {
  test('中途切换同步文件夹不会让写入目标与回滚目标分裂', async () => {
    const cloud = makeCloud();
    const src = device('reg-sw-src', cloud);
    await src.add('1', 'Remote good', 'https://remote-good.invalid/');
    await src.add('1', 'Remote blocked', 'https://remote-blocked.invalid/');
    expect((await run(src, 'upload')).success).toBe(true);
    const d = device('reg-sw-dst', cloud, { store: { download_clear: true } });
    await d.add('1', 'Original A', 'https://original-a.invalid/');
    const b = await d.add('2', 'Private B');
    const bKeep = await d.add(b.id, 'Original B', 'https://original-b.invalid/');
    await d.M.storage.getWebdavConfig();
    const set = d.chrome.storage.local.set;
    let switched = false;
    d.chrome.storage.local.set = (data, cb) => {
      const out = set(data, cb);
      if (!switched && Object.keys(data).length === 1 && Object.hasOwn(data, 'sync_tombstones')) {
        switched = true;
        d.state.store.bookmark_target_id = b.id;   // 用户在同步途中改了目标
      }
      return out;
    };
    d.state.failCreates = info => info.url === 'https://remote-blocked.invalid/';
    await run(d, 'download');
    // 回归点：第二次解析设置读到新桶，清空/导入 B 却回滚 A ⇒ B 的原内容丢失。
    expect(switched).toBe(true);
    expect(d.byId.has(bKeep.id)).toBe(true);
  });

  test('中途切换云盘账户不会让主文件与手机桥接分属不同账户', async () => {
    const d = device('reg-acct', makeCloud(), { store: { option_berry_enabled: true } });
    await d.add('1', 'Only in original account', 'https://original-account.invalid/');
    await d.M.storage.getWebdavConfig();
    const newBase = 'https://second.invalid/dav';
    d.cloud.put(newBase + '/berry/bookmarks.json', JSON.stringify({ schemaVersion: 2, data: [
      { id: '10', title: 'Second account private', url: 'https://second-account-private.invalid/', parentId: 'root', isFolder: false }
    ] }), 'application/json');
    let switched = false;
    d.cloud.hook = async (req) => {
      if (!switched && req.method === 'PUT' && req.url === d.mainUrl) {
        switched = true;
        await d.M.storage.setWebdavConfig({ url: newBase, username: 'synthetic-second', password: 'synthetic-second', filename: '/sync/minibookmarks.xbel' });
      }
      return null;
    };
    await run(d, 'upload');
    // 回归点：桥接重新读设置写到新账户，旧账户列表覆盖新账户的手机文件且报告全成功。
    expect(switched).toBe(true);
    expect(d.cloud.requests.some(r => String(r.url).startsWith(newBase))).toBe(false);
    expect(d.cloud.files.get('https://audit.invalid/dav/berry/bookmarks.json').content)
      .toContain('https://original-account.invalid/');
  });
});

describe('删除记录：重新添加可传播，普通删除照常传播', () => {
  test('另一设备重新添加的书签，原删除端必须接受', async () => {
    const cloud = makeCloud();
    const a = device('reg-readd-A', cloud), b = device('reg-readd-B', cloud);
    await a.add('1', 'Sentinel', 'https://sentinel.invalid/');
    const seeded = await a.add('1', 'Re-add', 'https://readd.invalid/');
    expect((await run(a, 'upload')).success).toBe(true);
    expect((await run(b, 'download')).success).toBe(true);
    a.state.now += 60000; b.state.now += 60000;
    await a.chrome.bookmarks.remove(seeded.id);
    expect((await run(a, 'merge')).success).toBe(true);
    expect((await run(b, 'merge')).success).toBe(true);
    expect(urls(a)).not.toContain('https://readd.invalid/');
    b.state.now += 60000;
    await b.add('1', 'Re-add', 'https://readd.invalid/');
    expect((await run(b, 'merge')).success).toBe(true);
    // 回归点：A 的旧墓碑把 B 的新副本再删一次，重新添加永远传不出去。
    expect((await run(a, 'merge')).success).toBe(true);
    expect(urls(a)).toContain('https://readd.invalid/');
    expect((await run(b, 'merge')).success).toBe(true);
    expect(urls(b)).toContain('https://readd.invalid/');
  });

  test('普通跨端删除仍然传播且多轮稳定', async () => {
    const cloud = makeCloud();
    const a = device('reg-del-A', cloud, { background: true }), b = device('reg-del-B', cloud, { background: true });
    await flush();
    await a.add('1', 'Keep', 'https://keep.invalid/');
    const doomed = await a.add('1', 'Doomed', 'https://doomed.invalid/');
    expect((await run(a, 'upload')).success).toBe(true);
    expect((await run(b, 'download')).success).toBe(true);
    const snapshot = clone(a.byId.get(doomed.id));
    await a.chrome.bookmarks.remove(doomed.id);
    await a.sandbox.handleBookmarkRemoved(doomed.id, { parentId: '1', index: 0, node: snapshot });
    expect((await run(a, 'merge')).success).toBe(true);
    expect((await run(b, 'merge')).success).toBe(true);
    expect(urls(b)).not.toContain('https://doomed.invalid/');
    expect(urls(a)).toContain('https://keep.invalid/');
    a.state.now += 60000; b.state.now += 60000;
    expect((await run(a, 'merge')).success).toBe(true);
    expect((await run(b, 'merge')).success).toBe(true);
    expect(urls(b)).not.toContain('https://doomed.invalid/');
  });

  test('纯换序仍然正常传播（v2.2.2 主线修复不回退）', async () => {
    const cloud = makeCloud();
    const a = device('reg-order-A', cloud), b = device('reg-order-B', cloud);
    const folder = await a.add('1', 'Work');
    for (const t of ['X', 'Y', 'Z']) await a.add(folder.id, t, `https://${t.toLowerCase()}.invalid/`);
    expect((await run(a, 'upload')).success).toBe(true);
    expect((await run(b, 'download')).success).toBe(true);
    const bf = b.byId.get('1').children.find(n => n.title === 'Work');
    await b.chrome.bookmarks.move(bf.children[2].id, { parentId: bf.id, index: 0 });
    await b.chrome.bookmarks.onMoved.emit(bf.children[2].id, { parentId: bf.id, oldParentId: bf.id, index: 0, oldIndex: 2 });
    expect((await run(b, 'merge')).success).toBe(true);
    expect(b.byId.get('1').children.find(n => n.title === 'Work').children.map(n => n.title)).toEqual(['Z', 'X', 'Y']);
    expect((await run(a, 'merge')).success).toBe(true);
    expect(a.byId.get('1').children.find(n => n.title === 'Work').children.map(n => n.title)).toEqual(['Z', 'X', 'Y']);
  });
});

  test('同步等待期间用户删的书签不被吞掉，删除会传播到云端', async () => {
    const cloud = makeCloud();
    const a = device('reg-dd-A', cloud, { background: true });
    await flush();
    const gone = await a.add('1', 'Gone', 'https://during-get.invalid/');
    await a.add('1', 'Keep', 'https://keep.invalid/');
    expect((await run(a, 'upload')).success).toBe(true);
    // 在云端 GET 等待窗口里删掉书签（真实用户操作，会触发 onRemoved）。
    let deleted = false;
    cloud.hook = async (req) => {
      if (req.method !== 'GET' || req.url !== a.mainUrl || deleted) return null;
      deleted = true;
      await a.chrome.bookmarks.remove(gone.id);
      await a.sandbox.handleBookmarkRemoved(gone.id, { node: gone });
      return null;
    };
    expect((await run(a, 'merge')).success).toBe(true);
    // 回归点：旧实现把这次删除判成「假墓碑」清掉，成功快照又记下删除后的树，
    // 下一轮把云端旧书签当新增导回 —— 用户的删除被静默撤销。
    expect(a.state.store.sync_tombstones.some(t => String(t.key || t).includes('during-get.invalid'))).toBe(true);
    cloud.hook = null;
    await run(a, 'merge');
    expect(urls(a)).not.toContain('https://during-get.invalid/');
    expect(urls(a)).toContain('https://keep.invalid/');   // 无关书签不受影响
    const cloudBody = a.cloud.files.get(a.mainUrl).content;
    expect(cloudBody).not.toContain('href="https://during-get.invalid/"');
  });

  test('同步期间用户删除的书签，在后续多轮合并中不被复活', async () => {
    const cloud = makeCloud();
    const a = device('reg-dd2-A', cloud, { background: true });
    await flush();
    const gone = await a.add('1', 'Gone', 'https://during-get2.invalid/');
    expect((await run(a, 'upload')).success).toBe(true);
    let deleted = false;
    cloud.hook = async (req) => {
      if (req.method !== 'GET' || req.url !== a.mainUrl || deleted) return null;
      deleted = true;
      await a.chrome.bookmarks.remove(gone.id);
      await a.sandbox.handleBookmarkRemoved(gone.id, { node: gone });
      return null;
    };
    await run(a, 'merge');
    cloud.hook = null;
    for (let round = 0; round < 3; round++) {
      a.state.now += 60000;
      await run(a, 'merge');
    }
    expect(urls(a)).not.toContain('https://during-get2.invalid/');
  });

  test('URL 片段编辑更新原节点，不再生成新旧两份', async () => {
    const cloud = makeCloud();
    const a = device('reg-frag-A', cloud), b = device('reg-frag-B', cloud);
    const bm = await a.add('1', 'Anchor', 'https://page.invalid/doc#old');
    expect((await run(a, 'upload')).success).toBe(true);
    expect((await run(b, 'download')).success).toBe(true);
    await a.chrome.bookmarks.update(bm.id, { url: 'https://page.invalid/doc#new' });
    expect((await run(a, 'merge')).success).toBe(true);
    expect((await run(b, 'merge')).success).toBe(true);
    // 回归点：只写 title 不写 url ⇒ 旧地址节点留着、新地址又建一份。
    expect(urls(b)).toEqual(['https://page.invalid/doc#new']);
    expect(b.state.updates.every(u => !Object.hasOwn(u.changes, 'url') || u.changes.url === 'https://page.invalid/doc#new')).toBe(true);
  });

describe('主页回滚：提交失败要把 home 一并恢复', () => {
  test('合并提交冲突后，被墓碑删除的主页书签回到本机', async () => {
    const cloud = makeCloud();
    const a = device('reg-hr-A', cloud), b = device('reg-hr-B', cloud);
    const home = await a.add('2', '移动端主页');
    const gone = await a.add(home.id, 'Home delete', 'https://home-delete.invalid/');
    await a.add('1', 'Bucket sentinel', 'https://bucket-sentinel.invalid/');
    expect((await run(a, 'upload')).success).toBe(true);
    expect((await run(b, 'download')).success).toBe(true);
    // A 删掉主页书签并另加一条，B 合并时 PUT 被并发拒绝。
    await a.chrome.bookmarks.remove(gone.id);
    await a.add('1', 'Cloud addition', 'https://cloud-addition.invalid/');
    expect((await run(a, 'merge')).success).toBe(true);
    b.cloud.hook = req => (req.method === 'PUT' && req.url === b.mainUrl) ? response(412, 'synthetic conflict') : null;
    const result = await run(b, 'merge');
    expect(result.success).toBe(false);
    // 回归点：旧实现只回滚同步桶，主页里被删的书签留在已删状态（备份里明明还有）。
    expect(urls(b)).toContain('https://home-delete.invalid/');
    expect(urls(b)).toContain('https://bucket-sentinel.invalid/');
  });

  test('上传提交冲突后，被墓碑删除的主页书签回到本机', async () => {
    const cloud = makeCloud();
    const a = device('reg-hru-A', cloud), b = device('reg-hru-B', cloud);
    await a.add('1', 'Keep', 'https://hru-keep.invalid/');
    const home = await a.add('2', '移动端主页');
    const gone = await a.add(home.id, 'Home kept', 'https://hru-home.invalid/');
    expect((await run(a, 'upload')).success).toBe(true);
    expect((await run(b, 'download')).success).toBe(true);
    await a.chrome.bookmarks.remove(gone.id);
    expect((await run(a, 'upload', { force: true })).success).toBe(true);
    b.cloud.hook = req => (req.method === 'PUT' && req.url === b.mainUrl) ? response(412, 'synthetic conflict') : null;
    const result = await run(b, 'upload', { force: true });
    expect(result.success).toBe(false);
    expect(urls(b)).toContain('https://hru-home.invalid/');
  });
});

describe('节点身份：重复 ID 与拓扑歧义不再吞节点', () => {
  const wrap = body => '<xbel version="1.0"><folder><title>书签栏</title>' + body
    + '</folder><folder><title>其他收藏夹</title></folder>'
    + '<folder><title>移动收藏夹</title></folder></xbel>';
  const metaId = id => '<info><metadata owner="mini-sync"><prop key="id">' + id + '</prop></metadata></info>';

  test('重复 metadata ID 的两条书签都保留（不再互相覆盖）', () => {
    const parsed = global.MiniSync.xbel.xbelToJson(wrap(
      '<bookmark href="https://one.invalid/"><title>One</title>' + metaId('duplicate') + '</bookmark>'
      + '<bookmark href="https://two.invalid/"><title>Two</title>' + metaId('duplicate') + '</bookmark>'));
    // 回归点：按 id 建索引时后者覆盖前者，一条书签从模型里消失并随回写永久丢失。
    expect(parsed.bookmarks.map(b => b.url).sort()).toEqual(['https://one.invalid/', 'https://two.invalid/']);
    expect(new Set(parsed.bookmarks.map(b => String(b.id))).size).toBe(2);
  });

  test('重复文件夹 ID 的两棵子树各自独立（子节点引用正确）', () => {
    const parsed = global.MiniSync.xbel.xbelToJson(wrap(
      '<folder><title>One</title>' + metaId('same')
      + '<bookmark href="https://one-child.invalid/"><title>One child</title></bookmark></folder>'
      + '<folder><title>Two</title>' + metaId('same')
      + '<bookmark href="https://two-child.invalid/"><title>Two child</title></bookmark></folder>'));
    const folders = parsed.bookmarks.filter(b => b.isFolder);
    const leaves = parsed.bookmarks.filter(b => b.url);
    expect(folders).toHaveLength(2);
    expect(new Set(folders.map(f => String(f.id))).size).toBe(2);
    // 两个子书签必须挂在各自那个同名文件夹下，不能同时指向第一个。
    expect(new Set(leaves.map(l => String(l.parentId))).size).toBe(2);
  });

  test('标题含 / 的字面文件夹与真实嵌套目录不再塌成同一个 pathKey', () => {
    const keys = global.MiniSync.xbelPath.computeJsonPathKeys([
      { id: 'bar', parentId: 'root', title: '书签栏', isFolder: true },
      { id: 'literal', parentId: 'bar', title: 'A/F:B', isFolder: true },
      { id: 'a', parentId: 'bar', title: 'A', isFolder: true },
      { id: 'b', parentId: 'a', title: 'B', isFolder: true }
    ]);
    // 回归点：两者都是 ROOT:bar/F:A/F:B，合并时一棵树被另一棵吞掉。
    expect(keys.get('literal')).not.toBe(keys.get('b'));
    // 普通标题的 pathKey 必须逐字节不变，否则历史快照与墓碑键全部失效。
    const plain = global.MiniSync.xbelPath.computeJsonPathKeys([
      { id: 'bar', parentId: 'root', title: '书签栏', isFolder: true },
      { id: 'f', parentId: 'bar', title: '开发', isFolder: true },
      { id: 'x', parentId: 'f', title: 'GH', url: 'https://github.com' }
    ]);
    expect(plain.get('f')).toBe('ROOT:bar/F:开发');
    expect(plain.get('x')).toBe('ROOT:bar/F:开发/L:https://github.com');
  });

  test('改名同时新增无关同级文件夹：接收端子树不被删除，离线新增不丢', async () => {
    const cloud = makeCloud();
    const a = device('reg-ras-A', cloud), b = device('reg-ras-B', cloud);
    const work = await a.add('1', 'Work');
    await a.add(work.id, 'Shared', 'https://shared.invalid/');
    expect((await run(a, 'upload')).success).toBe(true);
    expect((await run(b, 'download')).success).toBe(true);
    a.state.now += 60000; b.state.now += 60000;
    // B 离线在旧目录里加一条；A 把目录改名并新建一个无关同级目录。
    const bWork = b.byId.get('1').children.find(n => n.title === 'Work');
    await b.add(bWork.id, 'Offline-only', 'https://offline-only.invalid/');
    await a.chrome.bookmarks.update(work.id, { title: 'Renamed' });
    await a.add('1', 'Unrelated new folder');
    expect((await run(a, 'upload')).success).toBe(true);
    const result = await run(b, 'merge');
    // 回归点：严格 1:1 改名判定失败 ⇒ 旧目录整棵被删，B 的离线新增永久丢失。
    expect(result.success).toBe(true);
    expect(urls(b)).toContain('https://shared.invalid/');
    expect(urls(b)).toContain('https://offline-only.invalid/');
    expect(b.cloud.files.get(b.mainUrl).content).toContain('https://offline-only.invalid/');
  });
});

describe('路径安全：WebDAV 路径按字面段写入', () => {
  test('# 与百分号编码的点段被拒绝而不是静默写错位置', () => {
    const utils = global.MiniSync.utils;
    // 回归点：`#` 之后成为 URL fragment（地址被截断），`%2e%2e` 还原成 .. 越出基路径。
    expect(() => utils.normalizeBookmarkPath('/folder#2026')).toThrow();
    expect(() => utils.normalizeBookmarkPath('/%2e%2e/outside')).toThrow();
    expect(utils.normalizeBookmarkPath('/普通 目录')).toBe('/普通 目录');
  });

  test('joinWebDAVUrl 编码后仍落在配置的基路径下且不带 fragment', () => {
    const joined = global.MiniSync.utils.joinWebDAVUrl('https://host/dav', '/folder 2026/minibookmarks.xbel');
    const parsed = new URL(joined);
    expect(parsed.hash).toBe('');
    expect(parsed.pathname).toBe('/dav/folder%202026/minibookmarks.xbel');
    expect(new URL(global.MiniSync.utils.joinWebDAVUrl('https://host/dav', '/a/b/c.xbel')).pathname.startsWith('/dav/')).toBe(true);
  });
});
