// merge.test.js — 覆盖 merge 引擎的纯函数核心（分类 + 重命名丢弃决策）
const { loadSource } = require('./load-source');

loadSource();
const { classifyNodes, _decideRenameDiscard } = global.MiniSync.merger;

describe('classifyNodes — pathKey 三向分类', () => {

  test('基础分类：双端存在 / 仅本地 / 仅远程', () => {
    const localPKs = new Map([
      ['L1', 'ROOT:bar/L:https://a.com'],   // 双端
      ['L2', 'ROOT:bar/L:https://b.com'],   // 仅本地
    ]);
    const remotePKs = new Map([
      ['R1', 'ROOT:bar/L:https://a.com'],   // 双端
      ['R3', 'ROOT:bar/L:https://c.com'],   // 仅远程
    ]);
    const r = classifyNodes(localPKs, remotePKs, new Set());
    expect(r.bothPresent).toEqual([{ localId: 'L1', pk: 'ROOT:bar/L:https://a.com' }]);
    expect(r.localOnly).toEqual(['L2']);
    expect(r.remoteOnly).toEqual(['R3']);
    expect(r.localDeleted).toEqual([]);
    expect(r.remoteDeleted).toEqual([]);
  });

  test('墓碑命中的 pathKey 归入 deleted 而非 only', () => {
    const localPKs = new Map([['L9', 'ROOT:bar/L:https://dead.com']]);
    const remotePKs = new Map([['R9', 'ROOT:bar/L:https://dead.com']]);
    const tomb = new Set(['ROOT:bar/L:https://dead.com']);
    const r = classifyNodes(localPKs, remotePKs, tomb);
    expect(r.localDeleted).toEqual(['L9']);
    expect(r.remoteDeleted).toEqual(['R9']);
    expect(r.bothPresent).toEqual([]);
    expect(r.localOnly).toEqual([]);
    expect(r.remoteOnly).toEqual([]);
  });

  test('本地与远程 pathKey 完全一致时正确配对', () => {
    const localPKs = new Map([['L1', 'ROOT:bar/F:dev/L:https://x.com']]);
    const remotePKs = new Map([['R1', 'ROOT:bar/F:dev/L:https://x.com']]);
    const r = classifyNodes(localPKs, remotePKs, new Set());
    expect(r.bothPresent).toHaveLength(1);
    expect(r.bothPresent[0]).toEqual({ localId: 'L1', pk: 'ROOT:bar/F:dev/L:https://x.com' });
  });
});

describe('_decideRenameDiscard — 重命名丢弃决策', () => {

  // localItem/remoteItem 形如 { pk, node:{ addedAt } }
  test('本地旧名在墓碑、云端新名不在 → 丢弃本地旧名', () => {
    const tomb = new Set(['ROOT:bar/F:旧名']);
    const r = _decideRenameDiscard(
      { pk: 'ROOT:bar/F:旧名', node: {} },
      { pk: 'ROOT:bar/F:新名', node: {} },
      tomb
    );
    expect(r).toBe('ROOT:bar/F:旧名');
  });

  test('云端旧名在墓碑、本地新名不在 → 丢弃云端旧名', () => {
    const tomb = new Set(['ROOT:bar/F:旧名']);
    const r = _decideRenameDiscard(
      { pk: 'ROOT:bar/F:新名', node: {} },
      { pk: 'ROOT:bar/F:旧名', node: {} },
      tomb
    );
    expect(r).toBe('ROOT:bar/F:旧名');
  });

  test('都不在墓碑时按 addedAt 较晚者保留（丢弃较早者）', () => {
    const tomb = new Set();
    const r = _decideRenameDiscard(
      { pk: 'ROOT:bar/F:本地', node: { addedAt: 100 } },
      { pk: 'ROOT:bar/F:云端', node: { addedAt: 200 } },
      tomb
    );
    // 云端 addedAt(200) 较晚 → 保留云端 → 丢弃本地
    expect(r).toBe('ROOT:bar/F:本地');
  });

  test('都不在墓碑且 addedAt 相同 → 丢弃云端（>= 取云端）', () => {
    const tomb = new Set();
    const r = _decideRenameDiscard(
      { pk: 'ROOT:bar/F:本地', node: { addedAt: 100 } },
      { pk: 'ROOT:bar/F:云端', node: { addedAt: 100 } },
      tomb
    );
    expect(r).toBe('ROOT:bar/F:云端');
  });
});
