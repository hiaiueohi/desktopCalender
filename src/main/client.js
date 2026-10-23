// このアプリを Google に登録した情報 (OAuth クライアント) の管理。
//  優先順位: 取り込んだ JSON (設定に保存) → アプリに同梱した oauth-client.json
//  Google Cloud でダウンロードした JSON をダウンロード フォルダから自動で探す機能もここに置く。
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const store = require('./store');
const { configError } = require('./errors');

const BUNDLED_FILE = path.join(__dirname, '..', '..', 'oauth-client.json');
const MAX_JSON_BYTES = 64 * 1024;

function parseClientJson(text) {
  let data;
  try {
    data = JSON.parse(String(text).replace(/^﻿/, ''));
  } catch {
    throw configError('JSON ファイルとして読み込めませんでした');
  }
  if (data && data.web && !data.installed) {
    throw configError('「ウェブ アプリケーション」用のファイルです。種類を「デスクトップ アプリ」にしてクライアントを作り直してください');
  }
  const c = (data && (data.installed || data)) || {};
  const clientId = String(c.client_id || c.clientId || '').trim();
  const clientSecret = String(c.client_secret || c.clientSecret || '').trim();
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw configError('OAuth クライアントの JSON ではありません（client_id が見つかりません）');
  }
  if (!clientSecret) {
    throw configError('クライアント シークレットが入っていません。作成直後の画面で「JSON をダウンロード」したファイルを使ってください');
  }
  return { clientId, clientSecret };
}

function readBundled() {
  try {
    return parseClientJson(fs.readFileSync(BUNDLED_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function get() {
  const { clientId, clientSecret } = store.getConfig();
  if (clientId && clientSecret) return { clientId: clientId.trim(), clientSecret: clientSecret.trim(), source: 'imported' };
  const bundled = readBundled();
  return bundled ? { ...bundled, source: 'bundled' } : null;
}

function requireClient() {
  const c = get();
  if (!c) throw configError('最初にアプリを Google に登録してください（初回のみ）', 'no_client');
  return c;
}

function info() {
  const c = get();
  return c ? { configured: true, source: c.source, clientId: c.clientId } : { configured: false };
}

// JSON の文字列を検証して保存する。別のクライアントに切り替わったら true
function importText(text) {
  if (String(text).length > MAX_JSON_BYTES) throw configError('ファイルが大きすぎます');
  const parsed = parseClientJson(text);
  const before = get();
  store.setConfig(parsed);
  return !before || before.clientId !== parsed.clientId;
}

// ダウンロード フォルダから、Google Cloud で保存したクライアント JSON を新しい順に探す。
// 使えるファイルがなければ、最も新しい client_secret*.json の問題点を返す
function findDownloaded() {
  let dir;
  let names;
  try {
    dir = app.getPath('downloads');
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const files = names
    .filter((n) => /\.json$/i.test(n))
    .map((n) => {
      const p = path.join(dir, n);
      try {
        const st = fs.statSync(p);
        return st.isFile() ? { name: n, path: p, mtime: st.mtimeMs, size: st.size } : null;
      } catch {
        return null;
      }
    })
    .filter((f) => f && f.size <= MAX_JSON_BYTES && (/^client_secret/i.test(f.name) || f.mtime > dayAgo))
    .sort((a, b) => b.mtime - a.mtime);

  let rejected = null;
  for (const f of files) {
    try {
      const parsed = parseClientJson(fs.readFileSync(f.path, 'utf8'));
      return { name: f.name, path: f.path, clientId: parsed.clientId };
    } catch (e) {
      if (!rejected && /^client_secret/i.test(f.name)) rejected = { name: f.name, error: e.message };
    }
  }
  return rejected;
}

module.exports = { parseClientJson, get, requireClient, info, importText, findDownloaded };
