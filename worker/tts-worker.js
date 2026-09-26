const ELEVENLABS_API = 'https://api.elevenlabs.io/v1/text-to-speech';

function cors(origin) {
  const allowed = new Set([
    'https://nagi-presence-poc.pages.dev',
  ]);
  return {
    'Access-Control-Allow-Origin': allowed.has(origin) ? origin : 'https://nagi-presence-poc.pages.dev',
    'Vary': 'Origin',
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/tts') return new Response('Not found', { status: 404 });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    const origin = request.headers.get('Origin') || '';
    let body;
    try { body = JSON.parse(await request.text()); } catch { body = null; }
    const text = String(body?.text || '').trim();
    if (!text) return Response.json({ error: 'text_required' }, { status: 400, headers: cors(origin) });
    if (!env.ELEVENLABS_API_KEY || !env.NAGI_VOICE_ID) {
      return Response.json({ error: 'tts_not_configured' }, { status: 503, headers: cors(origin) });
    }

    const upstream = await fetch(
      `${ELEVENLABS_API}/${encodeURIComponent(env.NAGI_VOICE_ID)}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: env.ELEVENLABS_MODEL_ID || 'eleven_flash_v2_5',
        }),
      },
    );

    if (!upstream.ok) {
      const detail = await upstream.text();
      return Response.json(
        { error: 'elevenlabs_tts_failed', status: upstream.status, detail: detail.slice(0, 500) },
        { status: 502, headers: cors(origin) },
      );
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        ...cors(origin),
        'Content-Type': upstream.headers.get('Content-Type') || 'audio/mpeg',
        'Cache-Control': 'no-store',
      },
    });
  },
};
