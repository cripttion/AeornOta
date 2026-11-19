-- Aeron core schema: apps, API tokens, audit log, stats, and the Expo Updates tables.
-- Timestamps are ISO-8601 UTC strings.

CREATE TABLE apps (
  id          TEXT PRIMARY KEY,                       -- slug, e.g. "calmi"
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('expo', 'flutter')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE api_tokens (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,                 -- sha256 hex of the token; plaintext is never stored
  role          TEXT NOT NULL CHECK (role IN ('admin', 'publisher', 'viewer')),
  app_scope     TEXT,                                 -- JSON array of app ids, NULL = all apps
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by    TEXT,
  last_used_at  TEXT,
  revoked_at    TEXT
);

CREATE TABLE audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  app_id  TEXT,
  detail  TEXT
);
CREATE INDEX audit_log_app ON audit_log (app_id, id DESC);

-- Daily counters for downloads, launches, errors, rollbacks (subject = update id or patch ref).
CREATE TABLE stats_daily (
  day      TEXT NOT NULL,
  app_id   TEXT NOT NULL,
  subject  TEXT NOT NULL,
  metric   TEXT NOT NULL,
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, app_id, subject, metric)
);

-- ---------------------------------------------------------------- Expo Updates

-- Public keys (SPKI PEM) used to double-check signatures at publish time, plus a
-- pre-signed {"type":"noUpdateAvailable"} directive, because the server never holds private keys.
CREATE TABLE expo_keys (
  app_id               TEXT NOT NULL REFERENCES apps (id),
  key_id               TEXT NOT NULL,
  public_key_pem       TEXT NOT NULL,
  no_update_directive  TEXT NOT NULL,
  no_update_signature  TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  retired_at           TEXT,
  PRIMARY KEY (app_id, key_id)
);

-- Runtime versions that exist in a store build. Publishing to an unknown runtime is refused
-- when the app requires registration (default), so JS can't reach a binary that lacks its native code.
CREATE TABLE expo_runtimes (
  app_id           TEXT NOT NULL REFERENCES apps (id),
  platform         TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  runtime_version  TEXT NOT NULL,
  note             TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (app_id, platform, runtime_version)
);

CREATE TABLE expo_updates (
  id               TEXT PRIMARY KEY,                  -- manifest id (UUID)
  app_id           TEXT NOT NULL REFERENCES apps (id),
  channel          TEXT NOT NULL,
  platform         TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  runtime_version  TEXT NOT NULL,
  created_at       TEXT NOT NULL,                     -- copied from the signed manifest
  manifest         TEXT NOT NULL,                     -- exact signed bytes (UTF-8 JSON)
  signature        TEXT NOT NULL,                     -- base64 RSA-SHA256 over manifest
  key_id           TEXT NOT NULL,
  undo_directive   TEXT NOT NULL,                     -- pre-signed rollBackToEmbedded for this update
  undo_signature   TEXT NOT NULL,
  message          TEXT,
  git_sha          TEXT,
  critical         INTEGER NOT NULL DEFAULT 0,
  total_bytes      INTEGER,
  published_by     TEXT NOT NULL,
  published_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX expo_updates_lookup ON expo_updates (app_id, channel, platform, runtime_version, created_at DESC);

-- One pointer per (app, channel, platform, runtime). Devices inside the rollout bucket get
-- current_update_id; everyone else gets stable_update_id (the last update that reached 100%).
CREATE TABLE expo_rollouts (
  app_id             TEXT NOT NULL REFERENCES apps (id),
  channel            TEXT NOT NULL,
  platform           TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  runtime_version    TEXT NOT NULL,
  current_update_id  TEXT REFERENCES expo_updates (id),
  stable_update_id   TEXT REFERENCES expo_updates (id),
  percent_bp         INTEGER NOT NULL DEFAULT 10000 CHECK (percent_bp BETWEEN 0 AND 10000),
  salt               TEXT NOT NULL,
  undo_active        INTEGER NOT NULL DEFAULT 0,
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by         TEXT,
  PRIMARY KEY (app_id, channel, platform, runtime_version)
);
