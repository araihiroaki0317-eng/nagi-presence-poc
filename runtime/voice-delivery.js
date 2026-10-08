// Opt-in speech direction; never change the transcript or memory text.
export function prepareVoiceText(text, { delivery, modelId } = {}) {
  if (delivery !== 'soft' || !['eleven_v3_conversational', 'eleven_v3', 'eleven_v4'].includes(modelId)) return text;
  return '[softly] ' + text;
}
