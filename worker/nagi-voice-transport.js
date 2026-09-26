import { createSpeechEngineTransport } from '../runtime/speech-engine-transport.js';

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
  const key = await crypto.subtle.importKey(
    'raw',
    apiKeyHash,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    'HMAC',
    key,
    decodeBase64Url(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
}

function jsonSend(socket, message) {
  socket.send(JSON.stringify(message));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'nagi-voice-transport' });
    }

    // One-time bootstrap path: use the managed ElevenLabs secret without exposing it
    // to the browser, GitHub, logs, or the operator. Remove after bootstrap succeeds.
    if (url.pathname === '/bootstrap/speech-engine') {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      if (!env.ELEVENLABS_API_KEY) return Response.json({ ok: false, error: 'missing_elevenlabs_secret' }, { status: 500 });

      const wsUrl = `wss://${url.host}/speech-engine`;
      const response = await fetch('https://api.elevenlabs.io/v1/speech-engine', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': env.ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          name: 'Nagi Speech Engine',
          speech_engine: { ws_url: wsUrl },
          language: 'ja',
          tags: ['nagi', 'bootstrap'],
        }),
      });

      const body = await response.text();
      if (!response.ok) {
        return Response.json({ ok: false, status: response.status, error: body.slice(0, 1000) }, { status: 502 });
      }

      let created;
      try { created = JSON.parse(body); } catch { created = {}; }
      return Response.json({
        ok: true,
        speech_engine_id: created.speech_engine_id || null,
        name: created.name || 'Nagi Speech Engine',
        ws_url: created.speech_engine?.ws_url || wsUrl,
        voice_id: created.tts?.voice_id || null,
      });
    }

    if (url.pathname !== '/speech-engine') return new Response('Not found', { status: 404 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    const token = request.headers.get('X-Elevenlabs-Speech-Engine-Authorization');
    if (!await verifySpeechEngineJwt(token, env.ELEVENLABS_API_KEY)) {
      return new Response('Unauthorized', { status: 401 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    let activeController = null;
    const handle = createSpeechEngineTransport({
      respondEndpoint: env.NAGI_RESPOND_ENDPOINT || 'https://nagi-memory-adapter.arai-hiroaki0317.workers.dev',
      userId: 'hiro',
      threadId: 'nagi-poc-002',
    });

    server.addEventListener('message', async event => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        server.close(1003, 'invalid_json');
        return;
      }

      if (message.type === 'close') {
        activeController?.abort();
        server.close(1000, 'Speech Engine closed');
        return;
      }

      if (message.type === 'user_transcript') {
        activeController?.abort();
        activeController = new AbortController();
      }

      try {
        await handle(message, {
          signal: activeController?.signal,
          send: outgoing => jsonSend(server, outgoing),
        });
      } catch (error) {
        if (activeController?.signal.aborted) return;
        server.close(1011, error?.message || 'transport_error');
      }
    });

    server.addEventListener('close', () => activeController?.abort());
    server.addEventListener('error', () => activeController?.abort());

    return new Response(null, { status: 101, webSocket: client });
  },
};
