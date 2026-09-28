const ISSUER = 'https://api.elevenlabs.io/convai/speech-engine';
const SUBJECT = 'convai_speech_engine_upstream';

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}

function decodeJsonPart(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

export async function verifySpeechEngineJwt(token, apiKey, nowSeconds = Date.now() / 1000) {
  if (!token || !apiKey) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  let header, payload;
  try {
    header = decodeJsonPart(parts[0]);
    payload = decodeJsonPart(parts[1]);
  } catch {
    return false;
  }
  if (header.alg !== 'HS256') return false;
  if (payload.iss !== ISSUER || payload.sub !== SUBJECT) return false;
  if (typeof payload.exp !== 'number' || payload.exp + 60 < nowSeconds) return false;
  const apiKeyHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKey));
  const key = await crypto.subtle.importKey('raw', apiKeyHash, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, decodeBase64Url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
}
