-- Hand-written: indexes drizzle-kit cannot express.
-- Extensions are installed by the superuser at database creation
-- (vector, vectorscale, pg_textsearch, ai); this only checks they exist.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE EXCEPTION 'extension "vector" is missing; create it as a superuser first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_textsearch') THEN
    RAISE EXCEPTION 'extension "pg_textsearch" is missing; create it as a superuser first';
  END IF;
END $$;
--> statement-breakpoint
-- Cosine-distance ANN index for semantic search (pgvector HNSW).
CREATE INDEX IF NOT EXISTS "repositories_embedding_hnsw" ON "repositories" USING hnsw ("embedding" vector_cosine_ops);
--> statement-breakpoint
-- BM25 keyword index (pg_textsearch). Query: ORDER BY search_text <@> to_bm25query('words', 'repositories_search_bm25').
CREATE INDEX IF NOT EXISTS "repositories_search_bm25" ON "repositories" USING bm25 ("search_text") WITH (text_config = 'english');
