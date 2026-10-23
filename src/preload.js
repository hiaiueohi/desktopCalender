const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  init: call('app:init'),
  setConfig: call('config:set'),
  saveCache: call('cache:save'),
  detectClient: call('client:detect'),
  useDetectedClient: call('client:useDetected'),
  importClientText: call('client:importText'),
  importClientDialog: call('client:importDialog'),
  saveClientManual: call('client:manual'),
  signIn: call('auth:signIn'),
  signOut: call('auth:signOut'),
  account: call('auth:account'),
  listCalendars: call('cal:list'),
  listEvents: call('cal:events'),
  listHolidays: call('cal:holidays'),
  fetchTasks: call('tasks:fetch'),
  updateTask: call('tasks:update'),
  createTask: call('tasks:create'),
  deleteTask: call('tasks:delete'),
  minimize: call('win:minimize'),
  toggleMaximize: call('win:toggleMaximize'),
  close: call('win:close'),
  openExternal: call('open:external'),
  on: (channel, fn) => {
    const allowed = ['sync-request', 'auth-changed'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
