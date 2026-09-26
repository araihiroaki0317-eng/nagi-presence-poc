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

    if (url.pathname === '/tts') {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      if (!env.ELEVENLABS_API_KEY) return Response.json({ ok: false, error: 'missing_elevenlabs_secret' }, { status: 500 });

      let input;
      try { input = await request.json(); } catch { return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 }); }
      const text = String(input?.text || '').trim();
      if (!text || text.length > 5000) return Response.json({ ok: false, error: 'invalid_text' }, { status: 400 });

      const agentId = env.NAGI_ELEVENLABS_AGENT_ID || 'agent_8501m0nvtj12ea5vnc21ck26v9sp';
      const agentResponse = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, {
        headers: { 'xi-api-key': env.ELEVENLABS_API_KEY },
      });
      if (!agentResponse.ok) return Response.json({ ok: false, error: 'agent_config_unavailable', status: agentResponse.status }, { status: 502 });
      const agent = await agentResponse.json();
      const voiceId = agent?.conversation_config?.tts?.voice_id;
      if (!voiceId) return Response.json({ ok: false, error: 'agent_voice_missing' }, { status: 502 });

      const speech = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': env.ELEVENLABS_API_KEY },
        body: JSON.stringify({ text, model_id: agent?.conversation_config?.tts?.model_id || 'eleven_multilingual_v2' }),
      });
      if (!speech.ok) return Response.json({ ok: false, error: 'tts_failed', status: speech.status }, { status: 502 });
      return new Response(speech.body, { status: 200, headers: { 'Content-Type': speech.headers.get('Content-Type') || 'audio/mpeg', 'Cache-Control': 'no-store' } });
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
