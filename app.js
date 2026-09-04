import { eventLog, runtimeEvent, runtimeState } from './runtime/runtime.js';
import { createCheckpoint, LocalStorageCheckpointStore, contextFromCheckpoint } from './runtime/checkpoint.js';
import {
  CONVERSATION_PROFILES,
  LazyElevenLabsConversationAdapter,
  MockConversationAdapter,
} from './runtime/conversation-adapter.js';
import { LocalTranscriptStore, transcriptContext } from './runtime/transcript.js';
import { budgetNoticeFromError, budgetNoticeFromEvent } from './runtime/budget-notice.js';
import { RouteAccessController } from './runtime/route-access.js';
import { selectFallbackRoute } from './runtime/fallback-router.js';
import { MockConversationProvider } from './providers/mock-provider.js';

const AGENT_ID = 'agent_8501m0nvtj12ea5vnc21ck26v9sp';
const BASE = './assets/';
const RESUME_KEY = 'nagi.m3a.resume.v1';
const SPEAKING_RELEASE_MS = 1000;
const MOCK_MODE = new URLSearchParams(location.search).get('mock') === '1';
const ACTIVE_PAID_ROUTE_ID = 'legacy-elevenlabs';
const FREE_TEXT_ROUTE_ID = 'mock-free-text';
const CORE_LIFECYCLE_EVENTS = new Set([
  'provider_connect_started',
  'provider_connected',
  'provider_connect_failed',
  'provider_disconnected',
  'logical_conversation_started',
  'logical_conversation_resumed',
  'logical_conversation_paused',
  'logical_conversation_closed',
]);

const motionAssets = {
  listening: BASE + 'listening_loop_v02.MP4',
  thinking: BASE + 'listening_loop_v02.MP4',
  speaking: BASE + 'speaking_loop_v02.MP4',
};

const states = {
  neutral: { img: BASE + 'neutral.jpg', label: 'NEUTRAL', caption: '話したくなったら、会話を始めてください。' },
  listening: { video: motionAssets.listening, label: 'LISTENING', caption: '聞いています。' },
  thinking: { video: motionAssets.thinking, label: 'THINKING', caption: '少し考えています。' },
  speaking: { video: motionAssets.speaking, label: 'SPEAKING', caption: '凪さんが話しています。' },
  warm: { img: BASE + 'warm.jpg', label: 'WARM', caption: '会話の余韻。' },
};

const byId = id => document.getElementById(id);
const portraitA = byId('portraitA');
const portraitB = byId('portraitB');
const motionVideo = byId('motionVideo');
const placeholder = byId('placeholder');
const stateEl = byId('state');
const captionEl = byId('caption');
const statusEl = byId('status');
const continuityEl = byId('continuity');
const debugEl = byId('debug');
const startVoiceBtn = byId('startVoice');
const startTextBtn = byId('startText');
const replyWithVoice = byId('replyWithVoice');
const stopBtn = byId('stop');
const conversationPanel = byId('conversationPanel');
const transcriptEl = byId('transcript');
const transcriptEmpty = byId('transcriptEmpty');
const unreadEl = byId('unread');
const composer = byId('composer');
const textInput = byId('textInput');
const sendTextBtn = byId('sendText');
const inspectLogBtn = byId('inspectLog');
const exportLogBtn = byId('exportLog');
const budgetNoticeEl = byId('budgetNotice');
const budgetMessageEl = byId('budgetMessage');
const budgetDismissBtn = byId('budgetDismiss');

const checkpointStore = new LocalStorageCheckpointStore();
const transcriptStore = new LocalTranscriptStore();
const routeAccess = new RouteAccessController();
const routeRegistry = MOCK_MODE ? [{
  route_id: FREE_TEXT_ROUTE_ID,
  available: true,
  billing: 'none',
  priority: 1,
  input_channels: ['text'],
  output_channels: ['text'],
}] : [];
let adapter;
if (MOCK_MODE) {
  adapter = new MockConversationAdapter({
    eventSink: event => {
      if (!CORE_LIFECYCLE_EVENTS.has(event.type)) return;
      return runtimeEvent(event.type, {
        session_id: sessionId,
        input_channel: event.input_channel,
        output_channel: event.output_channels?.join('+') || null,
        metadata: {
          conversation_id: event.conversation_id,
          provider_id: event.provider_id,
          provider_session_id: event.provider_session_id || null,
          reason: event.reason || null,
        },
      });
    },
  });
} else {
  adapter = new LazyElevenLabsConversationAdapter({ agentId: AGENT_ID });
}

let loadSeq = 0;
let lastMode = '';
let ending = false;
let connecting = false;
let front = portraitA;
let back = portraitB;
let currentImg = '';
let currentVideo = '';
let currentState = 'neutral';
let currentProfile = null;
let listeningTimer = null;
let sessionId = null;
let turnNumber = 0;
let unreadCount = 0;
let resumable = localStorage.getItem(RESUME_KEY) === '1';
const revealTimers = new Map();

const safe = value => {
  try { return typeof value === 'string' ? value : JSON.stringify(value); }
  catch { return String(value); }
};
const stamp = () => new Date().toLocaleTimeString('ja-JP', { hour12: false });

function debug(type, data = '') {
  const line = `${stamp()} ${type}${data !== '' ? ' ' + safe(data) : ''}`;
  debugEl.textContent = (debugEl.textContent === 'ready' ? '' : debugEl.textContent + '\n') + line;
  debugEl.scrollTop = debugEl.scrollHeight;
}

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

function textFallbackSelection() {
  return selectFallbackRoute({
    fromRouteId: ACTIVE_PAID_ROUTE_ID,
    routes: routeRegistry,
    accessController: routeAccess,
    inputChannel: 'text',
    outputChannel: 'text',
  });
}

async function activateTextFallback(route) {
  if (!route || typeof adapter.switchToTextFallback !== 'function') return false;
  const priorContext = contextForResume();
  await adapter.switchToTextFallback({
    provider: new MockConversationProvider(),
    context: priorContext,
  });
  currentProfile = CONVERSATION_PROFILES.TEXT_SILENT;
  setStatus('chat: fallback connected', 'live');
  continuityEl.textContent = 'conversation: continued in text';
  continuityEl.className = 'continuity ready';
  conversationPanel.open = true;
  updateControls();
  runtimeEvent('fallback_route_activated', {
    session_id: sessionId,
    metadata: { from_route: ACTIVE_PAID_ROUTE_ID, to_route: route.route_id },
  });
  return true;
}

function showBudgetNotice(notice) {
  if (!notice) return;
  budgetNoticeEl.hidden = false;
  budgetNoticeEl.dataset.severity = notice.severity;
  budgetMessageEl.textContent = notice.message;
  budgetDismissBtn.textContent = notice.severity === 'hard' ? '閉じる' : '確認';
  if (notice.severity === 'hard') {
    routeAccess.lockRoute({
      routeId: ACTIVE_PAID_ROUTE_ID,
      reason: notice.reasons[0] || notice.code,
      sourceEventId: sessionId,
    });
    const fallback = textFallbackSelection();
    if (fallback.route) {
      budgetMessageEl.textContent = `${notice.message} 文字で同じ会話を続けます。`;
      setStatus('voice: paused / switching to chat', 'error');
      activateTextFallback(fallback.route).catch(error => {
        debug('FALLBACK_FAILED', error?.message || error);
        setStatus('paid route: paused', 'error');
        updateControls();
      });
    } else {
      setStatus('paid route: paused', 'error');
    }
    updateControls();
  }
  runtimeEvent(
    notice.severity === 'hard' ? 'budget_hard_limit_reached' : 'budget_soft_limit_reached',
    {
      session_id: sessionId,
      metadata: { code: notice.code, reasons: notice.reasons },
    },
  );
}

function hideBudgetNotice() {
  budgetNoticeEl.hidden = true;
  budgetNoticeEl.removeAttribute('data-severity');
}

function setResumable(value) {
  resumable = Boolean(value);
  localStorage.setItem(RESUME_KEY, resumable ? '1' : '0');
  continuityEl.textContent = resumable ? 'conversation: resumable' : 'conversation: new';
  continuityEl.className = 'continuity' + (resumable ? ' ready' : '');
}

function selectedTextProfile() {
  return replyWithVoice.checked
    ? CONVERSATION_PROFILES.TEXT_AUDIO
    : CONVERSATION_PROFILES.TEXT_SILENT;
}

function updateControls() {
  const active = adapter.active || connecting;
  const paidRouteBlocked = !routeAccess.canUse(ACTIVE_PAID_ROUTE_ID);
  const textFallbackAvailable = Boolean(textFallbackSelection().route);
  startVoiceBtn.disabled = connecting || paidRouteBlocked;
  startTextBtn.disabled = connecting || (paidRouteBlocked && !textFallbackAvailable);
  stopBtn.disabled = !active;
  sendTextBtn.disabled = connecting || (paidRouteBlocked && !textFallbackAvailable);
  startVoiceBtn.classList.toggle('active', currentProfile === CONVERSATION_PROFILES.VOICE);
  startTextBtn.classList.toggle('active', currentProfile === CONVERSATION_PROFILES.TEXT_AUDIO || currentProfile === CONVERSATION_PROFILES.TEXT_SILENT);
  startVoiceBtn.textContent = currentProfile && currentProfile !== CONVERSATION_PROFILES.VOICE ? '🎙 声に切り替える' : '🎙 声で話す';
  startTextBtn.textContent = currentProfile === CONVERSATION_PROFILES.VOICE ? '⌨️ 文字に切り替える' : '⌨️ 文字で話す';
}

function messageText(message) {
  const value = message || {};
  const candidates = [value.message, value.text, value.content, value.message?.message, value.message?.text, value.message?.content];
  return candidates.find(item => typeof item === 'string' && item.trim())?.trim() || '';
}

function messageRole(message) {
  const value = message || {};
  const raw = [value.source, value.role, value.message?.source, value.message?.role].find(Boolean);
  const role = String(raw || 'unknown').toLowerCase();
  if (role.includes('user')) return 'user';
  if (role.includes('ai') || role.includes('agent') || role.includes('assistant')) return 'agent';
  return 'unknown';
}

function inputChannelFor(role, source) {
  if (role !== 'user') return null;
  if (source === 'typed') return 'text';
  return currentProfile === CONVERSATION_PROFILES.VOICE ? 'voice' : 'text';
}

function outputChannelFor(role) {
  if (role !== 'agent') return null;
  return currentProfile === CONVERSATION_PROFILES.TEXT_SILENT ? 'text' : 'voice_and_text';
}

function channelLabel(turn) {
  if (turn.role === 'user') return turn.input_channel === 'voice' ? '音声' : '文字';
  return turn.output_channel === 'voice_and_text' ? '音声＋文字' : '文字';
}

function revealChunks(text) {
  if (!globalThis.Intl?.Segmenter) return Array.from(text);
  const segments = Array.from(new Intl.Segmenter('ja', { granularity: 'word' }).segment(text), item => item.segment);
  const chunks = [];
  for (let index = 0; index < segments.length; index += 2) chunks.push(segments.slice(index, index + 2).join(''));
  return chunks;
}

function finishReveal(turnId, body, text) {
  const timer = revealTimers.get(turnId);
  if (timer) clearTimeout(timer);
  revealTimers.delete(turnId);
  body.textContent = text;
  body.parentElement?.classList.remove('revealing');
}

function revealAgentText(turnId, bubble, body, text) {
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reducedMotion || text.length > 320 || !conversationPanel.open) {
    body.textContent = text;
    return;
  }
  const chunks = revealChunks(text);
  let index = 0;
  bubble.classList.add('revealing');
  const step = () => {
    if (index >= chunks.length) return finishReveal(turnId, body, text);
    const chunk = chunks[index++];
    body.textContent += chunk;
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
    const pause = /[。！？…]$/.test(chunk) ? 150 : /、$/.test(chunk) ? 80 : 34;
    revealTimers.set(turnId, setTimeout(step, pause));
  };
  bubble.addEventListener('click', () => finishReveal(turnId, body, text), { once: true });
  step();
}

function createTurnElement(turn, animate = false) {
  const bubble = document.createElement('div');
  bubble.className = `turn ${turn.role}`;
  bubble.dataset.turnId = turn.turn_id;
  bubble.setAttribute('aria-label', `${turn.role === 'user' ? 'ヒロ' : '凪'}: ${turn.text}`);
  const body = document.createElement('span');
  const meta = document.createElement('span');
  meta.className = 'turn-meta';
  meta.textContent = channelLabel(turn);
  bubble.append(body, meta);
  if (animate && turn.role === 'agent') revealAgentText(turn.turn_id, bubble, body, turn.text);
  else body.textContent = turn.text;
  return bubble;
}

function updateExistingTurn(turn) {
  const bubble = transcriptEl.querySelector(`[data-turn-id="${CSS.escape(turn.turn_id)}"]`);
  if (!bubble) return false;
  finishReveal(turn.turn_id, bubble.firstElementChild, turn.text);
  bubble.setAttribute('aria-label', `${turn.role === 'user' ? 'ヒロ' : '凪'}: ${turn.text}`);
  return true;
}

function appendTurnElement(turn, animate = false) {
  transcriptEmpty.hidden = true;
  transcriptEl.append(createTurnElement(turn, animate));
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  if (!conversationPanel.open && turn.role === 'agent') {
    unreadCount += 1;
    unreadEl.textContent = String(unreadCount);
    unreadEl.hidden = false;
  }
}

function renderStoredTranscript() {
  const turns = transcriptStore.read();
  if (!turns.length) return;
  transcriptEmpty.hidden = true;
  turns.forEach(turn => transcriptEl.append(createTurnElement(turn)));
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

async function recordTurn({ role, text, source = 'sdk' }) {
  const result = transcriptStore.append({
    role,
    text,
    source,
    input_channel: inputChannelFor(role, source),
    output_channel: outputChannelFor(role),
  });
  if (result.duplicate) return result;
  if (result.replaced) updateExistingTurn(result.turn);
  else appendTurnElement(result.turn, source === 'sdk');

  turnNumber += 1;
  const logged = await runtimeEvent(role === 'user' ? 'user_utterance' : 'assistant_response', {
    session_id: sessionId,
    turn_id: result.turn.turn_id,
    speaker: role === 'user' ? 'hiro' : 'nagi',
    transcript: text,
    input_channel: result.turn.input_channel,
    output_channel: result.turn.output_channel,
    transcript_source: source,
  });
  if (role === 'agent') saveCheckpoint(logged.event.event_id, 'completed_turn');
  return result;
}

function contextForResume() {
  const checkpoint = checkpointStore.readLatest();
  if (checkpoint) return contextFromCheckpoint(checkpoint);
  return transcriptContext(transcriptStore.read());
}

function saveCheckpoint(sourceEventId, reason = 'periodic') {
  const state = runtimeState.snapshot();
  const checkpoint = createCheckpoint({
    source_event_id: sourceEventId,
    active_project: state.active_project,
    mode_override: state.mode_override,
    role_override: state.role_override,
    recent_turns: transcriptStore.read().slice(-8),
    reason,
  });
  checkpointStore.save(checkpoint);
  runtimeState.setCheckpoint(checkpoint.checkpoint_id);
  runtimeEvent('checkpoint_created', {
    session_id: sessionId,
    parent_event_id: sourceEventId,
    metadata: { checkpoint_id: checkpoint.checkpoint_id, reason },
  });
  return checkpoint;
}

function cancelListeningRelease(reason = '') {
  if (!listeningTimer) return;
  clearTimeout(listeningTimer);
  listeningTimer = null;
  if (reason) debug('HYSTERESIS_CANCEL', reason);
}

function hideVideo() {
  motionVideo.pause();
  motionVideo.classList.remove('visible');
  currentVideo = '';
}

function showVideo(src) {
  front.classList.remove('visible');
  back.classList.remove('visible');
  placeholder.hidden = true;
  if (currentVideo !== src) {
    motionVideo.src = src + '?v=110';
    motionVideo.currentTime = 0;
    currentVideo = src;
  }
  motionVideo.classList.add('visible');
  motionVideo.play()?.catch?.(error => debug('VIDEO_PLAY', error?.message || error));
  currentImg = '';
}

function showImage(src, seq) {
  hideVideo();
  if (src === currentImg) {
    front.classList.add('visible');
    return;
  }
  const preload = new Image();
  preload.onload = () => {
    if (seq !== loadSeq) return;
    back.src = src + '?v=110';
    back.onload = () => {
      if (seq !== loadSeq) return;
      placeholder.hidden = true;
      requestAnimationFrame(() => {
        front.classList.remove('visible');
        back.classList.add('visible');
        const old = front;
        front = back;
        back = old;
        currentImg = src;
      });
    };
  };
  preload.onerror = () => {
    if (seq !== loadSeq) return;
    placeholder.hidden = false;
    placeholder.textContent = '画像の読み込みに失敗しました。';
  };
  preload.src = src + '?v=110';
}

function renderState(name, reason = '') {
  const state = states[name] || states.neutral;
  const seq = ++loadSeq;
  currentState = name;
  stateEl.textContent = state.label;
  captionEl.textContent = state.caption;
  if (reason) debug('STATE', name + ' / ' + reason);
  if (state.video) showVideo(state.video);
  else showImage(state.img, seq);
}

function requestListening(reason = 'agent listening') {
  if (currentState !== 'speaking') {
    renderState('listening', reason);
    return;
  }
  cancelListeningRelease();
  listeningTimer = setTimeout(() => {
    listeningTimer = null;
    if (lastMode === 'listening' || currentProfile === CONVERSATION_PROFILES.TEXT_SILENT) {
      renderState('listening', 'speaking release confirmed');
    }
  }, SPEAKING_RELEASE_MS);
}

function statusForProfile(profile) {
  if (profile === CONVERSATION_PROFILES.VOICE) return 'voice: connected';
  if (profile === CONVERSATION_PROFILES.TEXT_AUDIO) return 'text input / voice reply';
  return 'chat: connected';
}

function friendlyError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  if (message.includes('permission') || message.includes('notallowed')) return 'マイクの使用が許可されていません。';
  if (message.includes('credit') || message.includes('quota')) return '利用枠を確認してください。';
  if (message.includes('override')) return '文字会話の設定がまだ許可されていません。';
  return '接続できませんでした。診断ログを確認してください。';
}

function resetUI(reason = '', canResume = false) {
  cancelListeningRelease('reset');
  ending = false;
  connecting = false;
  lastMode = '';
  currentProfile = null;
  setStatus(MOCK_MODE ? 'simulation: ready' : 'conversation: disconnected');
  setResumable(canResume);
  updateControls();
  renderState('neutral', reason || 'reset');
}

function callbacksFor(profile, isResume) {
  return {
    onConnect: () => {
      debug('CONNECT', profile);
      runtimeEvent('session_connected', { session_id: sessionId, metadata: { profile } });
      setStatus(MOCK_MODE ? `simulation: ${profile}` : statusForProfile(profile), 'live');
      renderState('listening', isResume ? 'reconnected' : 'connected');
      updateControls();
    },
    onDisconnect: detail => {
      debug('DISCONNECT', detail);
      runtimeEvent('session_disconnected', { session_id: sessionId, metadata: { detail: safe(detail).slice(0, 500), profile } });
      runtimeState.expireScope('current_session');
      if (!ending) resetUI('agent disconnected', true);
    },
    onStatusChange: event => debug('STATUS', event),
    onModeChange: event => {
      const mode = String(event?.mode || event || '').toLowerCase();
      lastMode = mode;
      debug('MODE', mode);
      runtimeEvent('conversation_mode_changed', { session_id: sessionId, metadata: { mode, profile } });
      if (mode === 'speaking') {
        cancelListeningRelease('speaking resumed');
        renderState('speaking', 'agent speaking');
      } else if (mode === 'listening') requestListening();
    },
    onMessage: async message => {
      const text = messageText(message);
      const role = messageRole(message);
      debug('MESSAGE', safe(message).slice(0, 240));
      if (!text || role === 'unknown') return;
      const result = await recordTurn({ role, text, source: 'sdk' });
      if (role === 'user' && !result.duplicate && lastMode !== 'speaking') renderState('thinking', 'user transcript received');
      if (role === 'agent' && profile === CONVERSATION_PROFILES.TEXT_SILENT && lastMode !== 'speaking') {
        renderState('speaking', 'agent text response');
        lastMode = 'listening';
        requestListening('text response complete');
      }
    },
    onError: error => {
      debug('ERROR', error);
      runtimeEvent('runtime_error', { session_id: sessionId, processing_status: 'failed', error: error?.message || safe(error) });
      setStatus(friendlyError(error), 'error');
      showBudgetNotice(budgetNoticeFromError(error));
    },
    onBudget: event => showBudgetNotice(budgetNoticeFromEvent(event)),
  };
}

async function endConversation(reason = 'manual_stop', preserve = true) {
  if (!adapter.active) return;
  ending = true;
  cancelListeningRelease(reason);
  stopBtn.disabled = true;
  setStatus('conversation: disconnecting…');
  debug('STOP', reason);
  try {
    await adapter.end();
    const result = await runtimeEvent('session_ended', {
      session_id: sessionId,
      idempotency_key: `session:${sessionId}:end`,
      metadata: { reason, profile: currentProfile },
    });
    if (preserve) saveCheckpoint(result.event.event_id, reason);
  } catch (error) {
    debug('END_ERROR', error?.message || error);
    runtimeEvent('session_end_failed', { session_id: sessionId, processing_status: 'failed', error: error?.message || safe(error) });
  } finally {
    runtimeState.expireScope('current_session');
    resetUI(reason, preserve);
  }
}

async function startConversation(profile) {
  if (!routeAccess.canUse(ACTIVE_PAID_ROUTE_ID)
    && !(profile === CONVERSATION_PROFILES.TEXT_SILENT && textFallbackSelection().route)) {
    setStatus('paid route: paused', 'error');
    return false;
  }
  if (adapter.active && currentProfile === profile) return true;
  if (adapter.active) await endConversation('channel_switch', true);

  const isResume = resumable || transcriptStore.read().length > 0;
  const priorContext = isResume ? contextForResume() : '';
  sessionId = crypto.randomUUID();
  turnNumber = 0;
  currentProfile = profile;
  connecting = true;
  ending = false;
  updateControls();
  setStatus(profile === CONVERSATION_PROFILES.VOICE ? 'voice: requesting microphone…' : 'conversation: connecting…');
  debug('START', `${profile} / ${isResume ? 'resume' : 'new'}`);
  runtimeEvent('session_started', {
    session_id: sessionId,
    idempotency_key: `session:${sessionId}:start`,
    metadata: { resume: isResume, profile, mock: MOCK_MODE },
  });

  try {
    await adapter.start(profile, callbacksFor(profile, isResume));
    connecting = false;
    setResumable(false);
    updateControls();
    if (isResume && priorContext) {
      adapter.sendContext('これは直前の凪さんとの会話から引き継いだ文脈です。ユーザーにはこの注入自体を説明せず、自然に会話の続きをしてください。\n\n' + priorContext);
      runtimeEvent('checkpoint_restored', { session_id: sessionId, metadata: { context_length: priorContext.length, profile } });
      continuityEl.textContent = 'conversation: context restored';
      continuityEl.className = 'continuity ready';
    }
    debug('SESSION_ID', adapter.getId());
    return true;
  } catch (error) {
    debug('START_FAILED', error?.message || error);
    runtimeEvent('session_start_failed', { session_id: sessionId, processing_status: 'failed', error: error?.message || safe(error), metadata: { profile } });
    setStatus(friendlyError(error), 'error');
    connecting = false;
    currentProfile = null;
    updateControls();
    renderState('neutral', 'start failed');
    return false;
  }
}

async function sendTypedMessage(text) {
  const value = String(text || '').trim();
  if (!value) return;
  conversationPanel.open = true;
  unreadCount = 0;
  unreadEl.hidden = true;
  if (!adapter.active) {
    const started = await startConversation(selectedTextProfile());
    if (!started) return;
  }
  await recordTurn({ role: 'user', text: value, source: 'typed' });
  try {
    await adapter.sendText(value);
  } catch (error) {
    const notice = budgetNoticeFromError(error);
    if (notice) showBudgetNotice(notice);
    else throw error;
  }
  renderState('thinking', 'typed message sent');
  textInput.value = '';
  textInput.style.height = '';
}

startVoiceBtn.addEventListener('click', () => startConversation(CONVERSATION_PROFILES.VOICE));
startTextBtn.addEventListener('click', async () => {
  conversationPanel.open = true;
  await startConversation(selectedTextProfile());
  textInput.focus();
});
stopBtn.addEventListener('click', () => endConversation('manual_stop', true));

replyWithVoice.addEventListener('change', () => {
  if (currentProfile === CONVERSATION_PROFILES.TEXT_AUDIO || currentProfile === CONVERSATION_PROFILES.TEXT_SILENT) {
    startConversation(selectedTextProfile());
  }
});

textInput.addEventListener('input', () => {
  adapter.sendActivity();
  textInput.style.height = 'auto';
  textInput.style.height = `${Math.min(textInput.scrollHeight, 128)}px`;
});

textInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

composer.addEventListener('submit', event => {
  event.preventDefault();
  sendTypedMessage(textInput.value);
});

conversationPanel.addEventListener('toggle', () => {
  if (!conversationPanel.open) return;
  unreadCount = 0;
  unreadEl.hidden = true;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
});

budgetDismissBtn.addEventListener('click', hideBudgetNotice);

inspectLogBtn.addEventListener('click', async () => {
  const events = await eventLog.list();
  const latest = events.slice(-12);
  debugEl.textContent = latest.length
    ? latest.map(event => `${event.sequence_number} ${event.event_type}${event.error ? ' ERROR ' + event.error : ''}`).join('\n')
    : '記録されたイベントはありません。';
  debugEl.scrollTop = debugEl.scrollHeight;
});

exportLogBtn.addEventListener('click', async () => {
  const jsonl = await eventLog.toJSONL();
  if (!jsonl) return debug('EXPORT', 'no events');
  const blob = new Blob([jsonl + '\n'], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `nagi-events-${new Date().toISOString().slice(0, 10)}.ndjson`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  debug('EXPORT', 'NDJSON saved');
});

window.addEventListener('error', event => debug('WINDOW_ERROR', event.message));
window.addEventListener('unhandledrejection', event => debug('PROMISE_REJECTION', event.reason));

renderStoredTranscript();
setResumable(resumable);
updateControls();
renderState('neutral', 'initial');
if (MOCK_MODE) debug('SIMULATION', 'enabled with ?mock=1');
