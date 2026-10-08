import { createSessionLimit } from './runtime/session-limit.js';
import { monitorAvatarAudio } from './runtime/avatar-audio-stats.js';
import { createLiveAttention } from './runtime/live-attention.js';
import { Room, RoomEvent, Track } from 'https://esm.sh/livekit-client@2.22.3?bundle';
import { Conversation, Scribe, RealtimeEvents, CommitStrategy } from 'https://esm.sh/@elevenlabs/client@latest?bundle';
import { ElevenLabsConversationAdapter, CONVERSATION_PROFILES } from './runtime/conversation-adapter.js';
import { RealtimeVoiceInput } from './runtime/voice-input.js';
import { createBithumanOutput, createAudioAttachmentGate, captureRemoteGreeting } from './runtime/bithuman-live-output.js?v=1.0.2';
// Experimental opt-in; ordinary ver1 sessions keep their accepted delivery.
const requestedVoiceDelivery = new URLSearchParams(location.search).get('voice_delivery');
const voiceDelivery = requestedVoiceDelivery === 'baseline' ? undefined : ['soft', 'steady'].includes(requestedVoiceDelivery) ? requestedVoiceDelivery : 'steady';
const W = 'https://nagi-voice-transport.arai-hiroaki0317.workers.dev';
const $ = id => document.getElementById(id);
function appendTranscript(text) {
  const transcript = $('transcript');
  const follow = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <= 40;
  const line = document.createElement('div');
  line.textContent = text;
  transcript.append(line);
  if (follow) transcript.scrollTop = transcript.scrollHeight;
  $('latest').hidden = follow;
}
$('transcript').addEventListener('scroll', () => {
  const transcript = $('transcript');
  if (transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <= 40) $('latest').hidden = true;
});
$('latest').onclick = () => {
  $('transcript').scrollTop = $('transcript').scrollHeight;
  $('latest').hidden = true;
};
const pendingKey = 'nagi.bithuman.pending-stop.v1';
const attention = createLiveAttention();
let muted = false, listenTask = null, sessionGeneration = 0;
let audioBlocked = false, audioMonitor = null, sessionLimit = null;
const startupSilenceMs = new URLSearchParams(location.search).get('onset') === '0' ? 0 : 160;
const captureReceived = new URLSearchParams(location.search).get('capture') === '1';
let audioAttachment, sessionStartedAt = 0;
const audioEvent = name => { if (sessionStartedAt) log('audio_event +' + Math.round(performance.now() - sessionStartedAt) + ' ms: ' + name); };
for (const name of ['playing', 'waiting', 'stalled', 'pause', 'emptied']) {
  $('avatarAudio').addEventListener(name, () => audioEvent('device_' + name));
}
let sourceAudioUrl = '', receivedAudioUrl = '', receivedCapture = null;
let previewGeneration = 0;
let micRequestedAt = 0;
let viewer, sender, adapter, output, voiceInput, control = '', connected = false, busy = false, stopping = false, launching = false, cancelLaunch = false, timer, micTimer, micStarting = false, tokenPromise = null, tokenCreatedAt = 0;
const status = text => { $('status').textContent = text; };
const log = text => { $('debug').textContent += text + '\n'; };
const timing = ({ stage, ms }) => log(stage + ': ' + Math.round(ms) + ' ms');
function controls() {
  $('start').disabled = connected || busy || stopping || launching || Boolean(control);
  $('stop').disabled = !control || stopping;
  $('mic').textContent = muted ? 'マイクを再開' : 'マイクをミュート';
  for (const id of ['mic', 'text', 'send']) $(id).disabled = !connected || busy || stopping || micStarting || sessionLimit?.expired;
}
function prefetchScribeToken() {
  if (!tokenPromise || Date.now() - tokenCreatedAt > 50000) {
    tokenCreatedAt = Date.now();
    tokenPromise = fetch(W + '/scribe-token', { method: 'POST', signal: AbortSignal.timeout(15000) }).then(async response => {
      const data = await response.json();
      if (!response.ok || !data.token) throw new Error('scribe_token_failed');
      return data.token;
    });
    tokenPromise.catch(() => {});
  }
  return tokenPromise;
}
async function call(action, body) {
  const startedAt = performance.now();
  const response = await fetch(W + '/bithuman-live/' + action, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: action === 'stop' });
  const data = await response.json();
  timing({ stage: 'startup_' + action + '_ms', ms: performance.now() - startedAt });
  if (!response.ok || !data.ok) throw new Error(data.error || ('設定が必要: ' + (data.missing || []).join(', ')));
  return data;
}
function saveControl(value) { control = value; if (value) localStorage.setItem(pendingKey, value); else localStorage.removeItem(pendingKey); }
async function endSession(message = '終了しました。') {
  if (launching) cancelLaunch = true;
  if (stopping) return;
  audioAttachment?.close(); receivedCapture?.stop(); audioMonitor?.stop();
  sessionLimit?.close(); sessionLimit = null; $('remaining').textContent = '';
  stopping = true; connected = false; sessionGeneration++; attention.idle(); micStarting = false; tokenPromise = null; clearTimeout(timer); clearTimeout(micTimer); controls();
  await voiceInput?.stop().catch(() => {});
  await adapter?.end().catch(() => {});
  // Delete the room even if an audio RPC cannot complete.
  const cleanup = control ? call('stop', { control }) : Promise.resolve(null);
  const [cleanupResult] = await Promise.allSettled([cleanup, output?.stop(), viewer?.disconnect(), sender?.disconnect()]);
  try {
    if (cleanupResult.status === 'rejected') throw cleanupResult.reason;
    const result = cleanupResult.value;
    if (result && !result.session_end_acknowledged) throw new Error('bithuman_end_not_acknowledged');
    if (result) log('ルーム終了: ' + result.room_deleted + ' / bitHuman終了応答: ' + result.session_end_acknowledged);
    saveControl(''); status(message);
  } catch (error) { status('終了確認に失敗しました。「終了」で再試行してください。'); log(error.message); }
  $('avatarAudio').pause(); $('avatarAudio').srcObject = null; $('avatar').srcObject = null;
  stopping = false; busy = false; controls();
  if (sourceAudioUrl) { $('sourceAudio').src = sourceAudioUrl; $('sourcePreview').hidden = false; }
  if (receivedAudioUrl) { $('receivedAudio').src = receivedAudioUrl; $('receivedPreview').hidden = false; }
}
async function sendText(text) {
  if (!connected || busy || sessionLimit?.expired || !text.trim()) return;
  busy = true; clearTimeout(micTimer); controls();
  await voiceInput?.stop();
  $('text').value = '';
  appendTranscript('ヒロ: ' + text.trim());
  void prefetchScribeToken();
  status('考えています。');
  const replyStartedAt = performance.now();
  await adapter.sendText(text.trim());
  log('応答完了まで: ' + ((performance.now() - replyStartedAt) / 1000).toFixed(1) + '秒（再生時間を含む）');
  busy = false; controls(); sessionLimit?.finishTurn();
  if (connected) { attention.engage(); await listenAutomatically(); }
}
$('start').onclick = async () => {
  previewGeneration++;
  audioMonitor?.stop();
  log('audio_diagnostic_version: onset-silence-1 / recording: ' + captureReceived + ' / startup_silence_ms: ' + startupSilenceMs);
  receivedCapture?.stop(); receivedCapture = null;
  $('receivedAudio').pause(); $('receivedAudio').removeAttribute('src'); $('receivedPreview').hidden = true;
  if (receivedAudioUrl) URL.revokeObjectURL(receivedAudioUrl);
  receivedAudioUrl = '';
  $('sourceAudio').pause(); $('sourceAudio').removeAttribute('src'); $('sourcePreview').hidden = true;
  if (sourceAudioUrl) URL.revokeObjectURL(sourceAudioUrl);
  sourceAudioUrl = '';
  sessionLimit?.close(); sessionLimit = null;
  launching = true; cancelLaunch = false; sessionGeneration++; muted = false;
  const check = () => { if (cancelLaunch) throw new Error('接続を中止しました'); };
  busy = true; controls(); status('接続しています。');
  viewer = new Room(); sender = new Room(); audioBlocked = false;
  sessionStartedAt = performance.now();
  audioAttachment = createAudioAttachmentGate();
  const sessionAudioAttachment = audioAttachment;
  const captureGeneration = previewGeneration;
  // Invoke while the start gesture is still active, before permission/network awaits.
  const audioUnlock = viewer.startAudio().catch(() => { audioBlocked = true; $('play').hidden = false; });
  try {
    status('マイクの使用を許可してください。');
    const permissionStartedAt = performance.now();
    const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    timing({ stage: 'startup_permission_ms', ms: performance.now() - permissionStartedAt });
    permissionStream.getTracks().forEach(track => track.stop()); check();
    status('接続しています。');
    await call('verify'); check();
    const prep = await call('prepare', {}); saveControl(prep.control); controls(); check();
    await audioUnlock; check();
    output = createBithumanOutput({ room: sender, endpoint: W + '/tts', startupSilenceMs, voiceDelivery, onTiming: timing, beforeSend: signal => sessionAudioAttachment.wait(signal) });
    viewer.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      log('受信トラック: ' + participant.identity + ' / ' + track.kind);
      if (!['bithuman-avatar-agent', 'nagi-audio-sender'].includes(participant.identity)) return;
      if (track.kind === Track.Kind.Video) track.attach($('avatar'));
      else if (track.kind === Track.Kind.Audio) {
        const audio = $('avatarAudio'); track.attach(audio);
        audio.muted = false; audio.volume = 1;
        audioMonitor?.stop();
        audioMonitor = monitorAvatarAudio(track, sample => audioEvent('receiver ' + JSON.stringify(sample)));
        log('audio_element: rate=' + audio.playbackRate + ' / volume=' + audio.volume + ' / attached=' + track.attachedElements.length);
        if (captureReceived && !receivedCapture) receivedCapture = captureRemoteGreeting(track.mediaStreamTrack, {
          onBlob: blob => {
            if (captureGeneration !== previewGeneration) return;
            receivedAudioUrl = URL.createObjectURL(blob);
            log('受信音声の比較用記録: ' + blob.type);
            if (!connected && !launching && !stopping) {
              $('receivedAudio').src = receivedAudioUrl; $('receivedPreview').hidden = false;
            }
          },
          onError: message => log(message),
        });
        sessionAudioAttachment.attach(); audioEvent('track_attached');
        audio.play().then(() => { audioBlocked = false; $('play').hidden = viewer.canPlaybackAudio; log('端末音声: play()成功'); }).catch(error => { audioBlocked = true; $('play').hidden = false; log('端末音声: play()拒否 / ' + error.name); });
      }
    });
    viewer.on(RoomEvent.AudioPlaybackStatusChanged, () => { $('play').hidden = viewer.canPlaybackAudio && !audioBlocked; });
    viewer.on(RoomEvent.Disconnected, () => { if (!stopping && control) void endSession('接続が切れたため終了しました。'); });
    sender.on(RoomEvent.Disconnected, () => { if (!stopping && control) void endSession('音声接続が切れたため終了しました。'); });
    await viewer.connect(prep.url, prep.viewer_token); check();
    await sender.connect(prep.url, prep.sender_token); check();
    await viewer.startAudio().catch(() => { $('play').hidden = false; });
    check();
    void prefetchScribeToken();
    const start = await call('start', { control }); saveControl(start.control); check();
    log('session: ' + start.session_id + ' / model: ' + start.model);
    sessionLimit = createSessionLimit({ seconds: prep.max_session_seconds, isBusy: () => busy,
      onTick: remaining => { $('remaining').textContent = '残り ' + Math.floor(remaining / 60) + ':' + String(remaining % 60).padStart(2, '0'); },
      onExpire: () => { clearTimeout(micTimer); void voiceInput?.stop().catch(() => {}); controls(); status('時間になりました。最後の返答が終わったら終了します。'); },
      onEnd: () => void endSession('会話を終了しました。また話しかけてね。'),
    });
    await new Promise((resolve, reject) => {
      if (sender.remoteParticipants.has('bithuman-avatar-agent')) return resolve();
      const timeout = setTimeout(() => { sender.off(RoomEvent.ParticipantConnected, joined); reject(new Error('avatar_join_timeout')); }, 30000);
      const joined = participant => { if (participant.identity === 'bithuman-avatar-agent') { clearTimeout(timeout); sender.off(RoomEvent.ParticipantConnected, joined); resolve(); } };
      sender.on(RoomEvent.ParticipantConnected, joined);
    });
    check();
    adapter = new ElevenLabsConversationAdapter({ Conversation, agentId: 'agent_8501m0nvtj12ea5vnc21ck26v9sp', memoryConfig: { enabled: true, endpoint: 'https://nagi-memory-adapter.arai-hiroaki0317.workers.dev', userId: 'hiro', threadId: 'nagi-poc-002' }, ttsOutput: output });
    await adapter.start(CONVERSATION_PROFILES.TEXT_AUDIO, {
      onTiming: timing,
      onMessage: event => { if (event.source === 'ai') appendTranscript('凪: ' + event.message); },
      onError: error => { log(error.message); void endSession('応答エラーのため終了しました。'); },
      onTtsError: error => { log(error.error); void endSession('音声の再生を確認できなかったため終了しました。'); },
    });
    voiceInput = new RealtimeVoiceInput({ connect: async ({ onPartial, onFinal, onError }) => {
      const generation = sessionGeneration;
      let closed = false;
      const token = await prefetchScribeToken(); tokenPromise = null;
      if (!connected || stopping || generation !== sessionGeneration) throw new Error('session_ended');
      const connection = Scribe.connect({ token, modelId: 'scribe_v2_realtime', languageCode: 'ja', commitStrategy: CommitStrategy.VAD, vadSilenceThresholdSecs: 1.5, microphone: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      connection.on(RealtimeEvents.SESSION_STARTED, () => {
        if (closed || !connected || stopping || generation !== sessionGeneration) { connection.close(); return; }
        log('マイク準備完了まで: ' + ((performance.now() - micRequestedAt) / 1000).toFixed(1) + '秒');
        micStarting = false; controls();
        attention.engage();
        status('聞いています。そのまま話しかけてください。');
        clearTimeout(micTimer);
        micTimer = setTimeout(() => { if (connected && !busy && !muted) { attention.idle(); status('呼びかけ待ちです。「凪」と呼んでください。'); } }, 12000);
      });
      connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, data => { if (!closed) onPartial(data.text); });
      connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, data => { if (!closed) onFinal(data.text); });
      connection.on(RealtimeEvents.ERROR, error => { if (!closed) onError(error); });
      return { close: async () => {
        closed = true; audioEvent('mic_close_requested');
        await connection.close();
        audioEvent('mic_close_returned');
      } };
    } });
    log('startup_greeting_requested_ms: ' + Math.round(performance.now() - sessionStartedAt) + ' ms');
    status('凪が挨拶しています。');
    const greeting = 'おはよう、ひろくーん。今日は何企んでるの？';
    appendTranscript('凪: ' + greeting);
    const greeted = await output.speak(greeting, { onSourceAudio: blob => { sourceAudioUrl = URL.createObjectURL(blob); } }); check();
    receivedCapture?.stop();
    if (!greeted?.ok) throw new Error('greeting_playback_failed');
    connected = true; busy = false; attention.engage(); controls(); sessionLimit?.finishTurn(); if (connected) await listenAutomatically();
  } catch (error) { log(error.message); await endSession('接続できませんでした: ' + error.message); }
  finally { launching = false; controls(); }
};
async function handleTranscript(event) {
  if (!connected || muted || busy || sessionLimit?.expired) return;
  if (!event.final) {
    if (attention.state === 'conversation') {
      attention.engage(); clearTimeout(micTimer);
      status('聞いています: ' + event.text);
      micTimer = setTimeout(() => { attention.idle(); if (connected && !busy && !muted) status('呼びかけ待ちです。「凪」と呼んでください。'); }, 12000);
    }
    return;
  }
  const decision = attention.accept(event.text);
  if (decision.action === 'non_speech') return;
  if (decision.action === 'ignore') { status('呼びかけ待ちです。「凪」と呼んでください。'); return; }
  if (decision.action === 'respond') { await sendText(decision.text); return; }
  busy = true; clearTimeout(micTimer); controls(); await voiceInput.stop();
  appendTranscript('凪: ' + decision.text);
  const result = await output.speak(decision.text);
  if (!result.ok) { await endSession('呼びかけへの応答を再生できませんでした。'); return; }
  busy = false; controls(); sessionLimit?.finishTurn();
  if (connected) await listenAutomatically();
}
async function listenAutomatically() {
  if (!connected || muted || busy || stopping || sessionLimit?.expired || voiceInput?.active) return;
  if (listenTask) return listenTask;
  const generation = sessionGeneration;
  micStarting = true; controls(); status('マイクを準備しています。');
  micRequestedAt = performance.now();
  clearTimeout(micTimer);
  micTimer = setTimeout(() => { if (micStarting && connected) void endSession('マイク接続が時間内に完了しませんでした。'); }, 15000);
  listenTask = (async () => {
    try {
      await voiceInput.start({ onTranscript: event => { void handleTranscript(event); }, onError: error => { log(String(error?.message || error)); void endSession('音声入力エラーのため終了しました。'); } });
      if (!connected || stopping || muted || sessionLimit?.expired || generation !== sessionGeneration) { await voiceInput.stop(); return; }
    } catch (error) {
      micStarting = false; muted = true; controls(); log(error.message);
      if (connected) status('マイクを再開してください。文字入力も使えます。');
    } finally { listenTask = null; }
  })();
  return listenTask;
}
$('mic').onclick = async () => {
  if (!connected || busy || stopping || micStarting) return;
  muted = !muted; clearTimeout(micTimer); controls();
  if (muted) { await voiceInput.stop(); attention.idle(); status('マイクはミュートです。'); }
  else { attention.engage(); await listenAutomatically(); }
};
$('composer').onsubmit = event => { event.preventDefault(); void sendText($('text').value); };
$('stop').onclick = () => void endSession();
$('copyDebug').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('debug').textContent);
    $('copyDebug').textContent = 'コピーしました';
  } catch {
    const range = document.createRange(); range.selectNodeContents($('debug'));
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    $('copyDebug').textContent = '選択したログをコピーしてください';
  }
};
for (const [id, other] of [['sourceAudio', 'receivedAudio'], ['receivedAudio', 'sourceAudio']]) {
  $(id).addEventListener('play', () => $(other).pause());
}
$('play').onclick = async () => {
  try {
    await Promise.all([viewer.startAudio(), $('avatarAudio').play()]);
    audioBlocked = false; $('play').hidden = true; log('端末音声: 手動再生成功');
  } catch (error) { audioBlocked = true; $('play').hidden = false; log('端末音声: 手動再生失敗 / ' + error.name); }
};
document.addEventListener('visibilitychange', () => { if (document.hidden && control) void endSession('画面を離れたため終了しました。'); });
window.addEventListener('pagehide', () => { if (control) { navigator.sendBeacon(W + '/bithuman-live/stop', new Blob([JSON.stringify({ control })], { type: 'text/plain' })); void viewer?.disconnect(); void sender?.disconnect(); } });
try {
  const pending = localStorage.getItem(pendingKey);
  if (pending) { saveControl(pending); await endSession('前回の接続を終了しました。'); if (control) throw new Error('前回の終了確認が必要です'); }
  const health = await call('health'); log('設定確認: OK / avatar: ' + health.agent_code);
  status('開始すると凪が挨拶し、自動で音声入力を開始します。'); controls();
} catch (error) { status(error.message); log(error.message); }

