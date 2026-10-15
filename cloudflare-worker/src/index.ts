import { compactUpsertVectors } from './metadata';

/**
 * GitHub Stars Vectorize — Minimal Proxy Worker
 *
 * Plain Vectorize upsert/query/delete proxy that holds no AI keys.
 * The frontend generates embeddings, while the Worker only handles vector storage and retrieval.
 */

interface Env {
  VECTORIZE: Vectorize;
  AUTH_TOKEN: string;
}

interface QueryRequest {
  vector: number[];
  topK?: number;
  threshold?: number;
}

interface DeleteRequest {
  ids: string[];
}

interface UpsertRequest {
  vectors: VectorizeVector[];
}

// returnMetadata:'all' caps topK at 50 on Vectorize V2 indexes; clamp requests
// to avoid passing an out-of-range topK and being silently truncated.
const QUERY_TOPK_LIMIT = 50;
const QUERY_DEFAULT_TOPK = 20;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: CORS_HEADERS,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
        const { vectors } = (await request.json()) as UpsertRequest;
        if (!Array.isArray(vectors) || vectors.length === 0) {
          return jsonResponse({ success: false, error: 'vectors array required' }, 400);
        }
        const compactedVectors = compactUpsertVectors(vectors);
        await env.VECTORIZE.upsert(compactedVectors);
        return jsonResponse({ success: true, upserted: vectors.length });
      }

      // POST /query — Vector similarity search
      if (request.method === 'POST' && url.pathname === '/query') {
        const { vector, topK = QUERY_DEFAULT_TOPK, threshold = 0.35 } = (await request.json()) as QueryRequest;
        if (!Array.isArray(vector) || vector.length === 0) {
          return jsonResponse({ success: false, error: 'vector array required' }, 400);
        }
        // returnMetadata:'all' caps topK at 50 (Vectorize V2 limits); clamp so
        // an oversized/negative/NaN topK degrades gracefully instead of erroring.
        const requestedTopK = typeof topK === 'number' && Number.isFinite(topK)
          ? Math.floor(topK)
          : QUERY_DEFAULT_TOPK;
        const clampedTopK = Math.min(Math.max(requestedTopK, 1), QUERY_TOPK_LIMIT);
        const matches = await env.VECTORIZE.query(vector, {
          topK: clampedTopK,
          returnMetadata: 'all' as const,
        });
        // Filter out low-scoring results
        const filtered = matches.matches.filter((m) => m.score >= threshold);
        return jsonResponse({ success: true, matches: filtered });
      }

      // POST /delete — Delete specified vectors
      if (request.method === 'POST' && url.pathname === '/delete') {
        const { ids } = (await request.json()) as DeleteRequest;
        if (!Array.isArray(ids) || ids.length === 0) {
          return jsonResponse({ success: false, error: 'ids array required' }, 400);
        }
        await env.VECTORIZE.deleteByIds(ids);
        return jsonResponse({ success: true, deleted: ids.length });
      }

      // POST /cleanup — Delete vectors not in keepIds (clean up unstarred repositories)
      if (request.method === 'POST' && url.pathname === '/cleanup') {
        const { keepIds } = (await request.json()) as { keepIds: string[] };
        if (!Array.isArray(keepIds)) {
          return jsonResponse({ success: false, error: 'keepIds array required' }, 400);
        }
        const keepSet = new Set(keepIds);
        const info = await env.VECTORIZE.describe();
        if ((info.vectorCount ?? 0) === 0) {
          return jsonResponse({ success: true, deleted: 0 });
        }
        // Loop and delete vectors not in keepSet using query + zero-vector sampling.
        // The Vectorize binding does not support listVectors; topK is capped at 100.
        const dimensions = info.dimensions ?? 1536;
        let totalDeleted = 0;
        const zeroVector = new Array(dimensions).fill(0);
        // Iterate at most 10 rounds (covering up to 1,000 vectors)
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
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ success: false, error: message }, 500);
    }
  },
};
