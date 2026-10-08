import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareVoiceText, prepareVoiceSettings } from '../runtime/voice-delivery.js';
test('accepted baseline and unsupported models remain untagged', () => {
  const text = 'おはよう、ひろくん。';
  assert.equal(prepareVoiceText(text, { modelId: 'eleven_v3_conversational' }), text);
  assert.equal(prepareVoiceText(text, { delivery: 'soft', modelId: 'eleven_multilingual_v2' }), text);
});
test('soft direction reaches supported speech models without changing source text', () => {
  const turn = { text: 'うん、急がなくていいよ。' };
  const spoken = prepareVoiceText(turn.text, { delivery: 'soft', modelId: 'eleven_v3_conversational' });
  assert.equal(spoken, '[softly] うん、急がなくていいよ。');
  assert.equal(turn.text, 'うん、急がなくていいよ。');
});

test('steady candidate changes only stability and does not mutate baseline', () => {
  const baseline = { voice_settings: { stability: .5, speed: 1, similarity_boost: .8 } };
  const trial = prepareVoiceSettings(baseline, { delivery: 'steady', modelId: 'eleven_v3_conversational' });
  assert.deepEqual(trial, { voice_settings: { stability: 1, speed: 1, similarity_boost: .8 } });
  assert.equal(baseline.voice_settings.stability, .5);
  for (const delivery of [undefined, 'soft', 'unknown']) {
    assert.strictEqual(prepareVoiceSettings(baseline, { delivery, modelId: 'eleven_v3_conversational' }), baseline);
  }
  assert.strictEqual(prepareVoiceSettings(baseline, { delivery: 'steady', modelId: 'eleven_multilingual_v2' }), baseline);
  assert.equal(prepareVoiceText('ひろくん', { delivery: 'steady', modelId: 'eleven_v3_conversational' }), 'ひろくん');
});
