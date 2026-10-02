const AVATAR = 'bithuman-avatar-agent';
export function createBithumanOutput({ room, endpoint, fetchImpl = fetch, timeoutMs = 60000, prebufferMs = 750, onTiming = () => {} }) {
  let active = null;
  room.registerRpcMethod('lk.playback_started', async ({ callerIdentity }) => {
    if (callerIdentity === AVATAR && active) onTiming({ stage: 'avatar_playback_started_ms', ms: performance.now() - active.startedAt });
    return '';
  });
  room.registerRpcMethod('lk.playback_finished', async ({ callerIdentity }) => {
    if (callerIdentity === AVATAR) active?.finish();
    return '';
  });
  return {
    async speak(text, { onSourceAudio } = {}) {
      if (active) return { ok: false, error: 'speech_in_progress' };
      const controller = new AbortController();
      let resolveDone;
      const done = new Promise(resolve => { resolveDone = resolve; });
      const current = { startedAt: performance.now(), controller, finish: () => resolveDone(true), cancel: () => resolveDone(false) };
      active = current;
      const timer = setTimeout(() => { controller.abort(); current.cancel(); }, timeoutMs);
      let writer, reader;
      const sourceChunks = [];
      let sourceBytes = 0;
      const sourceLimit = 16000 * 2 * 15; // Diagnostic preview: first 15 seconds only.
      try {
        const response = await fetchImpl(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, output_format: 'pcm_16000' }), signal: controller.signal });
        if (!response.ok || !response.body) throw new Error('tts_http_' + response.status);
        writer = await room.localParticipant.streamBytes({ name: 'nagi-reply-' + Date.now(), topic: 'lk.audio_stream', destinationIdentities: [AVATAR], attributes: { sample_rate: '16000', num_channels: '1' } });
        reader = response.body.getReader();
        // Network chunks can split a 16-bit sample. Forward only complete samples.
        let tail = new Uint8Array(0);
        let bytes = 0, sent = 0, pendingBytes = 0, maxReceiveWait = 0, maxWriteWait = 0;
        let buffered = [];
        const prebufferBytes = Math.max(0, Math.round(prebufferMs * 32 / 2) * 2);
        const write = async chunk => {
          if (controller.signal.aborted) throw new Error('speech_cancelled');
          const startedAt = performance.now();
          await writer.write(chunk);
          maxWriteWait = Math.max(maxWriteWait, performance.now() - startedAt);
          sent += chunk.length;
        };
        const flush = async () => {
          if (!buffered.length) return;
          const initial = new Uint8Array(pendingBytes);
          let offset = 0;
          for (const chunk of buffered) { initial.set(chunk, offset); offset += chunk.length; }
          buffered = []; pendingBytes = 0;
          onTiming({ stage: 'audio_prebuffer_ready_ms', ms: performance.now() - current.startedAt });
          await write(initial);
        };
        while (true) {
          const readStartedAt = performance.now();
          const { value, done: ended } = await reader.read();
          if (bytes) maxReceiveWait = Math.max(maxReceiveWait, performance.now() - readStartedAt);
          if (ended) break;
          if (controller.signal.aborted) throw new Error('speech_cancelled');
          const chunk = new Uint8Array(tail.length + value.length);
          chunk.set(tail); chunk.set(value, tail.length);
          const length = chunk.length - chunk.length % 2;
          if (length && !bytes) onTiming({ stage: 'tts_first_pcm_ms', ms: performance.now() - current.startedAt });
          if (length) {
            bytes += length;
            if (onSourceAudio && sourceBytes < sourceLimit) {
              const copy = chunk.slice(0, Math.min(length, sourceLimit - sourceBytes));
              sourceChunks.push(copy); sourceBytes += copy.length;
            }
            const samples = chunk.subarray(0, length);
            if (!sent) {
              buffered.push(samples); pendingBytes += length;
              if (pendingBytes >= prebufferBytes) await flush();
            } else await write(samples);
          }
          tail = chunk.slice(length);
        }
        if (tail.length || !bytes) throw new Error('invalid_pcm_audio');
        await flush();
        onTiming({ stage: 'tts_receive_max_wait_ms', ms: maxReceiveWait });
        onTiming({ stage: 'audio_send_max_wait_ms', ms: maxWriteWait });
        onTiming({ stage: 'reply_audio_duration_ms', ms: bytes / 32 });
        await writer.close();
        writer = null;
        if (!await done) throw new Error('playback_not_confirmed');
        if (onSourceAudio) {
          try { onSourceAudio(pcmWav(sourceChunks, sourceBytes)); } catch { /* Diagnostics must not interrupt conversation. */ }
        }
        return { ok: true };
      } catch (error) {
        controller.abort();
        try { await reader?.cancel(); } catch {}
        try { await writer?.close(); } catch {}
        return { ok: false, error: error?.message || 'avatar_audio_failed' };
      } finally { clearTimeout(timer); if (active === current) active = null; }
    },
    async stop() {
      active?.controller.abort(); active?.cancel();
      try { await room.localParticipant.performRpc({ destinationIdentity: AVATAR, method: 'lk.clear_buffer', payload: '', responseTimeout: 3000 }); } catch {}
    },
  };
}

export function pcmWav(chunks, byteLength) {
  const header = new ArrayBuffer(44), view = new DataView(header);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + byteLength, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, byteLength, true);
  return new Blob([header, ...chunks], { type: 'audio/wav' });
}
