-- Shorebird-compatible code push for Flutter apps (kind = 'flutter').
-- The Aeron app id is used as the Shorebird app_id in shorebird.yaml.

-- Per-app policy. Patches must carry a hash_signature that verifies against public_key_pem
-- when require_signing = 1. Aeron never stores a private key.
CREATE TABLE flutter_settings (
  app_id           TEXT PRIMARY KEY REFERENCES apps (id),
  require_signing  INTEGER NOT NULL DEFAULT 1,
  public_key_pem   TEXT,
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE sb_releases (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id            TEXT NOT NULL REFERENCES apps (id),
  version           TEXT NOT NULL,                  -- e.g. 1.0.0+1 (versionName+versionCode)
  flutter_revision  TEXT NOT NULL,
  flutter_version   TEXT,
  display_name      TEXT,
  notes             TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (app_id, version)
);

CREATE TABLE sb_release_platforms (
  release_id    INTEGER NOT NULL REFERENCES sb_releases (id),
  platform      TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('draft', 'active')),
  signing_mode  TEXT,
  metadata      TEXT,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (release_id, platform)
);

CREATE TABLE sb_release_artifacts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  release_id         INTEGER NOT NULL REFERENCES sb_releases (id),
  platform           TEXT NOT NULL,
  arch               TEXT NOT NULL,
  hash               TEXT NOT NULL,
  size               INTEGER NOT NULL,
  filename           TEXT,
  can_sideload       INTEGER NOT NULL DEFAULT 0,
  podfile_lock_hash  TEXT,
  signing            TEXT,                          -- JSON as sent by the CLI
  r2_key             TEXT NOT NULL,
  download_token     TEXT NOT NULL UNIQUE,
  state              TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'uploaded')),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (release_id, platform, arch)
);

CREATE TABLE sb_patches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  release_id  INTEGER NOT NULL REFERENCES sb_releases (id),
  number      INTEGER NOT NULL,
  metadata    TEXT,
  notes       TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (release_id, number)
);

CREATE TABLE sb_patch_artifacts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  patch_id           INTEGER NOT NULL REFERENCES sb_patches (id),
  platform           TEXT NOT NULL,
  arch               TEXT NOT NULL,
  hash               TEXT NOT NULL,                 -- sha256 of the *inflated* libapp/vmcode, not the upload
  size               INTEGER NOT NULL,
  hash_signature     TEXT,
  podfile_lock_hash  TEXT,
  r2_key             TEXT NOT NULL,
  download_token     TEXT NOT NULL UNIQUE,
  state              TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'uploaded')),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (patch_id, platform, arch)
);

CREATE TABLE sb_channels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id      TEXT NOT NULL REFERENCES apps (id),
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (app_id, name)
);

CREATE TABLE sb_channel_patches (
  channel_id      INTEGER NOT NULL REFERENCES sb_channels (id),
  patch_id        INTEGER NOT NULL REFERENCES sb_patches (id),
  rollout_bp      INTEGER NOT NULL DEFAULT 10000 CHECK (rollout_bp BETWEEN 0 AND 10000),
  is_rolled_back  INTEGER NOT NULL DEFAULT 0,
  promoted_by     TEXT,
  promoted_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (channel_id, patch_id)
);

-- Resumable (GCS-style, 8 MiB chunks) uploads backed by R2 multipart uploads.
CREATE TABLE sb_upload_sessions (
  token         TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('release', 'patch')),
  artifact_id   INTEGER NOT NULL,
  r2_key        TEXT NOT NULL,
  total         INTEGER NOT NULL,
  committed     INTEGER NOT NULL DEFAULT 0,
  upload_id     TEXT,
  parts         TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at  TEXT
);
