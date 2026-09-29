import { WorkerEntrypoint } from 'cloudflare:workers';
import { createSpeechEngineTransport } from '../runtime/speech-engine-transport.js';
import { verifySpeechEngineJwt } from '../runtime/speech-engine-auth.js';

function jsonSend(socket, message) {
  socket.send(JSON.stringify(message));
}

export class ObservabilityEntrypoint extends WorkerEntrypoint {
  async getElevenLabsUsage({ startTime, endTime, intervalSeconds = 3600, timeZone = 'Asia/Tokyo' } = {}) {
    if (!this.env.ELEVENLABS_API_KEY) throw new Error('missing_elevenlabs_secret');
    if (!Number.isInteger(startTime) || !Number.isInteger(endTime) || startTime >= endTime) throw new Error('invalid_usage_window');
    const response = await fetch('https://api.elevenlabs.io/v1/workspace/analytics/query/usage-by-product-over-time', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': this.env.ELEVENLABS_API_KEY },
      body: JSON.stringify({ start_time: startTime, end_time: endTime, interval_seconds: intervalSeconds, time_zone: timeZone }),
    });
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok) throw new Error(`elevenlabs_usage_failed:${response.status}`);
    return { source: 'elevenlabs', startTime, endTime, intervalSeconds, timeZone, ...payload };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = origin === 'https://araihiroaki0317-eng.github.io' ? origin : '';
    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'nagi-voice-transport' });
    }

    if (url.pathname === '/liveavatar-health') {
      if (!env.LIVEAVATAR_API_KEY) {
        return Response.json({ ok: false, service: 'liveavatar', error: 'missing_liveavatar_secret' }, { status: 500 });
      }
      const creditsResponse = await fetch('https://api.liveavatar.com/v1/users/credits', {
        headers: { 'X-API-KEY': env.LIVEAVATAR_API_KEY },
      });
      let payload = null;
      try { payload = await creditsResponse.json(); } catch { payload = null; }
      if (!creditsResponse.ok) {
        return Response.json({ ok: false, service: 'liveavatar', error: 'liveavatar_auth_failed', status: creditsResponse.status }, { status: 502 });
      }
      return Response.json({
        ok: true,
        service: 'liveavatar',
        authenticated: true,
        credits_left: payload?.data?.credits_left ?? null,
      }, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (url.pathname === '/liveavatar-session-token') {
      if (request.method === 'OPTIONS') {
        if (!allowedOrigin) return new Response(null, { status: 403 });
        return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': allowedOrigin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' } });
      }
      if (!allowedOrigin) return new Response('Forbidden', { status: 403 });
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      if (!env.LIVEAVATAR_API_KEY) return Response.json({ ok: false, error: 'missing_liveavatar_secret' }, { status: 500 });

      let input;
      try { input = await request.json(); } catch { return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 }); }
      const avatarId = String(input?.avatar_id || '').trim();
      if (!avatarId || avatarId.length > 200) return Response.json({ ok: false, error: 'invalid_avatar_id' }, { status: 400 });

      const tokenResponse = await fetch('https://api.liveavatar.com/v1/sessions/token', {
        method: 'POST',
        headers: { 'X-API-KEY': env.LIVEAVATAR_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'LITE', avatar_id: avatarId, is_sandbox: true }),
      });
      let payload = null;
      try { payload = await tokenResponse.json(); } catch { payload = null; }
      const sessionToken = payload?.data?.session_token;
      const sessionId = payload?.data?.session_id;
      if (!tokenResponse.ok || !sessionToken) {
        return Response.json({ ok: false, error: 'liveavatar_session_token_failed', status: tokenResponse.status }, { status: 502 });
      }
      return Response.json({ session_token: sessionToken, session_id: sessionId }, {
        headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': allowedOrigin, 'Vary': 'Origin' },
      });
    }

    if (url.pathname === '/scribe-token') {
      if (request.method === 'OPTIONS') {
        if (!allowedOrigin) return new Response(null, { status: 403 });
        return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': allowedOrigin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin' } });
      }
      if (!allowedOrigin) return new Response('Forbidden', { status: 403 });
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      if (!env.ELEVENLABS_API_KEY) return Response.json({ ok: false, error: 'missing_elevenlabs_secret' }, { status: 500 });
      const tokenResponse = await fetch('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', {
        method: 'POST',
        headers: { 'xi-api-key': env.ELEVENLABS_API_KEY },
      });
      let payload = null;
      try { payload = await tokenResponse.json(); } catch { payload = null; }
      if (!tokenResponse.ok || !payload?.token) return Response.json({ ok: false, error: 'scribe_token_failed', status: tokenResponse.status }, { status: 502 });
      return Response.json({ token: payload.token }, { headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': allowedOrigin, 'Vary': 'Origin' } });
    }

    if (url.pathname === '/tts') {
      if (request.method === 'OPTIONS') {
        if (!allowedOrigin) return new Response(null, { status: 403 });
        return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': allowedOrigin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' } });
      }
      if (!allowedOrigin) return new Response('Forbidden', { status: 403 });
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
      return new Response(speech.body, { status: 200, headers: { 'Content-Type': speech.headers.get('Content-Type') || 'audio/mpeg', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': allowedOrigin, 'Vary': 'Origin' } });
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
