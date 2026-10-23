// userData 配下の JSON ファイルを読み書きする小さなストア。
// 書き込みは一時ファイル → rename で行い、途中でアプリが落ちても壊れないようにする。
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULT_CONFIG = {
  clientId: '',
  clientSecret: '',
  weekStart: 0,            // 0 = 日曜始まり, 1 = 月曜始まり
  showHolidays: true,
  hiddenCalendars: null,   // null = Google 側の「表示」設定に従う
  hiddenTaskLists: [],
  defaultTaskList: null,
  syncMinutes: 5,
  alwaysOnTop: false,
  opacity: 1,
  accent: 'cyan',          // cyan | magenta | green | amber
  effects: true,           // 走査線・発光アニメーション
  closeToTray: true,
  openAtLogin: false,
  showCompletedInCalendar: true,
  bounds: null,
};

function file(name) {
  return path.join(app.getPath('userData'), name);
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, data) {
  const target = file(name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

function readBuffer(name) {
  try {
    return fs.readFileSync(file(name));
  } catch {
    return null;
  }
}

function writeBuffer(name, buf) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(file(name), buf);
}

function remove(name) {
  try {
    fs.unlinkSync(file(name));
  } catch {
    /* 存在しなければ何もしない */
  }
}

let config = null;

function getConfig() {
  if (!config) config = { ...DEFAULT_CONFIG, ...readJson('config.json', {}) };
  return config;
}

function setConfig(patch) {
  config = { ...getConfig(), ...patch };
  writeJson('config.json', config);
  return config;
}

module.exports = { getConfig, setConfig, readJson, writeJson, readBuffer, writeBuffer, remove };
