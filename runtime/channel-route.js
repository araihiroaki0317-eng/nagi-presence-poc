export const INPUT_CHANNELS = Object.freeze({
  TEXT: 'text',
  AUDIO: 'audio',
});

export const OUTPUT_CHANNELS = Object.freeze({
  TEXT: 'text',
  AUDIO: 'audio',
});

const INPUT_VALUES = new Set(Object.values(INPUT_CHANNELS));
const OUTPUT_VALUES = new Set(Object.values(OUTPUT_CHANNELS));

export function normalizeChannelRoute(route = {}) {
  const inputChannel = route.inputChannel || INPUT_CHANNELS.TEXT;
  const outputChannels = Array.from(new Set(route.outputChannels || [OUTPUT_CHANNELS.TEXT]));

  if (!INPUT_VALUES.has(inputChannel)) throw new Error('invalid_input_channel');
  if (!outputChannels.length || outputChannels.some(channel => !OUTPUT_VALUES.has(channel))) {
    throw new Error('invalid_output_channels');
  }

  return Object.freeze({ inputChannel, outputChannels: Object.freeze(outputChannels) });
}
