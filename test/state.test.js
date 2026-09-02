import test from 'node:test';
import assert from 'node:assert/strict';
import { NagiRuntimeState } from '../runtime/state.js';
import { EventLog } from '../runtime/event-log.js';

test('current turn override expires deterministically', () => {
  const state = new NagiRuntimeState();
  state.setOverride({
    type: 'mode', value: 'critical', scope: 'current_turn', source_event_id: 'evt_1',
  });
  assert.equal(state.snapshot().mode_override.value, 'critical');
  const expired = state.expireScope('current_turn');
  assert.equal(expired[0].status, 'expired');
  assert.equal(state.snapshot().mode_override, null);
});

test('project state requires provenance', () => {
  const state = new NagiRuntimeState();
  assert.throws(() => state.setActiveProject({ project_id: 'nagi', status: 'foreground' }),
    /source_event_id_required/);
});

test('undefined modes cannot be injected as overrides', () => {
  const state = new NagiRuntimeState();
  assert.throws(() => state.setOverride({
    type: 'mode', value: 'angry', scope: 'current_session', source_event_id: 'evt_2',
  }), /invalid_mode_override_value/);
  assert.equal(state.snapshot().mode_override, null);
});

test('event log assigns order and suppresses duplicate idempotency keys', async () => {
  const rows = [];
  const store = {
    async read() { return rows; },
    async append(event) {
      if (event.idempotency_key && rows.some(row => row.idempotency_key === event.idempotency_key)) {
        return { event, duplicate: true };
      }
      rows.push(event);
      return { event, duplicate: false };
    },
  };
  const log = new EventLog(store);
  await log.append({ event_type: 'session_started', idempotency_key: 'start-1' });
  const duplicate = await log.append({ event_type: 'session_started', idempotency_key: 'start-1' });
  await log.append({ event_type: 'session_ended' });
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(rows.map(row => row.sequence_number), [1, 2]);
});
