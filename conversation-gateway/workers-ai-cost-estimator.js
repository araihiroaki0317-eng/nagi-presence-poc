const PROVIDER_ID = 'cloudflare-workers-ai';
const DEFAULT_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';
const MAX_OUTPUT_UNITS = 300;
const INPUT_USD_PER_MILLION = 0.051;
const OUTPUT_USD_PER_MILLION = 0.34;
const CONSERVATIVE_UNITS_PER_CHARACTER = 3;

function costMicros(units, usdPerMillion) {
  return units * usdPerMillion;
}

export function estimateWorkersAICost({ input_characters = 0, context_characters = 0 } = {}, model = DEFAULT_MODEL) {
  const characters = Number(input_characters) + Number(context_characters);
  if (!Number.isSafeInteger(characters) || characters < 0) throw new Error('character_count_invalid');
  const estimatedInputUnits = Math.max(1, characters * CONSERVATIVE_UNITS_PER_CHARACTER);
  const estimatedCostMicros = Math.max(1, Math.ceil(
    costMicros(estimatedInputUnits, INPUT_USD_PER_MILLION)
      + costMicros(MAX_OUTPUT_UNITS, OUTPUT_USD_PER_MILLION),
  ));
  return Object.freeze({
    estimate_id: `workers-ai-qwen3-price-2026-09-04:${estimatedInputUnits}:${MAX_OUTPUT_UNITS}`,
    estimate_kind: 'conservative_not_billed',
    provider_id: PROVIDER_ID,
    model_id: model,
    max_output_units: MAX_OUTPUT_UNITS,
    estimated_input_units: estimatedInputUnits,
    estimated_cost_micros: estimatedCostMicros,
    currency: 'USD',
    price_source_date: '2026-09-04',
  });
}

export async function handleWorkersAICostEstimate(request, env = {}) {
  if (request.method !== 'POST') return Response.json({ error: { code: 'method_not_allowed' } }, { status: 405 });
  let input;
  try { input = await request.json(); }
  catch { return Response.json({ error: { code: 'invalid_json' } }, { status: 400 }); }
  try {
    return Response.json(estimateWorkersAICost(input, String(env.WORKERS_AI_MODEL || DEFAULT_MODEL)));
  } catch (error) {
    return Response.json({ error: { code: error.message } }, { status: 400 });
  }
}

export default { fetch: handleWorkersAICostEstimate };
