// IPC 越しにエラーの種類を判別できるよう、type を持つエラーに揃える。
class AppError extends Error {
  constructor(type, message, status, code) {
    super(message);
    this.type = type;     // 'auth' | 'network' | 'api' | 'config' | 'cancelled'
    this.status = status; // HTTP ステータス (api のみ)
    this.code = code;     // 画面側で分岐したいときの補足 (例: 'no_client')
  }
}

const authError = (msg) => new AppError('auth', msg || 'Google への再ログインが必要です');
const networkError = (msg) => new AppError('network', msg || 'ネットワークに接続できません');
const apiError = (status, msg) => new AppError('api', msg || `API エラー (${status})`, status);
const configError = (msg, code) => new AppError('config', msg, undefined, code);
const cancelledError = () => new AppError('cancelled', '中断しました');

function serialize(err) {
  if (err instanceof AppError) return { type: err.type, message: err.message, status: err.status, code: err.code };
  return { type: 'unknown', message: String((err && err.message) || err) };
}

module.exports = { AppError, authError, networkError, apiError, configError, cancelledError, serialize };
