const OVERRIDE_SCOPES = new Set([
  'current_turn',
  'current_topic',
  'current_task',
  'current_session',
]);

const PROJECT_STATUSES = new Set(['foreground', 'background', 'closed']);

export function createInitialState() {
  return {
    relationship: 'partner',
    role_override: null,
    mode_override: null,
    active_project: null,
    latest_checkpoint_id: null,
  };
}

export class NagiRuntimeState {
  constructor(initial = createInitialState()) {
    this.value = structuredClone(initial);
  }

  snapshot() {
    return structuredClone(this.value);
  }

  setOverride(override) {
    if (!override?.source_event_id) throw new Error('source_event_id_required');
    if (!['role', 'mode'].includes(override.type)) throw new Error('invalid_override_type');
    if (!OVERRIDE_SCOPES.has(override.scope)) throw new Error('invalid_override_scope');

    const normalized = {
      override_id: override.override_id || crypto.randomUUID(),
      type: override.type,
      value: override.value,
      source_event_id: override.source_event_id,
      scope: override.scope,
      status: 'active',
      created_at: override.created_at || new Date().toISOString(),
    };

    this.value[`${override.type}_override`] = normalized;
    return structuredClone(normalized);
  }

  clearOverride(type, status = 'cleared') {
    if (!['role', 'mode'].includes(type)) throw new Error('invalid_override_type');
    const key = `${type}_override`;
    const previous = this.value[key];
    this.value[key] = null;
    return previous ? { ...structuredClone(previous), status } : null;
  }

  expireScope(scope) {
    const expired = [];
    for (const type of ['role', 'mode']) {
      const current = this.value[`${type}_override`];
      if (current?.scope === scope) expired.push(this.clearOverride(type, 'expired'));
    }
    return expired;
  }

  setActiveProject(project) {
    if (!project) {
      this.value.active_project = null;
      return null;
    }
    if (!project.project_id) throw new Error('project_id_required');
    if (!project.source_event_id) throw new Error('source_event_id_required');
    if (!PROJECT_STATUSES.has(project.status)) throw new Error('invalid_project_status');
    this.value.active_project = structuredClone(project);
    return structuredClone(this.value.active_project);
  }

  setCheckpoint(checkpointId) {
    this.value.latest_checkpoint_id = checkpointId || null;
  }
}
