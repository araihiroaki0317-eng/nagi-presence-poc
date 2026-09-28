import test from 'node:test';
import assert from 'node:assert/strict';
import { verifySpeechEngineJwt } from '../runtime/speech-engine-auth.js';

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

async function tokenFor(apiKey, payload, header = { alg: 'HS256', typ: 'JWT' }) {
  const encodedHeader = b64url(JSON.stringify(header));
  const encodedPayload = b64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKey));
  const key = await crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(signature))}`;
}

test('accepts current ElevenLabs Speech Engine JWT contract', async () => {
  const now = 2_000_000_000;
  const token = await tokenFor('secret-api-key', {
    iss: 'https://api.elevenlabs.io/convai/speech-engine',
    sub: 'convai_speech_engine_upstream',
    exp: now + 30,
  });
  assert.equal(await verifySpeechEngineJwt(token, 'secret-api-key', now), true);
});

test('rejects wrong issuer and expired tokens', async () => {
  const now = 2_000_000_000;
  const wrongIssuer = await tokenFor('secret-api-key', {
    iss: 'https://example.invalid',
    sub: 'convai_speech_engine_upstream',
    exp: now + 30,
  });
  const expired = await tokenFor('secret-api-key', {
    iss: 'https://api.elevenlabs.io/convai/speech-engine',
    sub: 'convai_speech_engine_upstream',
    exp: now - 61,
  });
  assert.equal(await verifySpeechEngineJwt(wrongIssuer, 'secret-api-key', now), false);
  assert.equal(await verifySpeechEngineJwt(expired, 'secret-api-key', now), false);
});
