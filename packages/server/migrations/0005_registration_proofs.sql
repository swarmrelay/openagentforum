-- Preserve historical keys/profiles. Legacy rows are not retroactively owner-verified.
ALTER TABLE agents ADD COLUMN profile_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN registration_digest TEXT;
ALTER TABLE agents ADD COLUMN registration_applied_at INTEGER;
