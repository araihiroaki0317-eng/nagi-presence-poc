import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTENTION_ACKNOWLEDGEMENT,
  ATTENTION_SEQUENCE,
  createAttentionAcknowledgement,
  isNagiWakeCall,
} from '../runtime/attention.js';

test('wake call accepts exact Nagi forms with light punctuation', () => {
  for (const value of ['凪', '凪？', ' なぎ ', 'ナギ！', 'Nagi', 'nagi...']) {
    assert.equal(isNagiWakeCall(value), true, value);
  }
});

test('wake call does not swallow normal conversation containing the name', () => {
  for (const value of ['凪さん', '凪、ちょっと聞いて', '今日は凪と話したい', 'nagi please']) {
    assert.equal(isNagiWakeCall(value), false, value);
  }
});

test('attention acknowledgement is deterministic and non-inferential', () => {
  const event = createAttentionAcknowledgement({
    transcript: '凪？',
    input_channel: 'voice',
    source: 'sdk',
  });
  assert.equal(event.event_type, 'attention_acknowledged');
  assert.equal(event.acknowledgement, ATTENTION_ACKNOWLEDGEMENT);
  assert.deepEqual(event.sequence, ATTENTION_SEQUENCE);
  assert.equal(event.input_channel, 'voice');
  assert.equal(event.source, 'sdk');
});

test('non-wake utterance produces no acknowledgement', () => {
  assert.equal(createAttentionAcknowledgement({ transcript: '凪、これ見て' }), null);
});
