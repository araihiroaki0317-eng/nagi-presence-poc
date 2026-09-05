export const MAX_GATEWAY_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function requiredToken(value) {
  const token = String(value || '').trim();
  if (!token || /\s/.test(token)) throw new Error('device_token_invalid');
  return token;
}

function expirationTime(value) {
  const time = typeof value === 'number' ? value : Date.parse(String(value || ''));
  if (!Number.isFinite(time)) throw new Error('device_token_expiration_invalid');
  return time;
}

export class GatewaySessionTokenStore {
  constructor({
    storage = globalThis.sessionStorage,
    now = () => Date.now(),
    key = 'nagi.gateway.device-token.v1',
    maxTtlMs = MAX_GATEWAY_SESSION_TTL_MS,
  } = {}) {
    if (!storage?.getItem || !storage?.setItem || !storage?.removeItem) {
      throw new Error('session_storage_required');
    }
    if (typeof now !== 'function') throw new Error('clock_required');
    if (!Number.isSafeInteger(maxTtlMs) || maxTtlMs <= 0 || maxTtlMs > MAX_GATEWAY_SESSION_TTL_MS) {
      throw new Error('device_token_ttl_invalid');
    }
    this.storage = storage;
    this.now = now;
    this.key = key;
    this.maxTtlMs = maxTtlMs;
  }

  save({ token, expiresAt } = {}) {
    const value = requiredToken(token);
    const expiresAtMs = expirationTime(expiresAt);
    const current = this.now();
    if (expiresAtMs <= current) throw new Error('device_token_expired');
    if (expiresAtMs - current > this.maxTtlMs) throw new Error('device_token_ttl_exceeded');
    this.storage.setItem(this.key, JSON.stringify({
      token: value,
      expires_at: new Date(expiresAtMs).toISOString(),
    }));
    return { expires_at: new Date(expiresAtMs).toISOString() };
  }

  getToken() {
    let record;
    try { record = JSON.parse(this.storage.getItem(this.key) || 'null'); }
    catch {
      this.clear();
      return null;
    }
    if (!record) return null;
    const expiresAtMs = Date.parse(String(record.expires_at || ''));
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.now()) {
      this.clear();
      return null;
    }
    try { return requiredToken(record.token); }
    catch {
      this.clear();
      return null;
    }
  }

  clear() {
    this.storage.removeItem(this.key);
  }
}
