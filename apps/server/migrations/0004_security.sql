-- Security hardening: approvals (four-eyes), token expiry, GitHub OIDC trust, CI provenance.

-- Tokens can expire. Tokens minted for GitHub Actions carry the verified CI identity.
ALTER TABLE api_tokens ADD COLUMN expires_at TEXT;
ALTER TABLE api_tokens ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';   -- manual | github-oidc | cli-ephemeral
ALTER TABLE api_tokens ADD COLUMN ci TEXT;                                 -- JSON {repository, sha, ref, runUrl}

-- Per-app policy. require_approval = 1 means new code (an Expo update or a Shorebird patch
-- promotion) waits until a *different* admin token approves it.
CREATE TABLE app_settings (
  app_id            TEXT PRIMARY KEY REFERENCES apps (id),
  require_approval  INTEGER NOT NULL DEFAULT 1,
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by        TEXT
);
INSERT INTO app_settings (app_id) SELECT id FROM apps;

-- Expo updates: pending → live | rejected. Existing rows are already live.
ALTER TABLE expo_updates ADD COLUMN status TEXT NOT NULL DEFAULT 'live';
ALTER TABLE expo_updates ADD COLUMN requested_percent_bp INTEGER;
ALTER TABLE expo_updates ADD COLUMN publisher_token_id TEXT;
ALTER TABLE expo_updates ADD COLUMN reviewed_by TEXT;
ALTER TABLE expo_updates ADD COLUMN reviewed_at TEXT;
ALTER TABLE expo_updates ADD COLUMN repository TEXT;
ALTER TABLE expo_updates ADD COLUMN ci_run_url TEXT;

-- Shorebird promotions: pending → live | rejected. Devices only ever see live rows.
ALTER TABLE sb_channel_patches ADD COLUMN status TEXT NOT NULL DEFAULT 'live';
ALTER TABLE sb_channel_patches ADD COLUMN requested_bp INTEGER;
ALTER TABLE sb_channel_patches ADD COLUMN requested_by_token TEXT;
ALTER TABLE sb_channel_patches ADD COLUMN reviewed_by TEXT;
ALTER TABLE sb_channel_patches ADD COLUMN reviewed_at TEXT;

ALTER TABLE sb_patches ADD COLUMN created_by_token TEXT;
ALTER TABLE sb_patches ADD COLUMN git_sha TEXT;
ALTER TABLE sb_patches ADD COLUMN repository TEXT;
ALTER TABLE sb_patches ADD COLUMN ci_run_url TEXT;

-- GitHub Actions workflows that may publish without a stored token (OIDC).
CREATE TABLE github_trust (
  id           TEXT PRIMARY KEY,
  app_id       TEXT NOT NULL REFERENCES apps (id),
  repository   TEXT NOT NULL,                -- owner/name (lower-case)
  ref          TEXT,                         -- e.g. refs/heads/main; NULL = any ref
  environment  TEXT,                         -- GitHub environment; NULL = any
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by   TEXT
);
CREATE INDEX github_trust_repo ON github_trust (repository);
