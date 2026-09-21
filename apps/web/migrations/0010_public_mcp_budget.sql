-- A fixed-size, connector-only admission ledger. No identity, IP, prompt,
-- message, cursor or client-selected key is stored. Provisioned only by migration.
CREATE TABLE public_mcp_budget (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  second_start INTEGER NOT NULL CHECK (second_start >= 0),
  second_used INTEGER NOT NULL CHECK (second_used BETWEEN 0 AND 20),
  minute_start INTEGER NOT NULL CHECK (minute_start >= 0),
  minute_used INTEGER NOT NULL CHECK (minute_used BETWEEN 0 AND 600),
  day_start INTEGER NOT NULL CHECK (day_start >= 0),
  day_used INTEGER NOT NULL CHECK (day_used BETWEEN 0 AND 20000)
);
INSERT INTO public_mcp_budget VALUES (1, 0, 0, 0, 0, 0, 0);
