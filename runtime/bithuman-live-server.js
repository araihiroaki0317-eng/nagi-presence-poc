const ORIGIN = 'https://araihiroaki0317-eng.github.io';
const AVATAR = 'bithuman-avatar-agent';
const SENDER = 'nagi-audio-sender';
const encoder = new TextEncoder();
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const encode = value => b64(encoder.encode(JSON.stringify(value)));
const decode = value => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0))));
async function key(secret, usage) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usage);
}
export async function signLiveKit(env, claims) {
  const now = Math.floor(Date.now() / 1000);
  const data = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode({ iss: env.LIVEKIT_API_KEY, nbf: now - 10, exp: now + 300, ...claims });
  return data + '.' + b64(new Uint8Array(await crypto.subtle.sign('HMAC', await key(env.LIVEKIT_API_SECRET, ['sign']), encoder.encode(data))));
}
async function controlToken(env, claims) {
  const data = encode({ ...claims, exp: Math.floor(Date.now() / 1000) + 1800 });
  const mac = await crypto.subtle.sign('HMAC', await key(env.BITHUMAN_API_SECRET, ['sign']), encoder.encode('nagi-bithuman-control-v1.' + data));
  return data + '.' + b64(new Uint8Array(mac));
}
async function readControl(env, value) {
  try {
    const [data, mac, extra] = String(value || '').split('.');
    if (!data || !mac || extra) throw new Error();
    const signature = Uint8Array.from(atob(mac.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
    if (!await crypto.subtle.verify('HMAC', await key(env.BITHUMAN_API_SECRET, ['verify']), signature, encoder.encode('nagi-bithuman-control-v1.' + data))) throw new Error();
    const claims = decode(data);
    if (claims.exp <= Date.now() / 1000 || !/^nagi-bh-[a-f0-9-]{36}$/.test(claims.room)) throw new Error();
    return claims;
  } catch { throw new Error('invalid_session_control'); }
}
function liveKitURL(env) {
  let url;
  try { url = new URL(env.LIVEKIT_URL); } catch { throw new Error('invalid_livekit_url'); }
  if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('invalid_livekit_url');
  return url;
}
async function roomCall(env, method, body, video) {
  const base = liveKitURL(env);
  base.protocol = 'https:';
  let token;
  try { token = await signLiveKit(env, { video }); } catch { throw new Error('livekit_token_signing_failed'); }
  let response;
  try {
    response = await fetch(new URL('/twirp/livekit.RoomService/' + method, base), {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch { throw new Error('livekit_network_request_failed'); }
  if (!response.ok && !(method === 'DeleteRoom' && response.status === 404)) throw new Error('livekit_' + method + '_http_' + response.status);
  return response;
}
export async function handleBithumanLive(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/bithuman-live/')) return null;
  const headers = { 'Access-Control-Allow-Origin': ORIGIN, 'Cache-Control': 'no-store', Vary: 'Origin' };
  const send = (data, status = 200) => Response.json(data, { status, headers });
  if (request.headers.get('Origin') !== ORIGIN) return new Response('Forbidden', { status: 403 });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
  const action = url.pathname.slice('/bithuman-live/'.length);
  if (!['health', 'verify', 'prepare', 'start', 'stop'].includes(action)) return send({ ok: false, error: 'not_found' }, 404);
  if (request.method !== (['health', 'verify'].includes(action) ? 'GET' : 'POST')) return send({ ok: false, error: 'method_not_allowed' }, 405);
  const missing = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'BITHUMAN_API_SECRET', 'ELEVENLABS_API_KEY'].filter(name => !env[name]);
  if (action === 'health') return send({ ok: missing.length === 0, configured: missing.length === 0, missing, agent_code: env.BITHUMAN_AGENT_CODE || 'A17VAN5175', max_session_seconds: 300 });
  if (missing.length) return send({ ok: false, error: 'missing_configuration', missing }, 503);
  try {
    liveKitURL(env);
    if (action === 'verify') {
      await roomCall(env, 'ListRooms', {}, { roomList: true });
      return send({ ok: true, livekit_authenticated: true });
    }
    if (action === 'prepare') {
      const room = 'nagi-bh-' + crypto.randomUUID();
      await roomCall(env, 'CreateRoom', { name: room, emptyTimeout: 30, departureTimeout: 10, maxParticipants: 3 }, { roomCreate: true });
      const grant = { roomJoin: true, room, canPublish: false, canSubscribe: true };
      return send({ ok: true, url: env.LIVEKIT_URL, viewer_token: await signLiveKit(env, { sub: 'nagi-viewer', video: { ...grant, canPublishData: false } }), sender_token: await signLiveKit(env, { sub: SENDER, kind: 'agent', video: { ...grant, canPublishData: true } }), control: await controlToken(env, { room }), max_session_seconds: 300 });
    }
    let input;
    try { input = await request.json(); } catch { return send({ ok: false, error: 'invalid_json' }, 400); }
    const claims = await readControl(env, input.control);
    if (action === 'stop') {
      let ended = !claims.session_id;
      if (claims.session_id) {
        try {
          const response = await fetch('https://api.bithuman.ai/v1/runtime-sessions/' + encodeURIComponent(claims.session_id) + '/end', { method: 'POST', headers: { 'api-secret': env.BITHUMAN_API_SECRET } });
          ended = response.ok;
        } catch { ended = false; }
      }
      await roomCall(env, 'DeleteRoom', { room: claims.room }, { roomCreate: true });
      return send({ ok: true, room_deleted: true, session_end_acknowledged: ended });
    }
    if (claims.session_id) return send({ ok: false, error: 'session_already_started' }, 409);
    const avatarToken = await signLiveKit(env, { sub: AVATAR, kind: 'agent', attributes: { 'lk.publish_on_behalf': SENDER }, video: { roomJoin: true, room: claims.room, canPublish: true, canPublishData: true, canSubscribe: true } });
    const response = await fetch('https://api.bithuman.ai/v1/runtime-tokens/request', {
      method: 'POST', headers: { 'api-secret': env.BITHUMAN_API_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'gpu', model: 'essence-2', agent_id: env.BITHUMAN_AGENT_CODE || 'A17VAN5175', livekit_url: env.LIVEKIT_URL, livekit_token: avatarToken, room_name: claims.room }),
    });
    let result; try { result = await response.json(); } catch { result = null; }
    if (!response.ok || result?.avatar_session_started !== true || !result?.session_id) {
      await roomCall(env, 'DeleteRoom', { room: claims.room }, { roomCreate: true });
      return send({ ok: false, error: 'bithuman_start_failed', upstream_status: response.status }, 502);
    }
    return send({ ok: true, session_id: result.session_id, model: result.model, control: await controlToken(env, { room: claims.room, session_id: result.session_id }) });
  } catch (error) {
    const message = error?.message || '';
    const safe = /^(invalid_session_control|invalid_livekit_url|livekit_token_signing_failed|livekit_network_request_failed|livekit_[A-Za-z]+_http_\d+)$/.test(message) ? message : 'live_session_request_failed';
    return send({ ok: false, error: safe }, safe === 'invalid_session_control' ? 403 : 502);
  }
}

