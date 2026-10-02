import { isNagiWakeCall, ATTENTION_ACKNOWLEDGEMENT } from './attention.js';

// Reuse the existing strict wake vocabulary. This is attention gating, not
// speaker identification: another voice saying the wake word can still wake it.
export function createLiveAttention({ idleMs = 12000, now = Date.now } = {}) {
  let until = 0;
  return {
    engage() { until = now() + idleMs; },
    idle() { until = 0; },
    get state() { return now() < until ? 'conversation' : 'idle'; },
    accept(text) {
      const value = String(text || '').trim();
      if (!value) return { action: 'ignore' };
      if (isNagiWakeCall(value)) {
        until = now() + idleMs;
        return { action: 'acknowledge', text: ATTENTION_ACKNOWLEDGEMENT };
      }
      if (now() >= until) return { action: 'ignore' };
      until = now() + idleMs;
      return { action: 'respond', text: value };
    },
  };
}
