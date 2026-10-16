/**
 * GitHub Stars Vectorize — Minimal Proxy Worker
 *
 * Plain Vectorize upsert/query/delete proxy that holds no AI keys.
 * The frontend generates embeddings, while the Worker only handles vector storage and retrieval.
 *
 * ── Deployment Methods ──
 * Option 1: wrangler deploy (CLI)
 * Option 2: Cloudflare Dashboard → Workers & Pages → Create → Paste this file's contents
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(data, status = 200) {
  return Response.json(data, {
    status,
    headers: CORS_HEADERS,
  });
}

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Authentication
    if (!env.AUTH_TOKEN) {
      return jsonResponse({ success: false, error: 'Server auth not configured' }, 500);
    }
    const token = request.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
    if (token !== env.AUTH_TOKEN) {
      return jsonResponse({ success: false, error: 'Unauthorized' }, 401);
    }

    const url = new URL(request.url);

    try {
      // POST /upsert — Batch upsert vectors
      if (request.method === 'POST' && url.pathname === '/upsert') {
        const { vectors } = await request.json();
        if (!Array.isArray(vectors) || vectors.length === 0) {
          return jsonResponse({ success: false, error: 'vectors array required' }, 400);
        }
        await env.VECTORIZE.upsert(vectors);
        return jsonResponse({ success: true, upserted: vectors.length });
      }

      // POST /query — Vector similarity search
      if (request.method === 'POST' && url.pathname === '/query') {
        const { vector, topK = 20, threshold = 0.3 } = await request.json();
        if (!Array.isArray(vector) || vector.length === 0) {
          return jsonResponse({ success: false, error: 'vector array required' }, 400);
        }
        // returnMetadata:'all' caps topK at 50; clamp to avoid silent truncation
        const clampedTopK = Math.min(topK, 50);
        const matches = await env.VECTORIZE.query(vector, {
          topK: clampedTopK,
          returnMetadata: 'all',
        });
        // Filter out low-scoring results
        const filtered = matches.matches.filter((m) => m.score >= threshold);
        return jsonResponse({ success: true, matches: filtered });
      }

      // POST /delete — Delete specified vectors
      if (request.method === 'POST' && url.pathname === '/delete') {
        const { ids } = await request.json();
        if (!Array.isArray(ids) || ids.length === 0) {
          return jsonResponse({ success: false, error: 'ids array required' }, 400);
        }
        await env.VECTORIZE.deleteByIds(ids);
        return jsonResponse({ success: true, deleted: ids.length });
      }

      // POST /cleanup — Delete vectors not in keepIds (clean up unstarred repositories)
      if (request.method === 'POST' && url.pathname === '/cleanup') {
        const { keepIds } = await request.json();
        if (!Array.isArray(keepIds)) {
          return jsonResponse({ success: false, error: 'keepIds array required' }, 400);
        }
        const keepSet = new Set(keepIds);
        const info = await env.VECTORIZE.describe();
        if ((info.vectorCount ?? 0) === 0) {
          return jsonResponse({ success: true, deleted: 0 });
        }
        // Loop and delete vectors not in keepSet using query + zero-vector sampling
        const dimensions = info.dimensions ?? 1536;
        let totalDeleted = 0;
        const zeroVector = new Array(dimensions).fill(0);
        for (let round = 0; round < 10; round++) {
          const result = await env.VECTORIZE.query(zeroVector, {
            topK: 100,
            returnMetadata: 'none',
          });
          const staleIds = result.matches
            .filter((m) => !keepSet.has(m.id))
            .map((m) => m.id);
          if (staleIds.length === 0) break;
          await env.VECTORIZE.deleteByIds(staleIds);
          totalDeleted += staleIds.length;
        }
        return jsonResponse({ success: true, deleted: totalDeleted });
      }

      // GET /status — Return index info
      if (request.method === 'GET' && url.pathname === '/status') {
        const info = await env.VECTORIZE.describe();
        return jsonResponse({
          success: true,
          vectorCount: info.vectorCount ?? 0,
          dimensions: info.dimensions ?? 0,
        });
      }

      return jsonResponse({ error: 'Not Found' }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ success: false, error: message }, 500);
    }
  },
};
