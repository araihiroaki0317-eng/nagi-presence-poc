// Preserve the existing Agent's voice tuning without inventing new values.
export function agentVoiceSettings(agent) {
  const tts = agent?.conversation_config?.tts || {};
  const settings = {};
  for (const key of ['stability', 'similarity_boost', 'speed']) {
    if (typeof tts[key] === 'number' && Number.isFinite(tts[key])) settings[key] = tts[key];
  }
  return Object.keys(settings).length ? { voice_settings: settings } : {};
}

import { readNagiVoiceConfiguration } from '../runtime/nagi-voice-configuration.js';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createSpeechEngineTransport } from '../runtime/speech-engine-transport.js';
import { verifySpeechEngineJwt } from '../runtime/speech-engine-auth.js';
import { handleBithumanLive } from '../runtime/bithuman-live-server.js';

function jsonSend(socket, message) {
  socket.send(JSON.stringify(message));
}

// ElevenLabs pcm_16000 is mono signed 16-bit little-endian PCM. Supply
// explicit RIFF sizes so bitHuman can determine duration without ffprobe.
export function pcm16ToWav(pcm, sampleRate = 16000) {
  if (!pcm.byteLength || pcm.byteLength % 2 || pcm.byteLength > sampleRate * 2 * 120) {
    throw new Error('invalid_test_audio_pcm');
  }
  const wav = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(wav.buffer);
  const label = (offset, value) => wav.set(new TextEncoder().encode(value), offset);
  label(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  label(8, 'WAVE');
  label(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  label(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  wav.set(new Uint8Array(pcm), 44);
  return wav;
}

export class ObservabilityEntrypoint extends WorkerEntrypoint {
  async getNagiVoiceConfiguration() {
    return readNagiVoiceConfiguration(this.env);
  }

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
    const liveResponse = await handleBithumanLive(request, env);
    if (liveResponse) return liveResponse;
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
      const avatarId = String(input?.avatar_id || 'dd73ea75-1218-4ef3-92ce-606d5f7fbc0a').trim();
      if (avatarId.length > 200) return Response.json({ ok: false, error: 'invalid_avatar_id' }, { status: 400 });

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

    if (url.pathname === '/spatius-config') {
      if (!allowedOrigin) return new Response('Forbidden', { status: 403 });
      return Response.json({
        app_id: 'app_mupg5qzm_1eouf3u',
        avatar_id: '18a01afe-7870-4934-a063-1bd7f9ceb4ac',
        region: 'auto',
      }, {
        headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': allowedOrigin, 'Vary': 'Origin' },
      });
    }

    if (url.pathname === '/spatius-session-token') {
      if (request.method === 'OPTIONS') {
        if (!allowedOrigin) return new Response(null, { status: 403 });
        return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': allowedOrigin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' } });
      }
      if (!allowedOrigin) return new Response('Forbidden', { status: 403 });
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      if (!env.SPATIUS_API_KEY) return Response.json({ ok: false, error: 'missing_spatius_secret' }, { status: 500 });

      const expireAt = Math.floor(Date.now() / 1000) + 55 * 60;
      const tokenResponse = await fetch('https://console.us-west.spatius.ai/v1/console/session-tokens', {
        method: 'POST',
        headers: { 'X-Api-Key': env.SPATIUS_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expireAt, modelVersion: '' }),
      });
      let payload = null;
      try { payload = await tokenResponse.json(); } catch { payload = null; }
      const sessionToken = payload?.sessionKey || payload?.sessionToken || payload?.token
        || payload?.data?.sessionKey || payload?.data?.sessionToken || payload?.data?.token;
      if (!tokenResponse.ok || payload?.errors || !sessionToken) {
        return Response.json({ ok: false, error: 'spatius_session_token_failed', status: tokenResponse.status }, { status: 502 });
      }
      return Response.json({
        session_token: sessionToken,
        expires_at: new Date(expireAt * 1000).toISOString(),
        app_id: 'app_mupg5qzm_1eouf3u',
        avatar_id: '18a01afe-7870-4934-a063-1bd7f9ceb4ac',
        region: 'auto',
      }, {
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

    if (['/bithuman-test-audio', '/bithuman-test-audio.wav'].includes(url.pathname) && request.method === 'GET') {
      const exp = Number(url.searchParams.get('exp') || 0);
      const sig = url.searchParams.get('sig') || '';
      if (!env.BITHUMAN_API_SECRET || !exp || Date.now() > exp) return new Response('Forbidden', { status: 403 });
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.BITHUMAN_API_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const expectedBytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('bithuman-test-audio:' + exp)));
      const expected = Array.from(expectedBytes, b => b.toString(16).padStart(2, '0')).join('');
      if (sig !== expected) return new Response('Forbidden', { status: 403 });
      if (!env.ELEVENLABS_API_KEY) return new Response('Unavailable', { status: 503 });
      const agentId = env.NAGI_ELEVENLABS_AGENT_ID || 'agent_8501m0nvtj12ea5vnc21ck26v9sp';
      const cfg = await fetch('https://api.elevenlabs.io/v1/convai/agents/' + agentId, { headers: { 'xi-api-key': env.ELEVENLABS_API_KEY } });
      if (!cfg.ok) return new Response('Unavailable', { status: 502 });
      const agent = await cfg.json();
      const voiceId = agent?.conversation_config?.tts?.voice_id;
      if (!voiceId) return new Response('Unavailable', { status: 502 });
      const speech = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(voiceId) + '?output_format=pcm_16000', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': env.ELEVENLABS_API_KEY },
        body: JSON.stringify({ text: 'こんにちは。凪の声で、リップシンクの動作を確認しています。', model_id: agent?.conversation_config?.tts?.model_id || 'eleven_multilingual_v2', ...agentVoiceSettings(agent) }),
      });
      if (!speech.ok) return new Response('Unavailable', { status: 502 });
      let wav;
      try { wav = pcm16ToWav(await speech.arrayBuffer()); }
      catch { return new Response('Invalid audio', { status: 502 }); }
      return new Response(wav, { headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(wav.byteLength), 'Cache-Control': 'no-store' } });
    }

    if (url.pathname === '/bithuman-test-render') {
      if (request.method === 'OPTIONS') {
        if (!allowedOrigin) return new Response(null, { status: 403 });
        return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': allowedOrigin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin' } });
      }
      if (!allowedOrigin) return new Response('Forbidden', { status: 403 });
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      if (!env.BITHUMAN_API_SECRET) return Response.json({ ok: false, error: 'missing_bithuman_secret' }, { status: 500, headers: { 'Access-Control-Allow-Origin': allowedOrigin } });
      const exp = Date.now() + 600000;
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.BITHUMAN_API_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sigBytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('bithuman-test-audio:' + exp)));
      const sig = Array.from(sigBytes, b => b.toString(16).padStart(2, '0')).join('');
      const audioUrl = url.origin + '/bithuman-test-audio.wav?exp=' + exp + '&sig=' + sig;
      const upstream = await fetch('https://api.bithuman.ai/v1/video/generate', {
        method: 'POST',
        headers: { 'api-secret': env.BITHUMAN_API_SECRET, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'essence-2', agent_code: 'A17VAN5175', input: { type: 'audio', audio_url: audioUrl }, wait: true }),
      });
      let data = null; try { data = await upstream.json(); } catch {}
      return Response.json({ ok: upstream.ok && data?.success !== false && data?.status !== 'failed', upstream_status: upstream.status, status: data?.status || null, job_id: data?.job_id || null, video_url: data?.video_url || null, error: data?.error || data?.message || data?.detail || (data?.status === 'failed' ? 'render_failed' : null), details: data?.details || data?.data || null, audio_format: 'wav_pcm_s16le_16000_mono' }, { status: upstream.ok ? 200 : upstream.status, headers: { 'Access-Control-Allow-Origin': allowedOrigin, 'Cache-Control': 'no-store', 'Vary': 'Origin' } });
    }

    if (url.pathname.startsWith('/bithuman-test-render-status/')) {
      if (!allowedOrigin) return new Response('Forbidden', { status: 403 });
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      if (!env.BITHUMAN_API_SECRET) return Response.json({ ok: false, error: 'missing_bithuman_secret' }, { status: 500, headers: { 'Access-Control-Allow-Origin': allowedOrigin } });
      const jobId = url.pathname.split('/').pop();
      if (!/^vid_[a-zA-Z0-9_-]{1,100}$/.test(jobId)) return Response.json({ ok: false, error: 'invalid_job_id' }, { status: 400, headers: { 'Access-Control-Allow-Origin': allowedOrigin } });
      const upstream = await fetch('https://api.bithuman.ai/v1/video/' + encodeURIComponent(jobId), { headers: { 'api-secret': env.BITHUMAN_API_SECRET } });
      let data = null; try { data = await upstream.json(); } catch {}
      return Response.json({ ok: upstream.ok, upstream_status: upstream.status, result: data }, { status: upstream.ok ? 200 : upstream.status, headers: { 'Access-Control-Allow-Origin': allowedOrigin, 'Cache-Control': 'no-store', 'Vary': 'Origin' } });
    }

    if (url.pathname === '/bithuman-health') {
      if (request.method === 'OPTIONS') {
        if (!allowedOrigin) return new Response(null, { status: 403 });
        return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': allowedOrigin, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' } });
      }
      if (!allowedOrigin) return new Response('Forbidden', { status: 403 });
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      if (!env.BITHUMAN_API_SECRET) return Response.json({ ok: false, service: 'bithuman', configured: false, error: 'missing_bithuman_secret' }, { status: 500, headers: { 'Access-Control-Allow-Origin': allowedOrigin, 'Vary': 'Origin' } });

      const validation = await fetch('https://api.bithuman.ai/v1/validate', {
        method: 'POST',
        headers: { 'api-secret': env.BITHUMAN_API_SECRET },
      });
      let payload = null;
      try { payload = await validation.json(); } catch {}
      return Response.json({
        ok: validation.ok && payload?.valid === true,
        service: 'bithuman',
        configured: true,
        authenticated: payload?.valid === true,
        upstream_status: validation.status,
        test_audio_format: 'wav_pcm_s16le_16000_mono',
      }, { status: validation.ok && payload?.valid === true ? 200 : 502, headers: { 'Access-Control-Allow-Origin': allowedOrigin, 'Cache-Control': 'no-store', 'Vary': 'Origin' } });
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

      const speech = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=${encodeURIComponent(input?.output_format === 'pcm_16000' ? 'pcm_16000' : input?.output_format === 'pcm_24000' ? 'pcm_24000' : 'mp3_44100_128')}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': env.ELEVENLABS_API_KEY },
        body: JSON.stringify({ text, model_id: agent?.conversation_config?.tts?.model_id || 'eleven_multilingual_v2', ...agentVoiceSettings(agent) }),
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
