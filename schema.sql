-- Wedding RSVP database schema for Cloudflare D1.

CREATE TABLE IF NOT EXISTS invites (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash      TEXT NOT NULL UNIQUE,
  household_label TEXT NOT NULL,
  phone_e164      TEXT NOT NULL,
  source_list     TEXT,
  email           TEXT,
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS guests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  invite_id  INTEGER NOT NULL REFERENCES invites(id) ON DELETE CASCADE,
  full_name  TEXT NOT NULL,
  events     TEXT NOT NULL DEFAULT 'welcome,ceremony,farewell',
  invited_by TEXT
);

CREATE TABLE IF NOT EXISTS rsvps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_id      INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  event         TEXT NOT NULL,
  attending     INTEGER NOT NULL DEFAULT 0,
  meal_choice   TEXT,
  dietary_notes TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (guest_id, event)
);

CREATE TABLE IF NOT EXISTS rate_limits (
  token_hash   TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_invites_token_hash ON invites(token_hash);
CREATE INDEX IF NOT EXISTS idx_guests_invite_id ON guests(invite_id);
CREATE INDEX IF NOT EXISTS idx_rsvps_guest_event ON rsvps(guest_id, event);
