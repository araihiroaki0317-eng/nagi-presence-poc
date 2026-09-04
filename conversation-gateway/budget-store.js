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

export function createBudgetPeriodState(period) {
  return {
    period,
    totals: emptyCounters(),
    conversations: {},
    reservations: {},
    turn_index: {},
  };
}

export class InMemoryBudgetStore {
  constructor() {
    this.periods = new Map();
    this.reservationPeriods = new Map();
    this.locks = new Map();
  }

  async transactPeriod(period, operation) {
    if (!period) throw new Error('period_required');
    if (typeof operation !== 'function') throw new Error('transaction_operation_required');
    const previous = this.locks.get(period) || Promise.resolve();
    const transaction = previous.catch(() => {}).then(async () => {
      const current = this.periods.get(period) || createBudgetPeriodState(period);
      const draft = structuredClone(current);
      const result = await operation(draft);
      this.periods.set(period, draft);
      for (const reservationId of Object.keys(draft.reservations)) {
        this.reservationPeriods.set(reservationId, period);
      }
      return structuredClone(result);
    });
    this.locks.set(period, transaction.then(() => undefined, () => undefined));
    return transaction;
  }

  async transactReservation(reservationId, operation) {
    if (!reservationId) throw new Error('reservation_id_required');
    const period = this.reservationPeriods.get(reservationId);
    if (!period) return operation(null, null);
    return this.transactPeriod(period, state => operation(state.reservations[reservationId] || null, state));
  }

  snapshotPeriod(period) {
    return structuredClone(this.periods.get(period) || createBudgetPeriodState(period));
  }
}
