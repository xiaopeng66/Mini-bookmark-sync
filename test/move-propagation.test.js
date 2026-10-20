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
