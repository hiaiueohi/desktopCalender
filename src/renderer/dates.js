// 日付とタスク並べ替えの純粋関数。ブラウザでは window.D、Node (テスト) では module.exports で使う。
(function (root) {
  const pad = (n) => String(n).padStart(2, '0');

  // ローカル日付の 'YYYY-MM-DD'
  const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  const parseKey = (k) => {
    const [y, m, d] = k.split('-').map(Number);
    return new Date(y, m - 1, d);
  };

  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
  const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);

  // 月表示グリッド (6 週 = 42 日) の先頭日
  function gridStart(month, weekStart) {
    const first = startOfMonth(month);
    const offset = (first.getDay() - weekStart + 7) % 7;
    return addDays(first, -offset);
  }

  // 予定がかかる日のキー一覧。終日予定の end は排他的、時間指定は終了時刻ちょうどの日を含めない
  function eventDayKeys(ev, limit = 62) {
    let from;
    let to;
    if (ev.allDay) {
      from = parseKey(ev.start);
      to = addDays(parseKey(ev.end), -1);
    } else {
      const s = new Date(ev.start);
      const e = new Date(Math.max(new Date(ev.end).getTime() - 1, s.getTime()));
      from = new Date(s.getFullYear(), s.getMonth(), s.getDate());
      to = new Date(e.getFullYear(), e.getMonth(), e.getDate());
    }
    const keys = [];
    for (let d = from; d <= to && keys.length < limit; d = addDays(d, 1)) keys.push(keyOf(d));
    if (!keys.length) keys.push(keyOf(from));
    return keys;
  }

  const hhmm = (iso) => {
    const d = new Date(iso);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  // タスクを パネル用のグループに分類する
  function taskGroup(t, todayKey, holdDone) {
    if (t.done && !holdDone) return 'done';
    if (!t.due) return 'nodate';
    if (t.due < todayKey) return 'overdue';
    if (t.due === todayKey) return 'today';
    const today = parseKey(todayKey);
    if (t.due === keyOf(addDays(today, 1))) return 'tomorrow';
    if (t.due <= keyOf(addDays(today, 7))) return 'week';
    return 'later';
  }

  // 期限 → Google 上の並び順 で並べ、サブタスクは親の直後に置く
  function sortTasks(tasks) {
    const cmp = (a, b) =>
      (a.due || '9999') < (b.due || '9999') ? -1
        : (a.due || '9999') > (b.due || '9999') ? 1
        : a.position < b.position ? -1
        : a.position > b.position ? 1
        : 0;
    const ids = new Set(tasks.map((t) => t.id));
    const roots = tasks.filter((t) => !t.parent || !ids.has(t.parent)).sort(cmp);
    const children = new Map();
    for (const t of tasks) {
      if (t.parent && ids.has(t.parent)) {
        if (!children.has(t.parent)) children.set(t.parent, []);
        children.get(t.parent).push(t);
      }
    }
    const out = [];
    for (const r of roots) {
      out.push({ task: r, child: false });
      for (const c of (children.get(r.id) || []).sort((a, b) => (a.position < b.position ? -1 : 1))) {
        out.push({ task: c, child: true });
      }
    }
    return out;
  }

  const api = { pad, keyOf, parseKey, addDays, addMonths, startOfMonth, gridStart, eventDayKeys, hhmm, taskGroup, sortTasks };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.D = api;
})(typeof window !== 'undefined' ? window : globalThis);
