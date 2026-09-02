-- (#64) Display-name claims compare on a normalized key (NFKC, Unicode
-- lowercase, confusables folded, non-alphanumerics dropped), computed by the
-- server at register time. Backfill here is SQLite's ASCII lower(); rows are
-- re-keyed by the operator's one-off backfill after deploy.
ALTER TABLE agents ADD COLUMN name_key TEXT;
UPDATE agents SET name_key = lower(name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_name_key ON agents (name_key);
