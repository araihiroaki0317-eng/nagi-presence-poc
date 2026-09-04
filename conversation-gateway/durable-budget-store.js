import { createBudgetPeriodState } from './budget-store.js';

export class DurableBudgetStore {
  constructor(storage) {
    if (!storage?.get || !storage?.put) throw new Error('durable_storage_required');
    this.storage = storage;
    this.cache = new Map();
  }

  periodKey(period) {
    return `period:${period}`;
  }

  reservationKey(reservationId) {
    return `reservation-period:${reservationId}`;
  }

  async transactPeriod(period, operation) {
    if (!period) throw new Error('period_required');
    if (typeof operation !== 'function') throw new Error('transaction_operation_required');
    const execute = async store => {
      const key = this.periodKey(period);
      const current = await store.get(key) || createBudgetPeriodState(period);
      const draft = structuredClone(current);
      const result = await operation(draft);
      await store.put(key, draft);
      for (const reservationId of Object.keys(draft.reservations)) {
        await store.put(this.reservationKey(reservationId), period);
      }
      this.cache.set(period, structuredClone(draft));
      return structuredClone(result);
    };
    if (typeof this.storage.transaction === 'function') {
      return this.storage.transaction(transaction => execute(transaction));
    }
    return execute(this.storage);
  }

  async transactReservation(reservationId, operation) {
    if (!reservationId) throw new Error('reservation_id_required');
    const period = await this.storage.get(this.reservationKey(reservationId));
    if (!period) return operation(null, null);
    return this.transactPeriod(period, state => operation(state.reservations[reservationId] || null, state));
  }

  snapshotPeriod(period) {
    return structuredClone(this.cache.get(period) || createBudgetPeriodState(period));
  }
}
