const CHECKPOINT_SCHEMA_VERSION = '0.1';

function fallbackId() {
  return `cp_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function createCheckpoint(input = {}) {
  if (!input.source_event_id) throw new Error('source_event_id_required');
  return {
    schema_version: CHECKPOINT_SCHEMA_VERSION,
    checkpoint_id: input.checkpoint_id || globalThis.crypto?.randomUUID?.() || fallbackId(),
    source_event_id: input.source_event_id,
    project_id: input.active_project?.project_id || null,
    phase: input.active_project?.phase || null,
    current_topic: input.active_project?.current_topic || null,
    confirmed_decisions: Array.isArray(input.confirmed_decisions) ? input.confirmed_decisions : [],
    open_questions: Array.isArray(input.open_questions) ? input.open_questions : [],
    next_safe_step: input.next_safe_step || 'resume_recent_conversation',
    active_override_ids: [input.mode_override?.override_id, input.role_override?.override_id].filter(Boolean),
    recent_turns: Array.isArray(input.recent_turns) ? input.recent_turns.slice(-8) : [],
    reason: input.reason || 'periodic',
    created_at: input.created_at || new Date().toISOString(),
  };
}

export class LocalStorageCheckpointStore {
  constructor(key = 'nagi.runtime.checkpoint.v1', storage = globalThis.localStorage) {
    this.key = key;
    this.storage = storage;
  }

  readLatest() {
    try {
      const value = JSON.parse(this.storage?.getItem(this.key) || 'null');
      return value?.checkpoint_id ? value : null;
    } catch {
      return null;
    }
  }

  save(checkpoint) {
    if (!checkpoint?.checkpoint_id) throw new Error('checkpoint_id_required');
    this.storage?.setItem(this.key, JSON.stringify(checkpoint));
    return checkpoint;
  }
}

export function contextFromCheckpoint(checkpoint) {
  if (!checkpoint) return '';
  const lines = [];
  if (checkpoint.project_id) lines.push(`Active project: ${checkpoint.project_id}`);
  if (checkpoint.current_topic) lines.push(`Current topic: ${checkpoint.current_topic}`);
  if (checkpoint.confirmed_decisions?.length) {
    lines.push('Confirmed decisions:', ...checkpoint.confirmed_decisions.map(item => `- ${item}`));
  }
  if (checkpoint.open_questions?.length) {
    lines.push('Open questions:', ...checkpoint.open_questions.map(item => `- ${item}`));
  }
  if (checkpoint.recent_turns?.length) {
    lines.push('Recent conversation:', ...checkpoint.recent_turns.map(turn =>
      `${turn.role === 'user' ? 'ヒロ' : '凪'}: ${turn.text}`));
  }
  return lines.join('\n').slice(-3500);
}
