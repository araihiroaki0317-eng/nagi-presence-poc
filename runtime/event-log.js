const SCHEMA_VERSION = '0.1';

function fallbackId() {
  return `evt_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export class LocalStorageEventStore {
  constructor(key = 'nagi.runtime.events.v1', maxEvents = 1000) {
    this.key = key;
    this.maxEvents = maxEvents;
  }

  async read() {
    try {
      const parsed = JSON.parse(localStorage.getItem(this.key) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async append(event) {
    const events = await this.read();
    if (event.idempotency_key && events.some(item => item.idempotency_key === event.idempotency_key)) {
      return { event, duplicate: true };
    }
    events.push(event);
    localStorage.setItem(this.key, JSON.stringify(events.slice(-this.maxEvents)));
    return { event, duplicate: false };
  }
}

export class EventLog {
  constructor(store) {
    this.store = store;
    this.queue = Promise.resolve();
  }

  append(input) {
    this.queue = this.queue.then(async () => {
      const prior = await this.store.read();
      const event = {
        schema_version: SCHEMA_VERSION,
        event_id: input.event_id || globalThis.crypto?.randomUUID?.() || fallbackId(),
        parent_event_id: input.parent_event_id || null,
        session_id: input.session_id || null,
        turn_id: input.turn_id || null,
        sequence_number: prior.length ? prior[prior.length - 1].sequence_number + 1 : 1,
        timestamp: input.timestamp || new Date().toISOString(),
        event_type: input.event_type,
        speaker: input.speaker || 'system',
        transcript: input.transcript || null,
        interrupted: input.interrupted === true,
        explicit_correction: input.explicit_correction === true,
        active_project_id: input.active_project_id || null,
        override_id: input.override_id || null,
        model_version: input.model_version || null,
        prompt_version: input.prompt_version || 'nagi-runtime-kernel-0.1',
        tool_call_id: input.tool_call_id || null,
        processing_status: input.processing_status || 'recorded',
        error: input.error || null,
        idempotency_key: input.idempotency_key || null,
        metadata: input.metadata || null,
      };
      if (!event.event_type) throw new Error('event_type_required');
      return this.store.append(event);
    });
    return this.queue;
  }

  async toJSONL() {
    await this.queue;
    return (await this.store.read()).map(event => JSON.stringify(event)).join('\n');
  }
}
