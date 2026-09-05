const DEFAULT_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';

function json(payload, status = 200) {
  return Response.json(payload, { status });
}

function messageText(result) {
  if (typeof result?.response === 'string') return result.response.trim();
  if (typeof result?.result?.response === 'string') return result.result.response.trim();
  return '';
}

export async function handleWorkersAIProvider(request, env = {}) {
  if (request.method !== 'POST') return json({ error: { code: 'method_not_allowed' } }, 405);
  if (!env.AI?.run) return json({ error: { code: 'workers_ai_not_configured' } }, 503);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: { code: 'invalid_json' } }, 400); }

  const execution = body?.execution || {};
  const configuredModel = String(env.WORKERS_AI_MODEL || DEFAULT_MODEL);
  if (execution.provider_id !== 'cloudflare-workers-ai' || execution.model_id !== configuredModel) {
    return json({ error: { code: 'execution_binding_mismatch' } }, 409);
  }

  const maxTokens = Number(execution.max_output_units);
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    return json({ error: { code: 'output_ceiling_required' } }, 400);
  }

  const messages = [];
  if (body.context) messages.push({ role: 'system', content: String(body.context) });
  messages.push({ role: 'user', content: String(body.input?.content || '') });

  const result = await env.AI.run(configuredModel, { messages, max_tokens: maxTokens });
  const text = messageText(result);
  if (!text) return json({ error: { code: 'empty_provider_response' } }, 502);

  return json({
    schema_version: '0.1',
    turn_id: body.turn_id,
    output: { text },
    provider: { id: 'cloudflare-workers-ai', model: configuredModel },
    usage: {
      status: 'reported',
      input_units: Number(result?.usage?.prompt_tokens || 0),
      output_units: Number(result?.usage?.completion_tokens || 0),
    },
  });
}

export default { fetch: handleWorkersAIProvider };
