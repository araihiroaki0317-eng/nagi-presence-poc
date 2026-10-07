import test from 'node:test';
import assert from 'node:assert/strict';
import { readNagiVoiceConfiguration } from '../runtime/nagi-voice-configuration.js';
test('fixed GET and whitelist keep upstream secrets and prompts private', async () => {
 let calls = 0;
 const result = await readNagiVoiceConfiguration({ELEVENLABS_API_KEY:'test-secret'}, async (url, init) => {
  calls++;
  assert.match(url, /\/v1\/convai\/agents\/agent_/);
  assert.equal(init.method, 'GET');
  assert.equal(init.headers['xi-api-key'], 'test-secret');
  return Response.json({secret:'private',conversation_config:{agent:{prompt:'private'},tts:{voice_id:'voice',model_id:'model',stability:0.7,speed:1,similarity_boost:Infinity,secret:'private'}}});
 });
 assert.equal(calls, 1);
 assert.equal(result.voice_id, 'voice');
 assert.equal(result.configured_voice_settings.stability, 0.7);
 assert.equal(result.configured_voice_settings.similarity_boost, null);
 assert.ok(!JSON.stringify(result).includes('private'));
 assert.ok(!JSON.stringify(result).includes('test-secret'));
});
test('missing model records transport fallback and missing settings remain null', async () => {
 const result = await readNagiVoiceConfiguration({ELEVENLABS_API_KEY:'x'}, async () => Response.json({conversation_config:{tts:{voice_id:'v'}}}));
 assert.equal(result.configured_model_id, null);
 assert.equal(result.transport_model_id, 'eleven_multilingual_v2');
 assert.equal(result.configured_voice_settings.speed, null);
});
test('fails closed without key or valid upstream TTS', async () => {
 await assert.rejects(readNagiVoiceConfiguration({},()=>{throw Error('must not call')}), /missing_elevenlabs_secret/);
 await assert.rejects(readNagiVoiceConfiguration({ELEVENLABS_API_KEY:'x'},async()=>new Response('secret',{status:403})), /^Error: elevenlabs_configuration_failed:403$/);
 await assert.rejects(readNagiVoiceConfiguration({ELEVENLABS_API_KEY:'x'},async()=>Response.json({})), /tts_configuration_missing/);
});
