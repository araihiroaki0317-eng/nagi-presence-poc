import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionLimit } from '../runtime/session-limit.js';
function setup(busy) {
  let clock = 0, id = 0; const timers = new Map(), events = [];
  const limit = createSessionLimit({ seconds: 300, graceSeconds: 60, isBusy: () => busy,
    onExpire: () => events.push('expired'), onEnd: () => events.push('end'),
    now: () => clock, schedule: (fn, delay) => { timers.set(++id, { fn, at: clock + delay }); return id; }, cancel: id => timers.delete(id) });
  function advance(ms) { const target = clock + ms; while (true) { const next = [...timers].sort((a,b) => a[1].at-b[1].at)[0]; if (!next || next[1].at > target) break; clock = next[1].at; timers.delete(next[0]); next[1].fn(); } clock = target; }
  return { limit, events, advance };
}
test('five-minute idle session ends once', () => { const x = setup(false); x.advance(299999); assert.deepEqual(x.events, []); x.advance(1); assert.deepEqual(x.events, ['expired', 'end']); x.limit.finishTurn(); assert.equal(x.events.length, 2); });
test('active reply finishes before shutdown without another input turn', () => { const x = setup(true); x.advance(300000); assert.equal(x.limit.expired, true); assert.deepEqual(x.events, ['expired']); x.advance(15000); x.limit.finishTurn(); assert.deepEqual(x.events, ['expired', 'end']); x.advance(60000); assert.equal(x.events.length, 2); });
test('hung reply has a bounded sixty-second grace', () => { const x = setup(true); x.advance(359999); assert.deepEqual(x.events, ['expired']); x.advance(1); assert.deepEqual(x.events, ['expired', 'end']); });
test('manual stop cancels deadline and grace', () => { const x = setup(true); x.advance(300000); x.limit.close(); x.advance(100000); assert.deepEqual(x.events, ['expired']); });
