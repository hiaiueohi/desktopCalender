const test = require('node:test');
const assert = require('node:assert');
const D = require('../src/renderer/dates.js');

test('gridStart: 日曜始まり / 月曜始まり', () => {
  // 2026-10-01 は木曜日
  assert.equal(D.keyOf(D.gridStart(new Date(2026, 9, 15), 0)), '2026-09-27');
  assert.equal(D.keyOf(D.gridStart(new Date(2026, 9, 15), 1)), '2026-09-28');
});

test('eventDayKeys: 終日予定の end は排他的', () => {
  const keys = D.eventDayKeys({ allDay: true, start: '2026-10-21', end: '2026-10-24' });
  assert.deepEqual(keys, ['2026-10-21', '2026-10-22', '2026-10-23']);
});

test('eventDayKeys: 深夜 0 時ちょうどに終わる予定は翌日に表示しない', () => {
  const s = new Date(2026, 9, 21, 22, 0).toISOString();
  const e = new Date(2026, 9, 22, 0, 0).toISOString();
  assert.deepEqual(D.eventDayKeys({ allDay: false, start: s, end: e }), ['2026-10-21']);
});

test('eventDayKeys: 日をまたぐ予定は両日に表示', () => {
  const s = new Date(2026, 9, 21, 22, 0).toISOString();
  const e = new Date(2026, 9, 22, 2, 0).toISOString();
  assert.deepEqual(D.eventDayKeys({ allDay: false, start: s, end: e }), ['2026-10-21', '2026-10-22']);
});

test('taskGroup: 期限による分類', () => {
  const today = '2026-10-21';
  assert.equal(D.taskGroup({ due: '2026-10-20' }, today), 'overdue');
  assert.equal(D.taskGroup({ due: today }, today), 'today');
  assert.equal(D.taskGroup({ due: '2026-10-22' }, today), 'tomorrow');
  assert.equal(D.taskGroup({ due: '2026-10-28' }, today), 'week');
  assert.equal(D.taskGroup({ due: '2026-10-29' }, today), 'later');
  assert.equal(D.taskGroup({ due: null }, today), 'nodate');
  assert.equal(D.taskGroup({ due: today, done: true }, today), 'done');
  // 完了直後は元のグループに残す
  assert.equal(D.taskGroup({ due: today, done: true }, today, true), 'today');
});

test('sortTasks: サブタスクは親の直後', () => {
  const tasks = [
    { id: 'c', parent: 'a', due: '2026-10-21', position: '1' },
    { id: 'b', due: '2026-10-20', position: '2' },
    { id: 'a', due: '2026-10-21', position: '0' },
  ];
  assert.deepEqual(D.sortTasks(tasks).map((x) => `${x.task.id}${x.child ? '*' : ''}`), ['b', 'a', 'c*']);
});
