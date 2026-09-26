// Minimal ElevenLabs Speech Engine transport boundary.
// Conversation semantics stay in nagi-memory-adapter /respond.
// Session identity is supplied by the caller; this transport never invents it.

export function latestUserTranscript(event) {
  if (!event || event.type !== 'user_transcript') return '';
  const direct = String(event.user_transcript || event.transcript || event.text || '').trim();
  if (direct) return direct;
  const history = Array.isArray(event.conversation_history) ? event.conversation_history : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index] || {};
    const role = String(item.role || item.source || '').toLowerCase();
    if (role === 'user') {
      const value = String(item.message || item.content || item.text || '').trim();
      if (value) return value;
    }
  }
  return '';
}

export function createSpeechEngineTransport({
  respondEndpoint,
  fetchImpl = globalThis.fetch?.bind(globalThis),
} = {}) {
  const endpoint = String(respondEndpoint || '').replace(/\/+$/, '');
  if (!endpoint) throw new Error('respond_endpoint_required');
  if (typeof fetchImpl !== 'function') throw new Error('fetch_required');

  return async function handle(event, { send, signal, userId, threadId } = {}) {
    if (typeof send !== 'function') throw new Error('send_required');
    if (event?.type !== 'user_transcript') return { ok: false, ignored: true };

    const query = latestUserTranscript(event);
    if (!query) return { ok: false, reason: 'transcript_required' };
    if (!userId) throw new Error('user_id_required');
    if (!threadId) throw new Error('thread_id_required');

    const response = await fetchImpl(`${endpoint}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({
        query,
        user_id: userId,
        thread_id: threadId,
        top_k: 5,
        threshold: 0.1,
      }),
      signal,
    });

    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok) {
      const error = new Error(payload?.error || `respond_http_${response.status}`);
      error.status = response.status;
      throw error;
    }

    const text = String(payload?.response || '').trim();
    if (!text) throw new Error('respond_text_missing');
    if (signal?.aborted) return { ok: false, reason: 'aborted' };

    const outgoing = {
      type: 'agent_response',
      event_id: event.event_id,
      agent_response: text,
    };
    await send(outgoing);
    return { ok: true, event_id: event.event_id, text };
  };
}
