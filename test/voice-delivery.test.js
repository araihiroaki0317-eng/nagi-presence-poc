import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareVoiceText } from '../runtime/voice-delivery.js';
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
