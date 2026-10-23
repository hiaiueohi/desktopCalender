// Google OAuth 2.0 (インストール型アプリ向け: ループバック + PKCE)。
// リフレッシュトークンは Windows の DPAPI (safeStorage) で暗号化して保存し、次回からは起動するだけで自動接続する。
const http = require('http');
const crypto = require('crypto');
const { shell, safeStorage } = require('electron');
const store = require('./store');
const client = require('./client');
const { authError, networkError, cancelledError } = require('./errors');

const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/tasks',
];
const TOKEN_FILE = 'token.bin';
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

let tokens = null;
let refreshing = null;
let pendingLogin = null; // 進行中のログイン (やり直したときに前回分を止めるため)

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function loadTokens() {
  const buf = store.readBuffer(TOKEN_FILE);
  if (!buf) return null;
  try {
    const text = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function saveTokens(t) {
  tokens = t;
  const text = JSON.stringify(t);
  const buf = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : Buffer.from(text, 'utf8');
  store.writeBuffer(TOKEN_FILE, buf);
}

function isSignedIn() {
  if (!tokens) tokens = loadTokens();
  return !!(tokens && tokens.refresh_token);
}

async function tokenRequest(params) {
  let res;
  try {
    res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
  } catch {
    throw networkError();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.error === 'invalid_grant' || data.error === 'invalid_client' || data.error === 'unauthorized_client') {
      throw authError(`ログインの有効期限が切れました (${data.error})。もう一度ログインしてください`);
    }
    throw networkError(`トークン取得に失敗しました: ${data.error_description || data.error || res.status}`);
  }
  return data;
}

function resultPage(ok, message) {
  const color = ok ? '#39ff88' : '#ff3d61';
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><title>DeskTop Calendar</title>
<style>
body{margin:0;height:100vh;display:grid;place-items:center;background:#04060b;color:#dff7ff;
font-family:"Segoe UI","Yu Gothic UI",sans-serif;
background-image:linear-gradient(rgba(0,240,255,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(0,240,255,.05) 1px,transparent 1px);
background-size:26px 26px}
.card{padding:34px 44px;text-align:center;background:rgba(8,13,23,.92);border:1px solid rgba(0,240,255,.35);
box-shadow:0 0 40px rgba(0,240,255,.12)}
.tag{font-family:Consolas,monospace;letter-spacing:.35em;font-size:12px;color:${color};text-shadow:0 0 8px ${color}}
h1{margin:12px 0 8px;font-size:22px}p{margin:0;color:#8ea7ba}
</style>
<div class="card"><div class="tag">${ok ? 'LINK ESTABLISHED' : 'LINK FAILED'}</div>
<h1>${message}</h1><p>このタブを閉じて、アプリに戻ってください。</p></div></html>`;
}

// 127.0.0.1 の空きポートで待ち受け、リダイレクト URI と「認可コードが届いたら解決する Promise」を返す
function startLoopback(expectedState) {
  return new Promise((resolveStart, rejectStart) => {
    let resolveCode;
    let rejectCode;
    const code = new Promise((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });
    code.catch(() => {}); // 中断時に誰も待っていなくても未処理扱いにしない
    const finish = () => {
      clearTimeout(timer);
      server.close();
    };
    const timer = setTimeout(() => {
      finish();
      rejectCode(authError('ログインがタイムアウトしました。もう一度お試しください'));
    }, AUTH_TIMEOUT_MS);

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/') {
        res.writeHead(404).end();
        return;
      }
      const value = url.searchParams.get('code');
      const err = url.searchParams.get('error');
      const ok = !!value && url.searchParams.get('state') === expectedState;
      const message = ok ? 'ログインが完了しました' : err === 'access_denied' ? 'ログインがキャンセルされました' : 'ログインできませんでした';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
      res.end(resultPage(ok, message));
      finish();
      if (ok) resolveCode(value);
      else rejectCode(authError(err ? `${message} (${err})` : '認証の応答が不正です'));
    });
    server.on('error', (e) => {
      clearTimeout(timer);
      rejectStart(e);
    });
    server.listen(0, '127.0.0.1', () => {
      resolveStart({
        redirectUri: `http://127.0.0.1:${server.address().port}`,
        code,
        cancel: () => {
          finish();
          rejectCode(cancelledError());
        },
      });
    });
  });
}

// ブラウザで Google のログイン画面を開き、許可されたらトークンを保存する。
// loginHint (前回のメールアドレス) を渡すと、そのアカウントが選ばれた状態で開く
async function signIn(loginHint) {
  const { clientId, clientSecret } = client.requireClient();
  if (pendingLogin) pendingLogin.cancel();

  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const loop = await startLoopback(state);
  pendingLogin = loop;

  try {
    const params = {
      client_id: clientId,
      redirect_uri: loop.redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: loginHint ? 'consent' : 'select_account consent',
      state,
    };
    if (loginHint) params.login_hint = loginHint;
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.search = new URLSearchParams(params).toString();
    await shell.openExternal(authUrl.toString());

    const code = await loop.code;
    const data = await tokenRequest({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: loop.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    });
    if (!data.refresh_token) throw authError('リフレッシュトークンが取得できませんでした。もう一度お試しください');
    saveTokens({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in - 60) * 1000,
    });
  } catch (e) {
    loop.cancel(); // ブラウザを開けなかった場合などに待ち受けを残さない
    throw e;
  } finally {
    if (pendingLogin === loop) pendingLogin = null;
  }
}

function signOut() {
  const t = tokens || loadTokens();
  tokens = null;
  store.remove(TOKEN_FILE);
  if (t && t.refresh_token) {
    // 失効はベストエフォート (オフラインでもローカルのログアウトは完了させる)
    fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.refresh_token)}`, { method: 'POST' }).catch(() => {});
  }
}

async function getAccessToken(forceRefresh = false) {
  if (!isSignedIn()) throw authError('Google にログインしていません');
  if (!forceRefresh && tokens.access_token && Date.now() < tokens.expires_at) return tokens.access_token;
  // 同時に複数のリクエストが来てもリフレッシュは 1 回だけ行う
  if (!refreshing) {
    refreshing = (async () => {
      const { clientId, clientSecret } = client.requireClient();
      try {
        const data = await tokenRequest({
          refresh_token: tokens.refresh_token,
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'refresh_token',
        });
        saveTokens({
          ...tokens,
          access_token: data.access_token,
          expires_at: Date.now() + (data.expires_in - 60) * 1000,
        });
      } catch (e) {
        if (e.type === 'auth') {
          tokens = null;
          store.remove(TOKEN_FILE);
        }
        throw e;
      }
    })().finally(() => {
      refreshing = null;
    });
  }
  await refreshing;
  return tokens.access_token;
}

module.exports = { signIn, signOut, isSignedIn, getAccessToken };
