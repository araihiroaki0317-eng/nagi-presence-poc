import { handleRequest } from './worker.js';
import { handleWorkersAIProvider } from './workers-ai-provider.js';
import { handleWorkersAICostEstimate } from './workers-ai-cost-estimator.js';
import { InMemoryBudgetGuard } from './budget-guard.js';
import { DurableBudgetStore } from './durable-budget-store.js';
export { DeviceAuthLedger } from './device-auth-ledger.js';

const ENVELOPE_LIMITS = Object.freeze({
  monthlyTurnLimit: 12,
  conversationTurnLimit: 1,
  monthlyCharacterLimit: 200000,
  conversationCharacterLimit: 20000,
  monthlyCostSoftLimitMicros: 8000,
  monthlyCostHardLimitMicros: 10000,
  conversationCostHardLimitMicros: 1000,
});

export class BudgetLedger {
  constructor(ctx, env) {
    this.guard = new InMemoryBudgetGuard({
      limits: ENVELOPE_LIMITS,
      store: new DurableBudgetStore(ctx.storage),
    });
    this.env = env;
  }

  fetch(input, init) {
    const request = input instanceof Request ? input : new Request(input, init);
    return this.guard.fetch(request);
  }
}

function budgetBinding(env) {
  if (!env.BUDGET_LEDGER?.getByName) return null;
  return env.BUDGET_LEDGER.getByName('env_workers_ai_baseline_2026_09_04_v1');
}

function deviceAuthBinding(env) {
  if (!env.DEVICE_AUTH_LEDGER?.getByName) return null;
  return env.DEVICE_AUTH_LEDGER.getByName('nagi-device-auth-v1');
}

export default {
  fetch(request, env) {
    return handleRequest(request, {
      ...env,
      DEVICE_AUTH: deviceAuthBinding(env),
      BUDGET_GUARD: budgetBinding(env),
      COST_ESTIMATOR: {
        fetch: (input, init) => handleWorkersAICostEstimate(
          input instanceof Request ? input : new Request(input, init), env),
      },
      TEXT_PROVIDER: {
        fetch: (input, init) => handleWorkersAIProvider(
          input instanceof Request ? input : new Request(input, init), env),
      },
    });
  },
};
