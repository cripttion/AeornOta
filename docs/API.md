# HTTP API reference

All endpoints are served by the one Worker.

- Device endpoints are public, because phones hold no secret.
- Admin endpoints need `Authorization: Bearer <token>`.

## Pages

| Path | What it is |
|---|---|
| `/` | The project website |
| `/dashboard` | The dashboard (sign in with a token). Old `/#/…` links redirect here |
| `/docs` | The documentation, readable without signing in |

## Device endpoints (public)

| Method | Path | Used by |
|---|---|---|
| GET | `/expo/:app/manifest` | `expo-updates` (protocol v1). Returns a multipart manifest or directive with `expo-signature` |
| POST | `/expo/:app/events` | Expo client kit telemetry: `{"event":"launch_ok","updateId":"…"}` |
| GET | `/files/:sha256` | Bundles and assets, immutable. Answers `226` + `IM: bsdiff` with a patch when the request has `A-IM: bsdiff` and `Expo-Current-Update-ID` |
| POST | `/api/v1/patches/check` | Shorebird updater: `{app_id, channel, release_version, platform, arch, client_id, current_patch_number?}` |
| POST | `/api/v1/patches/events` | Shorebird updater events |
| GET | `/sb/patches/:token` | Shorebird patch download; supports `Range` |
| GET | `/healthz` | Health check |
| POST | `/api/auth/github` | GitHub Actions OIDC token → one-hour publisher token (only for trusted repository/branch) |
| GET | `/cli/aeron.mjs`, `/cli/aeron.mjs.sha256` | The single-file CLI and its hash |

## Shorebird CLI endpoints (token required)

Under `/api/v1`, Aeron implements what the stock `shorebird` CLI uses:
- organizations;
- apps;
- releases, release artifacts and patches;
- patch artifacts, channels and promote;
- rollback, rollforward and rollout;
- `users/me` and `plan`.

Uploads go to `/api/v1/uploads/:token` (resumable, 8 MiB chunks). Errors use Shorebird's `{code, message}` body.

`GET /api/v1/apps/:app/signing-key` always answers `503`, because Aeron doesn't hold signing keys. Release with `--public-key-path`.

## Admin API (token required)

Under `/api/admin`. Errors are `{"error":{"code","message"}}`.

| Method | Path | Role |
|---|---|---|
| GET | `/me`, `/config`, `/settings`, `/overview?days=14` | viewer |
| GET, POST | `/apps` | viewer / admin |
| DELETE | `/apps/:id` with `{"dryRun": true}` (preview) or `{"confirm": "<id>"}` (delete permanently). Removes the app's updates, releases, patches, keys, stats, trust rules and the stored files no other app uses; revokes tokens limited to it | admin |
| GET | `/apps/:id`, `/apps/:id/stats?days=14` | viewer |
| GET | `/audit?app=&limit=` | viewer (with `app`) / admin |
| POST, GET, DELETE | `/tokens`, `/tokens/:id` | admin |
| POST | `/files/missing` | publisher |
| PUT | `/files/:sha256` | publisher |
| POST | `/expo/apps/:id/keys` | admin |
| GET | `/expo/apps/:id/keys` | viewer |
| POST | `/expo/apps/:id/keys/:keyId/retire` | admin |
| POST, GET | `/expo/apps/:id/runtimes` | publisher / viewer |
| POST, GET | `/expo/apps/:id/updates` | publisher / viewer |
| GET | `/expo/updates/:updateId` | viewer |
| POST | `/expo/apps/:id/patches` | publisher |
| GET | `/expo/apps/:id/rollouts` | viewer |
| POST | `/expo/apps/:id/rollouts/action` (`set_percent`, `halt`, `undo`, `cancel_undo`) | publisher |
| GET | `/flutter/apps/:id` | viewer |
| POST | `/flutter/apps/:id/settings` | admin |
| POST | `/flutter/apps/:id/patches/:patchId/action` (`approve`, `reject`, `promote`, `set_percent`, `halt`, `rollback`, `rollforward`) | publisher; approve/reject: admin, not the submitter |
| POST | `/flutter/apps/:id/patches/:patchId/meta` | publisher (submitter) |
| GET | `/approvals` | viewer |
| POST | `/expo/updates/:id/review` (`approve` / `reject`) | admin, not the submitter |
| GET, POST | `/apps/:id/settings` (`requireApproval`) | viewer / admin |
| GET | `/security` | admin |
| GET, POST, DELETE | `/github/trust`, `/github/trust/:id` | admin |
| GET | `/github/workflow?app=` | viewer |
| POST | `/notifications/test` | admin |

Sensitive admin actions also require a Cloudflare Access login when `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set: approvals, tokens, key changes after an app's first key, trust rules, the approval policy, Flutter signing changes and deleting apps. The login is read from the `Cf-Access-Jwt-Assertion` header or the `CF_Authorization` cookie and verified against your team's keys. Creating an app and registering its first key work with an admin token.

## Publishing an Expo update by hand

A publish is two steps:

1. Upload every file to `PUT /api/admin/files/<sha256 hex>`. Use `POST /api/admin/files/missing` first to skip files the server already has.
2. Call `POST /api/admin/expo/apps/:id/updates` with:
   - the exact manifest string and its base64 RSA-SHA256 `signature`;
   - a signed `rollBackToEmbedded` `undoDirective` whose `commitTime` is later than the manifest's `createdAt`;
   - `channel`, `platform`, `runtimeVersion`, `keyId`, and optionally `rolloutPercent`.

The server verifies both signatures, checks that every referenced file exists, and checks that the update is newer than the current one. With approvals on, the update is stored as `pending` and goes live only after an admin with a different token approves it.
