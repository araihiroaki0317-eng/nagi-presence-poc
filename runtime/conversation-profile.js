import { INPUT_CHANNELS, OUTPUT_CHANNELS } from './channel-route.js';

export const CONVERSATION_PROFILES = Object.freeze({
  VOICE: 'voice',
  TEXT_AUDIO: 'text_audio',
  TEXT_SILENT: 'text_silent',
});

const VALID_PROFILES = new Set(Object.values(CONVERSATION_PROFILES));

export function assertConversationProfile(profile) {
  if (!VALID_PROFILES.has(profile)) throw new Error('invalid_conversation_profile');
}

export function sessionOptionsFor(profile, callbacks = {}) {
  assertConversationProfile(profile);
  const textOnly = profile === CONVERSATION_PROFILES.TEXT_SILENT;
  return {
    ...callbacks,
    connectionType: textOnly ? 'websocket' : 'webrtc',
    textOnly,
    micMuted: profile === CONVERSATION_PROFILES.TEXT_AUDIO,
    ...(textOnly ? { overrides: { conversation: { textOnly: true } } } : {}),
  };
}

export function routeForProfile(profile) {
  assertConversationProfile(profile);
  if (profile === CONVERSATION_PROFILES.VOICE) {
    return { inputChannel: INPUT_CHANNELS.AUDIO, outputChannels: [OUTPUT_CHANNELS.TEXT, OUTPUT_CHANNELS.AUDIO] };
  }
  if (profile === CONVERSATION_PROFILES.TEXT_AUDIO) {
    return { inputChannel: INPUT_CHANNELS.TEXT, outputChannels: [OUTPUT_CHANNELS.TEXT, OUTPUT_CHANNELS.AUDIO] };
  }
  return { inputChannel: INPUT_CHANNELS.TEXT, outputChannels: [OUTPUT_CHANNELS.TEXT] };
}
