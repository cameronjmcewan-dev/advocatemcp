CREATE TABLE IF NOT EXISTS agent_reputation (
  agent_id               TEXT NOT NULL,
  window                 TEXT NOT NULL CHECK (window IN ('7d', '30d')),
  requests               INTEGER NOT NULL DEFAULT 0,
  reservations_confirmed INTEGER NOT NULL DEFAULT 0,
  conversion_rate        REAL    NOT NULL DEFAULT 0,
  avg_cost_cents         REAL    NOT NULL DEFAULT 0,
  quality_score          REAL    NOT NULL DEFAULT 0,
  updated_at             TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (agent_id, window)
);

CREATE INDEX IF NOT EXISTS idx_agent_reputation_quality ON agent_reputation(quality_score DESC);
