// タスクの変更 (完了チェック・編集) を確実に Google へ届けるための仕組み。
//  - 同じタスクへの操作は直列化し、後から押したチェックが先に届いて状態が逆転するのを防ぐ
//  - オフライン時は操作をディスクに保存し、次回の同期で再送する
//  - 取得したデータに未送信の操作を重ねて返すので、同期してもチェックが元に戻らない
const store = require('./store');

const QUEUE_FILE = 'queue.json';

function createQueue({ send, persist = true }) {
  let ops = persist ? store.readJson(QUEUE_FILE, []) : [];
  const chains = new Map();

  const save = () => {
    if (persist) store.writeJson(QUEUE_FILE, ops);
  };

  function enqueue(listId, taskId, patch) {
    const existing = ops.find((o) => o.listId === listId && o.taskId === taskId);
    // 同じタスクへの未送信操作はまとめる (完了 → 未完了 → 完了 なら最終状態だけ送る)
    if (existing) existing.patch = { ...existing.patch, ...patch };
    else ops.push({ listId, taskId, patch, ts: Date.now() });
    save();
  }

  function drop(listId, taskId) {
    const before = ops.length;
    ops = ops.filter((o) => !(o.listId === listId && o.taskId === taskId));
    if (ops.length !== before) save();
  }

  // 同じタスクに対する処理を順番に実行する
  function serial(taskId, fn) {
    const prev = chains.get(taskId) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    chains.set(taskId, next);
    next.finally(() => {
      if (chains.get(taskId) === next) chains.delete(taskId);
    }).catch(() => {});
    return next;
  }

  // 変更を送る。通信できなければキューに積んで { queued: true } を返す
  function apply(listId, taskId, patch) {
    return serial(taskId, async () => {
      const pending = ops.find((o) => o.listId === listId && o.taskId === taskId);
      const merged = pending ? { ...pending.patch, ...patch } : patch;
      try {
        const task = await send(listId, taskId, merged);
        drop(listId, taskId);
        return { task, queued: false };
      } catch (e) {
        if (e.type === 'network') {
          enqueue(listId, taskId, patch);
          return { queued: true };
        }
        if (e.type === 'api' && (e.status === 404 || e.status === 410)) drop(listId, taskId);
        throw e;
      }
    });
  }

  // 溜まった操作を順に送る。通信できなくなったらそこで止める
  async function flush() {
    for (const op of [...ops]) {
      try {
        await serial(op.taskId, async () => {
          const current = ops.find((o) => o.listId === op.listId && o.taskId === op.taskId);
          if (!current) return;
          await send(current.listId, current.taskId, current.patch);
          drop(current.listId, current.taskId);
        });
      } catch (e) {
        if (e.type === 'network' || e.type === 'auth' || e.type === 'config') return false;
        // 削除済みタスクなど、再送しても成功しない操作は捨てる
        drop(op.listId, op.taskId);
      }
    }
    return true;
  }

  // 取得結果に未送信の変更を上書きして返す
  function overlay(tasks) {
    if (!ops.length) return tasks;
    return tasks.map((t) => {
      const op = ops.find((o) => o.listId === t.listId && o.taskId === t.id);
      return op ? { ...t, ...op.patch, pending: true } : t;
    });
  }

  return { apply, flush, overlay, size: () => ops.length };
}

module.exports = { createQueue };
