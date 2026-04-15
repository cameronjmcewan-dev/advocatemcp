ALTER TABLE click_events ADD COLUMN agent_id   TEXT;
ALTER TABLE click_events ADD COLUMN request_id TEXT;
CREATE INDEX IF NOT EXISTS idx_click_events_agent_ts ON click_events(agent_id, timestamp);
