// Read only the fixed Nagi agent; never return prompts, tools, or credentials.
export async function readNagiVoiceConfiguration(env, request = fetch) {
  if (!env.ELEVENLABS_API_KEY) throw new Error('missing_elevenlabs_secret');
  const agentId = env.NAGI_ELEVENLABS_AGENT_ID || 'agent_8501m0nvtj12ea5vnc21ck26v9sp';
  const response = await request('https://api.elevenlabs.io/v1/convai/agents/' + encodeURIComponent(agentId), {
    method: 'GET',
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('elevenlabs_configuration_failed:' + response.status);
  const agent = await response.json();
  const tts = agent?.conversation_config?.tts;
  if (!tts || typeof tts !== 'object') throw new Error('elevenlabs_tts_configuration_missing');
  const safeString = value => typeof value === 'string' && value.length <= 256 ? value : null;
  const settings = {};
  for (const key of ['stability', 'similarity_boost', 'speed']) {
    settings[key] = typeof tts[key] === 'number' && Number.isFinite(tts[key]) ? tts[key] : null;
  }
  return {
    source: 'elevenlabs_agent',
    agent_id: agentId,
    voice_id: safeString(tts.voice_id),
    configured_model_id: safeString(tts.model_id),
    transport_model_id: safeString(tts.model_id) || 'eleven_multilingual_v2',
    configured_voice_settings: settings,
    omitted_settings: 'Provider defaults apply where a configured value is null.',
  };
}
