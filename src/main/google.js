// Google Calendar / Tasks REST API の薄いクライアント。
// 401 は 1 度だけトークンを更新して再試行し、通信不能は network エラーとして区別する。
const auth = require('./auth');
const { networkError, apiError } = require('./errors');

const CAL = 'https://www.googleapis.com/calendar/v3';
const TASKS = 'https://tasks.googleapis.com/tasks/v1';
const HOLIDAY_CALENDAR = 'ja.japanese.official#holiday@group.v.calendar.google.com';

// Google カレンダーの「予定の色」(colorId 1〜11)
const EVENT_COLORS = {
  1: '#7986cb', 2: '#33b679', 3: '#8e24aa', 4: '#e67c73', 5: '#f6bf26', 6: '#f4511e',
  7: '#039be5', 8: '#616161', 9: '#3f51b5', 10: '#0b8043', 11: '#d50000',
};

async function request(url, { method = 'GET', query, body } = {}, retried = false) {
  const u = new URL(url);
  if (query) {
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  const token = await auth.getAccessToken(retried);
  let res;
  try {
    res = await fetch(u, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw networkError();
  }
  if (res.status === 401 && !retried) return request(url, { method, query, body }, true);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data && data.error && data.error.message;
    if (res.status >= 500 || res.status === 429) throw networkError(`Google 側が一時的に応答できません (${res.status})`);
    throw apiError(res.status, msg);
  }
  return data;
}

async function paginate(url, query, key) {
  const items = [];
  let pageToken;
  do {
    const data = await request(url, { query: { ...query, pageToken } });
    items.push(...((data && data[key]) || []));
    pageToken = data && data.nextPageToken;
  } while (pageToken);
  return items;
}

async function userInfo() {
  const data = await request('https://openidconnect.googleapis.com/v1/userinfo');
  return { email: data.email };
}

async function listCalendars() {
  const items = await paginate(`${CAL}/users/me/calendarList`, { maxResults: 250 }, 'items');
  return items.map((c) => ({
    id: c.id,
    title: c.summaryOverride || c.summary,
    color: c.backgroundColor,
    selected: !!c.selected,
    primary: !!c.primary,
  }));
}

function normalizeEvent(e, cal) {
  const allDay = !!(e.start && e.start.date);
  return {
    id: `${cal.id}::${e.id}`,
    calendarId: cal.id,
    title: e.summary || '(タイトルなし)',
    allDay,
    // 終日予定は 'YYYY-MM-DD' (end は Google の仕様どおり翌日 = 排他的)、時間指定は ISO 文字列
    start: allDay ? e.start.date : e.start.dateTime,
    end: allDay ? e.end.date : e.end.dateTime,
    color: EVENT_COLORS[e.colorId] || cal.color || '#039be5',
    location: e.location || '',
    link: e.htmlLink || '',
  };
}

async function listEvents(calendars, timeMin, timeMax) {
  const results = await Promise.allSettled(
    calendars.map((cal) =>
      paginate(
        `${CAL}/calendars/${encodeURIComponent(cal.id)}/events`,
        { timeMin, timeMax, singleEvents: true, orderBy: 'startTime', maxResults: 2500 },
        'items'
      ).then((items) => items.filter((e) => e.status !== 'cancelled').map((e) => normalizeEvent(e, cal)))
    )
  );
  const failed = results.filter((r) => r.status === 'rejected');
  // 全滅ならエラーとして扱う (一部失敗なら取れた分だけ返す)
  if (failed.length && failed.length === results.length) throw failed[0].reason;
  return {
    events: results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])),
    failedCalendars: results.map((r, i) => (r.status === 'rejected' ? calendars[i].id : null)).filter(Boolean),
  };
}

async function listHolidays(timeMin, timeMax) {
  const items = await paginate(
    `${CAL}/calendars/${encodeURIComponent(HOLIDAY_CALENDAR)}/events`,
    { timeMin, timeMax, singleEvents: true, maxResults: 250 },
    'items'
  );
  const map = {};
  for (const e of items) if (e.start && e.start.date) map[e.start.date] = e.summary;
  return map;
}

function normalizeTask(t, listId) {
  return {
    id: t.id,
    listId,
    title: t.title || '',
    notes: t.notes || '',
    // Tasks API の due は日付のみ意味を持つ (時刻は常に 00:00Z)。
    // Date に変換するとタイムゾーンで前日にずれるので、文字列の日付部分だけを使う。
    due: t.due ? t.due.slice(0, 10) : null,
    done: t.status === 'completed',
    completedAt: t.completed || null,
    parent: t.parent || null,
    position: t.position || '',
    updated: t.updated,
  };
}

async function listTaskLists() {
  const items = await paginate(`${TASKS}/users/@me/lists`, { maxResults: 100 }, 'items');
  return items.map((l) => ({ id: l.id, title: l.title }));
}

async function listTasks(listId, completedMin) {
  const items = await paginate(
    `${TASKS}/lists/${encodeURIComponent(listId)}/tasks`,
    { maxResults: 100, showCompleted: true, showHidden: true, completedMin },
    'items'
  );
  return items.filter((t) => !t.deleted && (t.title || '').trim() !== '').map((t) => normalizeTask(t, listId));
}

const dueToApi = (due) => (due ? `${due}T00:00:00.000Z` : null);

function toApiPatch(patch) {
  const body = {};
  if ('title' in patch) body.title = patch.title;
  if ('notes' in patch) body.notes = patch.notes;
  if ('due' in patch) body.due = dueToApi(patch.due);
  if ('done' in patch) {
    body.status = patch.done ? 'completed' : 'needsAction';
    // 未完了に戻すときは completed を明示的に消さないと完了扱いが残る
    if (!patch.done) body.completed = null;
  }
  return body;
}

async function patchTask(listId, taskId, patch) {
  const data = await request(`${TASKS}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    body: toApiPatch(patch),
  });
  return normalizeTask(data, listId);
}

async function insertTask(listId, { title, notes, due, parent }) {
  const data = await request(`${TASKS}/lists/${encodeURIComponent(listId)}/tasks`, {
    method: 'POST',
    query: { parent },
    body: { title, notes: notes || undefined, due: dueToApi(due) || undefined },
  });
  return normalizeTask(data, listId);
}

async function deleteTask(listId, taskId) {
  await request(`${TASKS}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
}

module.exports = {
  userInfo,
  listCalendars,
  listEvents,
  listHolidays,
  listTaskLists,
  listTasks,
  patchTask,
  insertTask,
  deleteTask,
  toApiPatch,
  normalizeTask,
};
