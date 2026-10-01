import { AvatarSDK, AvatarManager, AvatarView, DrivingServiceMode } from 'https://esm.sh/@spatius/avatarkit@1.3.8?bundle';
const WORKER='https://nagi-voice-transport.arai-hiroaki0317.workers.dev';
const SAMPLE_RATE=16000;
const $=id=>document.getElementById(id), status=$('status'), stage=$('stage'), start=$('start'), speak=$('speak');
let controller=null;
function log(s){status.textContent += '\n'+s}
async function boot(){
  try{
    const [cfgRes,tokRes]=await Promise.all([fetch(WORKER+'/spatius-config'),fetch(WORKER+'/spatius-session-token',{method:'POST'})]);
    if(!cfgRes.ok) throw new Error('config '+cfgRes.status+' '+await cfgRes.text());
    if(!tokRes.ok) throw new Error('token '+tokRes.status+' '+await tokRes.text());
    const cfg=await cfgRes.json(), tok=await tokRes.json();
    const appId=cfg.app_id||cfg.appId, avatarId=cfg.avatar_id||cfg.avatarId, region=cfg.region||'auto';
    const token=tok.session_token||tok.sessionToken;
    if(!appId||!avatarId||!token) throw new Error('bridge response missing required field');
    await AvatarSDK.initialize(appId,{...(region!=='auto'?{region}:{}),drivingServiceMode:DrivingServiceMode.direct,audioFormat:{channelCount:1,sampleRate:SAMPLE_RATE}});
    AvatarSDK.setSessionToken(token);
    log('TOKEN PASS');
    const avatar=await AvatarManager.shared.load(avatarId,p=>log('load '+Math.round((p.progress||0)*100)+'%'));
    const view=new AvatarView(avatar,stage); controller=view.controller;
    controller.onConnectionState=s=>{log('connection: '+s); if(s==='connected') speak.disabled=false};
    controller.onError=e=>log('SDK ERROR: '+(e?.message||e));
    view.onFirstRendering=()=>log('RENDER PASS');
    start.disabled=false; log('Nora loaded');
  }catch(e){log('BOOT FAIL: '+(e?.message||e)); start.disabled=true}
}
start.onclick=async()=>{try{await controller.initializeAudioContext();await controller.start();log('START requested')}catch(e){log('START FAIL: '+(e?.message||e))}};
speak.onclick=async()=>{try{
  const r=await fetch(WORKER+'/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'音声同期の動作確認です。',output_format:'pcm_16000'})});
  if(!r.ok) throw new Error('tts '+r.status+' '+await r.text());
  const pcm=new Uint8Array(await r.arrayBuffer()); controller.send(pcm); log('PCM sent: '+pcm.byteLength+' bytes');
}catch(e){log('AUDIO FAIL: '+(e?.message||e))}};
boot();