import { errorFromGateway, TextGatewayError } from '../gateway/text-protocol.js';
import { normalizeGatewayUrl } from './http-text-provider.js';

async function readPayload(response) {
  try { return await response.json(); }
  catch { return null; }
}

export class GatewayPairingClient {
  constructor({ gatewayUrl, tokenStore, fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch_required');
    if (!tokenStore?.save) throw new Error('token_store_required');
    this.gatewayUrl = normalizeGatewayUrl(gatewayUrl);
    this.tokenStore = tokenStore;
    this.fetchImpl = fetchImpl;
  }

  async redeem(code) {
    const value = String(code || '').trim();
    if (value.length < 6 || value.length > 128 || /\s/.test(value)) {
      throw new TextGatewayError('pairing_code_invalid', 'Pairing code is invalid.', {
        retryable: false,
      });
    }
    const response = await this.fetchImpl(`${this.gatewayUrl}/v1/pairing/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: value }),
    });
    const payload = await readPayload(response);
    if (!response.ok) throw errorFromGateway(response.status, payload);
    const token = String(payload?.token || '').trim();
    if (!token || /\s/.test(token) || !payload?.expires_at) {
      throw new TextGatewayError('pairing_response_invalid', 'Pairing response is invalid.', {
        status: response.status,
        retryable: false,
      });
    }
    const saved = this.tokenStore.save({ token, expiresAt: payload.expires_at });
    return { expires_at: saved.expires_at };
  }
}
