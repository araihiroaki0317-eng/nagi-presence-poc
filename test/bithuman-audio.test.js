import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Node cannot load cloudflare:workers. Stub only the unused RPC base class;
// run the real fetch handler and audio converter with mocked upstream APIs.
let source = await readFile(new URL('../worker/nagi-voice-transport.js', import.meta.url), 'utf8');
source = source.replace("import { WorkerEntrypoint } from 'cloudflare:workers';", 'class WorkerEntrypoint {}');
source = source.replaceAll("'../runtime/", "'" + new URL('../runtime/', import.meta.url).href);
const { default: worker, pcm16ToWav } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

test('WAV exposes exact duration and preserves every PCM sample', () => {
  const pcm = new Uint8Array(32000);
  pcm.set([0x00, 0x80, 0xff, 0x7f]);
  const wav = pcm16ToWav(pcm.buffer);
  const header = new DataView(wav.buffer);
  assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(wav.subarray(8, 12)), 'WAVE');
  assert.equal(header.getUint32(4, true), wav.length - 8);
  assert.equal(header.getUint16(20, true), 1);
  assert.equal(header.getUint16(22, true), 1);
  assert.equal(header.getUint32(24, true), 16000);
  assert.equal(header.getUint16(32, true), 2);
  assert.equal(header.getUint16(34, true), 16);
  assert.equal(header.getUint32(40, true) / header.getUint32(28, true), 1);
  assert.deepEqual(wav.subarray(44), pcm);
  assert.throws(() => pcm16ToWav(new ArrayBuffer(0)));
  assert.throws(() => pcm16ToWav(new ArrayBuffer(3)));
});

test('signed audio is fetched as PCM and served as WAV; failures remain visible', async t => {
  const origin = 'https://araihiroaki0317-eng.github.io';
  const base = 'https://worker.example';
  const env = { BITHUMAN_API_SECRET: 'test-only-secret', ELEVENLABS_API_KEY: 'test-only-key' };
  let audioUrl;
  let speechCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://api.bithuman.ai/v1/video/generate') {
      const body = JSON.parse(options.body);
      assert.equal(body.agent_code, 'A52DHS2219');
      assert.equal(body.model, 'essence-2');
      audioUrl = body.input.audio_url;
      assert.equal(new URL(audioUrl).pathname, '/bithuman-test-audio.wav');
      const response = await worker.fetch(new Request(audioUrl), env);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Content-Type'), 'audio/wav');
      const bytes = await response.arrayBuffer();
      assert.equal(bytes.byteLength, 32044);
      assert.equal(response.headers.get('Content-Length'), '32044');
      assert.equal(new DataView(bytes).getUint32(40, true), 32000);
      return Response.json({ success: true, status: 'failed', job_id: 'vid_test', error: { message: 'upstream failure' } });
    }
    if (url.includes('/convai/agents/')) return Response.json({ conversation_config: { tts: { voice_id: 'voice-test' } } });
    assert.ok(url.endsWith('?output_format=pcm_16000'));
    speechCalls++;
    return new Response(new Uint8Array(32000));
  });
  const response = await worker.fetch(new Request(base + '/bithuman-test-render', { method: 'POST', headers: { Origin: origin } }), env);
  const result = await response.json();
  assert.equal(result.ok, false);
  assert.equal(result.error.message, 'upstream failure');
  assert.equal(result.audio_format, 'wav_pcm_s16le_16000_mono');
  assert.equal(JSON.stringify(result).includes(env.BITHUMAN_API_SECRET), false);
  const tampered = new URL(audioUrl);
  tampered.searchParams.set('sig', 'invalid');
  assert.equal((await worker.fetch(new Request(tampered), env)).status, 403);
  tampered.searchParams.set('exp', String(Date.now() - 1));
  assert.equal((await worker.fetch(new Request(tampered), env)).status, 403);
  assert.equal(speechCalls, 1);
});
