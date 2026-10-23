const test = require('node:test');
const assert = require('node:assert');
const { createQueue } = require('../src/main/queue.js');
const { networkError, apiError } = require('../src/main/errors.js');
const { normalizeTask, toApiPatch } = require('../src/main/google.js');

const task = (id, done) => ({ id, listId: 'L', title: id, due: null, done, position: '' });

test('オンライン: 送信成功ならキューに残らない', async () => {
  const sent = [];
  const q = createQueue({ persist: false, send: async (l, id, p) => (sent.push(p), task(id, p.done)) });
  const r = await q.apply('L', 't1', { done: true });
  assert.equal(r.queued, false);
  assert.equal(r.task.done, true);
  assert.equal(q.size(), 0);
  assert.deepEqual(sent, [{ done: true }]);
});

test('オフライン: キューに積み、取得結果に上書きされる', async () => {
  let online = false;
  const sent = [];
  const q = createQueue({
    persist: false,
    send: async (l, id, p) => {
      if (!online) throw networkError();
      sent.push([id, p]);
      return task(id, p.done);
    },
  });
  assert.equal((await q.apply('L', 't1', { done: true })).queued, true);
  // 同期で Google から古い状態 (未完了) が返ってきても、画面には完了で出る
  const view = q.overlay([task('t1', false), task('t2', false)]);
  assert.equal(view[0].done, true);
  assert.equal(view[0].pending, true);
  assert.equal(view[1].done, false);

  // 完了 → 未完了 → 完了 と押しても送るのは最終状態だけ
  await q.apply('L', 't1', { done: false });
  await q.apply('L', 't1', { done: true });
  assert.equal(q.size(), 1);

  online = true;
  assert.equal(await q.flush(), true);
  assert.equal(q.size(), 0);
  assert.deepEqual(sent, [['t1', { done: true }]]);
});

test('同じタスクへの操作は順番どおりに送られる', async () => {
  const order = [];
  const q = createQueue({
    persist: false,
    send: async (l, id, p) => {
      // 1 回目の送信をわざと遅くしても、2 回目が先に届かない
      await new Promise((r) => setTimeout(r, p.done ? 30 : 1));
      order.push(p.done);
      return task(id, p.done);
    },
  });
  await Promise.all([q.apply('L', 't1', { done: true }), q.apply('L', 't1', { done: false })]);
  assert.deepEqual(order, [true, false]);
});

test('削除済みタスク (404) の操作は捨てる', async () => {
  let fail = 'network';
  const q = createQueue({
    persist: false,
    send: async () => {
      throw fail === 'network' ? networkError() : apiError(404, 'Not Found');
    },
  });
  await q.apply('L', 'gone', { done: true });
  assert.equal(q.size(), 1);
  fail = '404';
  await q.flush();
  assert.equal(q.size(), 0);
});

test('Tasks API: 期限はタイムゾーンでずれない / 未完了に戻すと completed を消す', () => {
  const t = normalizeTask({ id: 'x', title: 'a', status: 'needsAction', due: '2026-10-21T00:00:00.000Z' }, 'L');
  assert.equal(t.due, '2026-10-21');
  assert.deepEqual(toApiPatch({ done: false }), { status: 'needsAction', completed: null });
  assert.deepEqual(toApiPatch({ done: true }), { status: 'completed' });
  assert.deepEqual(toApiPatch({ due: '2026-10-21' }), { due: '2026-10-21T00:00:00.000Z' });
  assert.deepEqual(toApiPatch({ due: null }), { due: null });
});
