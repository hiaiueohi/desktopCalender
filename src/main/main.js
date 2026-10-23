const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, screen, nativeTheme, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const auth = require('./auth');
const client = require('./client');
const google = require('./google');
const { createQueue } = require('./queue');
const { serialize, configError } = require('./errors');

const DEMO = process.argv.includes('--demo');
const ICON = path.join(__dirname, '..', '..', 'assets', 'icon.png');
const BG_COLOR = '#04060b';

let win = null;
let tray = null;
let quitting = false;
let detected = null; // ダウンロード フォルダで見つけたクライアント JSON

const queue = createQueue({ send: (listId, taskId, patch) => google.patchTask(listId, taskId, patch) });

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(init);
}

function init() {
  // サイバー調のダーク UI に合わせ、日付ピッカーやスクロールバーもダークにする
  nativeTheme.themeSource = 'dark';
  createWindow();
  createTray();
}

function validBounds(b) {
  if (!b) return null;
  const visible = screen.getAllDisplays().some(({ workArea: a }) =>
    b.x < a.x + a.width - 50 && b.x + b.width > a.x + 50 && b.y >= a.y - 10 && b.y < a.y + a.height - 50
  );
  return visible ? b : null;
}

function createWindow() {
  const cfg = store.getConfig();
  const bounds = validBounds(cfg.bounds) || { width: 1220, height: 780 };
  win = new BrowserWindow({
    ...bounds,
    minWidth: 820,
    minHeight: 560,
    frame: false,
    show: false,
    icon: ICON,
    alwaysOnTop: cfg.alwaysOnTop,
    backgroundColor: BG_COLOR,
    title: 'DeskTop Calendar',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setOpacity(cfg.opacity || 1);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win.show();
  });

  let saveTimer;
  const saveBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (win && !win.isMinimized() && !win.isMaximized()) store.setConfig({ bounds: win.getBounds() });
    }, 400);
  };
  win.on('move', saveBounds);
  win.on('resize', saveBounds);

  win.on('close', (e) => {
    if (!quitting && store.getConfig().closeToTray && tray) {
      e.preventDefault();
      win.hide();
    }
  });

  // リンクは既定のブラウザで開く。ファイルのドロップなどで画面が遷移しないようにする
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function createTray() {
  const image = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.setToolTip('DeskTop Calendar');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '表示', click: showWindow },
      { label: '今すぐ同期', click: () => send('sync-request') },
      { type: 'separator' },
      {
        label: '終了',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on('click', showWindow);
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

app.on('before-quit', () => {
  quitting = true;
});
app.on('window-all-closed', () => app.quit());

// ---- IPC: すべて { ok, data } / { ok:false, error } の形で返す ----
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      if (err && err.type === 'auth') send('auth-changed', { signedIn: auth.isSignedIn() });
      return { ok: false, error: serialize(err) };
    }
  });
}

function publicConfig() {
  const { bounds, clientId, clientSecret, ...rest } = store.getConfig();
  return rest;
}

handle('app:init', async () => ({
  demo: DEMO,
  signedIn: !DEMO && auth.isSignedIn(),
  config: publicConfig(),
  client: client.info(),
  cache: DEMO ? null : store.readJson('cache.json', null),
  pending: queue.size(),
  version: app.getVersion(),
}));

handle('config:set', async (patch) => {
  const allowed = [
    'weekStart', 'showHolidays', 'hiddenCalendars', 'hiddenTaskLists', 'defaultTaskList', 'syncMinutes',
    'alwaysOnTop', 'opacity', 'accent', 'effects', 'closeToTray', 'openAtLogin', 'showCompletedInCalendar',
  ];
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  const cfg = store.setConfig(clean);
  if ('alwaysOnTop' in clean && win) win.setAlwaysOnTop(!!cfg.alwaysOnTop);
  if ('opacity' in clean && win) win.setOpacity(Math.min(1, Math.max(0.3, Number(cfg.opacity) || 1)));
  if ('openAtLogin' in clean) {
    app.setLoginItemSettings({ openAtLogin: !!cfg.openAtLogin, args: ['--hidden'] });
  }
  return publicConfig();
});

handle('cache:save', async (data) => {
  store.writeJson('cache.json', data);
});

// ---- アプリ登録 (OAuth クライアント) ----
function importClient(text) {
  const changed = client.importText(text);
  // 別のクライアントに切り替えたら、古いクライアントで得たログインは使えないので破棄する
  const signedOut = changed && auth.isSignedIn();
  if (signedOut) {
    auth.signOut();
    store.remove('cache.json');
  }
  return { ...client.info(), signedOut };
}

handle('client:detect', async () => {
  detected = client.findDownloaded();
  return detected && { name: detected.name, error: detected.error || null };
});

handle('client:useDetected', async () => {
  if (!detected || !detected.path) throw configError('ファイルが見つかりません。もう一度ダウンロードしてください');
  return importClient(fs.readFileSync(detected.path, 'utf8'));
});

handle('client:importText', async (text) => importClient(text));

handle('client:importDialog', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Google Cloud でダウンロードした JSON を選択',
    defaultPath: app.getPath('downloads'),
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return importClient(fs.readFileSync(r.filePaths[0], 'utf8'));
});

handle('client:manual', async (clientId, clientSecret) =>
  importClient(JSON.stringify({ installed: { client_id: clientId, client_secret: clientSecret } }))
);

// ---- ログイン ----
handle('auth:signIn', async (loginHint) => {
  await auth.signIn(loginHint || undefined);
  showWindow();
  // ログイン自体は成功しているので、アカウント名が取れなくても失敗扱いにしない
  const email = await google.userInfo().then((u) => u.email, () => null);
  return { email };
});

handle('auth:signOut', async () => {
  auth.signOut();
  store.remove('cache.json');
});

handle('auth:account', async () => (await google.userInfo()).email);

// ---- データ ----
handle('cal:list', () => google.listCalendars());
handle('cal:events', (calendars, timeMin, timeMax) => google.listEvents(calendars, timeMin, timeMax));
handle('cal:holidays', (timeMin, timeMax) => google.listHolidays(timeMin, timeMax));

handle('tasks:fetch', async () => {
  // 先に未送信の変更を送ってから取得する
  await queue.flush();
  const lists = await google.listTaskLists();
  const completedMin = new Date(Date.now() - 120 * 86400000).toISOString();
  const perList = await Promise.all(lists.map((l) => google.listTasks(l.id, completedMin)));
  return { lists, tasks: queue.overlay(perList.flat()), pending: queue.size() };
});

handle('tasks:update', async (listId, taskId, patch) => {
  const result = await queue.apply(listId, taskId, patch);
  return { ...result, pending: queue.size() };
});

handle('tasks:create', (listId, task) => google.insertTask(listId, task));
handle('tasks:delete', (listId, taskId) => google.deleteTask(listId, taskId));

// ---- ウィンドウ ----
handle('win:minimize', async () => win.minimize());
handle('win:toggleMaximize', async () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
handle('win:close', async () => win.close());
handle('open:external', async (url) => {
  if (/^https:\/\//.test(url)) await shell.openExternal(url);
});
