const MEM0_BASE = 'https://api.mem0.ai';
const ALLOWED_ORIGIN = 'https://araihiroaki0317-eng.github.io';

function cors(origin) {
  const allowed = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function json(data, status = 200, origin = ALLOWED_ORIGIN) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(origin) },
  });
}

async function readJson(request) {
  try { return await request.json(); }
  catch { throw new Error('invalid_json'); }
}

async function mem0Fetch(env, path, body) {
  if (!env.MEM0_API_KEY) throw new Error('MEM0_API_KEY_missing');
  const res = await fetch(`${MEM0_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${env.MEM0_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
  if (!res.ok) {
    const err = new Error('mem0_error');
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || ALLOWED_ORIGIN;
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

    const url = new URL(request.url);

    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ ok: true, service: 'nagi-memory-adapter', engine: 'mem0', milestone: '3B' }, 200, origin);
      }

      if (request.method === 'POST' && url.pathname === '/memory/add') {
        const body = await readJson(request);
        const messages = Array.isArray(body.messages) ? body.messages : [];
        if (!messages.length) return json({ error: 'messages_required' }, 400, origin);

        const payload = await mem0Fetch(env, '/v3/memories/add/', {
          messages,
          user_id: body.user_id || 'nagi-primary-user',
          agent_id: body.agent_id || 'nagi',
          run_id: body.run_id,
          metadata: body.metadata || { source: 'nagi-presence-poc' },
          custom_instructions: body.custom_instructions,
          infer: body.infer !== false,
        });
        return json(payload, 200, origin);
      }

      if (request.method === 'POST' && url.pathname === '/memory/search') {
        const body = await readJson(request);
        if (!body.query) return json({ error: 'query_required' }, 400, origin);
        const filters = body.filters || { user_id: body.user_id || 'nagi-primary-user' };
        const payload = await mem0Fetch(env, '/v3/memories/search/', {
          query: body.query,
          filters,
          top_k: body.top_k || 5,
          threshold: body.threshold ?? 0.1,
          rerank: body.rerank === true,
        });
        return json(payload, 200, origin);
      }

      if (request.method === 'POST' && url.pathname === '/memory/list') {
        const body = await readJson(request);
        const filters = body.filters || { user_id: body.user_id || 'nagi-primary-user' };
        const page = Number(body.page || 1);
        const pageSize = Math.min(Number(body.page_size || 50), 100);
        const payload = await mem0Fetch(env, `/v3/memories/?page=${page}&page_size=${pageSize}`, { filters });
        return json(payload, 200, origin);
      }

      return json({ error: 'not_found' }, 404, origin);
    } catch (error) {
      return json({
        error: error.message || 'internal_error',
        upstream_status: error.status || null,
        details: error.payload || null,
      }, error.status || 500, origin);
    }
  },
};
