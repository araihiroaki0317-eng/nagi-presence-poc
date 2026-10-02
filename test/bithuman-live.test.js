import test from 'node:test';
import assert from 'node:assert/strict';
import { handleBithumanLive } from '../runtime/bithuman-live-server.js';
import { createBithumanOutput, createAudioAttachmentGate } from '../runtime/bithuman-live-output.js';
const origin = 'https://araihiroaki0317-eng.github.io';
const env = { LIVEKIT_URL: 'wss://example.livekit.cloud', LIVEKIT_API_KEY: 'test-key', LIVEKIT_API_SECRET: 'test-secret', BITHUMAN_API_SECRET: 'test-bithuman', ELEVENLABS_API_KEY: 'test-eleven' };
const request = (action, body, site = origin) => new Request('https://worker.example/bithuman-live/' + action, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: site, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const jwtClaims = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));

test('missing credentials fail closed without launching or revealing secrets', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('must not call upstream'); });
  const health = await (await handleBithumanLive(request('health'), {})).json();
  assert.equal(health.configured, false);
  assert.ok(health.missing.includes('LIVEKIT_API_SECRET'));
  assert.equal((await handleBithumanLive(request('prepare', {}), {})).status, 503);
  assert.equal((await handleBithumanLive(request('prepare', {}, 'https://other.example'), env)).status, 403);
});

test('session uses separate viewer/sender grants and scoped stop capability', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(String(url));
    if (String(url).includes('/twirp/')) {
      const token = options.headers.Authorization.slice(7);
      const claims = jwtClaims(token);
      const [head, payload, signature] = token.split('.');
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.LIVEKIT_API_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
      assert.ok(await crypto.subtle.verify('HMAC', key, Buffer.from(signature, 'base64url'), new TextEncoder().encode(head + '.' + payload)));
      assert.equal(claims.iss, env.LIVEKIT_API_KEY);
      return Response.json({});
    }
    if (String(url).endsWith('/runtime-tokens/request')) {
      const body = JSON.parse(options.body);
      const avatar = jwtClaims(body.livekit_token);
      assert.equal(body.mode, 'gpu'); assert.equal(body.model, 'essence-2');
      assert.equal(avatar.sub, 'bithuman-avatar-agent');
      assert.equal(avatar.kind, 'agent');
      assert.equal(avatar.attributes['lk.publish_on_behalf'], 'nagi-audio-sender');
      assert.equal(JSON.stringify(avatar).includes(env.BITHUMAN_API_SECRET), false);
      return Response.json({ avatar_session_started: true, session_id: 'cs_test', model: 'essence-2' });
    }
    assert.ok(String(url).endsWith('/runtime-sessions/cs_test/end'));
    return Response.json({ ended: true });
  });
  const prep = await (await handleBithumanLive(request('prepare', {}), env)).json();
  const viewer = jwtClaims(prep.viewer_token), sender = jwtClaims(prep.sender_token);
  assert.equal(viewer.video.room, sender.video.room);
  assert.equal(viewer.kind, undefined); assert.equal(sender.kind, 'agent');
  assert.equal(viewer.video.canPublish, false); assert.equal(sender.video.canPublishData, true);
  assert.equal(JSON.stringify(prep).includes(env.LIVEKIT_API_SECRET), false);
  const bad = await handleBithumanLive(request('start', { control: prep.control + 'x' }), env);
  assert.equal(bad.status, 403);
  assert.equal(calls.length, 1);
  const start = await (await handleBithumanLive(request('start', { control: prep.control }), env)).json();
  assert.equal(start.session_id, 'cs_test');
  const stop = await (await handleBithumanLive(request('stop', { control: start.control }), env)).json();
  assert.equal(stop.room_deleted, true); assert.equal(stop.session_end_acknowledged, true);
  assert.ok(calls.at(-1).endsWith('/DeleteRoom'));
});

test('rejected avatar launch deletes the prepared room', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(String(url));
    return String(url).includes('bithuman.ai') ? Response.json({ error: 'no capacity' }, { status: 503 }) : Response.json({});
  });
  const prep = await (await handleBithumanLive(request('prepare', {}), env)).json();
  const failed = await handleBithumanLive(request('start', { control: prep.control }), env);
  assert.equal(failed.status, 502); assert.ok(calls.at(-1).endsWith('/DeleteRoom'));
});

test('stop still deletes the room when the provider end request loses its connection', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(String(url));
    if (String(url).endsWith('/end')) throw new Error('network failed');
    if (String(url).includes('bithuman.ai')) return Response.json({ avatar_session_started: true, session_id: 'cs_test', model: 'essence-2' });
    return Response.json({});
  });
  const prep = await (await handleBithumanLive(request('prepare', {}), env)).json();
  const start = await (await handleBithumanLive(request('start', { control: prep.control }), env)).json();
  const stopped = await (await handleBithumanLive(request('stop', { control: start.control }), env)).json();
  assert.equal(stopped.room_deleted, true);
  assert.equal(stopped.session_end_acknowledged, false);
  assert.ok(calls.at(-1).endsWith('/DeleteRoom'));
});

test('audio delivery preserves split PCM samples and waits for avatar playback', async () => {
  const handlers = {}, chunks = [];
  let source;
  let closed = false;
  const room = { registerRpcMethod: (name, handler) => { handlers[name] = handler; }, localParticipant: { streamBytes: async options => {
    assert.equal(options.topic, 'lk.audio_stream');
    assert.deepEqual(options.destinationIdentities, ['bithuman-avatar-agent']);
    assert.equal(options.attributes.sample_rate, '16000');
    return { write: async bytes => { assert.equal(bytes.length % 2, 0); chunks.push(...bytes); }, close: async () => { closed = true; queueMicrotask(() => handlers['lk.playback_finished']({ callerIdentity: 'bithuman-avatar-agent' })); } };
  } } };
  const output = createBithumanOutput({ room, endpoint: 'https://tts.example', fetchImpl: async (url, options) => {
    assert.equal(JSON.parse(options.body).output_format, 'pcm_16000');
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.of(1)); controller.enqueue(Uint8Array.of(2, 3, 4)); controller.close(); } }));
  } });
  assert.deepEqual(await output.speak('こんにちは', { onSourceAudio: blob => { source = blob; } }), { ok: true });
  assert.deepEqual(chunks, [1, 2, 3, 4]); assert.equal(closed, true);
  const wav = new Uint8Array(await source.arrayBuffer());
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), 'RIFF');
  assert.equal(new DataView(wav.buffer).getUint32(40, true), 4);
  assert.deepEqual(Array.from(wav.slice(44)), chunks);
});

test('missing playback confirmation is an error, not success', async () => {
  const room = { registerRpcMethod() {}, localParticipant: { streamBytes: async () => ({ write: async () => {}, close: async () => {} }) } };
  const output = createBithumanOutput({ room, endpoint: 'https://tts.example', timeoutMs: 5, fetchImpl: async () => new Response(Uint8Array.of(1, 2)) });
  assert.equal((await output.speak('test')).ok, false);
});


test('verification distinguishes invalid URLs, network errors and authentication failures without leaking values', async t => {
  const invalid = await (await handleBithumanLive(request('verify'), { ...env, LIVEKIT_URL: 'invalid' })).json();
  assert.equal(invalid.error, 'invalid_livekit_url');
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('sensitive upstream details'); });
  const network = await (await handleBithumanLive(request('verify'), env)).json();
  assert.deepEqual(network, { ok: false, error: 'livekit_network_request_failed' });
  t.mock.method(globalThis, 'fetch', async () => new Response('sensitive details', { status: 401 }));
  const auth = await (await handleBithumanLive(request('verify'), env)).json();
  assert.deepEqual(auth, { ok: false, error: 'livekit_ListRooms_http_401' });
});

test('audio prebuffer waits for 750ms of PCM and drains a short reply without padding', async () => {
  const handlers = {}, chunks = [], timings = [];
  let input;
  const room = { registerRpcMethod: (name, handler) => { handlers[name] = handler; }, localParticipant: {
    streamBytes: async () => ({
      write: async bytes => chunks.push(bytes.slice()),
      close: async () => { await handlers['lk.playback_finished']({ callerIdentity: 'bithuman-avatar-agent' }); },
    }),
  } };
  const output = createBithumanOutput({ room, endpoint: 'https://tts.example', onTiming: event => timings.push(event),
    fetchImpl: async () => new Response(new ReadableStream({ start(controller) { input = controller; } })),
  });
  const result = output.speak('buffered reply');
  await new Promise(resolve => setImmediate(resolve));
  input.enqueue(new Uint8Array(12000).fill(1));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(chunks.length, 0);
  input.enqueue(new Uint8Array(12000).fill(2));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].length, 24000);
  input.enqueue(Uint8Array.of(3, 4));
  input.close();
  assert.deepEqual(await result, { ok: true });
  assert.equal(chunks[1].length, 2);
  assert.equal(timings.find(x => x.stage === 'reply_audio_duration_ms').ms, 24002 / 32);
  assert.ok(timings.some(x => x.stage === 'tts_receive_max_wait_ms'));
  // EOF before the prebuffer threshold still sends exactly the short reply.
  chunks.length = 0;
  const short = createBithumanOutput({ room, endpoint: 'https://tts.example', fetchImpl: async () => new Response(Uint8Array.of(7, 8)) });
  assert.deepEqual(await short.speak('short reply'), { ok: true });
  assert.deepEqual(Array.from(chunks[0]), [7, 8]);
});

test('audio waits for attachment without duplicating samples or adding a fixed delay', async () => {
  const gate = createAudioAttachmentGate(), handlers = {};
  let streams = 0;
  const chunks = [];
  const room = { registerRpcMethod: (name, fn) => { handlers[name] = fn; }, localParticipant: {
    streamBytes: async () => {
      streams++;
      return { write: async bytes => chunks.push(...bytes), close: async () => handlers['lk.playback_finished']({ callerIdentity: 'bithuman-avatar-agent' }) };
    },
  } };
  const output = createBithumanOutput({ room, endpoint: 'test', beforeSend: signal => gate.wait(signal),
    fetchImpl: async () => new Response(Uint8Array.of(1, 2, 3, 4)) });
  const speaking = output.speak('greeting');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(streams, 0);
  gate.attach();
  assert.deepEqual(await speaking, { ok: true });
  assert.deepEqual(chunks, [1, 2, 3, 4]);
  assert.deepEqual(await output.speak('next turn'), { ok: true });
  assert.equal(streams, 2);
});

test('attachment wait cancels, times out, and rejects after session close', async () => {
  const gate = createAudioAttachmentGate(), controller = new AbortController();
  const pending = gate.wait(controller.signal);
  controller.abort();
  await assert.rejects(pending, /audio_session_ended/);
  await assert.rejects(gate.wait(undefined, 5), /audio_track_timeout/);
  const ending = gate.wait();
  gate.close();
  await assert.rejects(ending, /audio_session_ended/);
  gate.attach();
  await assert.rejects(gate.wait(), /audio_session_ended/);
});
