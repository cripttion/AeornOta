-- Binary patches (BSDIFF40) for Expo launch assets. A device running base_update_id that asks for
-- the target bundle with `A-IM: bsdiff` gets this small patch instead of the full file.
-- The device verifies the patched result against the hash in the signed manifest, so a bad patch
-- can never produce unverified code; the client simply falls back to the full download.
CREATE TABLE expo_patches (
  app_id            TEXT NOT NULL REFERENCES apps (id),
  base_update_id    TEXT NOT NULL REFERENCES expo_updates (id),
  target_update_id  TEXT NOT NULL REFERENCES expo_updates (id),
  target_hex        TEXT NOT NULL,      -- sha256 hex of the full target launch asset
  patch_hex         TEXT NOT NULL,      -- sha256 hex of the patch file in R2 (files/<hex>)
  patch_bytes       INTEGER NOT NULL,
  target_bytes      INTEGER NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (base_update_id, target_hex)
);
