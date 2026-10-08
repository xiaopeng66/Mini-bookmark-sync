// sync-merge.test.js — 覆盖 core/sync-merge.js 的 mergeSync 关键历史修复分支
//
// mergeSync 是编排层，依赖大量外部（webdav/importer/storage/xbel/merger/bridge 等）。
// 这里在 beforeEach 安装可控 mock，让 mergeSync 跑通一条受控路径，重点断言三处
// 曾反复踩坑的修复逻辑：
//   1) 删除传播：localDeletedIds 的子树在落盘前被 prune（跨端删除生效）
//   2) 顺序冲突 localOrderWins：本地顺序领先时不重排、但仍写回云端
//   3) 收养节点迁移：adoptedLocalOnlyIds + renamePairs 触发 chrome.bookmarks.create

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadSource, ROOT } = require('./load-source');

// 预置 chrome.bookmarks / chrome.runtime stub（mergeSync 直接调用 chrome.bookmarks.*，
// 且 getChromeTree 内会读取 chrome.runtime.lastError）
global.chrome = global.chrome || {};
global.chrome.runtime = global.chrome.runtime || {};
global.chrome.bookmarks = {
  // 每次返回深拷贝，避免 mergeSync 内部 mutate 污染后续 getTree 调用（真实 Chrome 每次返回新对象）
  getTree: (cb) => cb(JSON.parse(JSON.stringify(global.__chromeTree || []))),
  move: (id, info, cb) => cb && cb({ id, ...info }),
  create: (info, cb) => cb && cb({ id: 'created_' + Math.random().toString(36).slice(2), ...info }),
  removeTree: (id, cb) => cb && cb(),
};

loadSource();
const M = global.MiniSync;
const bindSyncStatusBucket = M.storage.bindSyncStatusBucket;
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'lib/webdav.js'), 'utf8'), { filename: 'lib/webdav.js' });
const isStrongETag = M.webdav.isStrongETag;
const versionWriteCondition = M.webdav.versionWriteCondition;
const describeWriteProtection = M.webdav.describeWriteProtection;
const writeProtectionNote = M.webdav.writeProtectionNote;

// 默认可控 chrome 树：书签栏(1) 下挂 百度(10) 与 工作(11)，工作下挂 GitHub(110)
const DEFAULT_TREE = [{
  id: '0', title: '', children: [
    { id: '1', title: '书签栏', children: [
      { id: '10', title: '百度', url: 'https://baidu.com' },
      { id: '11', title: '工作', children: [
        { id: '110', title: 'GitHub', url: 'https://github.com' },
      ]},
    ]},
    { id: '2', title: '其他书签', children: [] },
  ],
}];

let captured = {}; // 收集 mergeSync 运行期对各 mock 的调用

function installMocks(mergeResultOverride = {}) {
  captured = { importCalled: false, importData: null, putCalled: false, creates: [] };
  global.__chromeTree = DEFAULT_TREE;

  // storage：全部返回空/无操作，避免依赖 chrome.storage.local 真实行为
  const store = {};
  M.storage = {
    getSyncStatus: async () => ({ status: 'idle' }),
    setSyncStatus: async () => {},
    bindSyncStatusBucket,
    getLocal: async (keys) => Object.fromEntries((keys || []).filter(k => k in store).map(k => [k, store[k]])),
    setLocal: async (values) => Object.assign(store, values),
    getDeviceId: async () => 'dev-test',
    getWebdavConfig: async () => ({ url: 'https://dav/file.xbel', username: '', password: '', filename: 'file.xbel' }),
  };

  // A missing-file GET has no ETag; the implementation must create it conditionally.
  M.webdav = {
    isStrongETag,
    versionWriteCondition,
    describeWriteProtection,
    writeProtectionNote,
    getFileVersion: async () => ({ exists: false, content: null, etag: null, lastModified: 0, serverModified: 0 }),
    putFile: async () => { captured.putCalled = true; return { lastModified: 123, protection: 'create-only' }; },
  };

  // xbel：捕获 chromeToXbel 的输入树，xbelToJson 据此返回其扁平列表（反映 prune 结果）
  let capturedTree = DEFAULT_TREE;
  M.xbel = {
    chromeToXbel: (tree) => { capturedTree = tree; return '<xbel/>'; },
    parseXbelFromString: () => null,
    xbelToJson: () => ({ bookmarks: M.merger.chromeTreeToList(capturedTree) }),
    normalizeUrl: (u) => u,
  };

  // xbelPath.computeJsonPathKeys：id -> pk 固定映射，使收养/重命名匹配可预测
  const PK_BY_ID = {
    '1': 'ROOT:bar',
    '2': 'ROOT:other',
    '10': 'ROOT:bar/L:https://baidu.com',
    '11': 'ROOT:bar/F:工作',
    '110': 'ROOT:bar/F:工作/L:https://github.com',
    '8888': 'ROOT:bar/F:8888',
  };
  M.xbelPath = {
    computeJsonPathKeys: (list) => {
      const m = new Map();
      for (const n of (list || [])) {
        const id = String(n.id);
        m.set(id, PK_BY_ID[id] || ('ROOT:bar/' + (n.url ? 'L:' + n.url : 'F:' + (n.title || id))));
      }
      return m;
    },
  };

  // merger：mergeBookmarks 由测试控制返回；chromeTreeToList 给恒等
  M.merger = {
    // 落盘后的统计段会调用它（排除根容器）——真实实现来自 lib/merge.js，这里补个最小版
    isRootContainer: (n) => !!(n && (n.title === '书签栏' || n.title === '其他书签' || n.title === '移动设备书签' || n.title === '移动书签')),
    mergeBookmarks: async () => ({
      stats: { added: 0, updated: 0, skipped: 0, deleted: 0 },
      localUpdated: false,
      remoteUpdated: true,
      orderChanged: false,
      contentUpdatedIds: [],
      localOnlyIds: [],
      remoteOnlyIds: [],
      localDeletedIds: [],
      adoptedLocalOnlyIds: [],
      renamePairs: [],
      ...mergeResultOverride,
    }),
    chromeTreeToList: (tree) => {
      const out = [];
      (function walk(node, pid) {
        if (!node) return;
        if (node.id !== '0') out.push({ id: String(node.id), parentId: String(pid), title: node.title || '', url: node.url || '' });
        (node.children || []).forEach(c => walk(c, node.id));
      })(tree[0], 'root');
      return out;
    },
  };

  // tombstone 使用真实实现（load-source 已加载 model/tombstone.js，纯逻辑无副作用）；
  // bridge / berry/via/aira：no-op
  M.bridgePatcher = { patchBridges: async () => ({ bridgeResults: {}, partial: false }) };
  M.berry = { mergeBerryDataWithChanges: async (list) => ({ list, deletedIds: [], deletedPathKeys: [], complete: true, errors: [] }) };
  M.via = { mergeViaDataWithChanges: async (list) => ({ list, deletedIds: [], deletedPathKeys: [], complete: true, errors: [] }) };
  M.aira = { mergeAiraDataWithChanges: async (list) => ({ list, deletedIds: [], deletedPathKeys: [], complete: true, errors: [] }) };

  // importer：记录接收到的落盘数据
  M.importer = {
    importBookmarksFromData: async (data) => {
      captured.importCalled = true;
      captured.importData = data;
      return { importedCount: (data.bookmarks || []).length, conflicts: [], removedCount: 0 };
    },
  };

  // sync-input 的 getChromeTree 真实调用 chrome.bookmarks.getTree（已被 stub）
  // 无需额外处理；restoreLocalBackup 在失败分支才用，本测试不触发。
}

const baseMerge = M.mergeStrategy.mergeSync;

describe('mergeSync — 删除传播（跨端删除生效）', () => {
  beforeEach(() => installMocks({ localDeletedIds: ['110'] }));

  test('localDeletedIds 对应的子树在落盘前被 prune', async () => {
    await baseMerge({});
    expect(captured.importCalled).toBe(true);
    const ids = (captured.importData.bookmarks || []).map(n => n.id);
    expect(ids).not.toContain('110'); // GitHub 被删
    // 父文件夹 11 仍在（仅子节点被删）
    expect(ids).toContain('11');
  });
});

describe('mergeSync — 顺序冲突 localOrderWins', () => {
  // 仅顺序变化、无增删；云端时间 <= 本机记录 → 本地顺序领先，不重排但写回云端
  beforeEach(() => installMocks({
    orderChanged: true,
    localOnlyIds: [],
    stats: { added: 0, updated: 0, skipped: 0, deleted: 0 },
  }));

  test('顺序冲突 localOrderWins：统一走落盘分支（import 被调用），且仍写回云端（putFile 被调用）', async () => {
    // The GET timestamp is the only remote timestamp used for ordering.
    M.webdav.getFileVersion = async () => ({ exists: true, content: '<xbel/>', etag: '"v1"', lastModified: 0 });
    M.xbel.parseXbelFromString = () => ({ bookmarks: [] });
    // 本机记录 localLastSeen 通过 storage.getLocal 返回 100，云端 lastModified=0
    // 则 remoteLastModified(0) <= localLastSeen(100)+TOL → localOrderWins=true
    const getLocal = M.storage.getLocal;
    M.storage.getLocal = async (keys) => ({ ...await getLocal(keys), ...(keys.includes('cloud_last_modified') ? { cloud_last_modified: 100 } : {}) });
    await baseMerge({});
    // 注：当前实现已将 localOrderWins 统一进落盘分支（对纯顺序变化幂等），
    // 因此 import 仍会被调用；"不重排本地"的语义由顺序修复段（useRemoteOrder=false
    // 时保留本地 _index）保证，而非跳过落盘。
    expect(captured.importCalled).toBe(true);
    expect(captured.putCalled).toBe(true);     // 仍写回云端
  });
});

describe('mergeSync — 收养节点迁移', () => {
  beforeEach(() => {
    installMocks({
      localDeletedIds: ['999'], // 触发 prune 块（收养节点收集发生在此块内）
      adoptedLocalOnlyIds: ['110'],
      renamePairs: [{ oldPk: 'ROOT:bar/F:工作', newPk: 'ROOT:bar/F:8888' }],
    });
    // 让本地树含重命名后的「新名文件夹 8888」，使收养迁移能找到目标父节点
    global.__chromeTree = [{
      id: '0', title: '', children: [
        { id: '1', title: '书签栏', children: [
          { id: '10', title: '百度', url: 'https://baidu.com' },
          { id: '11', title: '工作', children: [{ id: '110', title: 'GitHub', url: 'https://github.com' }] },
          { id: '8888', title: '8888', children: [] },
        ]},
        { id: '2', title: '其他书签', children: [] },
      ],
    }];
  });

  test('存在 renamePairs + adoptedLocalOnlyIds 时触发 chrome.bookmarks.create 迁移', async () => {
    const creates = [];
    global.chrome.bookmarks.create = (info, cb) => { creates.push(info); cb && cb({ id: 'x', ...info }); };
    await baseMerge({});
    expect(creates.length).toBeGreaterThan(0);
    // 迁移目标应为新名文件夹 8888
    expect(creates[0].parentId).toBe('8888');
  });
});

describe('core 拆分结构 — 挂载正确性', () => {
  beforeEach(() => installMocks());

  test('MiniSync.mergeStrategy.mergeSync 与 MiniSync.orchestrator.mergeSync 是同一函数', () => {
    expect(M.mergeStrategy.mergeSync).toBe(M.orchestrator.mergeSync);
  });

  test('orchestrator 透传 restoreLocalBackup / saveLocalSnapshot 来自 syncInput', () => {
    expect(M.orchestrator.restoreLocalBackup).toBe(M.syncInput.restoreLocalBackup);
    expect(M.orchestrator.saveLocalSnapshot).toBe(M.syncInput.saveLocalSnapshot);
  });

  test('orchestrator 暴露 uploadBookmarks / downloadBookmarks', () => {
    expect(typeof M.orchestrator.uploadBookmarks).toBe('function');
    expect(typeof M.orchestrator.downloadBookmarks).toBe('function');
  });
});

describe('mergeSync — 回迁桥必须收到墓碑集合（否则桥接写回把已删节点复活）', () => {
  test('每一处 mergeViaData 调用都带墓碑 pathKey 集合', async () => {
    installMocks();
    const calls = [];
    M.via = { mergeViaDataWithChanges: async (...args) => {
      calls.push(args);
      return { list: args[0], deletedIds: [], deletedPathKeys: [], complete: true, errors: [] };
    } };
    const getLocal = M.storage.getLocal;
    M.storage.getLocal = async (keys) => ({ ...await getLocal(keys),
      ...(keys.includes('option_via_enabled') ? { option_via_enabled: true } : {}),
      ...(keys.includes('sync_tombstones') ? { sync_tombstones: [{ key: 'ROOT:bar/L:https://dead.example', deletedAt: 1, deviceId: 'dev-test' }] } : {})
    });

    await baseMerge({});

    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      // ★ 第 2 参必须传：漏传时桥接侧拿不到墓碑，会把已删节点写回桥接文件 → 下一轮复活
      expect(args.length).toBe(2);
      const keys = args[1];
      expect(keys && typeof keys.has === 'function').toBe(true);
      expect([...keys]).toContain('ROOT:bar/L:https://dead.example');
    }
  });
});

describe('mergeSync — 顺序重排失败必须如实上报', () => {
  test('reported reorder failures prevent cloud write and baseline', async () => {
    installMocks();
    M.importer.importBookmarksFromData = async () => ({ importedCount: 0, removedCount: 0, conflicts: [], moveFailed: 3 });
    const r = await baseMerge({});
    expect(r.success).toBe(false);
    expect(captured.putCalled).toBe(false);
    expect(r.message).toContain('3');
  });

  test('a meaningful move conflict prevents cloud write', async () => {
    installMocks();
    M.importer.importBookmarksFromData = async () => ({ importedCount: 0, removedCount: 0, moveFailed: 1,
      conflicts: [{ type: 'move', title: 'Work', error: 'Cannot move' }] });
    const r = await baseMerge({});
    expect(r.success).toBe(false);
    expect(captured.putCalled).toBe(false);
  });
});
