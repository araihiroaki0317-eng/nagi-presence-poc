// Minimal ElevenLabs Speech Engine transport boundary.
// Conversation semantics stay in nagi-memory-adapter /respond.
// Wire format follows the current ElevenLabs Speech Engine upstream protocol.

export function latestUserTranscript(event) {
  if (!event || event.type !== 'user_transcript') return '';
  const history = Array.isArray(event.user_transcript) ? event.user_transcript : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index] || {};
    if (item.role === 'user') {
      const value = String(item.content || '').trim();
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

    if (event?.type === 'ping') {
      await send({ type: 'pong' });
      return { ok: true, pong: true };
    }
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

    await send({
      type: 'agent_response',
      event_id: event.event_id,
      content: text,
      is_final: false,
    });
    await send({
      type: 'agent_response',
      event_id: event.event_id,
      content: '',
      is_final: true,
    });
    return { ok: true, event_id: event.event_id, text };
  };
}
