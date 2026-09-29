import { LiveAvatarSession, SessionEvent } from 'https://esm.sh/@heygen/liveavatar-web-sdk@latest?bundle';
const TRANSPORT='https://nagi-voice-transport.arai-hiroaki0317.workers.dev';
const video=document.getElementById('avatar'), start=document.getElementById('start'), stop=document.getElementById('stop'), status=document.getElementById('status');
let session=null;
const setStatus=(s)=>status.textContent=s;
start.onclick=async()=>{
  start.disabled=true; setStatus('session token取得中…');
  try{
    const r=await fetch(TRANSPORT+'/liveavatar-session-token',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    const data=await r.json();
    if(!r.ok||!data.session_token) throw new Error(data.error||('HTTP '+r.status));
    setStatus('LiveAvatar接続中…');
    session=new LiveAvatarSession(data.session_token,{voiceChat:{defaultMuted:true},autoKeepAlive:true});
    session.on(SessionEvent.SESSION_STREAM_READY,()=>{session.attach(video); video.play().catch(()=>{}); setStatus('PASS: Sandbox stream ready');});
    session.on(SessionEvent.SESSION_DISCONNECTED,()=>{setStatus('切断'); start.disabled=false; stop.disabled=true; session=null;});
    await session.start();
    stop.disabled=false;
  }catch(e){setStatus('FAIL: '+(e?.message||e)); start.disabled=false;}
};
stop.onclick=async()=>{stop.disabled=true; try{await session?.stop();}finally{session=null;start.disabled=false;setStatus('終了');}};
