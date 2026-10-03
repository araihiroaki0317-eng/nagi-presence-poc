// A bounded grace period lets an in-flight reply finish without reopening input.
export function createSessionLimit({ seconds, graceSeconds = 60, isBusy, onExpire, onEnd, onTick = () => {}, now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
  const deadline = now() + seconds * 1000;
  let expired = false, closed = false, tickTimer, forceTimer;
  function end() { if (closed) return; closed = true; cancel(tickTimer); cancel(forceTimer); onEnd(); }
  function tick() {
    if (closed) return;
    const remaining = Math.max(0, Math.ceil((deadline - now()) / 1000));
    onTick(remaining);
    if (!remaining) {
      expired = true; onExpire();
      if (!isBusy()) end();
      else forceTimer = schedule(end, graceSeconds * 1000);
      return;
    }
    tickTimer = schedule(tick, Math.min(1000, deadline - now()));
  }
  tick();
  return {
    get expired() { return expired; },
    finishTurn() { if (expired) end(); },
    close() { closed = true; cancel(tickTimer); cancel(forceTimer); },
  };
}
