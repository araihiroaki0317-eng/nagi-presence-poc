import { EventLog, LocalStorageEventStore } from './event-log.js';
import { NagiRuntimeState } from './state.js';

export const runtimeState = new NagiRuntimeState();
export const eventLog = new EventLog(new LocalStorageEventStore());

export function runtimeEvent(eventType, fields = {}) {
  const state = runtimeState.snapshot();
  return eventLog.append({
    event_type: eventType,
    active_project_id: state.active_project?.project_id || null,
    override_id: state.mode_override?.override_id || state.role_override?.override_id || null,
    ...fields,
  });
}
