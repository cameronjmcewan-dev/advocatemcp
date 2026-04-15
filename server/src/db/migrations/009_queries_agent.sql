-- Session 10: agent_id + stage on queries — both nullable for back-compat.
-- agent_id is self-asserted by the caller (header > tool arg, never auth).
-- stage is the EXPLICIT input only — inferred-stage values are not persisted
-- so the audit trail Session 11 reads stays free of server guesses.
ALTER TABLE queries ADD COLUMN agent_id TEXT;
ALTER TABLE queries ADD COLUMN stage TEXT;
