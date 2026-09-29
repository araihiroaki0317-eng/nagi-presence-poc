import { LiveAvatarSession, SessionEvent } from 'https://esm.sh/@heygen/liveavatar-web-sdk@latest?bundle';
const TRANSPORT='https://nagi-voice-transport.arai-hiroaki0317.workers.dev';
const video=document.getElementById('avatar'), start=document.getElementById('start'), stop=document.getElementById('stop'), status=document.getElementById('status');
let session=null;
const setStatus=(s)=>status.textContent=s;
const audioBtn=document.createElement('button'); audioBtn.textContent='凪音声テスト'; audioBtn.disabled=true; stop.before(audioBtn);
start.onclick=async()=>{
  start.disabled=true; setStatus('session token取得中…');
  try{
    const r=await fetch(TRANSPORT+'/liveavatar-session-token',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    const data=await r.json();
    if(!r.ok||!data.session_token) throw new Error(data.error||('HTTP '+r.status));
    setStatus('LiveAvatar接続中…');
    session=new LiveAvatarSession(data.session_token,{voiceChat:{defaultMuted:true},autoKeepAlive:true});
    session.on(SessionEvent.SESSION_STREAM_READY,()=>{session.attach(video); video.play().catch(()=>{}); setStatus('PASS: Sandbox stream ready'); audioBtn.disabled=false;});
    session.on(SessionEvent.SESSION_DISCONNECTED,()=>{setStatus('切断'); start.disabled=false; stop.disabled=true; session=null;});
    await session.start();
    stop.disabled=false;
  }catch(e){setStatus('FAIL: '+(e?.message||e)); start.disabled=false;}
};
stop.onclick=async()=>{stop.disabled=true; try{await session?.stop();}finally{session=null;start.disabled=false;setStatus('終了');}};

audioBtn.onclick=async()=>{
  audioBtn.disabled=true; setStatus('ElevenLabs→LiveAvatar 音声送信中…');
  try{
    const r=await fetch(TRANSPORT+'/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'こんにちは。凪の音声同期テストです。',output_format:'pcm_24000'})});
    if(!r.ok) throw new Error('tts HTTP '+r.status);
    const pcm=new Uint8Array(await r.arrayBuffer());
    if(!pcm.length) throw new Error('empty pcm');
    await session.repeatAudio(pcm);
    setStatus('PCM送信完了: '+pcm.length+' bytes — 口パクと音声を確認');
  }catch(e){setStatus('AUDIO FAIL: '+(e?.message||e));}
  finally{audioBtn.disabled=false;}
};
