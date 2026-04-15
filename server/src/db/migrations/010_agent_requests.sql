CREATE TABLE IF NOT EXISTS agent_requests (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL,
  agent_id_source TEXT NOT NULL CHECK (agent_id_source IN ('oauth', 'header', 'tool_arg', 'inferred')),
  business_slug   TEXT,
  tool_called     TEXT NOT NULL,
  request_id      TEXT,
  timestamp       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  latency_ms      INTEGER NOT NULL,
  cost_cents      INTEGER NOT NULL DEFAULT 0,
  outcome_signal  TEXT NOT NULL DEFAULT 'none' CHECK (outcome_signal IN ('none', 'click', 'reservation_held', 'reservation_confirmed', 'handoff_completed', 'error')),
  outcome_ts      TEXT,
  related_id      TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_requests_agent_ts   ON agent_requests(agent_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_agent_requests_request_id ON agent_requests(request_id);
CREATE INDEX IF NOT EXISTS idx_agent_requests_related_id ON agent_requests(related_id);
