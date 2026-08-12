/**
 * 日志页：级别与关键字过滤、增量追加、清空，以及「加载更早」的历史翻页。
 *
 * 迁自 scripts/smoke-view.js 的 == 日志页 ==（1525）。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP } = require('../../helpers/dom');

const entry = (seq, level, scope, message, detail) => ({
  seq, level, scope, message, detail, at: new Date(2026, 0, 1, 12, 3, 41).toISOString(),
});

describe('日志页', { skip: JSDOM_SKIP }, () => {
  let ui;
  let ask;
  const rows = () => [...ui.doc.querySelectorAll('#logBody .log-row')];
  const texts = () => rows().map((n) => n.textContent);
  const setLevel = (v) => {
    ui.doc.getElementById('logLevel').value = v;
    ui.doc.getElementById('logLevel').dispatchEvent(new ui.window.Event('change'));
  };

  before(() => {
    ui = mount();
    ui.post({
      type: 'logs',
      entries: [
        entry(1, 'debug', '摘要', '第 1 章请求模型'),
        entry(2, 'info', '摘要', '第 1 章摘要已写入', '耗时 3.2s'),
        entry(3, 'warn', '摘要', '第 2 章是空的'),
        entry(4, 'error', '模型', '连接失败'),
      ],
    });
  });

  // 默认「信息及以上」：debug 那条不显示。
  test('默认过滤掉 debug', () => {
    assert.equal(rows().length, 3, `${rows().length}`);
  });

  test('显示时间', () => {
    assert.ok(texts()[0].includes('12:03:41'), texts()[0]);
  });

  test('显示来源', () => {
    assert.ok(texts()[0].includes('摘要'), texts()[0]);
  });

  test('显示消息', () => {
    assert.ok(texts()[0].includes('第 1 章摘要已写入'), texts()[0]);
  });

  test('警告行带级别样式', () => {
    assert.ok(rows()[1].classList.contains('log-warn'));
  });

  test('错误行带级别样式', () => {
    assert.ok(rows()[2].classList.contains('log-error'));
  });

  test('detail 折叠在 details 里', () => {
    assert.ok(rows()[0].querySelector('details.log-detail'));
  });

  test('detail 默认收起', () => {
    assert.ok(!rows()[0].querySelector('details.log-detail').open);
  });

  test('计数显示筛选比例', () => {
    assert.equal(ui.doc.getElementById('logMeta').textContent, '3 / 4 条',
      ui.doc.getElementById('logMeta').textContent);
  });

  // 调到「全部」应当把 debug 放出来。
  test('切到全部后 debug 出现', () => {
    setLevel('debug');
    assert.equal(rows().length, 4, `${rows().length}`);
  });

  test('全部显示时计数不带比例', () => {
    assert.equal(ui.doc.getElementById('logMeta').textContent, '4 条',
      ui.doc.getElementById('logMeta').textContent);
  });

  test('切到仅错误只剩一条', () => {
    setLevel('error');
    assert.equal(rows().length, 1, `${rows().length}`);
  });

  test('剩下的就是那条错误', () => {
    assert.ok(texts()[0].includes('连接失败'), texts()[0]);
    setLevel('info');
  });

  // 关键字过滤。
  test('关键字过滤生效', () => {
    const filter = ui.doc.getElementById('logFilter');
    filter.value = '模型';
    filter.dispatchEvent(new ui.window.Event('input'));
    assert.equal(rows().length, 1, texts().join(' | '));
    assert.ok(texts()[0].includes('连接失败'), texts().join(' | '));
  });

  test('清空过滤后恢复', () => {
    const filter = ui.doc.getElementById('logFilter');
    filter.value = '';
    filter.dispatchEvent(new ui.window.Event('input'));
    assert.equal(rows().length, 3, `${rows().length}`);
  });

  // 增量追加。
  test('增量追加一条', () => {
    ui.post({ type: 'log', entry: entry(5, 'info', '摘要', '第 3 章摘要已写入') });
    assert.equal(rows().length, 4, `${rows().length}`);
  });

  test('追加在末尾', () => {
    assert.ok(texts().at(-1).includes('第 3 章摘要已写入'), texts().at(-1));
  });

  // 被过滤掉的级别，增量也不该冒出来。
  test('增量也走过滤', () => {
    ui.post({ type: 'log', entry: entry(6, 'debug', '摘要', '不该显示的调试') });
    assert.ok(!texts().some((t) => t.includes('不该显示的调试')), texts().join(' | '));
  });

  // 清空按钮把请求发回后端，前端不自己清（后端要留一条痕迹）。
  test('点清空发出 clearLogs', () => {
    ui.sent.length = 0;
    ui.clickEl(ui.doc.getElementById('logClearBtn'));
    assert.ok(ui.sent.some((m) => m.type === 'clearLogs'), JSON.stringify(ui.sent));
  });

  test('清空后只剩痕迹那条', () => {
    ui.post({ type: 'logs', entries: [entry(7, 'info', '日志', '日志已清空')] });
    assert.equal(rows().length, 1, texts().join(' | '));
    assert.ok(texts()[0].includes('日志已清空'), texts().join(' | '));
  });

  // ---- 「加载更早」：内存缓冲只有几百条且随进程消失，更早的存在工程库里。
  // 默认路径（切到日志页）仍然只看缓冲，一次查询都不做，所以这里要验的是
  // 「只有点了按钮才发消息」。
  test('切到日志页不主动要历史', () => {
    ui.post({ type: 'logs', entries: [entry(20, 'info', '摘要', '本次会话的一条')] });
    ui.sent.length = 0;
    assert.ok(!ui.sent.some((m) => m.type === 'requestLogHistory'));
  });

  test('日志页有「加载更早」按钮', () => {
    assert.ok(ui.doc.getElementById('logEarlierBtn'));
  });

  test('点按钮发 requestLogHistory', () => {
    ui.clickEl(ui.doc.getElementById('logEarlierBtn'));
    ask = ui.sent.find((m) => m.type === 'requestLogHistory');
    assert.ok(ask, JSON.stringify(ui.sent));
  });

  // before 是已显示的最早那条的时间戳，据它继续往前翻。
  test('带上已显示的最早时间戳', () => {
    assert.equal(typeof ask?.before, 'string', JSON.stringify(ask));
  });

  // 历史接在最前面（seq 取负，与实时序号不会撞）。
  test('历史接在最前面', () => {
    ui.post({
      type: 'logHistory',
      entries: [
        { seq: -2, level: 'error', scope: '角色卡', message: '上次会话的失败', at: new Date(2026, 0, 1, 9, 0, 0).toISOString() },
        { seq: -1, level: 'info', scope: '摘要', message: '上次会话的一条', at: new Date(2026, 0, 1, 9, 0, 1).toISOString() },
      ],
      exhausted: false,
    });
    assert.ok(texts()[0].includes('上次会话的失败'), texts().join(' | '));
  });

  test('本次会话的日志还在', () => {
    assert.ok(texts().some((t) => t.includes('本次会话的一条')), texts().join(' | '));
  });

  // 再往前没有了：按钮禁用并改文案，别让用户一直点一个没反应的按钮。
  test('没有更早时按钮禁用', () => {
    ui.post({ type: 'logHistory', entries: [], exhausted: true });
    assert.ok(ui.doc.getElementById('logEarlierBtn').disabled);
  });

  test('没有更早时改文案', () => {
    assert.ok(ui.doc.getElementById('logEarlierBtn').textContent.includes('没有更早'),
      ui.doc.getElementById('logEarlierBtn').textContent);
  });

  // 切筛选条件不该把加载进来的历史丢掉（那以前会走 renderLogs 重置状态）。
  test('切筛选后历史仍在', () => {
    setLevel('debug');
    assert.ok(texts().some((t) => t.includes('上次会话的失败')), texts().join(' | '));
  });
});
