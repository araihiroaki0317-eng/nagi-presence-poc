// Compatibility surface while the live route is migrated to ConversationCore.
export {
  CONVERSATION_PROFILES,
  routeForProfile,
  sessionOptionsFor,
} from './conversation-profile.js';
export { MockConversationAdapter, ProviderConversationAdapter } from './mock-conversation-adapter.js';
export {
  LegacyElevenLabsConversationAdapter,
  LegacyElevenLabsConversationAdapter as ElevenLabsConversationAdapter,
  LazyElevenLabsConversationAdapter,
} from '../providers/legacy-elevenlabs-adapter.js';
