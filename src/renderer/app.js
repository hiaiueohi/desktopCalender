'use strict';
/* global D, api */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad2 = (n) => String(n).padStart(2, '0');
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const WD_EN = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTH_EN = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const CHECK_SVG = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const TRASH_SVG = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';
const CHEVRON_SVG = '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';

const S = {
  demo: false,
  signedIn: false,
  expired: false,        // ログイン済みだったが有効期限切れなど (キャッシュは表示したまま再ログインを促す)
  loginBusy: false,
  account: null,
  client: { configured: false },
  config: {},
  view: D.startOfMonth(new Date()),
  selected: D.keyOf(new Date()),
  today: D.keyOf(new Date()),
  tab: 'day',
  calendars: [],
  events: [],
  holidays: {},
  lists: [],
  tasks: [],
  syncing: false,
  syncQueued: false,
  lastSync: null,
  offline: false,
  error: null,
  pending: 0,
  inflight: new Map(),   // taskId → 送信中の件数 (同期で上書きしないため)
  holdDone: new Set(),   // 完了直後、少しの間だけ元の場所に残すタスク
  collapsed: { done: true },
  eventsReq: 0,
  version: '',
};

// ================= 起動 =================
async function boot() {
  const r = await api.init();
  const init = r.data;
  Object.assign(S, {
    demo: init.demo,
    signedIn: init.signedIn,
    config: init.config,
    client: init.client,
    pending: init.pending,
    version: init.version,
  });
  if (init.cache) restoreCache(init.cache);
  if (S.demo) loadDemo();

  applyLook();
  bindUi();
  render();
  startClock();

  // 前回ログインしていれば、起動しただけで自動的に同期する
  if (S.signedIn) {
    syncAll();
    refreshAccount();
  }
  scheduleSync();
}

function applyLook() {
  document.documentElement.dataset.accent = S.config.accent || 'cyan';
  document.documentElement.classList.toggle('fx', S.config.effects !== false);
}

function startClock() {
  const el = $('#clock');
  const tick = () => {
    const now = new Date();
    el.innerHTML = `<span>${pad2(now.getHours())}</span><i>:</i><span>${pad2(now.getMinutes())}</span><i>:</i><span>${pad2(now.getSeconds())}</span>`;
    const key = D.keyOf(now);
    if (key !== S.today) {
      // 日付が変わったら「今日」を更新
      if (S.selected === S.today) S.selected = key;
      S.today = key;
      render();
    }
    setTimeout(tick, 1000 - (Date.now() % 1000));
  };
  tick();
}

let syncTimer = null;
function scheduleSync() {
  clearInterval(syncTimer);
  const min = Number(S.config.syncMinutes) || 5;
  syncTimer = setInterval(() => syncAll({ quiet: true }), min * 60 * 1000);
}

async function refreshAccount() {
  const a = await api.account();
  if (!a.ok) return;
  S.account = a.data;
  saveCache();
  if ($('#settingsDlg').open) renderSettingsAccount();
}

// ================= キャッシュ =================
function restoreCache(c) {
  S.calendars = c.calendars || [];
  S.events = c.events || [];
  S.holidays = c.holidays || {};
  S.lists = c.lists || [];
  S.tasks = c.tasks || [];
  S.account = c.account || null;
  S.lastSync = c.savedAt ? new Date(c.savedAt) : null;
}

function clearData() {
  Object.assign(S, { calendars: [], events: [], holidays: {}, lists: [], tasks: [], lastSync: null });
}

let cacheTimer = null;
function saveCache() {
  if (S.demo || !S.signedIn) return;
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(() => {
    api.saveCache({
      calendars: S.calendars,
      events: S.events,
      holidays: S.holidays,
      lists: S.lists,
      tasks: S.tasks.filter((t) => !t.id.startsWith('tmp-')).map(({ _seq, ...t }) => t),
      account: S.account,
      savedAt: S.lastSync ? S.lastSync.toISOString() : null,
    });
  }, 500);
}

// ================= 同期 =================
function range() {
  const start = D.gridStart(S.view, Number(S.config.weekStart) || 0);
  return { start, end: D.addDays(start, 42) };
}

async function syncAll({ quiet = false } = {}) {
  if (S.demo || !S.signedIn) return;
  if (S.syncing) {
    S.syncQueued = true;
    return;
  }
  S.syncing = true;
  renderStatus();
  const results = await Promise.all([syncTasks(), syncCalendars().then(syncEvents)]);
  S.syncing = false;
  const err = results.find((x) => x && x.error);
  handleSyncResult(err ? err.error : null, quiet);
  render();
  saveCache();
  if (S.syncQueued) {
    S.syncQueued = false;
    syncAll({ quiet: true });
  }
}

function handleSyncResult(error, quiet) {
  if (!error) {
    S.offline = false;
    S.error = null;
    S.lastSync = new Date();
    return;
  }
  if (error.type === 'network') {
    S.offline = true;
  } else if (error.type === 'auth' || error.code === 'no_client') {
    S.signedIn = false;
    S.expired = true;
    S.error = error.message;
  } else {
    S.error = error.message;
    if (!quiet) toast(error.message, { type: 'error' });
  }
}

async function syncCalendars() {
  const r = await api.listCalendars();
  if (!r.ok) return r;
  S.calendars = r.data;
  return null;
}

async function syncEvents(prev) {
  if (prev && prev.error) return prev;
  const reqId = ++S.eventsReq;
  const { start, end } = range();
  const tMin = start.toISOString();
  const tMax = end.toISOString();
  const [ev, hol] = await Promise.all([
    api.listEvents(visibleCalendars(), tMin, tMax),
    S.config.showHolidays ? api.listHolidays(tMin, tMax) : Promise.resolve(null),
  ]);
  // 月を素早く切り替えたときに古い応答で上書きしない
  if (reqId !== S.eventsReq) return null;
  if (!ev.ok) return ev;
  S.events = ev.data.events;
  if (hol && hol.ok) Object.assign(S.holidays, hol.data);
  if (ev.data.failedCalendars.length) console.warn('取得できなかったカレンダー', ev.data.failedCalendars);
  return null;
}

async function syncTasks() {
  const r = await api.fetchTasks();
  if (!r.ok) return r;
  S.lists = r.data.lists;
  S.pending = r.data.pending;
  // 送信中のタスクは画面上の状態を優先する (同期でチェックが戻るのを防ぐ)
  const local = new Map(S.tasks.map((t) => [t.id, t]));
  const fetched = r.data.tasks.map((t) => (S.inflight.get(t.id) ? local.get(t.id) || t : t));
  const tmp = S.tasks.filter((t) => t.id.startsWith('tmp-'));
  S.tasks = [...fetched, ...tmp];
  return null;
}

// ================= ログイン =================
async function startLogin() {
  if (S.demo) return;
  if (!S.client.configured) {
    openSetup();
    return;
  }
  S.loginBusy = true;
  renderLoginState();
  const r = await api.signIn(S.account || null);
  // もう一度押してやり直した場合は、新しいほうの結果を待つ
  if (!r.ok && r.error.type === 'cancelled') return;
  S.loginBusy = false;
  if (!r.ok) {
    if (r.error.code === 'no_client') {
      S.client = { configured: false };
      openSetup();
    } else {
      toast(errorText(r.error, 'ログインできませんでした'), { type: 'error' });
    }
    renderLoginState();
    return;
  }
  const email = r.data.email;
  if (S.account && email && S.account !== email) clearData();
  Object.assign(S, { signedIn: true, expired: false, error: null, account: email || S.account });
  if ($('#setupDlg').open) $('#setupDlg').close();
  render();
  toast(`${email || 'Google アカウント'} でログインしました`, { tag: 'LINK' });
  await syncAll();
}

function renderLoginState() {
  renderGate();
  renderLoginButtons();
}

function renderLoginButtons() {
  $$('[data-login]').forEach((b) => {
    b.textContent = S.loginBusy ? 'ブラウザで許可してください…' : b.dataset.label || 'Google でログイン';
    b.classList.toggle('busy', S.loginBusy);
  });
}

// ---- アプリ登録 (初回セットアップ) ----
let detectTimer = null;

function openSetup() {
  if ($('#settingsDlg').open) $('#settingsDlg').close();
  showDetect(null);
  const dlg = $('#setupDlg');
  if (!dlg.open) dlg.showModal();
  detect();
  clearInterval(detectTimer);
  // Google Cloud で JSON をダウンロードしたら自動で見つける
  detectTimer = setInterval(detect, 2000);
}

async function detect() {
  const r = await api.detectClient();
  if (r.ok && $('#setupDlg').open) showDetect(r.data);
}

function showDetect(d) {
  const found = !!(d && !d.error);
  $('#detectIdle').hidden = found;
  $('#detectFound').hidden = !found;
  $('#detectBad').hidden = !(d && d.error);
  if (found) $('#detectName').textContent = d.name;
  if (d && d.error) $('#detectBad').textContent = `${d.name}：${d.error}`;
}

async function importClient(call) {
  const r = await call();
  if (!r.ok) {
    toast(errorText(r.error, '登録ファイルを読み込めませんでした'), { type: 'error' });
    return;
  }
  if (!r.data) return; // ファイル選択をキャンセル
  const { signedOut, ...info } = r.data;
  S.client = info;
  if (signedOut) {
    clearData();
    Object.assign(S, { signedIn: false, expired: false, account: null });
  }
  if ($('#setupDlg').open) $('#setupDlg').close();
  toast('アプリの登録ファイルを読み込みました', { tag: 'SETUP' });
  render();
  if (!S.signedIn) startLogin();
}

// ================= 表示対象 =================
function visibleCalendars() {
  const hidden = S.config.hiddenCalendars;
  return S.calendars.filter((c) => (hidden ? !hidden.includes(c.id) : c.selected));
}

function visibleTasks() {
  const hidden = S.config.hiddenTaskLists || [];
  return S.tasks.filter((t) => !hidden.includes(t.listId));
}

function listName(id) {
  const l = S.lists.find((x) => x.id === id);
  return l ? l.title : '';
}

function dayIndex(start) {
  const idx = new Map();
  for (let i = 0; i < 42; i++) idx.set(D.keyOf(D.addDays(start, i)), { events: [], tasks: [] });
  const shown = new Set(visibleCalendars().map((c) => c.id));
  for (const ev of S.events) {
    if (!S.demo && !shown.has(ev.calendarId)) continue;
    for (const k of D.eventDayKeys(ev)) if (idx.has(k)) idx.get(k).events.push(ev);
  }
  for (const t of visibleTasks()) {
    if (!t.due || !idx.has(t.due)) continue;
    if (t.done && !S.config.showCompletedInCalendar && !S.holdDone.has(t.id)) continue;
    idx.get(t.due).tasks.push(t);
  }
  for (const v of idx.values()) {
    v.events.sort(eventCmp);
    v.tasks.sort((a, b) => doneRank(a) - doneRank(b) || (a.position < b.position ? -1 : 1));
  }
  return idx;
}

const doneRank = (t) => (t.done && !S.holdDone.has(t.id) ? 1 : 0);

function eventCmp(a, b) {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  if (a.start !== b.start) return a.start < b.start ? -1 : 1;
  return a.title.localeCompare(b.title);
}

// ================= 描画 =================
function render() {
  renderHeader();
  renderBanner();
  renderGate();
  renderGrid();
  renderPanel();
  renderStatus();
  renderQuickAddLists();
  renderLoginButtons();
  if ($('#settingsDlg').open) renderSettingsAccount();
}

function renderHeader() {
  const y = S.view.getFullYear();
  const m = S.view.getMonth();
  $('#monthTitle').innerHTML = `<span class="y">${y}</span><span class="sep">.</span><span class="m">${pad2(m + 1)}</span><small>${MONTH_EN[m]}</small>`;
  $('#pinBtn').classList.toggle('active', !!S.config.alwaysOnTop);
  $('#syncBtn').classList.toggle('spinning', S.syncing);
  $('#syncBtn').disabled = S.demo || !S.signedIn;
  const ws = Number(S.config.weekStart) || 0;
  $('#weekdays').innerHTML = Array.from({ length: 7 }, (_, i) => {
    const d = (i + ws) % 7;
    return `<div class="${d === 0 ? 'sun' : d === 6 ? 'sat' : ''}">${WD_EN[d]}<small>${WD[d]}</small></div>`;
  }).join('');
}

function renderBanner() {
  const b = $('#banner');
  b.className = 'banner';
  if (S.demo) {
    b.innerHTML = '<span class="tag">DEMO MODE</span>サンプルデータで表示中です。チェックや追加はこのウィンドウ内だけで動作します。';
  } else if (S.expired) {
    b.classList.add('error');
    b.innerHTML = `<span class="tag">LINK LOST</span>${esc(S.error || 'ログインの有効期限が切れました')}
      <button data-login data-label="Google で再ログイン">Google で再ログイン</button>`;
  } else {
    b.hidden = true;
    return;
  }
  b.hidden = false;
}

function renderGate() {
  const show = !S.demo && !S.signedIn && !S.expired;
  $('#gate').hidden = !show;
  if (!show) return;
  $('#gateNote').textContent = S.loginBusy
    ? 'ブラウザで Google アカウントを選び「許可」を押してください（もう一度押すとやり直せます）'
    : S.client.configured
      ? ''
      : '最初の 1 回だけ、アプリを Google に登録する手順があります（約 3 分）';
}

function renderGrid() {
  const grid = $('#grid');
  const ws = Number(S.config.weekStart) || 0;
  const start = D.gridStart(S.view, ws);
  const idx = dayIndex(start);
  const rowH = grid.clientHeight / 6;
  const slots = rowH > 0 ? Math.max(1, Math.floor((rowH - 30) / 20)) : 3;
  const month = S.view.getMonth();
  const overdueCount = visibleTasks().filter((t) => !t.done && t.due && t.due < S.today).length;

  let html = '';
  for (let i = 0; i < 42; i++) {
    const d = D.addDays(start, i);
    const k = D.keyOf(d);
    const { events, tasks } = idx.get(k);
    const hol = S.config.showHolidays ? S.holidays[k] : null;
    const overdue = k === S.today ? overdueCount : 0;
    const cls = [
      'cell',
      d.getMonth() !== month && 'other',
      d.getDay() === 0 && 'sun',
      d.getDay() === 6 && 'sat',
      hol && 'holiday',
      k === S.today && 'today',
      k === S.selected && 'selected',
    ].filter(Boolean).join(' ');

    const items = [...events.map((ev) => eventChip(ev, k)), ...tasks.map((t) => taskChip(t))];
    const visible = items.length > slots ? items.slice(0, slots - 1) : items;
    const more = items.length - visible.length;

    html += `<div class="${cls}" data-day="${k}">
      <div class="cell-head"><span class="num">${pad2(d.getDate())}</span>${hol ? `<span class="holiday-name" title="${esc(hol)}">${esc(hol)}</span>` : ''}${overdue ? `<span class="badge" title="期限切れのタスク">▲期限切れ ${overdue}</span>` : ''}</div>
      ${visible.join('')}
      ${more > 0 ? `<div class="chip more" data-more="${k}">+${more} MORE</div>` : ''}
    </div>`;
  }
  grid.innerHTML = html;
}

function eventChip(ev, dayKey) {
  const showTime = !ev.allDay && D.keyOf(new Date(ev.start)) === dayKey;
  return `<div class="chip ev ${ev.allDay ? 'allday' : ''}" style="--c:${esc(ev.color)}" data-event="${esc(ev.id)}" title="${esc(eventTooltip(ev))}">
    ${showTime ? `<span class="time">${D.hhmm(ev.start)}</span>` : ''}<span class="label">${esc(ev.title)}</span></div>`;
}

function eventTooltip(ev) {
  const when = ev.allDay ? '終日' : `${D.hhmm(ev.start)}–${D.hhmm(ev.end)}`;
  return `${when} ${ev.title}${ev.location ? `\n${ev.location}` : ''}`;
}

function taskChip(t) {
  const cls = [
    'chip',
    'task',
    t.done && 'done',
    !t.done && t.due < S.today && 'overdue',
    S.holdDone.has(t.id) && 'just-done',
  ].filter(Boolean).join(' ');
  return `<div class="${cls}" data-task="${esc(t.id)}" title="${esc(t.title)}${t.notes ? `\n${esc(t.notes)}` : ''}">
    <button class="check-btn" data-check="${esc(t.id)}" aria-label="${t.done ? '未完了に戻す' : '完了にする'}" ${t.id.startsWith('tmp-') ? 'disabled' : ''}>${CHECK_SVG}</button>
    <span class="label">${esc(t.title)}</span></div>`;
}

function renderPanel() {
  const active = visibleTasks().filter((t) => !t.done).length;
  $$('.tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === S.tab);
    b.innerHTML = b.dataset.tab === 'day'
      ? '<span class="en">DAY</span>選択した日'
      : `<span class="en">TASKS</span>すべてのタスク<span class="count">${pad2(active)}</span>`;
  });
  const body = $('#panelBody');
  const scroll = body.scrollTop;
  body.innerHTML = S.tab === 'day' ? dayPanel() : tasksPanel();
  body.scrollTop = scroll;
}

function groupTitle(en, ja, n, cls = '') {
  return `<div class="group-title ${cls}"><span class="en">${en}</span>${ja}<span class="n">${pad2(n)}</span></div>`;
}

function dayPanel() {
  const d = D.parseKey(S.selected);
  const hol = S.config.showHolidays ? S.holidays[S.selected] : null;
  const inGrid = dayIndex(D.gridStart(S.view, Number(S.config.weekStart) || 0)).get(S.selected);
  const events = inGrid ? inGrid.events : S.events.filter((ev) => D.eventDayKeys(ev).includes(S.selected)).sort(eventCmp);
  const tasks = visibleTasks().filter((t) => t.due === S.selected);
  const overdue = S.selected === S.today ? visibleTasks().filter((t) => !t.done && t.due && t.due < S.today) : [];
  const linked = S.signedIn || S.demo;

  let html = `<div class="day-head">
    <span class="day-num">${pad2(d.getDate())}</span>
    <div class="day-meta">
      <span class="day-ym">${d.getFullYear()}.${pad2(d.getMonth() + 1)} · ${WD_EN[d.getDay()]}</span>
      <span class="day-ja">${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）</span>
    </div>
    <div class="pills">${S.selected === S.today ? '<span class="pill">TODAY</span>' : ''}${hol ? `<span class="hol">${esc(hol)}</span>` : ''}</div>
  </div>`;

  if (tasks.length) {
    const done = tasks.filter((t) => t.done).length;
    html += `<div class="progress">
      <div class="progress-label"><span>COMPLETION</span><span><b>${done}</b> / ${tasks.length}</span></div>
      <div class="bar"><div style="width:${(done / tasks.length) * 100}%"></div></div>
    </div>`;
  }

  html += `<div class="group">${groupTitle('EVENTS', '予定', events.length)}`;
  html += events.length
    ? events.map((ev) => eventRow(ev)).join('')
    : `<div class="empty">${linked ? '予定はありません' : 'Google にログインすると予定が表示されます'}</div>`;
  html += '</div>';

  if (overdue.length) {
    html += `<div class="group">${groupTitle('OVERDUE', '期限切れ', overdue.length, 'overdue')}
      ${D.sortTasks(overdue).map(({ task, child }) => taskRow(task, child)).join('')}</div>`;
  }

  const sorted = [...D.sortTasks(tasks.filter((t) => !doneRank(t))), ...D.sortTasks(tasks.filter((t) => doneRank(t)))];
  html += `<div class="group">${groupTitle('TASKS', 'タスク', tasks.filter((t) => !t.done).length)}`;
  html += sorted.length
    ? sorted.map(({ task, child }) => taskRow(task, child)).join('')
    : `<div class="empty">${linked ? 'この日が期限のタスクはありません。下の欄から追加できます。' : 'Google にログインするとタスクが表示されます'}</div>`;
  html += '</div>';
  return html;
}

function eventRow(ev) {
  let when = 'ALL DAY';
  if (!ev.allDay) {
    const sameDay = D.keyOf(new Date(ev.start)) === D.keyOf(new Date(ev.end));
    when = sameDay ? `${D.hhmm(ev.start)}–${D.hhmm(ev.end)}` : `${D.hhmm(ev.start)} →`;
  }
  return `<div class="event-row" style="--c:${esc(ev.color)}" data-event="${esc(ev.id)}">
    <span class="bar"></span><span class="when">${when}</span>
    <div class="what"><div class="title">${esc(ev.title)}</div>${ev.location ? `<div class="loc">${esc(ev.location)}</div>` : ''}</div></div>`;
}

const GROUPS = [
  ['overdue', 'OVERDUE', '期限切れ'],
  ['today', 'TODAY', '今日'],
  ['tomorrow', 'TOMORROW', '明日'],
  ['week', 'NEXT 7 DAYS', '今後 7 日間'],
  ['later', 'LATER', 'それ以降'],
  ['nodate', 'NO DATE', '期限なし'],
  ['done', 'COMPLETED', '完了済み'],
];

function tasksPanel() {
  const all = visibleTasks();
  if (!all.length) {
    return `<div class="empty">${S.signedIn || S.demo ? 'タスクはありません。下の欄から追加できます。' : 'Google にログインすると ToDo リストのタスクが表示されます'}</div>`;
  }
  const groups = Object.fromEntries(GROUPS.map(([k]) => [k, []]));
  for (const t of all) groups[D.taskGroup(t, S.today, S.holdDone.has(t.id))].push(t);
  groups.done.sort((a, b) => ((a.completedAt || '') > (b.completedAt || '') ? -1 : 1));

  let html = '';
  for (const [key, en, ja] of GROUPS) {
    const list = groups[key];
    if (!list.length && key !== 'today') continue;
    if (key === 'done') {
      const collapsed = S.collapsed.done;
      html += `<div class="group"><button type="button" class="group-title ${collapsed ? 'collapsed' : ''}" data-toggle-group="done">
        ${CHEVRON_SVG}<span class="en">${en}</span>${ja}<span class="n">${pad2(list.length)}</span></button>
        ${collapsed ? '' : list.slice(0, 50).map((t) => taskRow(t, false)).join('')}</div>`;
      continue;
    }
    const rows = list.length
      ? D.sortTasks(list).map(({ task, child }) => taskRow(task, child)).join('')
      : '<div class="empty">今日が期限のタスクはありません</div>';
    html += `<div class="group">${groupTitle(en, ja, list.length, key === 'overdue' ? 'overdue' : '')}${rows}</div>`;
  }
  return html;
}

function dueLabel(due) {
  if (!due) return '';
  if (due === S.today) return '今日';
  if (due === D.keyOf(D.addDays(D.parseKey(S.today), 1))) return '明日';
  const d = D.parseKey(due);
  const y = d.getFullYear() !== D.parseKey(S.today).getFullYear() ? `${d.getFullYear()}.` : '';
  return `${y}${pad2(d.getMonth() + 1)}.${pad2(d.getDate())} ${WD_EN[d.getDay()]}`;
}

function taskRow(t, child) {
  const overdue = !t.done && t.due && t.due < S.today;
  const cls = ['task-row', t.done && 'done', child && 'child', S.holdDone.has(t.id) && 'just-done'].filter(Boolean).join(' ');
  const meta = [
    t.due ? `<span class="due ${overdue ? 'overdue' : t.due === S.today ? 'today' : ''}">${overdue ? '▲ ' : ''}${dueLabel(t.due)}</span>` : '',
    S.lists.length > 1 ? `<span>${esc(listName(t.listId))}</span>` : '',
    t.pending ? '<span class="sync-flag" title="Google への送信待ち">◆ 未送信</span>' : '',
  ].filter(Boolean).join('');
  return `<div class="${cls}" data-task="${esc(t.id)}">
    <button class="check-btn" data-check="${esc(t.id)}" aria-label="${t.done ? '未完了に戻す' : '完了にする'}" ${t.id.startsWith('tmp-') ? 'disabled' : ''}>${CHECK_SVG}</button>
    <div class="main" data-edit="${esc(t.id)}">
      <div class="title">${esc(t.title)}</div>
      ${t.notes ? `<div class="notes">${esc(t.notes)}</div>` : ''}
      ${meta ? `<div class="meta">${meta}</div>` : ''}
    </div>
    <button class="del" data-delete="${esc(t.id)}" title="削除">${TRASH_SVG}</button>
  </div>`;
}

function renderStatus() {
  const el = $('#status');
  let cls = 'status';
  let text;
  let tip;
  if (S.demo) {
    cls += ' demo';
    text = 'DEMO MODE';
    tip = 'サンプルデータで表示中';
  } else if (!S.signedIn) {
    cls += ' error';
    text = S.expired ? 'LINK LOST' : 'NOT LINKED';
    tip = S.expired ? 'ログインの有効期限が切れています' : 'Google にログインしていません';
  } else if (S.syncing) {
    text = 'SYNCING…';
    tip = '同期中';
  } else if (S.offline) {
    cls += ' offline';
    text = `NO SIGNAL${S.pending ? ` · 未送信 ${S.pending}` : ''}`;
    tip = 'オフラインです。つながったら自動で送信します';
  } else if (S.error) {
    cls += ' error';
    text = 'SYNC ERROR';
    tip = S.error;
  } else {
    text = `ONLINE${S.lastSync ? ` · ${D.hhmm(S.lastSync.toISOString())}` : ''}${S.pending ? ` · 未送信 ${S.pending}` : ''}`;
    tip = `${S.account || ''}${S.lastSync ? ` / ${D.hhmm(S.lastSync.toISOString())} に同期` : ''}`;
  }
  el.className = cls;
  el.innerHTML = `<span class="dot"></span>${esc(text)}`;
  el.title = tip;
  $('#syncBtn').classList.toggle('spinning', S.syncing);
}

function renderQuickAddLists() {
  const sel = $('#qaList');
  const lists = S.lists.filter((l) => !(S.config.hiddenTaskLists || []).includes(l.id));
  const current = sel.value || S.config.defaultTaskList;
  sel.innerHTML = lists.map((l) => `<option value="${esc(l.id)}">${esc(l.title)}</option>`).join('');
  if (lists.some((l) => l.id === current)) sel.value = current;
  sel.disabled = !lists.length;
  $('#quickAdd').querySelector('button[type=submit]').disabled = !lists.length;
  $('#qaTitle').disabled = !lists.length;
}

// ================= タスク操作 =================
function findTask(id) {
  return S.tasks.find((t) => t.id === id);
}

async function toggleTask(id, { fromUndo = false } = {}) {
  const t = findTask(id);
  if (!t || t.id.startsWith('tmp-')) return;
  const snapshot = { done: t.done, completedAt: t.completedAt };
  const next = !t.done;
  t.done = next;
  t.completedAt = next ? new Date().toISOString() : null;

  if (next) {
    S.holdDone.add(t.id);
    setTimeout(() => {
      S.holdDone.delete(t.id);
      render();
    }, 1500);
  } else {
    S.holdDone.delete(t.id);
  }
  render();

  if (!fromUndo) {
    toast(next ? `「${t.title}」を完了しました` : `「${t.title}」を未完了に戻しました`, {
      type: next ? 'done' : 'info',
      tag: next ? 'DONE' : 'REOPEN',
      action: 'UNDO',
      onAction: () => toggleTask(id, { fromUndo: true }),
    });
  }
  await pushPatch(t, { done: next }, snapshot);
}

// 楽観的に反映済みの変更を Google に送る。失敗したら snapshot に戻す
async function pushPatch(t, patch, snapshot) {
  if (S.demo) return;
  const seq = (t._seq = (t._seq || 0) + 1);
  S.inflight.set(t.id, (S.inflight.get(t.id) || 0) + 1);
  t.pending = true;
  renderPanel();

  const r = await api.updateTask(t.listId, t.id, patch);

  const n = S.inflight.get(t.id) - 1;
  if (n > 0) S.inflight.set(t.id, n);
  else S.inflight.delete(t.id);

  const cur = findTask(t.id);
  if (!cur) return;
  if (r.ok) {
    S.pending = r.data.pending;
    if (r.data.queued) {
      S.offline = true;
      cur.pending = true;
    } else if (seq === cur._seq) {
      // 最後に押した操作の応答だけを反映する
      Object.assign(cur, r.data.task, { pending: false });
      if (S.offline) {
        S.offline = false;
        syncAll({ quiet: true });
      }
    }
  } else {
    if (seq === cur._seq) Object.assign(cur, snapshot, { pending: false });
    toast(errorText(r.error, '変更を保存できませんでした'), { type: 'error' });
    if (r.error.type === 'auth') {
      S.signedIn = false;
      S.expired = true;
      S.error = r.error.message;
    }
  }
  render();
  saveCache();
}

async function addTask(title, due, listId) {
  const tmp = {
    id: `tmp-${Date.now()}`,
    listId,
    title,
    notes: '',
    due: due || null,
    done: false,
    completedAt: null,
    parent: null,
    position: '',
    pending: true,
  };
  S.tasks.push(tmp);
  render();
  if (S.demo) {
    tmp.id = `demo-${Date.now()}`;
    tmp.pending = false;
    render();
    return;
  }
  const r = await api.createTask(listId, { title, due: due || null });
  const i = S.tasks.indexOf(tmp);
  if (r.ok) S.tasks.splice(i, 1, r.data);
  else {
    S.tasks.splice(i, 1);
    toast(errorText(r.error, 'タスクを追加できませんでした'), { type: 'error' });
  }
  render();
  saveCache();
}

async function deleteTask(id) {
  const t = findTask(id);
  if (!t) return;
  const i = S.tasks.indexOf(t);
  // サブタスクも Google 側で一緒に消えるので画面からも外す
  const removed = S.tasks.filter((x) => x.id === id || x.parent === id);
  S.tasks = S.tasks.filter((x) => !removed.includes(x));
  render();
  if (S.demo) {
    toast(`「${t.title}」を削除しました`, { tag: 'DELETE' });
    return;
  }
  const r = await api.deleteTask(t.listId, t.id);
  if (r.ok) toast(`「${t.title}」を削除しました`, { tag: 'DELETE' });
  else {
    S.tasks.splice(Math.min(i, S.tasks.length), 0, ...removed);
    toast(errorText(r.error, '削除できませんでした'), { type: 'error' });
  }
  render();
  saveCache();
}

function errorText(err, fallback) {
  if (!err) return fallback;
  if (err.type === 'network') return `${fallback}（オフラインです）`;
  return `${fallback}：${err.message}`;
}

// ================= タスク編集ダイアログ =================
let editingId = null;
function openTaskDialog(id) {
  const t = findTask(id);
  if (!t || t.id.startsWith('tmp-')) return;
  editingId = id;
  const f = $('#taskForm').elements;
  f.title.value = t.title;
  f.notes.value = t.notes || '';
  f.due.value = t.due || '';
  f.list.value = listName(t.listId);
  $('#taskDlg').showModal();
  f.title.focus();
}

function onTaskDialogClose() {
  const dlg = $('#taskDlg');
  const t = findTask(editingId);
  if (dlg.returnValue === 'save' && t) {
    const f = $('#taskForm').elements;
    const patch = {};
    const title = f.title.value.trim();
    if (title && title !== t.title) patch.title = title;
    if (f.notes.value !== (t.notes || '')) patch.notes = f.notes.value;
    if ((f.due.value || null) !== t.due) patch.due = f.due.value || null;
    if (Object.keys(patch).length) {
      const snapshot = Object.fromEntries(Object.keys(patch).map((k) => [k, t[k]]));
      Object.assign(t, patch);
      render();
      pushPatch(t, patch, snapshot);
    }
  }
  dlg.returnValue = '';
  editingId = null;
}

// ================= 設定ダイアログ =================
function openSettings() {
  const f = $('#settingsForm').elements;
  const c = S.config;
  f.accent.value = c.accent || 'cyan';
  f.weekStart.value = String(c.weekStart || 0);
  f.opacity.value = String(c.opacity || 1);
  f.syncMinutes.value = String(c.syncMinutes || 5);
  for (const k of ['showHolidays', 'showCompletedInCalendar', 'alwaysOnTop', 'closeToTray', 'openAtLogin']) f[k].checked = !!c[k];
  f.effects.checked = c.effects !== false;
  $('#versionInfo').textContent = `DESKTOP//CAL v${S.version}`;
  renderSettingsAccount();
  $('#settingsDlg').showModal();
}

function renderSettingsAccount() {
  const live = S.signedIn && !S.demo;
  $('#accountStatus').innerHTML = S.demo
    ? '<span class="bad-tag">DEMO</span>デモモードです（npm start で通常起動するとログインできます）'
    : live
      ? `<span class="ok-tag">ONLINE</span>${esc(S.account || 'Google アカウント')}`
      : S.expired
        ? '<span class="bad-tag">EXPIRED</span>再ログインが必要です'
        : '<span class="bad-tag">OFFLINE</span>ログインしていません';
  $('#loginBtn').hidden = live || S.demo;
  $('#logoutBtn').hidden = !live;

  const c = S.client;
  $('#clientInfo').innerHTML = S.demo
    ? ''
    : c.configured
      ? `アプリ登録：${c.source === 'bundled' ? 'アプリに同梱' : '登録済み'}（${esc(c.clientId.slice(0, 14))}…） <button type="button" class="link" data-setup>登録をやり直す</button>`
      : 'アプリ登録：未登録 <button type="button" class="link" data-setup>登録する（初回のみ）</button>';

  $('#calSection').hidden = !S.calendars.length;
  $('#listSection').hidden = !S.lists.length;
  const shown = new Set(visibleCalendars().map((x) => x.id));
  $('#calList').innerHTML = S.calendars
    .map((x) => `<label><input type="checkbox" data-cal="${esc(x.id)}" ${shown.has(x.id) ? 'checked' : ''}>
      <span class="swatch" style="--c:${esc(x.color)}"></span>${esc(x.title)}</label>`)
    .join('');
  const hiddenLists = S.config.hiddenTaskLists || [];
  $('#taskListList').innerHTML = S.lists
    .map((l) => `<label><input type="checkbox" data-list="${esc(l.id)}" ${hiddenLists.includes(l.id) ? '' : 'checked'}>${esc(l.title)}</label>`)
    .join('');
  $('#defaultListSel').innerHTML = S.lists.map((l) => `<option value="${esc(l.id)}">${esc(l.title)}</option>`).join('');
  if (S.config.defaultTaskList) $('#defaultListSel').value = S.config.defaultTaskList;
  renderLoginButtons();
}

async function setConfig(patch) {
  const r = await api.setConfig(patch);
  if (r.ok) S.config = r.data;
  return r;
}

async function onSettingsChange(e) {
  const el = e.target;
  if (el.dataset.cal) {
    const hidden = S.calendars.filter((c) => {
      const box = $(`#calList input[data-cal="${CSS.escape(c.id)}"]`);
      return box && !box.checked;
    }).map((c) => c.id);
    await setConfig({ hiddenCalendars: hidden });
    render();
    syncAll({ quiet: true });
    return;
  }
  if (el.dataset.list) {
    const hidden = $$('#taskListList input').filter((b) => !b.checked).map((b) => b.dataset.list);
    await setConfig({ hiddenTaskLists: hidden });
    render();
    return;
  }
  const name = el.name;
  if (!name) return;
  let value = el.type === 'checkbox' ? el.checked : el.value;
  if (['weekStart', 'syncMinutes', 'opacity'].includes(name)) value = Number(value);
  await setConfig({ [name]: value });
  if (name === 'accent' || name === 'effects') applyLook();
  if (name === 'syncMinutes') scheduleSync();
  if (name === 'weekStart' || name === 'showHolidays') syncAll({ quiet: true });
  render();
}

async function logout() {
  if (!confirm('ログアウトしますか？（Google 上のデータは消えません）')) return;
  await api.signOut();
  clearData();
  Object.assign(S, { signedIn: false, expired: false, account: null, error: null });
  render();
}

// ================= トースト =================
function toast(message, { type = 'info', tag, action, onAction, ms = 5000 } = {}) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const label = tag || (type === 'error' ? 'ERROR' : type === 'done' ? 'DONE' : 'SYS');
  el.innerHTML = `<span class="tag">[${esc(label)}]</span><span class="msg">${esc(message)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
  const remove = () => el.remove();
  if (action) {
    el.querySelector('button').addEventListener('click', () => {
      remove();
      onAction();
    });
  }
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(remove, ms);
}

// ================= ナビゲーション =================
function goMonth(delta) {
  S.view = D.addMonths(S.view, delta);
  render();
  if (S.demo || !S.signedIn) return;
  syncEvents().then((r) => {
    if (r && r.error) handleSyncResult(r.error, true);
    render();
    saveCache();
  });
}

function goToday() {
  const now = new Date();
  const changed = D.startOfMonth(now).getTime() !== S.view.getTime();
  S.view = D.startOfMonth(now);
  S.selected = D.keyOf(now);
  S.tab = 'day';
  if (changed) goMonth(0);
  else render();
}

function selectDay(key) {
  S.selected = key;
  S.tab = 'day';
  $('#qaDue').value = key;
  const d = D.parseKey(key);
  if (d.getFullYear() !== S.view.getFullYear() || d.getMonth() !== S.view.getMonth()) {
    S.view = D.startOfMonth(d);
    goMonth(0);
    return;
  }
  render();
}

function openEvent(id) {
  const ev = S.events.find((e) => e.id === id);
  if (ev && ev.link) api.openExternal(ev.link);
}

// ================= イベント登録 =================
function bindUi() {
  $('#qaDue').value = S.selected;
  $('#prevBtn').addEventListener('click', () => goMonth(-1));
  $('#nextBtn').addEventListener('click', () => goMonth(1));
  $('#todayBtn').addEventListener('click', goToday);
  $('#syncBtn').addEventListener('click', () => syncAll());
  $('#pinBtn').addEventListener('click', async () => {
    await setConfig({ alwaysOnTop: !S.config.alwaysOnTop });
    renderHeader();
  });
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#minBtn').addEventListener('click', () => api.minimize());
  $('#maxBtn').addEventListener('click', () => api.toggleMaximize());
  $('#closeBtn').addEventListener('click', () => api.close());
  $('.titlebar').addEventListener('dblclick', (e) => {
    if (!e.target.closest('button')) api.toggleMaximize();
  });

  $$('.tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      S.tab = b.dataset.tab;
      renderPanel();
    })
  );

  document.addEventListener('click', (e) => {
    const check = e.target.closest('[data-check]');
    if (check) {
      e.stopPropagation();
      toggleTask(check.dataset.check);
      return;
    }
    if (e.target.closest('[data-login]')) return startLogin();
    if (e.target.closest('[data-setup]')) return openSetup();
    const link = e.target.closest('[data-url]');
    if (link) return api.openExternal(link.dataset.url);
    const del = e.target.closest('[data-delete]');
    if (del) return deleteTask(del.dataset.delete);
    const edit = e.target.closest('[data-edit]');
    if (edit) return openTaskDialog(edit.dataset.edit);
    const grp = e.target.closest('[data-toggle-group]');
    if (grp) {
      S.collapsed[grp.dataset.toggleGroup] = !S.collapsed[grp.dataset.toggleGroup];
      return renderPanel();
    }

    const evEl = e.target.closest('[data-event]');
    const cell = e.target.closest('.cell');
    if (evEl && !cell) return openEvent(evEl.dataset.event);
    if (cell) {
      const chipTask = e.target.closest('.chip.task');
      selectDay(cell.dataset.day);
      if (chipTask) openTaskDialog(chipTask.dataset.task);
    }
  });

  $('#grid').addEventListener('dblclick', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell || e.target.closest('.chip')) return;
    selectDay(cell.dataset.day);
    $('#qaTitle').focus();
  });

  $('#quickAdd').addEventListener('submit', (e) => {
    e.preventDefault();
    const title = $('#qaTitle').value.trim();
    const listId = $('#qaList').value;
    if (!title || !listId) return;
    addTask(title, $('#qaDue').value, listId);
    $('#qaTitle').value = '';
  });

  // ダイアログ
  $('#taskDlg').addEventListener('close', onTaskDialogClose);
  $('#taskCancel').addEventListener('click', () => $('#taskDlg').close('cancel'));
  $('#taskDelete').addEventListener('click', () => {
    const id = editingId;
    $('#taskDlg').close();
    if (id) deleteTask(id);
  });
  $('#settingsForm').addEventListener('change', onSettingsChange);
  $('#settingsForm').elements.opacity.addEventListener('input', (e) => setConfig({ opacity: Number(e.target.value) }));
  $('#logoutBtn').addEventListener('click', logout);
  $('#setupDlg').addEventListener('close', () => clearInterval(detectTimer));
  $('#useDetected').addEventListener('click', () => importClient(() => api.useDetectedClient()));
  $('#pickJson').addEventListener('click', () => importClient(() => api.importClientDialog()));
  $('#manualSave').addEventListener('click', () => {
    const id = $('#manualId').value.trim();
    const secret = $('#manualSecret').value.trim();
    if (!id || !secret) {
      toast('クライアント ID とシークレットを入力してください', { type: 'error' });
      return;
    }
    importClient(() => api.saveClientManual(id, secret));
  });

  // Google Cloud でダウンロードした JSON をウィンドウにドロップすると、読み込んでそのままログインする
  let veilTimer = null;
  const hideVeil = () => {
    $('#dropveil').hidden = true;
    $('#dropzone').classList.remove('over');
  };
  document.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (S.demo) return;
    if ($('#setupDlg').open) $('#dropzone').classList.add('over');
    else $('#dropveil').hidden = false;
    clearTimeout(veilTimer);
    veilTimer = setTimeout(hideVeil, 200);
  });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    hideVeil();
    const file = e.dataTransfer && e.dataTransfer.files[0];
    if (!file || S.demo) return;
    if (!/\.json$/i.test(file.name)) {
      toast('Google Cloud でダウンロードした JSON ファイルをドロップしてください', { type: 'error' });
      return;
    }
    if (S.signedIn && !confirm('アプリの登録ファイルを読み込み直します。別の登録に切り替わる場合はいったんログアウトします。続けますか？')) return;
    const text = await file.text();
    importClient(() => api.importClientText(text));
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select, dialog')) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === 'ArrowLeft') goMonth(-1);
    else if (e.key === 'ArrowRight') goMonth(1);
    else if (e.key === 't' || e.key === 'T') goToday();
    else if (e.key === 'r' || e.key === 'R') syncAll();
    else if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      $('#qaTitle').focus();
    }
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderGrid, 80);
  });
  window.addEventListener('online', () => syncAll({ quiet: true }));
  window.addEventListener('focus', () => {
    if (S.lastSync && Date.now() - S.lastSync.getTime() > 60 * 1000) syncAll({ quiet: true });
    if ($('#setupDlg').open) detect();
  });

  api.on('sync-request', () => syncAll());
  api.on('auth-changed', ({ signedIn }) => {
    if (!signedIn && S.signedIn) {
      S.signedIn = false;
      S.expired = true;
      S.error = 'ログインの有効期限が切れました';
      render();
    }
  });
}

// ================= デモデータ =================
function loadDemo() {
  const t = D.parseKey(S.today);
  const k = (n) => D.keyOf(D.addDays(t, n));
  const at = (n, h, m = 0) => {
    const d = D.addDays(t, n);
    d.setHours(h, m);
    return d.toISOString();
  };
  S.calendars = [
    { id: 'work', title: '仕事', color: '#039be5', selected: true },
    { id: 'home', title: 'プライベート', color: '#33b679', selected: true },
  ];
  S.events = [
    { id: 'e1', calendarId: 'work', title: '定例ミーティング', allDay: false, start: at(0, 10), end: at(0, 11), color: '#039be5', location: '会議室 A' },
    { id: 'e2', calendarId: 'work', title: '1on1', allDay: false, start: at(0, 15, 30), end: at(0, 16), color: '#7986cb' },
    { id: 'e3', calendarId: 'home', title: '歯医者', allDay: false, start: at(2, 18), end: at(2, 19), color: '#33b679' },
    { id: 'e4', calendarId: 'work', title: '出張（大阪）', allDay: true, start: k(5), end: k(8), color: '#f4511e' },
    { id: 'e5', calendarId: 'work', title: 'リリース', allDay: true, start: k(-3), end: k(-2), color: '#8e24aa' },
    { id: 'e6', calendarId: 'home', title: 'ジム', allDay: false, start: at(-1, 19), end: at(-1, 20), color: '#33b679' },
    { id: 'e7', calendarId: 'work', title: '企画レビュー', allDay: false, start: at(1, 13), end: at(1, 14), color: '#039be5' },
  ];
  S.lists = [
    { id: 'L1', title: 'マイタスク' },
    { id: 'L2', title: '買い物' },
  ];
  const task = (id, title, due, listId = 'L1', extra = {}) => ({
    id, listId, title, notes: '', due, done: false, completedAt: null, parent: null, position: id, ...extra,
  });
  S.tasks = [
    task('t1', '経費精算を提出する', k(-2)),
    task('t2', '週報を書く', k(0), 'L1', { notes: '先週の数字を入れる' }),
    task('t3', '資料のレビュー', k(0)),
    task('t3a', 'グラフの差し替え', k(0), 'L1', { parent: 't3' }),
    task('t4', '牛乳を買う', k(0), 'L2'),
    task('t5', '請求書の確認', k(1)),
    task('t6', '旅費の申請', k(3)),
    task('t7', '本を返却する', k(12), 'L2'),
    task('t8', 'いつかやる：机の整理', null),
    task('t9', '会議室の予約', k(-1), 'L1', { done: true, completedAt: new Date().toISOString() }),
  ];
  S.holidays = {};
}

boot();
