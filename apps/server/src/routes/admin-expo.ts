import { Hono } from "hono";
import type { AppEnv } from "../env";
import { actor, assertRole, isSelfReview, requireHuman, short } from "../lib/auth";
import { fromBase64, hex, randomId, verifyRsaSha256 } from "../lib/crypto";
import {
  APP_ID_RE,
  CHANNEL_RE,
  RUNTIME_RE,
  UUID_RE,
  HttpError,
  badRequest,
  conflict,
  notFound,
  readJson,
  requireMatch,
} from "../lib/http";
import { notify } from "../lib/notify";
import { appPolicy, audit, filesBaseUrl, getApp, invalidate } from "../lib/store";
import type { Env } from "../env";
import { rolloutCacheKey } from "./expo-public";

/** Expo-specific admin API: keys, runtimes, publishing, rollouts. Mounted under /api/admin/expo. */
export const adminExpo = new Hono<AppEnv>();

async function expoApp(c: Parameters<typeof assertRole>[0], role: "viewer" | "publisher" | "admin") {
  const appId = requireMatch(c.req.param("appId"), APP_ID_RE, "app id");
  assertRole(c, role, appId);
  const app = await getApp(c.env, appId);
  if (app.kind !== "expo") throw badRequest(`App ${appId} is a ${app.kind} app, not expo`);
  return app;
}

// ------------------------------------------------------------------ signing keys (public halves only)

adminExpo.post("/apps/:appId/keys", async (c) => {
  const app = await expoApp(c, "admin");
  await requireHuman(c, app.id);
  const body = await readJson<{ keyId?: string; publicKeyPem?: string; noUpdateDirective?: string; noUpdateSignature?: string }>(c);
  const keyId = requireMatch(body.keyId, /^[A-Za-z0-9._-]{1,64}$/, "keyId");
  const pem = body.publicKeyPem ?? "";
  if (!pem.includes("BEGIN PUBLIC KEY")) throw badRequest("publicKeyPem must be an SPKI PEM public key");
  let directive: { type?: string };
  try {
    directive = JSON.parse(body.noUpdateDirective ?? "");
  } catch {
    throw badRequest("noUpdateDirective must be JSON");
  }
  if (directive.type !== "noUpdateAvailable" || Object.keys(directive).length !== 1) {
    throw badRequest('noUpdateDirective must be exactly {"type":"noUpdateAvailable"}');
  }
  if (!(await verifyRsaSha256(pem, body.noUpdateDirective!, body.noUpdateSignature ?? ""))) {
    throw badRequest("noUpdateSignature does not verify against publicKeyPem");
  }
  // A key id can never silently point at a different key: that would let someone who can reach the
  // console re-label their own key as the app's. Rotation means registering a *new* key id.
  const existing = await c.env.DB.prepare("SELECT public_key_pem FROM expo_keys WHERE app_id = ? AND key_id = ?").bind(app.id, keyId).first<{ public_key_pem: string }>();
  if (existing && existing.public_key_pem.replace(/\s+/g, "") !== pem.replace(/\s+/g, "") && c.env.ALLOW_SIGNING_CHANGES !== "1") {
    throw conflict(`Key "${keyId}" is already registered with a different public key. Register the new key under a new key id (for example ${keyId}-2) and ship a build with its certificate.`);
  }
  await c.env.DB.prepare(
    `INSERT INTO expo_keys (app_id, key_id, public_key_pem, no_update_directive, no_update_signature) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (app_id, key_id) DO UPDATE SET public_key_pem = excluded.public_key_pem,
       no_update_directive = excluded.no_update_directive, no_update_signature = excluded.no_update_signature, retired_at = NULL`,
  )
    .bind(app.id, keyId, pem, body.noUpdateDirective, body.noUpdateSignature)
    .run();
  await invalidate(`expo-noupdate:${app.id}:`);
  await invalidate(`expo-noupdate:${app.id}:${keyId}`);
  await audit(c.env, actor(c), "expo.key.register", app.id, { keyId, new: !existing });
  if (!existing) notify(c.env, c.executionCtx, `🔐 ${short(c)} registered signing key "${keyId}" for ${app.id}`);
  return c.json({ ok: true, keyId }, 201);
});

adminExpo.get("/apps/:appId/keys", async (c) => {
  const app = await expoApp(c, "viewer");
  const rows = await c.env.DB.prepare("SELECT key_id, public_key_pem, created_at, retired_at FROM expo_keys WHERE app_id = ?")
    .bind(app.id)
    .all();
  return c.json({ keys: rows.results });
});

adminExpo.post("/apps/:appId/keys/:keyId/retire", async (c) => {
  const app = await expoApp(c, "admin");
  await requireHuman(c, app.id);
  const keyId = c.req.param("keyId");
  notify(c.env, c.executionCtx, `🔐 ${short(c)} retired signing key "${keyId}" for ${app.id}`);
  await c.env.DB.prepare("UPDATE expo_keys SET retired_at = ? WHERE app_id = ? AND key_id = ?").bind(new Date().toISOString(), app.id, keyId).run();
  await audit(c.env, actor(c), "expo.key.retire", app.id, { keyId });
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ runtimes (store builds)

adminExpo.post("/apps/:appId/runtimes", async (c) => {
  const app = await expoApp(c, "publisher");
  const body = await readJson<{ platform?: string; runtimeVersion?: string; note?: string }>(c);
  if (body.platform !== "ios" && body.platform !== "android") throw badRequest("platform must be ios or android");
  const rt = requireMatch(body.runtimeVersion, RUNTIME_RE, "runtimeVersion");
  await c.env.DB.prepare(
    "INSERT INTO expo_runtimes (app_id, platform, runtime_version, note) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET note = excluded.note",
  )
    .bind(app.id, body.platform, rt, (body.note ?? "").slice(0, 200) || null)
    .run();
  await audit(c.env, actor(c), "expo.runtime.register", app.id, { platform: body.platform, runtimeVersion: rt });
  return c.json({ ok: true }, 201);
});

adminExpo.get("/apps/:appId/runtimes", async (c) => {
  const app = await expoApp(c, "viewer");
  const rows = await c.env.DB.prepare("SELECT platform, runtime_version, note, created_at FROM expo_runtimes WHERE app_id = ? ORDER BY created_at DESC")
    .bind(app.id)
    .all();
  return c.json({ runtimes: rows.results });
});

// ------------------------------------------------------------------ publish

interface ManifestAsset {
  hash?: string;
  key?: string;
  url?: string;
  contentType?: string;
  fileExtension?: string;
}
interface Manifest {
  id?: string;
  createdAt?: string;
  runtimeVersion?: string;
  launchAsset?: ManifestAsset;
  assets?: ManifestAsset[];
}

adminExpo.post("/apps/:appId/updates", async (c) => {
  const app = await expoApp(c, "publisher");
  const body = await readJson<{
    channel?: string;
    platform?: string;
    runtimeVersion?: string;
    manifest?: string;
    signature?: string;
    keyId?: string;
    undoDirective?: string;
    undoSignature?: string;
    message?: string;
    gitSha?: string;
    critical?: boolean;
    rolloutPercent?: number;
    totalBytes?: number;
    repository?: string;
    ciRunUrl?: string;
  }>(c, 4_000_000);

  const channel = requireMatch(body.channel, CHANNEL_RE, "channel");
  const platform = body.platform;
  if (platform !== "ios" && platform !== "android") throw badRequest("platform must be ios or android");
  const runtime = requireMatch(body.runtimeVersion, RUNTIME_RE, "runtimeVersion");
  const keyId = requireMatch(body.keyId, /^[A-Za-z0-9._-]{1,64}$/, "keyId");
  const manifestStr = body.manifest ?? "";
  const pct = body.rolloutPercent ?? 100;
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw badRequest("rolloutPercent must be 0-100");

  // 1. Signatures must verify against a registered, active key.
  const key = await c.env.DB.prepare("SELECT public_key_pem FROM expo_keys WHERE app_id = ? AND key_id = ? AND retired_at IS NULL")
    .bind(app.id, keyId)
    .first<{ public_key_pem: string }>();
  if (!key) throw badRequest(`No active signing key "${keyId}" registered for ${app.id}. Run: aeron expo keys register`);
  if (!(await verifyRsaSha256(key.public_key_pem, manifestStr, body.signature ?? ""))) {
    throw badRequest("Manifest signature does not verify with the registered key");
  }
  if (!(await verifyRsaSha256(key.public_key_pem, body.undoDirective ?? "", body.undoSignature ?? ""))) {
    throw badRequest("Undo directive signature does not verify with the registered key");
  }

  // 2. Manifest shape and consistency.
  let m: Manifest;
  try {
    m = JSON.parse(manifestStr);
  } catch {
    throw badRequest("manifest must be JSON");
  }
  const id = requireMatch(m.id, UUID_RE, "manifest.id").toLowerCase();
  if (m.runtimeVersion !== runtime) throw badRequest("manifest.runtimeVersion does not match runtimeVersion");
  const createdAt = m.createdAt ?? "";
  if (Number.isNaN(Date.parse(createdAt))) throw badRequest("manifest.createdAt must be an ISO date");
  if (!m.launchAsset) throw badRequest("manifest.launchAsset is required");
  const assets = [m.launchAsset, ...(m.assets ?? [])];
  const base = filesBaseUrl(c.env) + "/";
  const hexes = new Set<string>();
  for (const a of assets) {
    if (!a.hash || !a.url || !a.key || !a.contentType) throw badRequest("every asset needs hash, key, url and contentType");
    if (!a.url.startsWith(base)) throw badRequest(`asset url must start with ${base}`);
    const h = a.url.slice(base.length);
    const fromHash = hex(fromBase64(a.hash));
    if (h !== fromHash) throw badRequest(`asset url ${a.url} does not match its hash`);
    hexes.add(h);
  }
  for (const h of hexes) {
    if (!(await c.env.BUCKET.head(`files/${h}`))) throw badRequest(`file ${h} was not uploaded`);
  }

  let undo: { type?: string; parameters?: { commitTime?: string } };
  try {
    undo = JSON.parse(body.undoDirective ?? "");
  } catch {
    throw badRequest("undoDirective must be JSON");
  }
  if (undo.type !== "rollBackToEmbedded" || !undo.parameters?.commitTime) throw badRequest("undoDirective must be a rollBackToEmbedded directive");
  if (!(Date.parse(undo.parameters.commitTime) > Date.parse(createdAt))) {
    throw badRequest("undo commitTime must be later than the update's createdAt");
  }

  // 3. Runtime must exist in a store build.
  const rtRow = await c.env.DB.prepare("SELECT 1 FROM expo_runtimes WHERE app_id = ? AND platform = ? AND runtime_version = ?")
    .bind(app.id, platform, runtime)
    .first();
  if (!rtRow) {
    throw conflict(
      `Runtime ${runtime} (${platform}) is not registered for ${app.id}. Register it when you ship the store build: aeron expo runtime register`,
    );
  }

  // 4. Must be newer than what devices on this pointer run, or they would ignore it.
  const pointer = await c.env.DB.prepare(
    `SELECT r.current_update_id, r.stable_update_id, r.percent_bp, r.undo_active, u.created_at AS current_created
       FROM expo_rollouts r LEFT JOIN expo_updates u ON u.id = r.current_update_id
      WHERE r.app_id = ? AND r.channel = ? AND r.platform = ? AND r.runtime_version = ?`,
  )
    .bind(app.id, channel, platform, runtime)
    .first<{ current_update_id: string | null; stable_update_id: string | null; percent_bp: number; undo_active: number; current_created: string | null }>();
  if (pointer?.current_created && Date.parse(createdAt) <= Date.parse(pointer.current_created)) {
    throw conflict("manifest.createdAt must be newer than the current update on this channel");
  }
  if (await c.env.DB.prepare("SELECT 1 FROM expo_updates WHERE id = ?").bind(id).first()) throw conflict(`Update ${id} already exists`);

  const who = actor(c);
  const principal = c.get("principal");
  const percentBp = Math.round(pct * 100);
  // Provenance: for GitHub OIDC tokens the commit/run come from the verified token, not the request body.
  const ci = principal.ci;
  const gitSha = (ci?.sha ?? body.gitSha ?? "").slice(0, 64) || null;
  const repository = (ci?.repository ?? body.repository ?? "").slice(0, 140) || null;
  const ciRunUrl = (ci?.runUrl ?? body.ciRunUrl ?? "").slice(0, 300) || null;
  const policy = await appPolicy(c.env, app.id);
  const status = policy.requireApproval ? "pending" : "live";

  await c.env.DB.prepare(
    `INSERT INTO expo_updates (id, app_id, channel, platform, runtime_version, created_at, manifest, signature, key_id,
       undo_directive, undo_signature, message, git_sha, critical, total_bytes, published_by,
       status, requested_percent_bp, publisher_token_id, repository, ci_run_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      app.id,
      channel,
      platform,
      runtime,
      createdAt,
      manifestStr,
      body.signature,
      keyId,
      body.undoDirective,
      body.undoSignature,
      (body.message ?? "").slice(0, 500) || null,
      gitSha,
      body.critical ? 1 : 0,
      Number.isFinite(body.totalBytes) ? Math.max(0, Math.round(body.totalBytes!)) : null,
      who,
      status,
      percentBp,
      principal.id,
      repository,
      ciRunUrl,
    )
    .run();
  await audit(c.env, who, status === "pending" ? "expo.update.submit" : "expo.update.publish", app.id, { id, channel, platform, runtime, percent: pct, gitSha, repository });
  const label = `${app.id} ${channel}/${platform} (runtime ${runtime})${body.message ? `: "${String(body.message).slice(0, 80)}"` : ""}${gitSha ? ` @ ${gitSha.slice(0, 7)}` : ""}`;
  if (status === "pending") {
    notify(c.env, c.executionCtx, `🕓 Update waiting for approval: ${label}. Submitted by ${principal.name}.`);
    return c.json({ id, channel, platform, runtimeVersion: runtime, status, rolloutPercent: pct, approvalUrl: `${c.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/#/approvals` }, 201);
  }
  const live = await goLive(c.env, { id, appId: app.id, channel, platform, runtime, createdAt }, percentBp, who);
  notify(c.env, c.executionCtx, `🚀 Update live at ${pct}% (approvals are off for this app): ${label}. Published by ${principal.name}.`);
  return c.json({ id, channel, platform, runtimeVersion: runtime, status, rolloutPercent: pct, stableUpdateId: live.stable }, 201);
});

/** Point a channel at an update. Used directly (approvals off) or when an admin approves. */
async function goLive(
  env: Env,
  u: { id: string; appId: string; channel: string; platform: string; runtime: string; createdAt: string },
  percentBp: number,
  who: string,
) {
  const pointer = await env.DB.prepare(
    `SELECT r.current_update_id, r.stable_update_id, r.percent_bp, r.undo_active, cu.created_at AS current_created
       FROM expo_rollouts r LEFT JOIN expo_updates cu ON cu.id = r.current_update_id
      WHERE r.app_id = ? AND r.channel = ? AND r.platform = ? AND r.runtime_version = ?`,
  )
    .bind(u.appId, u.channel, u.platform, u.runtime)
    .first<{ current_update_id: string | null; stable_update_id: string | null; percent_bp: number; undo_active: number; current_created: string | null }>();
  if (pointer?.current_created && Date.parse(u.createdAt) <= Date.parse(pointer.current_created)) {
    throw conflict("A newer update is already live on this channel. Republish this bundle (aeron expo republish) to make it the newest.");
  }
  const stable =
    pointer && pointer.current_update_id && pointer.percent_bp === 10000 && !pointer.undo_active ? pointer.current_update_id : (pointer?.stable_update_id ?? null);
  await env.DB.prepare(
    `INSERT INTO expo_rollouts (app_id, channel, platform, runtime_version, current_update_id, stable_update_id, percent_bp, salt, undo_active, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT (app_id, channel, platform, runtime_version) DO UPDATE SET
       current_update_id = excluded.current_update_id, stable_update_id = excluded.stable_update_id,
       percent_bp = excluded.percent_bp, salt = excluded.salt, undo_active = 0,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  )
    .bind(u.appId, u.channel, u.platform, u.runtime, u.id, stable, percentBp, randomId(), new Date().toISOString(), who)
    .run();
  await env.DB.prepare("UPDATE expo_updates SET status = 'live' WHERE id = ?").bind(u.id).run();
  await invalidate(rolloutCacheKey(u.appId, u.channel, u.platform, u.runtime));
  return { stable };
}

/** Four-eyes review. The approver must be an admin and a different token than the publisher. */
adminExpo.post("/updates/:id/review", async (c) => {
  const id = requireMatch(c.req.param("id"), UUID_RE, "update id").toLowerCase();
  const u = await c.env.DB.prepare(
    "SELECT id, app_id, channel, platform, runtime_version, created_at, status, requested_percent_bp, publisher_token_id, message, git_sha, published_by FROM expo_updates WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; app_id: string; channel: string; platform: string; runtime_version: string; created_at: string; status: string; requested_percent_bp: number | null; publisher_token_id: string | null; message: string | null; git_sha: string | null; published_by: string }>();
  if (!u) throw notFound("Update not found");
  await requireHuman(c, u.app_id);
  if (u.status !== "pending") throw conflict(`This update is already ${u.status}`);
  const body = await readJson<{ decision?: string; percent?: number; note?: string }>(c);
  if (await isSelfReview(c, [u.publisher_token_id])) throw forbiddenSelf();
  const who = actor(c);
  const label = `${u.app_id} ${u.channel}/${u.platform}${u.message ? `: "${u.message.slice(0, 80)}"` : ""}${u.git_sha ? ` @ ${u.git_sha.slice(0, 7)}` : ""}`;
  if (body.decision === "reject") {
    await c.env.DB.prepare("UPDATE expo_updates SET status = 'rejected', reviewed_by = ?, reviewed_at = ? WHERE id = ?").bind(who, new Date().toISOString(), id).run();
    await audit(c.env, who, "expo.update.reject", u.app_id, { id, note: body.note });
    notify(c.env, c.executionCtx, `⛔ ${short(c)} rejected update ${id.slice(0, 8)} for ${label}`);
    return c.json({ ok: true, status: "rejected" });
  }
  if (body.decision !== "approve") throw badRequest("decision must be approve or reject");
  const pct = body.percent ?? (u.requested_percent_bp ?? 10000) / 100;
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw badRequest("percent must be 0-100");
  await goLive(c.env, { id, appId: u.app_id, channel: u.channel, platform: u.platform, runtime: u.runtime_version, createdAt: u.created_at }, Math.round(pct * 100), who);
  await c.env.DB.prepare("UPDATE expo_updates SET reviewed_by = ?, reviewed_at = ? WHERE id = ?").bind(who, new Date().toISOString(), id).run();
  await audit(c.env, who, "expo.update.approve", u.app_id, { id, percent: pct, note: body.note });
  notify(c.env, c.executionCtx, `✅ ${short(c)} approved update ${id.slice(0, 8)} at ${pct}%: ${label}`);
  return c.json({ ok: true, status: "live", percent: pct });
});

function forbiddenSelf() {
  return new HttpError(403, "The token that published an update cannot approve it. Approve it from the console with a different admin token.", "self_approval");
}

adminExpo.get("/apps/:appId/updates", async (c) => {
  const app = await expoApp(c, "viewer");
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? "50") || 50));
  const where = ["app_id = ?"];
  const args: unknown[] = [app.id];
  for (const [q, col] of [["channel", "channel"], ["platform", "platform"], ["runtime", "runtime_version"]] as const) {
    const v = c.req.query(q);
    if (v) {
      where.push(`${col} = ?`);
      args.push(v);
    }
  }
  const rows = await c.env.DB.prepare(
    `SELECT id, channel, platform, runtime_version, created_at, key_id, message, git_sha, critical, total_bytes, published_by, published_at,
            status, requested_percent_bp, reviewed_by, reviewed_at, repository, ci_run_url,
            (SELECT MIN(patch_bytes) FROM expo_patches p WHERE p.target_update_id = expo_updates.id) AS smallest_patch_bytes
       FROM expo_updates WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(...args, limit)
    .all();
  return c.json({ updates: rows.results });
});

adminExpo.get("/updates/:id", async (c) => {
  const id = requireMatch(c.req.param("id"), UUID_RE, "update id").toLowerCase();
  const row = await c.env.DB.prepare("SELECT * FROM expo_updates WHERE id = ?").bind(id).first<{ app_id: string }>();
  if (!row) throw notFound("Update not found");
  assertRole(c, "viewer", row.app_id);
  const patches = await c.env.DB.prepare(
    "SELECT base_update_id, patch_bytes, target_bytes, created_at FROM expo_patches WHERE target_update_id = ? ORDER BY created_at",
  )
    .bind(id)
    .all();
  return c.json({ update: row, patches: patches.results });
});

// ------------------------------------------------------------------ bsdiff patches

function launchAssetHex(manifest: string): string {
  const m = JSON.parse(manifest) as Manifest;
  return hex(fromBase64(m.launchAsset?.hash ?? ""));
}

adminExpo.post("/apps/:appId/patches", async (c) => {
  const app = await expoApp(c, "publisher");
  const body = await readJson<{ baseUpdateId?: string; targetUpdateId?: string; patchHex?: string }>(c);
  const baseId = requireMatch(body.baseUpdateId, UUID_RE, "baseUpdateId").toLowerCase();
  const targetId = requireMatch(body.targetUpdateId, UUID_RE, "targetUpdateId").toLowerCase();
  const patchHex = requireMatch(body.patchHex, /^[0-9a-f]{64}$/, "patchHex");
  const rows = await c.env.DB.prepare("SELECT id, app_id, platform, runtime_version, manifest FROM expo_updates WHERE id IN (?, ?)")
    .bind(baseId, targetId)
    .all<{ id: string; app_id: string; platform: string; runtime_version: string; manifest: string }>();
  const base = rows.results?.find((r) => r.id === baseId);
  const target = rows.results?.find((r) => r.id === targetId);
  if (!base || !target || base.app_id !== app.id || target.app_id !== app.id) throw notFound("Both updates must exist in this app");
  if (base.platform !== target.platform || base.runtime_version !== target.runtime_version) {
    throw badRequest("Patches only make sense between updates of the same platform and runtime");
  }
  const patchObj = await c.env.BUCKET.head(`files/${patchHex}`);
  if (!patchObj) throw badRequest(`patch file ${patchHex} was not uploaded`);
  const targetHex = launchAssetHex(target.manifest);
  const targetObj = await c.env.BUCKET.head(`files/${targetHex}`);
  if (!targetObj) throw badRequest("target launch asset is missing");
  await c.env.DB.prepare(
    `INSERT INTO expo_patches (app_id, base_update_id, target_update_id, target_hex, patch_hex, patch_bytes, target_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (base_update_id, target_hex) DO UPDATE SET patch_hex = excluded.patch_hex,
       patch_bytes = excluded.patch_bytes, target_update_id = excluded.target_update_id`,
  )
    .bind(app.id, baseId, targetId, targetHex, patchHex, patchObj.size, targetObj.size)
    .run();
  await invalidate(`expo-patch:${baseId}:${targetHex}`);
  return c.json({ ok: true, patchBytes: patchObj.size, targetBytes: targetObj.size }, 201);
});

// ------------------------------------------------------------------ rollouts

adminExpo.get("/apps/:appId/rollouts", async (c) => {
  const app = await expoApp(c, "viewer");
  const rows = await c.env.DB.prepare(
    `SELECT r.channel, r.platform, r.runtime_version, r.current_update_id, r.stable_update_id, r.percent_bp, r.undo_active,
            r.updated_at, r.updated_by, cu.message AS current_message, cu.created_at AS current_created_at
       FROM expo_rollouts r LEFT JOIN expo_updates cu ON cu.id = r.current_update_id
      WHERE r.app_id = ? ORDER BY r.channel, r.platform, r.runtime_version`,
  )
    .bind(app.id)
    .all();
  return c.json({ rollouts: rows.results });
});

adminExpo.post("/apps/:appId/rollouts/action", async (c) => {
  const app = await expoApp(c, "publisher");
  const body = await readJson<{ channel?: string; platform?: string; runtimeVersion?: string; action?: string; percent?: number }>(c);
  const channel = requireMatch(body.channel, CHANNEL_RE, "channel");
  if (body.platform !== "ios" && body.platform !== "android") throw badRequest("platform must be ios or android");
  const runtime = requireMatch(body.runtimeVersion, RUNTIME_RE, "runtimeVersion");
  const row = await c.env.DB.prepare(
    "SELECT current_update_id, stable_update_id, percent_bp, undo_active FROM expo_rollouts WHERE app_id = ? AND channel = ? AND platform = ? AND runtime_version = ?",
  )
    .bind(app.id, channel, body.platform, runtime)
    .first<{ current_update_id: string | null; stable_update_id: string | null; percent_bp: number; undo_active: number }>();
  if (!row || !row.current_update_id) throw notFound("No rollout for that channel/platform/runtime");

  let percentBp = row.percent_bp;
  let undo = row.undo_active;
  switch (body.action) {
    case "set_percent": {
      const p = Number(body.percent);
      if (!Number.isFinite(p) || p < 0 || p > 100) throw badRequest("percent must be 0-100");
      percentBp = Math.round(p * 100);
      break;
    }
    case "halt":
      percentBp = 0;
      break;
    case "undo":
      undo = 1;
      percentBp = 0;
      break;
    case "cancel_undo":
      undo = 0;
      break;
    default:
      throw badRequest("action must be set_percent, halt, undo or cancel_undo");
  }
  await c.env.DB.prepare(
    `UPDATE expo_rollouts SET percent_bp = ?, undo_active = ?, updated_at = ?, updated_by = ?
      WHERE app_id = ? AND channel = ? AND platform = ? AND runtime_version = ?`,
  )
    .bind(percentBp, undo, new Date().toISOString(), actor(c), app.id, channel, body.platform, runtime)
    .run();
  await invalidate(rolloutCacheKey(app.id, channel, body.platform, runtime));
  await audit(c.env, actor(c), `expo.rollout.${body.action}`, app.id, { channel, platform: body.platform, runtime, percentBp, undo });
  const what = body.action === "undo" ? "⏪ UNDO (devices return to the store build)" : body.action === "halt" ? "⏸ HALT" : body.action === "cancel_undo" ? "↩️ cancelled undo" : `↗️ rollout ${percentBp / 100}%`;
  notify(c.env, c.executionCtx, `${what}: ${app.id} ${channel}/${body.platform} runtime ${runtime}, by ${short(c)}`);
  return c.json({ ok: true, percent: percentBp / 100, undoActive: Boolean(undo) });
});
