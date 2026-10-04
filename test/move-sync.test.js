// move-sync.test.js — 「书签移动/顺序传播」系列修复的回归测试
//
// 背景：这一组 bug 共享同一根因——节点身份用 pathKey（路径指纹）表示，
// 「移动」会让 pathKey 变化，于是：
//   1) 书签跨文件夹挪出 → 旧位置落入 remoteOnly → 被「云端独有追加」复活（跑回原处）
//   2) 挪回原路径 → 命中历史墓碑 → classifyNodes 判 localDeleted → 被误删
//   3) 顺序传播 → 落盘重排依赖 _index，本地全局计数与云端同父序号语义错位
// 本文件用真实 mergeBookmarks（lib/merge.js）+ 真实 tombstone/xbelPath 锁定这些行为，
// 任何未来改动若破坏此处断言，即为回归。

const { loadSource } = require('./load-source');

// ---- chrome mocks（mergeBookmarks 只依赖 chrome.storage.local 的墓碑读写）----
const storageState = {}; // key -> value
global.chrome = global.chrome || {};
global.chrome.runtime = global.chrome.runtime || {};
global.chrome.storage = {
  local: {
    get: (keys, cb) => {
      const out = {};
      for (const k of (Array.isArray(keys) ? keys : [keys])) out[k] = storageState[k];
      if (typeof cb === 'function') cb(out); else return Promise.resolve(out);
    },
    set: (obj, cb) => {
      Object.assign(storageState, obj);
      if (typeof cb === 'function') cb(); else return Promise.resolve();
    },
  },
};

loadSource();
const M = global.MiniSync;

const DEV_EDGE = 'dev-edge';
const NOW = Date.now();

// ---- 树构造辅助 ----
// 本地 Chrome 树：书签栏(1) > FolderA(fa) / FolderB(fb)
function localTree(folderAChildren, folderBChildren) {
  return [{
    id: '0', children: [
      { id: '1', title: '书签栏', children: [
        { id: 'fa', title: 'FolderA', children: folderAChildren, dateAdded: NOW },
        { id: 'fb', title: 'FolderB', children: folderBChildren, dateAdded: NOW },
      ]},
      { id: '2', title: '其他书签', children: [], dateAdded: NOW },
    ],
  }];
}

// 云端（XBEL 解析态）书签列表：FolderA(fa)/FolderB(fb) 为 XBEL 域 id
function remoteBookmarks(folderAChildren, folderBChildren) {
  const out = [
    { id: 'rbar', title: '书签栏', url: '', isFolder: true, parentId: null, addedAt: NOW, _index: 0 },
    { id: 'rfa', title: 'FolderA', url: '', isFolder: true, parentId: 'rbar', addedAt: NOW, _index: 0 },
    { id: 'rfb', title: 'FolderB', url: '', isFolder: true, parentId: 'rbar', addedAt: NOW, _index: 1 },
  ];
  // 同父内序号从 0 开始（与真实 XBEL 解析一致）
  const countByParent = new Map();
  const pushChild = (c, pid) => {
    const i = countByParent.get(pid) || 0;
    out.push({ ...c, parentId: pid, addedAt: NOW, _index: i });
    countByParent.set(pid, i + 1);
  };
  for (const c of folderAChildren) pushChild(c, 'rfa');
  for (const c of folderBChildren) pushChild(c, 'rfb');
  return out;
}

function remoteData(folderAChildren, folderBChildren, deviceId) {
  return {
    version: 1,
    bookmarks: remoteBookmarks(folderAChildren, folderBChildren),
    lastModified: NOW,
    deviceId: deviceId || DEV_EDGE,
    tombstones: [],
    endpoints: {},
    snapshots: {},
  };
}

async function installStorage(tombstones) {
  storageState.sync_tombstones = tombstones || [];
  storageState.cloud_last_modified = 0;
  M.storage = M.storage || {};
  M.storage.getDeviceId = async () => DEV_EDGE;
}

const X = (id) => ({ id, title: 'X', url: 'https://x', isFolder: false, addedAt: NOW });

describe('书签跨文件夹移动 — 旧位置不复活（5f 书签移动识别）', () => {
  test('发起端（本端有移动意图）：不生成迁移对、旧位置不被追加', async () => {
    await installStorage([]);
    // 本端挪动时 onMoved 记录的意图（新旧路径都在意图表）
    storageState.sync_move_intents = {
      'ROOT:bar/F:FolderA/L:https://x': { time: Date.now(), deviceId: DEV_EDGE },
      'ROOT:bar/F:FolderB/L:https://x': { time: Date.now(), deviceId: DEV_EDGE },
    };
    const localTreeArg = localTree([], [X('xb')]); // 本地：X 在 FolderB（挪后）
    const remote = remoteData([X('xa')], []);      // 云端：X 在 FolderA（挪前）
    const result = await M.merger.mergeBookmarks(localTreeArg, remote, {});

    // 旧位置 X 的远程 id 不得出现在 remoteOnlyIds（否则落盘会把它追加回 FolderA = 跑回原处）
    expect(result.remoteOnlyIds).not.toContain('xa');
    // 发起端不生成迁移对（生成则会把本地迁回旧位置）
    expect(result.renamePairs.length).toBe(0);
  });

  test('接收端（无移动意图）：生成迁移对（本地跟随云端）', async () => {
    await installStorage([]);
    const localTreeArg = localTree([X('xa')], []); // 本地：X 在 FolderA（未同步移动）
    const remote = remoteData([], [X('xb')]);      // 云端：X 已在 FolderB
    const result = await M.merger.mergeBookmarks(localTreeArg, remote, {});

    // 本地 X(旧位置) 不该被当作「本地独有」保留在 A（否则出现两份），而应识别为移动
    expect(result.localOnlyIds).not.toContain('xa');
    expect(result.renamePairs.length).toBeGreaterThan(0);
    expect(result.renamePairs[0].oldPk).toContain('FolderA');
    expect(result.renamePairs[0].newPk).toContain('FolderB');
  });

  test('addedAt 不一致（跨端创建的副本）也识别为移动', async () => {
    await installStorage([]);
    // 本地：X 在 FolderA（addedAt=T0）；云端：X 在 FolderB（addedAt=T0+1天，跨端创建时间不同）
    const localTreeArg = localTree([X('xa')], []);
    const remote = remoteData([], [{ ...X('xb'), addedAt: NOW + 86400000 }]);
    const result = await M.merger.mergeBookmarks(localTreeArg, remote, {});

    // 接收端（无意图）：识别为移动（不因 addedAt 差异漏配）→ 生成迁移对
    expect(result.renamePairs.length).toBeGreaterThan(0);
    expect(result.remoteOnlyIds).not.toContain('xb');
  });
});

describe('顶层文件夹改名（5c）— 本端就地改名，不删不重建', () => {
  // 云端已把「工作」改名成「8888」（旧路径墓碑上云），本端还叫「工作」。
  // 期望：本端那个旧名节点**就地改名**（保 chrome id、保整棵子树），
  // 既不能判成删除（会连内容一起删掉），也不能把云端新名当「云端独有」建成空壳。
  function renamedRemote() {
    return {
      version: 1,
      bookmarks: [
        { id: 'rbar', title: '书签栏', url: '', isFolder: true, parentId: null, addedAt: NOW, _index: 0 },
        { id: 'r8888', title: '8888', url: '', isFolder: true, parentId: 'rbar', addedAt: NOW, _index: 0 },
        { id: 'rg', title: 'GitHub', url: 'https://github.com', isFolder: false, parentId: 'r8888', addedAt: NOW, _index: 0 },
        // FolderB 两端都在（不参与 5c 识别，但必须是 bothPresent，否则同父下会有两个单端节点）
        { id: 'rfb', title: 'FolderB', url: '', isFolder: true, parentId: 'rbar', addedAt: NOW, _index: 1 },
      ],
      lastModified: NOW, deviceId: DEV_EDGE,
      // 旧名墓碑**云端也有**（对端改名时写下的）：这样 pendingTombstones=0，
      // 「本端改名必须回写云端」就只能靠 localRenames 那条判据顶着（否则用例测不出它）。
      tombstones: [{ key: 'ROOT:bar/F:FolderA', deletedAt: NOW, deviceId: 'dev-other' }],
      endpoints: {}, snapshots: {},
    };
  }
  const G = (id) => ({ id, title: 'GitHub', url: 'https://github.com', isFolder: false, addedAt: NOW });

  test('本端旧名命中墓碑 + 云端同名父下只有一个新名 ⇒ renameLocalNodes 指向本端节点', async () => {
    await installStorage(['ROOT:bar/F:FolderA']);
    const result = await M.merger.mergeBookmarks(localTree([G('xg')], []), renamedRemote(), {});

    // 本端旧名节点不许被判删除（判了就整棵被 prune 掉）
    expect(result.localDeletedIds).not.toContain('fa');
    // 云端新名节点不许被当「云端独有」追加（追加就多一个空壳文件夹）
    expect(result.remoteOnlyIds).not.toContain('r8888');
    // 就地改名的指令指向本端原节点 + 云端新标题
    expect(result.renameLocalNodes).toEqual([{ id: 'fa', title: '8888' }]);
    // 本端改名必须回写云端，否则下一轮又判一次、两端各留自己的名字
    expect(result.remoteUpdated).toBe(true);
    // 改名不是删除 ⇒ 不走「收养迁移」（收养会另建一份节点）
    expect(result.adoptedLocalOnlyIds).toEqual([]);
    // 子孙（同名的 GitHub）按 5f 移动携带，云端不再重复追加
    expect(result.remoteOnlyIds).toEqual([]);
  });

  test('云端改名 + 本端在旧名下新增子节点 ⇒ 子节点保留为本地独有（随改名后的文件夹上传）', async () => {
    await installStorage(['ROOT:bar/F:FolderA']);
    const local = localTree([G('xg'), { id: 'xn', title: '新书签', url: 'https://new.example', isFolder: false, addedAt: NOW }], []);
    const result = await M.merger.mergeBookmarks(local, renamedRemote(), {});

    // 新书签在云端新名下没有对应 ⇒ 仍是本地独有（要上传），但不许被「收养」另建
    expect(result.localOnlyIds).toContain('xn');
    expect(result.adoptedLocalOnlyIds).toEqual([]);
    expect(result.renameLocalNodes).toEqual([{ id: 'fa', title: '8888' }]);
  });
});

describe('挪回原文件夹 — 过时墓碑不误删（cleanFakeTombstones 接入）', () => {
  test('本端墓碑（挪出时误写）+ 节点挪回原路径 → 不判 localDeleted', async () => {
    const tombPK = 'ROOT:bar/F:FolderA/L:https://x';
    await installStorage([{ key: tombPK, deletedAt: NOW, deviceId: DEV_EDGE }]); // 本端误写墓碑
    // 挪回时 onMoved 记录的意图（新旧路径）
    storageState.sync_move_intents = {
      'ROOT:bar/F:FolderA/L:https://x': { time: Date.now(), deviceId: DEV_EDGE },
      'ROOT:bar/F:FolderB/L:https://x': { time: Date.now(), deviceId: DEV_EDGE },
    };
    const localTreeArg = localTree([X('xa')], []); // 本地：X 已挪回 FolderA
    const remote = remoteData([], [X('xb')]);      // 云端：X 还停在 FolderB（挪出后状态）
    const result = await M.merger.mergeBookmarks(localTreeArg, remote, {});

    // 关键断言：X 不得进入 localDeletedIds（进入即被落盘删除 = 「挪回后被删」）
    expect(result.localDeletedIds).not.toContain('xa');
  });

  test('他端墓碑 + 本地节点仍在 → 删除传播保持有效（不被误清）', async () => {
    const tombPK = 'ROOT:bar/F:FolderA/L:https://x';
    await installStorage([{ key: tombPK, deletedAt: NOW, deviceId: 'dev-chrome' }]); // 他端墓碑
    const localTreeArg = localTree([X('xa')], []); // 本地：X 在 FolderA
    const remote = remoteData([], []);             // 云端：X 已被删除（对端删后回写）
    const result = await M.merger.mergeBookmarks(localTreeArg, remote, {});

    // 他端删除指令必须照常传播：X 进入 localDeletedIds
    expect(result.localDeletedIds).toContain('xa');
  });
});

describe('顺序传播 — _index 语义归一化（orderChanged）', () => {
  const A = { id: 'xa', title: 'A', url: 'https://a', isFolder: false, addedAt: NOW };
  const B = { id: 'xb', title: 'B', url: 'https://b', isFolder: false, addedAt: NOW };
  const RA = { id: 'ra', title: 'A', url: 'https://a', isFolder: false, addedAt: NOW };
  const RB = { id: 'rb', title: 'B', url: 'https://b', isFolder: false, addedAt: NOW };

  test('同序但计数体系不同（本地全局计数 vs 云端同父序号）→ 不误报顺序变化', async () => {
    await installStorage([]);
    const localTreeArg = localTree([], [A, B]);      // 本地 FolderB 下 [A,B]
    const remote = remoteData([], [RA, RB]);         // 云端 FolderB 下同序 [A,B]
    const result = await M.merger.mergeBookmarks(localTreeArg, remote, {});
    if (result.orderChanged !== false) {
      // 诊断输出：定位归一化比较中不相等的 pk
      const localList = M.merger.chromeTreeToList(localTreeArg);
      const localPKs = M.xbelPath.computeJsonPathKeys(localList);
      const remotePKs = M.xbelPath.computeJsonPathKeys(remote.bookmarks);
      const rank = new Map();
      const localRanks = {};
      for (const n of localList) {
        const key = n.parentId || '__root__';
        const i = rank.get(key) || 0;
        localRanks[localPKs.get(n.id)] = i;
        rank.set(key, i + 1);
      }
      const remoteIdx = {};
      for (const n of remote.bookmarks) remoteIdx[remotePKs.get(n.id)] = n._index;
      console.log('[diag] localRank:', JSON.stringify(localRanks, null, 0));
      console.log('[diag] remoteIdx:', JSON.stringify(remoteIdx, null, 0));
    }
    expect(result.orderChanged).toBe(false);
  });

  test('云端顺序真变（[A,B] → [B,A]）→ orderChanged=true', async () => {
    await installStorage([]);
    const localTreeArg = localTree([], [A, B]);      // 本地 FolderB 下 [A,B]
    const remote = remoteData([], [RB, RA]);         // 云端 FolderB 下 [B,A]
    const result = await M.merger.mergeBookmarks(localTreeArg, remote, {});
    expect(result.orderChanged).toBe(true);
  });
});
