import {
  ATTENTION_ACKNOWLEDGEMENT,
  ATTENTION_SEQUENCE,
  createAttentionAcknowledgement,
} from './attention.js';
import { createAttentionAudioPlayer } from './attention-audio.js';
import { runtimeEvent } from './runtime.js';
import { LocalTranscriptStore } from './transcript.js';

const transcriptStore = new LocalTranscriptStore();
const attentionAudio = createAttentionAudioPlayer();
const composer = document.getElementById('composer');
const textInput = document.getElementById('textInput');
const conversationPanel = document.getElementById('conversationPanel');
const transcriptEl = document.getElementById('transcript');
const transcriptEmpty = document.getElementById('transcriptEmpty');
const stateEl = document.getElementById('state');
const captionEl = document.getElementById('caption');
const debugEl = document.getElementById('debug');
const motionVideo = document.getElementById('motionVideo');
const portraitA = document.getElementById('portraitA');
const portraitB = document.getElementById('portraitB');
const placeholder = document.getElementById('placeholder');

const ATTENTION_VIDEO = './assets/nagi_attention_v2.mp4';
const LISTENING_VIDEO = './assets/listening_loop_v02.MP4';
const ATTENTION_FALLBACK_MS = 3600;
const ATTENTION_STEP_MS = 180;
const LISTENING_HOLD_MS = 700;

function debug(type, data = '') {
  if (!debugEl) return;
  const stamp = new Date().toLocaleTimeString('ja-JP', { hour12: false });
  const suffix = data === '' ? '' : ` ${typeof data === 'string' ? data : JSON.stringify(data)}`;
  const line = `${stamp} ${type}${suffix}`;
  debugEl.textContent = (debugEl.textContent === 'ready' ? '' : `${debugEl.textContent}\n`) + line;
  debugEl.scrollTop = debugEl.scrollHeight;
}

function channelLabel(turn) {
  if (turn.role === 'user') return turn.input_channel === 'voice' ? '音声' : '文字';
  return turn.output_channel === 'voice_and_text' ? '音声＋文字' : '文字';
}

function appendTurn(turn) {
  if (!transcriptEl) return;
  if (transcriptEmpty) transcriptEmpty.hidden = true;
  const bubble = document.createElement('div');
  bubble.className = `turn ${turn.role}`;
  bubble.dataset.turnId = turn.turn_id;
  bubble.setAttribute('aria-label', `${turn.role === 'user' ? 'ヒロ' : '凪'}: ${turn.text}`);
  const body = document.createElement('span');
  body.textContent = turn.text;
  const meta = document.createElement('span');
  meta.className = 'turn-meta';
  meta.textContent = channelLabel(turn);
  bubble.append(body, meta);
  transcriptEl.append(bubble);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function storeTurn(input) {
  const result = transcriptStore.append(input);
  if (!result.duplicate) appendTurn(result.turn);
  return result;
}

function setPresenceState(label, caption) {
  if (stateEl) stateEl.textContent = label;
  if (captionEl) captionEl.textContent = caption;
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function playVideoOnce(src) {
  if (!motionVideo) return Promise.resolve(false);
  portraitA?.classList.remove('visible');
  portraitB?.classList.remove('visible');
  if (placeholder) placeholder.hidden = true;
  motionVideo.loop = false;
  motionVideo.src = `${src}?v=attention-v01`;
  motionVideo.currentTime = 0;
  motionVideo.classList.add('visible');

  return new Promise(resolve => {
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      motionVideo.removeEventListener('ended', onEnded);
      motionVideo.removeEventListener('error', onError);
      resolve(ok);
    };
    const onEnded = () => finish(true);
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(false), ATTENTION_FALLBACK_MS);
    motionVideo.addEventListener('ended', onEnded, { once: true });
    motionVideo.addEventListener('error', onError, { once: true });
    motionVideo.play()?.catch?.(error => {
      debug('ATTENTION_VIDEO_PLAY', error?.message || String(error));
      finish(false);
    });
  });
}

function restoreListeningVideo() {
  if (!motionVideo) return;
  motionVideo.loop = true;
  motionVideo.src = `${LISTENING_VIDEO}?v=attention-v01`;
  motionVideo.currentTime = 0;
  motionVideo.classList.add('visible');
  motionVideo.play()?.catch?.(error => debug('LISTENING_VIDEO_PLAY', error?.message || String(error)));
}

async function playAttentionSequence(attention) {
  setPresenceState('ATTENTION', '呼びかけに気づきました。');
  const videoPromise = playVideoOnce(ATTENTION_VIDEO);

  for (const step of attention.sequence) {
    if (step === 'attention_start') setPresenceState('ATTENTION', '呼びかけに気づきました。');
    if (step === 'gaze') setPresenceState('ATTENTION', 'こちらを見ます。');
    if (step === 'head_up') setPresenceState('ATTENTION', '顔を上げます。');
    if (step === 'expression_soften') setPresenceState('ATTENTION', '少し表情がやわらぎます。');

    await runtimeEvent(step, {
      speaker: 'nagi',
      input_channel: attention.input_channel,
      metadata: { source: attention.source, acknowledgement: attention.acknowledgement },
    });
    debug('ATTENTION', step);
    if (step !== 'listening') await wait(ATTENTION_STEP_MS);
  }

  const playedToEnd = await videoPromise;
  debug('ATTENTION_VIDEO_END', playedToEnd ? 'ended' : 'fallback');
  restoreListeningVideo();
  setPresenceState('LISTENING', '聞いています。');
}

async function acknowledgeTypedWake(transcript) {
  const attention = createAttentionAcknowledgement({
    transcript,
    input_channel: 'text',
    source: 'typed_local',
  });
  if (!attention) return false;

  if (conversationPanel) conversationPanel.open = true;
  const user = storeTurn({
    role: 'user',
    text: transcript,
    source: 'typed_attention',
    input_channel: 'text',
  });
  if (!user.duplicate) {
    await runtimeEvent('user_utterance', {
      turn_id: user.turn.turn_id,
      speaker: 'hiro',
      transcript,
      input_channel: 'text',
      transcript_source: 'typed_attention',
    });
  }

  await playAttentionSequence(attention);

  const agent = storeTurn({
    role: 'agent',
    text: ATTENTION_ACKNOWLEDGEMENT,
    source: 'attention_acknowledgement',
    output_channel: 'text',
  });
  if (!agent.duplicate) {
    await runtimeEvent('attention_acknowledged', {
      turn_id: agent.turn.turn_id,
      speaker: 'nagi',
      transcript: ATTENTION_ACKNOWLEDGEMENT,
      output_channel: 'text',
      metadata: { sequence: ATTENTION_SEQUENCE, source: attention.source },
    });
  }

  setPresenceState('ATTENTION', 'ん？');
  const audioResult = await attentionAudio.play();
  debug('ATTENTION_AUDIO', audioResult.ok ? 'played' : audioResult);
  await runtimeEvent(audioResult.ok ? 'attention_audio_played' : 'attention_audio_unavailable', {
    speaker: 'nagi',
    transcript: ATTENTION_ACKNOWLEDGEMENT,
    output_channel: audioResult.ok ? 'audio' : 'text',
    metadata: audioResult,
  });
  await wait(LISTENING_HOLD_MS);
  setPresenceState('LISTENING', '聞いています。');
  return true;
}

if (composer && textInput) {
  composer.addEventListener('submit', event => {
    const value = String(textInput.value || '').trim();
    const attention = createAttentionAcknowledgement({ transcript: value });
    if (!attention) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    textInput.value = '';
    textInput.style.height = '';
    acknowledgeTypedWake(value).catch(error => debug('ATTENTION_ERROR', error?.message || String(error)));
  }, true);
}
