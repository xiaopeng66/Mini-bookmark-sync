// sync-log-recovery.test.js — 手机端「没拿到后台回执」时的台账取证判据
//
// 背景：雨见等宿主会把后台响应丢掉。消息明明送达、后台也执行了，页面却收不到回执。
// 此时唯一能回答「刚才那次成没成」的证据是后台写进 storage 的 sync_log。
// 判据的关键是**不许把上一次的结果当本次**：那会把一次失败说成成功（或反之），比不说更糟。
const { loadSource } = require('./load-source');

loadSource();
const U = global.MiniSync.utils;

const A = 100000; // 本次点击时间戳

describe('pickSyncLogRecord：从台账里认出「本次操作」的记录', () => {
  test('本次点击之后写下的同动作记录 ⇒ 认定为本次结果', () => {
    const r = U.pickSyncLogRecord([{ action: '上传', success: true, time: A + 300, message: '完成' }],
      '上传', A);
    expect(r).toMatchObject({ success: true, message: '完成', fromLedger: true });
  });

  test('★ 只有上一轮的记录（时间早于点击）⇒ null，绝不冒充本次', () => {
    const r = U.pickSyncLogRecord([{ action: '上传', success: true, time: A - 60000 }], '上传', A);
    expect(r).toBeNull();
  });

  test('刚过去 1 秒的记录在时钟容差内仍算本次（点击时间比后台写台账早一点点）', () => {
    const r = U.pickSyncLogRecord([{ action: '上传', success: false, message: '网络超时', time: A - 1000 }],
      '上传', A);
    expect(r).toMatchObject({ success: false, message: '网络超时' });
  });

  test('动作对不上 ⇒ 不拿别的动作的记录顶替', () => {
    const r = U.pickSyncLogRecord([{ action: '下载', success: true, time: A + 100 }], '上传', A);
    expect(r).toBeNull();
  });

  test('多条记录 ⇒ 取最新那条（旧失败 + 新成功 = 本次成功）', () => {
    const logs = [
      { action: '上传', success: false, message: '旧失败', time: A - 50000 },
      { action: '下载', success: true, message: '别的动作', time: A + 10 },
      { action: '上传', success: true, message: '本次成功', time: A + 500 }
    ];
    const r = U.pickSyncLogRecord(logs, '上传', A);
    expect(r).toMatchObject({ success: true, message: '本次成功' });
  });

  test('最新那条动作对得上但时间对不上 ⇒ null（本次还没写完，不能拿更旧的说事）', () => {
    const logs = [
      { action: '上传', success: true, message: '上一轮成功', time: A - 90000 },
      { action: '上传', success: true, message: '更早的成功', time: A - 120000 }
    ];
    expect(U.pickSyncLogRecord(logs, '上传', A)).toBeNull();
  });

  test('记录缺 time ⇒ 不敢认，返回 null', () => {
    expect(U.pickSyncLogRecord([{ action: '上传', success: true }], '上传', A)).toBeNull();
  });

  test('空台账 / 非数组 ⇒ null（不是抛错，页面要能照常显示「没拿到回执」）', () => {
    expect(U.pickSyncLogRecord([], '上传', A)).toBeNull();
    expect(U.pickSyncLogRecord(null, '上传', A)).toBeNull();
    expect(U.pickSyncLogRecord(undefined, '上传', A)).toBeNull();
    expect(U.pickSyncLogRecord([null, 0, 'x'], '上传', A)).toBeNull();
  });

  test('success 字段按真值归一（后台写的是布尔，别处塞的字符串也认）', () => {
    const r = U.pickSyncLogRecord([{ action: '合并', success: 1, time: A + 1 }], '合并', A);
    expect(r.success).toBe(true);
  });
});
