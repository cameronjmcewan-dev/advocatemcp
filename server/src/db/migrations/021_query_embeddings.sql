-- 021_query_embeddings.sql
--
-- Adds Voyage embedding storage and cluster assignment to the queries
-- table, plus a query_clusters catalog. All additive + nullable so the
-- migration is safe against a live prod database — existing rows simply
-- get NULL for the new columns until the backfill job runs.

ALTER TABLE queries ADD COLUMN query_embedding BLOB;

ALTER TABLE queries ADD COLUMN cluster_id INTEGER;

CREATE TABLE IF NOT EXISTS query_clusters (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  label                    TEXT NOT NULL,
  centroid                 BLOB NOT NULL,
  size                     INTEGER NOT NULL DEFAULT 0,
  representative_query_ids TEXT,
  updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at              TEXT
);

CREATE INDEX IF NOT EXISTS idx_queries_cluster_ts
  ON queries(cluster_id, timestamp)
  WHERE cluster_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_query_clusters_active
  ON query_clusters(archived_at)
  WHERE archived_at IS NULL;
