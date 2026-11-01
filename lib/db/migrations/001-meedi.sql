ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_admin_activity_at timestamptz;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS needs_attention boolean NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS escalation_reason text;
CREATE TABLE IF NOT EXISTS bot_settings (
  id integer PRIMARY KEY DEFAULT 1,
  system_prompt text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  temperature real NOT NULL DEFAULT 0.4,
  handover_timeout_hours integer NOT NULL DEFAULT 4,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO bot_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
