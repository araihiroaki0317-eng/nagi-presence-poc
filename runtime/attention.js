export const ATTENTION_ACKNOWLEDGEMENT = 'ん？';

export const ATTENTION_SEQUENCE = Object.freeze([
  'attention_start',
  'gaze',
  'head_up',
  'expression_soften',
  'listening',
]);

const WAKE_FORMS = new Set(['凪', 'なぎ', 'ナギ', 'nagi']);

function normalizeWakeText(value) {
  return String(value || '')
    .trim()
    .replace(/[\s　]+/g, '')
    .replace(/[、。！？!?….．]+$/g, '')
    .toLowerCase();
}

export function isNagiWakeCall(value) {
  return WAKE_FORMS.has(normalizeWakeText(value));
}

export function createAttentionAcknowledgement({
  transcript,
  input_channel = null,
  source = 'unknown',
} = {}) {
  if (!isNagiWakeCall(transcript)) return null;

  return {
    event_type: 'attention_acknowledged',
    acknowledgement: ATTENTION_ACKNOWLEDGEMENT,
    sequence: [...ATTENTION_SEQUENCE],
    input_channel,
    source,
  };
}
