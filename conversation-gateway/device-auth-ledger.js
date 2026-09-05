import { fixedTimeHexEqual, readBearerToken, sha256Hex } from './auth.js';

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
const DEVICE_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_PAIRING_FAILURES = 5;

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const encoded = btoa(String.fromCharCode(...bytes));
  return encoded.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function timestamp(value) {
  const result = Date.parse(String(value || ''));
  return Number.isFinite(result) ? result : null;
}

function response(payload, status = 200) {
  return Response.json(payload, { status });
}

export class DeviceAuthLedger {
  constructor(ctx, env, { now = () => Date.now(), tokenFactory = randomToken } = {}) {
    if (!ctx?.storage?.get || !ctx?.storage?.put) throw new Error('durable_storage_required');
    this.storage = ctx.storage;
    this.env = env || {};
    this.now = now;
    this.tokenFactory = tokenFactory;
  }

  pairingConfig() {
    const digest = String(this.env.PAIRING_CODE_SHA256 || '').toLowerCase();
    const issuedAt = timestamp(this.env.PAIRING_CODE_ISSUED_AT);
    const expiresAt = timestamp(this.env.PAIRING_CODE_EXPIRES_AT);
    if (!/^[a-f0-9]{64}$/.test(digest) || issuedAt === null || expiresAt === null
      || expiresAt <= issuedAt || expiresAt - issuedAt > PAIRING_CODE_TTL_MS) {
      return null;
    }
    return { digest, issuedAt, expiresAt };
  }

  async redeem(code) {
    const config = this.pairingConfig();
    if (!config) return { status: 503, payload: { error: { code: 'pairing_not_configured' } } };
    const current = this.now();
    if (current < config.issuedAt || current >= config.expiresAt) {
      return { status: 410, payload: { error: { code: 'pairing_code_expired' } } };
    }

    const candidateDigest = await sha256Hex(code);
    const token = this.tokenFactory();
    const tokenDigest = await sha256Hex(token);
    const tokenExpiresAt = current + DEVICE_TOKEN_TTL_MS;
    const pairingKey = `pairing:${config.digest}`;
    const execute = async store => {
      const state = await store.get(pairingKey) || { failed_attempts: 0, used_at: null };
      if (state.used_at) return { status: 409, payload: { error: { code: 'pairing_code_used' } } };
      if (state.failed_attempts >= MAX_PAIRING_FAILURES) {
        return { status: 429, payload: { error: { code: 'pairing_locked' } } };
      }
      if (!fixedTimeHexEqual(candidateDigest, config.digest)) {
        state.failed_attempts += 1;
        await store.put(pairingKey, state);
        return {
          status: state.failed_attempts >= MAX_PAIRING_FAILURES ? 429 : 401,
          payload: { error: { code: state.failed_attempts >= MAX_PAIRING_FAILURES
            ? 'pairing_locked' : 'pairing_code_invalid' } },
        };
      }

      state.used_at = new Date(current).toISOString();
      await store.put(pairingKey, state);
      await store.put(`device-token:${tokenDigest}`, {
        expires_at: new Date(tokenExpiresAt).toISOString(),
        issued_at: new Date(current).toISOString(),
      });
      return {
        status: 200,
        payload: { token, expires_at: new Date(tokenExpiresAt).toISOString() },
      };
    };
    return typeof this.storage.transaction === 'function'
      ? this.storage.transaction(transaction => execute(transaction))
      : execute(this.storage);
  }

  async verify(token) {
    const value = String(token || '').trim();
    if (!value || /\s/.test(value)) return { ok: false, reason: 'device_token_required' };
    const digest = await sha256Hex(value);
    const key = `device-token:${digest}`;
    const record = await this.storage.get(key);
    if (!record) return { ok: false, reason: 'device_token_invalid' };
    const expiresAt = timestamp(record.expires_at);
    if (expiresAt === null || expiresAt <= this.now()) {
      await this.storage.delete?.(key);
      return { ok: false, reason: 'device_token_expired' };
    }
    return { ok: true };
  }

  async fetch(input, init) {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (request.method !== 'POST') return response({ error: { code: 'method_not_allowed' } }, 405);
    if (url.pathname === '/redeem') {
      let body;
      try { body = await request.json(); }
      catch { return response({ error: { code: 'invalid_json' } }, 400); }
      const code = String(body?.code || '').trim();
      if (code.length < 6 || code.length > 128 || /\s/.test(code)) {
        return response({ error: { code: 'pairing_code_invalid' } }, 400);
      }
      const result = await this.redeem(code);
      return response(result.payload, result.status);
    }
    if (url.pathname === '/verify') {
      const result = await this.verify(readBearerToken(request));
      return response(result, result.ok ? 200 : 401);
    }
    return response({ error: { code: 'not_found' } }, 404);
  }
}

export const DEVICE_AUTH_LIMITS = Object.freeze({
  pairingCodeTtlMs: PAIRING_CODE_TTL_MS,
  deviceTokenTtlMs: DEVICE_TOKEN_TTL_MS,
  maxPairingFailures: MAX_PAIRING_FAILURES,
});
