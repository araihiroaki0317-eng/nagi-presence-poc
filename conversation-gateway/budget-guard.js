import { InMemoryBudgetStore } from './budget-store.js';

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name}_required`);
  return number;
}

function optionalSoftLimit(value, hardLimit, name) {
  if (value === undefined || value === null) return null;
  const number = positiveInteger(value, name);
  if (number >= hardLimit) throw new Error(`${name}_must_be_below_hard_limit`);
  return number;
}

function fallbackId() {
  return `budget_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function periodFor(date) {
  return date.toISOString().slice(0, 7);
}

function emptyCounters() {
  return {
    reservedTurns: 0,
    committedTurns: 0,
    reservedCharacters: 0,
    committedCharacters: 0,
    reservedCostMicros: 0,
    committedCostMicros: 0,
  };
}

function counters(state, conversationId) {
  if (!state.conversations[conversationId]) state.conversations[conversationId] = emptyCounters();
  return state.conversations[conversationId];
}

function total(value, field) {
  return value[`reserved${field}`] + value[`committed${field}`];
}

export class InMemoryBudgetGuard {
  constructor({ limits, now = () => new Date(), idFactory = fallbackId, store = new InMemoryBudgetStore() } = {}) {
    const monthlyCostHardLimitMicros = positiveInteger(
      limits?.monthlyCostHardLimitMicros, 'monthly_cost_hard_limit_micros');
    const conversationCostHardLimitMicros = positiveInteger(
      limits?.conversationCostHardLimitMicros, 'conversation_cost_hard_limit_micros');
    this.limits = Object.freeze({
      monthlyTurnLimit: positiveInteger(limits?.monthlyTurnLimit, 'monthly_turn_limit'),
      conversationTurnLimit: positiveInteger(limits?.conversationTurnLimit, 'conversation_turn_limit'),
      monthlyCharacterLimit: positiveInteger(limits?.monthlyCharacterLimit, 'monthly_character_limit'),
      conversationCharacterLimit: positiveInteger(limits?.conversationCharacterLimit, 'conversation_character_limit'),
      monthlyCostHardLimitMicros,
      conversationCostHardLimitMicros,
      monthlyCostSoftLimitMicros: optionalSoftLimit(
        limits?.monthlyCostSoftLimitMicros, monthlyCostHardLimitMicros, 'monthly_cost_soft_limit_micros'),
      conversationCostSoftLimitMicros: optionalSoftLimit(
        limits?.conversationCostSoftLimitMicros,
        conversationCostHardLimitMicros,
        'conversation_cost_soft_limit_micros'),
    });
    if (!store?.transactPeriod || !store?.transactReservation || !store?.snapshotPeriod) {
      throw new Error('budget_store_required');
    }
    this.now = now;
    this.idFactory = idFactory;
    this.store = store;
  }

  async authorize(input = {}) {
    const conversationId = String(input.conversation_id || '').trim();
    const turnId = String(input.turn_id || '').trim();
    if (!conversationId || !turnId) return { allowed: false, reason: 'identity_required' };
    const characters = Number(input.input_characters || 0) + Number(input.context_characters || 0);
    if (!Number.isSafeInteger(characters) || characters < 0) {
      return { allowed: false, reason: 'character_count_invalid' };
    }
    const estimatedCostMicros = Number(input.estimated_cost_micros);
    if (!Number.isSafeInteger(estimatedCostMicros) || estimatedCostMicros <= 0) {
      return { allowed: false, reason: 'cost_estimate_required' };
    }

    const period = periodFor(this.now());
    return this.store.transactPeriod(period, state => {
      const turnKey = `${conversationId}:${turnId}`;
      const existingId = state.turn_index[turnKey];
      if (existingId) {
        const existing = state.reservations[existingId];
        return {
          allowed: existing?.status !== 'released',
          reservation_id: existingId,
          duplicate: true,
          status: existing?.status || 'unknown',
        };
      }

      const month = state.totals;
      const conversation = counters(state, conversationId);
      const checks = [
        [total(month, 'Turns') + 1, this.limits.monthlyTurnLimit, 'monthly_turn_limit'],
        [total(conversation, 'Turns') + 1, this.limits.conversationTurnLimit, 'conversation_turn_limit'],
        [total(month, 'Characters') + characters, this.limits.monthlyCharacterLimit, 'monthly_character_limit'],
        [
          total(conversation, 'Characters') + characters,
          this.limits.conversationCharacterLimit,
          'conversation_character_limit',
        ],
        [
          total(month, 'CostMicros') + estimatedCostMicros,
          this.limits.monthlyCostHardLimitMicros,
          'monthly_cost_hard_limit',
        ],
        [
          total(conversation, 'CostMicros') + estimatedCostMicros,
          this.limits.conversationCostHardLimitMicros,
          'conversation_cost_hard_limit',
        ],
      ];
      const denied = checks.find(([projected, limit]) => projected > limit);
      if (denied) return { allowed: false, reason: denied[2] };

      const reservationId = this.idFactory();
      const reservation = {
        reservation_id: reservationId,
        period,
        conversation_id: conversationId,
        turn_id: turnId,
        characters,
        estimated_cost_micros: estimatedCostMicros,
        currency: input.currency || null,
        status: 'reserved',
        usage: null,
      };
      state.reservations[reservationId] = reservation;
      state.turn_index[turnKey] = reservationId;
      for (const value of [month, conversation]) {
        value.reservedTurns += 1;
        value.reservedCharacters += characters;
        value.reservedCostMicros += estimatedCostMicros;
      }

      const warningReasons = [];
      if (this.limits.monthlyCostSoftLimitMicros
        && total(month, 'CostMicros') >= this.limits.monthlyCostSoftLimitMicros) {
        warningReasons.push('monthly_cost_soft_limit');
      }
      if (this.limits.conversationCostSoftLimitMicros
        && total(conversation, 'CostMicros') >= this.limits.conversationCostSoftLimitMicros) {
        warningReasons.push('conversation_cost_soft_limit');
      }
      return {
        allowed: true,
        reservation_id: reservationId,
        duplicate: false,
        status: 'reserved',
        warning: warningReasons.length ? { level: 'soft_limit', reasons: warningReasons } : null,
      };
    });
  }

  async commit(input = {}) {
    return this.store.transactReservation(input.reservation_id, (reservation, state) => {
      if (!reservation) return { ok: false, reason: 'reservation_not_found' };
      if (reservation.status === 'committed') return { ok: true, duplicate: true, status: 'committed' };
      if (reservation.status !== 'reserved') return { ok: false, reason: 'reservation_not_active' };

      const month = state.totals;
      const conversation = counters(state, reservation.conversation_id);
      const reportedCost = Number(input.usage?.cost_micros);
      const actualCostMicros = Number.isSafeInteger(reportedCost) && reportedCost >= 0
        ? reportedCost
        : reservation.estimated_cost_micros;
      for (const value of [month, conversation]) {
        value.reservedTurns -= 1;
        value.reservedCharacters -= reservation.characters;
        value.reservedCostMicros -= reservation.estimated_cost_micros;
        value.committedTurns += 1;
        value.committedCharacters += reservation.characters;
        value.committedCostMicros += actualCostMicros;
      }
      reservation.status = 'committed';
      reservation.usage = input.usage || null;
      reservation.actual_cost_micros = actualCostMicros;
      return {
        ok: true,
        duplicate: false,
        status: 'committed',
        estimate_exceeded: actualCostMicros > reservation.estimated_cost_micros,
      };
    });
  }

  async release(input = {}) {
    return this.store.transactReservation(input.reservation_id, (reservation, state) => {
      if (!reservation) return { ok: false, reason: 'reservation_not_found' };
      if (reservation.status === 'released') return { ok: true, duplicate: true, status: 'released' };
      if (reservation.status !== 'reserved') return { ok: false, reason: 'reservation_not_active' };

      const month = state.totals;
      const conversation = counters(state, reservation.conversation_id);
      for (const value of [month, conversation]) {
        value.reservedTurns -= 1;
        value.reservedCharacters -= reservation.characters;
        value.reservedCostMicros -= reservation.estimated_cost_micros;
      }
      reservation.status = 'released';
      return { ok: true, duplicate: false, status: 'released' };
    });
  }

  snapshot(period = periodFor(this.now())) {
    const state = this.store.snapshotPeriod(period);
    return {
      period,
      limits: structuredClone(this.limits),
      totals: state.totals,
      reservations: Object.values(state.reservations),
    };
  }

  async fetch(input, init) {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    let body = {};
    try { body = await request.json(); } catch {}
    let result;
    if (url.pathname === '/authorize') result = await this.authorize(body);
    else if (url.pathname === '/commit') result = await this.commit(body);
    else if (url.pathname === '/release') result = await this.release(body);
    else return Response.json({ error: 'not_found' }, { status: 404 });
    return Response.json(result, { status: result.allowed === false || result.ok === false ? 409 : 200 });
  }
}
