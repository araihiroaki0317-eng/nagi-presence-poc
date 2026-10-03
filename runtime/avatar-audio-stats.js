// Read-only diagnostics. Never change playback, record audio, or report network addresses.
const counters = ['packetsReceived', 'packetsLost', 'packetsDiscarded', 'totalSamplesReceived',
  'concealedSamples', 'silentConcealedSamples', 'concealmentEvents',
  'insertedSamplesForDeceleration', 'removedSamplesForAcceleration',
  'jitterBufferDelay', 'jitterBufferEmittedCount'];

export function audioStatsSnapshot(report) {
  if (!report?.values) return null;
  const inbound = [...report.values()].find(s => s.type === 'inbound-rtp' && (s.kind || s.mediaType) === 'audio');
  if (!inbound) return null;
  const snapshot = { id: inbound.id, timestamp: inbound.timestamp };
  for (const key of [...counters, 'jitter']) {
    if (Number.isFinite(inbound[key])) snapshot[key] = inbound[key];
  }
  const codec = report.get(inbound.codecId);
  if (codec) {
    snapshot.codec = codec.mimeType;
    snapshot.clockRate = codec.clockRate;
    snapshot.channels = codec.channels;
  }
  return snapshot;
}

export function audioStatsDelta(previous, next) {
  if (!previous || previous.id !== next.id || next.timestamp <= previous.timestamp) return null;
  const delta = { interval_ms: Math.round(next.timestamp - previous.timestamp) };
  for (const key of counters) {
    if (!Number.isFinite(previous[key]) || !Number.isFinite(next[key])) continue;
    const value = next[key] - previous[key];
    // packetsLost can decrease when previously missing packets arrive late.
    if (value < 0 && key !== 'packetsLost') return null;
    delta[key] = value;
  }
  if (Number.isFinite(next.jitter)) delta.jitter_ms = Math.round(next.jitter * 1000);
  if (delta.jitterBufferEmittedCount > 0 && Number.isFinite(delta.jitterBufferDelay)) {
    delta.mean_buffer_ms = Math.round(1000 * delta.jitterBufferDelay / delta.jitterBufferEmittedCount);
  }
  delete delta.jitterBufferDelay;
  delete delta.jitterBufferEmittedCount;
  return delta;
}

export function monitorAvatarAudio(track, onSample, intervalMs = 1000) {
  let stopped = false, timer, previous, announced = false;
  const sample = async () => {
    try {
      const next = audioStatsSnapshot(await track.getRTCStatsReport());
      if (stopped) return;
      if (next) {
        if (!announced) {
          onSample({ state: 'available', codec: next.codec, clockRate: next.clockRate,
            channels: next.channels, supported: counters.filter(key => Number.isFinite(next[key])) });
          announced = true;
        }
        const delta = audioStatsDelta(previous, next);
        if (delta) onSample(delta);
        previous = next;
      } else if (!announced) { onSample({ state: 'unavailable' }); announced = true; }
    } catch {
      if (!stopped && !announced) { onSample({ state: 'unavailable' }); announced = true; }
    }
    if (!stopped) timer = setTimeout(sample, intervalMs);
  };
  void sample();
  return { stop() { stopped = true; clearTimeout(timer); } };
}
