// move-propagation.test.js — 「书签/文件夹换文件夹」必须跨端传播的回归测试
//
// 真实缺陷（用户报障）：在一端把书签从 A 文件夹拖到 B 文件夹，同步后另一端没有拿到新位置，
// 反而把位置还原了。根因是移动方向只靠 onMoved 写下的「移动意图」判定：
//   · 同步进行中 onMoved 监听直接 return（用户这时拖动完全不被记录）
//   · 意图 TTL 只有 65 分钟（自动同步间隔可配到 7 天）
//   · 部分宿主/操作路径根本不派发 onMoved
// 意图一旦缺失，合并引擎把本端刚做的移动判成「跟随云端」，落盘阶段把书签迁回旧位置；
// 同时（源文件夹只有这一个书签时）没有任何写回条件成立，云端永远停在旧位置。
// 本文件端到端锁住：无意图也必须靠「上次同步基线」判出本端是发起方并写回云端。

const { makeCloud, makeDevice, flush } = require('./helpers/audit-harness.cjs');

const devices = [];
afterEach(() => { for (const d of devices.splice(0)) d.close(); });
const device = (name, cloud, opts) => {
  const d = makeDevice(name, cloud, opts);
  devices.push(d);
  return d;
};
const paths = d => d.paths().map(n => n.path.replace(/^书签栏\//, '')).sort();
const pks = d => d.M.xbelPath.computeJsonPathKeys(d.M.merger.chromeTreeToList([d.state.root]));
const pkOf = (d, id) => pks(d).get(id);

async function sync(d, action) {
  const result = await d.M.orchestrator[action]({});
  expect(result.success, JSON.stringify(result)).toBe(true);
  return result;
}

// 两台设备完成初始同步（A 上传 → B 下载），基线在两端都建立起来。
async function seed() {
  const cloud = makeCloud();
  const a = device('move-A', cloud);
  const b = device('move-B', cloud);
  const src = await a.add('1', 'Src');
  const dst = await a.add('1', 'Dst');
  await a.add('1', 'Sentinel', 'https://sentinel.invalid/');
  await sync(a, 'uploadBookmarks');
  await sync(b, 'downloadBookmarks');
  a.state.now += 60000;
  b.state.now += 60000;
  return { a, b, src, dst };
}

async function converge(a, b, rounds = 2) {
  for (let i = 0; i < rounds; i++) {
    for (const d of [a, b]) {
      d.state.now += 60000;
      await sync(d, 'mergeSync');
    }
  }
}

test('★ 无移动意图（监听被跳过/过期/宿主没派发）⇒ 仍按基线判定本端发起，位置不回迁且写回云端', async () => {
  const { a, b, src, dst } = await seed();
  const bm = await a.add(src.id, 'Target', 'https://target.invalid/');
  await sync(a, 'uploadBookmarks');
  await sync(b, 'downloadBookmarks');

  a.state.now += 60000;
  const oldPk = pkOf(a, bm.id);
  await a.chrome.bookmarks.move(bm.id, { parentId: dst.id });
  const newPk = pkOf(a, bm.id);
  a.state.store.sync_move_intents = {}; // 模拟：没有任何意图记录

  const result = await sync(a, 'mergeSync');
  // 本端发起：不得生成「迁回旧位置」的迁移对；台账里要能看见这次移动
  expect(result.crossZoneDiag.moves).toBe(0);
  expect(paths(a)).toEqual(['Dst/Target', 'Sentinel']);
  // 关键：源文件夹里没有其它兄弟节点，顺序与墓碑都无法间接触发写回，
  // 必须由「本端发起的移动」这一条显式触发 —— 否则云端永远停在旧位置。
  expect(oldPk).not.toBe(newPk);

  await converge(a, b);
  for (const d of [a, b]) expect(paths(d)).toEqual(['Dst/Target', 'Sentinel']);
});

test('★ 无移动意图的文件夹移动（带子书签）同样传播', async () => {
  const { a, b, src, dst } = await seed();
  const folder = await a.add(src.id, 'Moving');
  await a.add(folder.id, 'Target', 'https://target.invalid/');
  await sync(a, 'uploadBookmarks');
  await sync(b, 'downloadBookmarks');

  a.state.now += 60000;
  await a.chrome.bookmarks.move(folder.id, { parentId: dst.id });
  a.state.store.sync_move_intents = {};

  await sync(a, 'mergeSync');
  expect(paths(a)).toEqual(['Dst/Moving/Target', 'Sentinel']);

  await converge(a, b);
  for (const d of [a, b]) expect(paths(d)).toEqual(['Dst/Moving/Target', 'Sentinel']);
});

test('接收端（本端停在基线路径）仍跟随云端的新位置，不被误判成发起方', async () => {
  const { a, b, src, dst } = await seed();
  const bm = await a.add(src.id, 'Target', 'https://target.invalid/');
  await sync(a, 'uploadBookmarks');
  await sync(b, 'downloadBookmarks');

  a.state.now += 60000;
  await a.chrome.bookmarks.move(bm.id, { parentId: dst.id });
  await sync(a, 'mergeSync'); // A 发起并写回

  b.state.now += 60000;
  const rb = await sync(b, 'mergeSync');
  expect(rb.crossZoneDiag.moves).toBe(1);
  expect(paths(b)).toEqual(['Dst/Target', 'Sentinel']);
});

test('★ 同步进行中用户拖动书签 = 记录意图；同步自身落盘的移动不记录', async () => {
  const cloud = makeCloud();
  const a = device('move-A', cloud, { background: true });
  const src = await a.add('1', 'Src');
  const dst = await a.add('1', 'Dst');
  const moved = await a.add(src.id, 'Target', 'https://target.invalid/');
  const ownMove = await a.add(src.id, 'OwnMove', 'https://own.invalid/');
  await sync(a, 'uploadBookmarks');

  a.state.now += 60000;
  const oldPk = pkOf(a, moved.id);
  // 模拟「一轮同步正在跑」：旧实现在这个状态下直接忽略 onMoved，用户的拖动就此丢失
  a.state.store.sync_status = 'syncing';
  a.state.store.last_sync_time = a.state.now;

  await a.chrome.bookmarks.move(moved.id, { parentId: dst.id });
  const newPk = pkOf(a, moved.id);
  // 同步自身的落盘/重排：登记为事务移动，监听必须忽略它（否则本端会拒绝跟随云端）
  a.M.utils.noteTransactionMove(ownMove.id);
  await a.chrome.bookmarks.move(ownMove.id, { parentId: dst.id });

  await a.chrome.bookmarks.onMoved.emit(moved.id, { parentId: dst.id });
  await a.chrome.bookmarks.onMoved.emit(ownMove.id, { parentId: dst.id });
  await flush();

  const intents = a.state.store.sync_move_intents || {};
  expect(intents[oldPk]).toBeTruthy();
  expect(intents[newPk]).toBeTruthy();
  expect(Object.keys(intents).filter(k => k.includes('OwnMove'))).toEqual([]);
});

test('★ 手机端残留移动意图（上次移动遗留、未清理）⇒ 不能被当成发起方把旧位置写回云端', async () => {
  const { a, b } = await seed();
  const bsrc = [...b.byId.values()].find(n => !n.url && n.title === 'Src');
  const bdst = [...b.byId.values()].find(n => !n.url && n.title === 'Dst');
  const bm = await b.add(bsrc.id, 'Target', 'https://target.invalid/');
  await sync(b, 'uploadBookmarks');
  await sync(a, 'downloadBookmarks');

  // 桌面把书签挪到 Dst 并同步（意图在提交后清除）
  a.state.now += 60000;
  await a.chrome.bookmarks.move([...a.byId.values()].find(n => n.url && n.title === 'Target').id, { parentId: [...a.byId.values()].find(n => !n.url && n.title === 'Dst').id });
  await sync(a, 'mergeSync');

  // 手机端残留一条旧意图：它此前也动过这条路径，但那次同步失败/走了下载路径
  const oldTree = b.M.merger.chromeTreeToList([b.state.root]);
  const oldPk = b.M.xbelPath.computeJsonPathKeys(oldTree).get(bm.id);
  b.state.store.sync_move_intents = { [oldPk]: { time: b.state.now, deviceId: b.state.store.sync_device_id } };
  // 把手机的基线恢复为「书签在 Src」的状态（它上次成功同步时就是这样）
  b.state.store.sync_snapshots = { localTree: oldTree };

  b.state.now += 60000;
  const rb = await sync(b, 'mergeSync');
  expect(rb.crossZoneDiag.moves).toBe(1);
  expect(paths(b)).toEqual(['Dst/Target', 'Sentinel']);
  // 云端仍是桌面的新位置（没有被手机的旧位置覆盖）
  const cloudData = a.M.xbel.xbelToJson(a.cloud.files.get(a.mainUrl).content);
  const byId = new Map(cloudData.bookmarks.map(n => [n.id, n]));
  const cloudPaths = cloudData.bookmarks.filter(n => n.url).map(n => {
    const chain = []; let cur = n;
    while (cur) { chain.unshift(cur.title || cur.url); cur = byId.get(cur.parentId); }
    return chain.join('/');
  }).sort();
  expect(cloudPaths).toEqual(['Dst/Target', 'Sentinel']);
});

test('★ PUT 等待期间用户又移动了书签：基线记「已上传的树」，下一轮不把这次移动迁回', async () => {
  const cloud = makeCloud();
  const a = device('inflight-A', cloud);
  const src = await a.add('1', 'Src');
  const dst = await a.add('1', 'Dst');
  const bm = await a.add(src.id, 'Target', 'https://target.invalid/');
  await sync(a, 'uploadBookmarks');
  // 先制造一个必然写回云端的改动（新增书签），保证这一轮真的走 PUT
  await a.add('1', 'Extra', 'https://extra.invalid/');

  a.state.now += 60000;
  const originalPut = a.M.webdav.putFile;
  let moved = false;
  a.M.webdav.putFile = async (...args) => {
    if (!moved) {
      moved = true;
      // PUT 发出前的树已经算好；此刻用户把书签挪走，云端不会包含这次移动
      await a.chrome.bookmarks.move(bm.id, { parentId: dst.id });
      a.state.store.sync_move_intents = {};
    }
    return originalPut(...args);
  };
  await sync(a, 'mergeSync');
  expect(moved).toBe(true);
  // 基线里必须仍是上传时的旧位置（不是 PUT 之后的新位置）
  const baseKeys = a.M.xbelPath.computeJsonPathKeys(a.state.store.sync_snapshots.localTree).values();
  expect([...baseKeys].some(k => k.includes('Src/L:https://target.invalid'))).toBe(true);
  expect([...baseKeys].some(k => k.includes('Dst/L:https://target.invalid'))).toBe(false);

  // 下一轮：本端移动发生在基线之后 ⇒ 仍判本端发起，不回迁
  a.state.now += 60000;
  await sync(a, 'mergeSync');
  expect(paths(a)).toEqual(['Dst/Target', 'Extra']);
});

test('★ 剪切/粘贴式移动（新 id + 删旧节点，无 onMoved）同样传播', async () => {
  const { a, b, src, dst } = await seed();
  const bm = await a.add(src.id, 'Target', 'https://target.invalid/');
  await sync(a, 'uploadBookmarks');
  await sync(b, 'downloadBookmarks');

  a.state.now += 60000;
  // 书签管理器「剪切→粘贴」：新节点拿到新 id，旧节点被删，浏览器不派发 onMoved
  await a.add(dst.id, 'Target', 'https://target.invalid/');
  await a.chrome.bookmarks.remove(bm.id);
  a.state.store.sync_move_intents = {};

  await sync(a, 'mergeSync');
  expect(paths(a)).toEqual(['Dst/Target', 'Sentinel']);

  await converge(a, b);
  for (const d of [a, b]) expect(paths(d)).toEqual(['Dst/Target', 'Sentinel']);
});

test('★ 宿主 move 静默不生效 ⇒ 明确失败，旧书签原样保留、云端不变（绝不自动删旧）', async () => {
  const { a, b, src, dst } = await seed();
  const bm = await a.add(src.id, 'Target', 'https://target.invalid/');
  await a.add(src.id, 'Stay', 'https://stay.invalid/');
  await sync(a, 'uploadBookmarks');
  await sync(b, 'downloadBookmarks');

  a.state.now += 60000;
  await a.chrome.bookmarks.move(bm.id, { parentId: dst.id });
  a.state.store.sync_move_intents = {};
  await sync(a, 'mergeSync');
  const cloudBefore = a.cloud.files.get(a.mainUrl).content;

  b.chrome.bookmarks.move = (id, info, cb) => {
    if (cb) { cb({ id, parentId: info.parentId }); return undefined; }
    return Promise.resolve({ id, parentId: info.parentId });
  };
  b.state.now += 60000;
  const rb = await b.M.orchestrator.mergeSync({});

  expect(rb.success).toBe(false);
  expect(rb.message).toContain('已停止写回云端');
  // 旧书签必须还在原处；绝不因为「移动失败」而删除任何书签
  expect(paths(b)).toContain('Src/Target');
  expect(paths(b)).toContain('Src/Stay');
  // 云端逐字节未变
  expect(a.cloud.files.get(a.mainUrl).content).toBe(cloudBefore);
});

test('★ 宿主 move 静默不生效且无法重建（文件夹）⇒ 合并明确失败，云端保持新位置', async () => {
  const { a, b, src, dst } = await seed();
  const folder = await a.add(src.id, 'Moving');
  await a.add(folder.id, 'Inside', 'https://inside.invalid/');
  await sync(a, 'uploadBookmarks');
  await sync(b, 'downloadBookmarks');

  a.state.now += 60000;
  await a.chrome.bookmarks.move(folder.id, { parentId: dst.id });
  a.state.store.sync_move_intents = {};
  await sync(a, 'mergeSync');
  const cloudBefore = a.cloud.files.get(a.mainUrl).content;

  b.chrome.bookmarks.move = (id, info, cb) => {
    if (cb) { cb({ id, parentId: info.parentId }); return undefined; }
    return Promise.resolve({ id, parentId: info.parentId });
  };
  b.state.now += 60000;
  const rb = await b.M.orchestrator.mergeSync({});

  expect(rb.success).toBe(false);
  expect(rb.message).toContain('已停止写回云端');
  // 云端逐字节未变（没有用旧位置覆盖）
  expect(a.cloud.files.get(a.mainUrl).content).toBe(cloudBefore);
});

test('★ 重建也失败（宿主 create 不可见）⇒ 旧书签必须保住、云端不变', async () => {
  const { a, b, src, dst } = await seed();
  const bm = await a.add(src.id, 'Target', 'https://target.invalid/');
  await sync(a, 'uploadBookmarks');
  await sync(b, 'downloadBookmarks');

  a.state.now += 60000;
  await a.chrome.bookmarks.move(bm.id, { parentId: dst.id });
  a.state.store.sync_move_intents = {};
  await sync(a, 'mergeSync');
  const cloudBefore = a.cloud.files.get(a.mainUrl).content;

  // 宿主：move 静默无效，create 也只返回一个并不存在的 id
  b.chrome.bookmarks.move = (id, info, cb) => {
    if (cb) { cb({ id, parentId: info.parentId }); return undefined; }
    return Promise.resolve({ id, parentId: info.parentId });
  };
  const realCreate = b.chrome.bookmarks.create;
  b.chrome.bookmarks.create = (info, cb) => {
    if (info && info.url === 'https://target.invalid/') {
      const phantom = { id: 'phantom-node', parentId: String(info.parentId), title: info.title || '', url: info.url };
      if (cb) { cb(phantom); return undefined; }
      return Promise.resolve(phantom);
    }
    return realCreate(info, cb);
  };
  b.state.now += 60000;
  const rb = await b.M.orchestrator.mergeSync({});

  expect(rb.success).toBe(false);
  expect(rb.message).toContain('已停止写回云端');
  // 旧书签仍在原处（绝不先删后建）
  expect(paths(b)).toContain('Src/Target');
  // 云端逐字节未变
  expect(a.cloud.files.get(a.mainUrl).content).toBe(cloudBefore);
});

test('★ 宿主只认「带 index 的 move」⇒ 兼容重试后移动成功', async () => {
  const { a, b, src, dst } = await seed();
  const bm = await a.add(src.id, 'Target', 'https://target.invalid/');
  await sync(a, 'uploadBookmarks');
  await sync(b, 'downloadBookmarks');

  a.state.now += 60000;
  await a.chrome.bookmarks.move(bm.id, { parentId: dst.id });
  a.state.store.sync_move_intents = {};
  await sync(a, 'mergeSync');   // 桌面先把新位置写进云端

  // 宿主形态：不给 index 就静默不动；给了 index 才真正移动
  const realMove = b.chrome.bookmarks.move;
  b.chrome.bookmarks.move = (id, info, cb) => {
    if (info.index === undefined) {
      if (cb) { cb({ id, parentId: info.parentId }); return undefined; }
      return Promise.resolve({ id, parentId: info.parentId });
    }
    return realMove(id, info, cb);
  };
  b.state.now += 60000;
  const rb = await sync(b, 'mergeSync');
  expect(rb.success).toBe(true);
  expect(paths(b)).toEqual(['Dst/Target', 'Sentinel']);
});

test('★ 宿主只认 browser.* Promise 版 move ⇒ 兼容重试后移动成功', async () => {
  const { a, b, src, dst } = await seed();
  const bm = await a.add(src.id, 'Target', 'https://target.invalid/');
  await sync(a, 'uploadBookmarks');
  await sync(b, 'downloadBookmarks');

  a.state.now += 60000;
  await a.chrome.bookmarks.move(bm.id, { parentId: dst.id });
  a.state.store.sync_move_intents = {};
  await sync(a, 'mergeSync');   // 桌面先把新位置写进云端

  // 宿主形态：chrome 回调版全部静默不动，只有 browser.* Promise 版生效
  const realMove = b.chrome.bookmarks.move;
  b.chrome.bookmarks.move = (id, info, cb) => {
    if (cb) { cb({ id, parentId: info.parentId }); return undefined; }
    return Promise.resolve({ id, parentId: info.parentId });
  };
  b.sandbox.browser = { bookmarks: { move: (id, info) => realMove(id, info, undefined) } };
  b.state.now += 60000;
  const rb = await sync(b, 'mergeSync');
  expect(rb.success).toBe(true);
  expect(paths(b)).toEqual(['Dst/Target', 'Sentinel']);
});
