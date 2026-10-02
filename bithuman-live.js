import { Room, RoomEvent, Track } from 'https://esm.sh/livekit-client@2.22.3?bundle';
import { Conversation, Scribe, RealtimeEvents, CommitStrategy } from 'https://esm.sh/@elevenlabs/client@latest?bundle';
import { ElevenLabsConversationAdapter, CONVERSATION_PROFILES } from './runtime/conversation-adapter.js';
import { RealtimeVoiceInput } from './runtime/voice-input.js';
import { createBithumanOutput } from './runtime/bithuman-live-output.js';
const W = 'https://nagi-voice-transport.arai-hiroaki0317.workers.dev';
const $ = id => document.getElementById(id);
const pendingKey = 'nagi.bithuman.pending-stop.v1';
let micRequestedAt = 0;
let viewer, sender, adapter, output, voiceInput, control = '', connected = false, busy = false, stopping = false, launching = false, cancelLaunch = false, timer, micTimer, micStarting = false, tokenPromise = null, tokenCreatedAt = 0;
const status = text => { $('status').textContent = text; };
const log = text => { $('debug').textContent += text + '\n'; };
function controls() {
  $('start').disabled = connected || busy || stopping || launching || Boolean(control);
  $('stop').disabled = !control || stopping;
  for (const id of ['mic', 'text', 'send']) $(id).disabled = !connected || busy || stopping || micStarting;
}
function prefetchScribeToken() {
  if (!tokenPromise || Date.now() - tokenCreatedAt > 50000) {
    tokenCreatedAt = Date.now();
    tokenPromise = fetch(W + '/scribe-token', { method: 'POST' }).then(async response => {
      const data = await response.json();
      if (!response.ok || !data.token) throw new Error('scribe_token_failed');
      return data.token;
    });
    tokenPromise.catch(() => {});
  }
  return tokenPromise;
}
async function call(action, body) {
  const response = await fetch(W + '/bithuman-live/' + action, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: action === 'stop' });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || ('設定が必要: ' + (data.missing || []).join(', ')));
  return data;
}
function saveControl(value) { control = value; if (value) localStorage.setItem(pendingKey, value); else localStorage.removeItem(pendingKey); }
async function endSession(message = '終了しました。') {
  if (launching) cancelLaunch = true;
  if (stopping) return;
  stopping = true; connected = false; micStarting = false; tokenPromise = null; clearTimeout(timer); clearTimeout(micTimer); controls();
  await voiceInput?.stop().catch(() => {});
  await adapter?.end().catch(() => {});
  // Delete the room even if an audio RPC cannot complete.
  const cleanup = control ? call('stop', { control }) : Promise.resolve(null);
  const [cleanupResult] = await Promise.allSettled([cleanup, output?.stop(), viewer?.disconnect(), sender?.disconnect()]);
  try {
    if (cleanupResult.status === 'rejected') throw cleanupResult.reason;
    const result = cleanupResult.value;
    if (result) log('ルーム終了: ' + result.room_deleted + ' / bitHuman終了応答: ' + result.session_end_acknowledged);
    saveControl(''); status(message);
  } catch (error) { status('終了確認に失敗しました。「終了」で再試行してください。'); log(error.message); }
  $('audio').replaceChildren(); $('avatar').srcObject = null;
  stopping = false; busy = false; controls();
}
async function sendText(text) {
  if (!connected || busy || !text.trim()) return;
  busy = true; clearTimeout(micTimer); controls();
  await voiceInput?.stop();
  $('mic').textContent = '話す'; $('text').value = '';
  $('transcript').textContent += 'ヒロ: ' + text.trim() + '\n';
  void prefetchScribeToken();
  status('考えています。');
  const replyStartedAt = performance.now();
  await adapter.sendText(text.trim());
  log('応答完了まで: ' + ((performance.now() - replyStartedAt) / 1000).toFixed(1) + '秒（再生時間を含む）');
  busy = false; controls();
  if (connected) status('「話す」を押すか、文字を送ってください。');
}
$('start').onclick = async () => {
  launching = true; cancelLaunch = false;
  const check = () => { if (cancelLaunch) throw new Error('接続を中止しました'); };
  busy = true; controls(); status('接続しています。');
  try {
    await call('verify'); check();
    const prep = await call('prepare', {}); saveControl(prep.control); controls(); check();
    viewer = new Room(); sender = new Room();
    output = createBithumanOutput({ room: sender, endpoint: W + '/tts' });
    viewer.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (participant.identity !== 'bithuman-avatar-agent') return;
      if (track.kind === Track.Kind.Video) track.attach($('avatar'));
      else if (track.kind === Track.Kind.Audio) { const audio = track.attach(); $('audio').append(audio); audio.play().catch(() => { $('play').hidden = false; }); }
    });
    viewer.on(RoomEvent.AudioPlaybackStatusChanged, () => { $('play').hidden = viewer.canPlaybackAudio; });
    viewer.on(RoomEvent.Disconnected, () => { if (!stopping && control) void endSession('接続が切れたため終了しました。'); });
    sender.on(RoomEvent.Disconnected, () => { if (!stopping && control) void endSession('音声接続が切れたため終了しました。'); });
    await viewer.connect(prep.url, prep.viewer_token); check();
    await sender.connect(prep.url, prep.sender_token); check();
    await viewer.startAudio().catch(() => { $('play').hidden = false; });
    timer = setTimeout(() => void endSession('90秒の接続テストを終了しました。'), prep.max_session_seconds * 1000);
    check();
    void prefetchScribeToken();
    const start = await call('start', { control }); saveControl(start.control); check();
    log('session: ' + start.session_id + ' / model: ' + start.model);
    await new Promise((resolve, reject) => {
      if (sender.remoteParticipants.has('bithuman-avatar-agent')) return resolve();
      const timeout = setTimeout(() => { sender.off(RoomEvent.ParticipantConnected, joined); reject(new Error('avatar_join_timeout')); }, 30000);
      const joined = participant => { if (participant.identity === 'bithuman-avatar-agent') { clearTimeout(timeout); sender.off(RoomEvent.ParticipantConnected, joined); resolve(); } };
      sender.on(RoomEvent.ParticipantConnected, joined);
    });
    check();
    adapter = new ElevenLabsConversationAdapter({ Conversation, agentId: 'agent_8501m0nvtj12ea5vnc21ck26v9sp', memoryConfig: { enabled: true, endpoint: 'https://nagi-memory-adapter.arai-hiroaki0317.workers.dev', userId: 'hiro', threadId: 'nagi-poc-002' }, ttsOutput: output });
    await adapter.start(CONVERSATION_PROFILES.TEXT_AUDIO, {
      onMessage: event => { if (event.source === 'ai') $('transcript').textContent += '凪: ' + event.message + '\n'; },
      onError: error => { log(error.message); void endSession('応答エラーのため終了しました。'); },
      onTtsError: error => { log(error.error); void endSession('音声の再生を確認できなかったため終了しました。'); },
    });
    voiceInput = new RealtimeVoiceInput({ connect: async ({ onPartial, onFinal, onError }) => {
      const token = await prefetchScribeToken(); tokenPromise = null;
      if (!connected || stopping) throw new Error('session_ended');
      const connection = Scribe.connect({ token, modelId: 'scribe_v2_realtime', languageCode: 'ja', commitStrategy: CommitStrategy.VAD, vadSilenceThresholdSecs: 0.6, microphone: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      connection.on(RealtimeEvents.SESSION_STARTED, () => {
        if (!connected || stopping) { connection.close(); return; }
        log('マイク準備完了まで: ' + ((performance.now() - micRequestedAt) / 1000).toFixed(1) + '秒');
        micStarting = false; controls();
        $('mic').textContent = '入力を止める'; status('聞いています。話し終えると送信します。');
      });
      connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, data => onPartial(data.text));
      connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, data => onFinal(data.text));
      connection.on(RealtimeEvents.ERROR, onError);
      return { close: () => connection.close() };
    } });
    status('凪が挨拶しています。');
    const greeting = 'おはよう、ひろくーん。今日は何企んでるの？';
    $('transcript').textContent += '凪: ' + greeting + '\n';
    const greeted = await output.speak(greeting); check();
    if (!greeted?.ok) throw new Error('greeting_playback_failed');
    connected = true; busy = false; controls(); status('接続しました。「話す」を押して話しかけてください。');
  } catch (error) { log(error.message); await endSession('接続できませんでした: ' + error.message); }
  finally { launching = false; controls(); }
};
$('mic').onclick = async () => {
  if (!connected || busy || stopping || micStarting) return;
  if (voiceInput.active) { await voiceInput.stop(); clearTimeout(micTimer); $('mic').textContent = '話す'; status('音声入力を止めました。'); return; }
  micStarting = true; controls(); status('マイクを準備しています。');
  const micStartedAt = performance.now(); micRequestedAt = micStartedAt;
  try {
    await voiceInput.start({ onTranscript: event => { if (event.final) void sendText(event.text); else status('聞いています: ' + event.text); }, onError: error => { log(String(error?.message || error)); void endSession('音声入力エラーのため終了しました。'); } });
    if (!connected || stopping) { await voiceInput.stop(); return; }
    log('音声入力接続要求まで: ' + ((performance.now() - micStartedAt) / 1000).toFixed(1) + '秒');
    micTimer = setTimeout(() => { void voiceInput.stop(); micStarting = false; controls(); $('mic').textContent = '話す'; status('音声入力を止めました。'); }, 20000);
  } catch (error) { micStarting = false; controls(); log(error.message); if (connected) status('マイクを開始できませんでした。'); }
};
$('composer').onsubmit = event => { event.preventDefault(); void sendText($('text').value); };
$('stop').onclick = () => void endSession();
$('play').onclick = async () => { await viewer?.startAudio(); for (const audio of $('audio').children) await audio.play(); $('play').hidden = true; };
document.addEventListener('visibilitychange', () => { if (document.hidden && control) void endSession('画面を離れたため終了しました。'); });
window.addEventListener('pagehide', () => { if (control) { navigator.sendBeacon(W + '/bithuman-live/stop', new Blob([JSON.stringify({ control })], { type: 'text/plain' })); void viewer?.disconnect(); void sender?.disconnect(); } });
try {
  const pending = localStorage.getItem(pendingKey);
  if (pending) { saveControl(pending); await endSession('前回の接続を終了しました。'); if (control) throw new Error('前回の終了確認が必要です'); }
  const health = await call('health'); log('設定確認: OK / avatar: ' + health.agent_code);
  status('開始できます。最初は文字で1往復、その後「話す」で確認できます。'); controls();
} catch (error) { status(error.message); log(error.message); }
