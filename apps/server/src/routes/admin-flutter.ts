import { Hono, type Context } from "hono";
import type { AppEnv } from "../env";
import { actor, assertRole, isSelfReview, requireHuman, short } from "../lib/auth";
import { APP_ID_RE, HttpError, badRequest, conflict, notFound, readJson, requireMatch } from "../lib/http";
import { notify } from "../lib/notify";
import { appPolicy, audit, getApp, invalidate } from "../lib/store";
import { sbCheckCacheKey } from "../lib/shorebird";

/** Flutter (Shorebird) admin API for the console and `aeron flutter`. Mounted under /api/admin/flutter. */
export const adminFlutter = new Hono<AppEnv>();

async function flutterApp(c: Context<AppEnv>, role: "viewer" | "publisher" | "admin") {
  const id = requireMatch(c.req.param("appId"), APP_ID_RE, "app id");
  assertRole(c, role, id);
  const app = await getApp(c.env, id);
  if (app.kind !== "flutter") throw badRequest(`App ${id} is an ${app.kind} app, not flutter`);
  return app;
}

adminFlutter.get("/apps/:appId", async (c) => {
  const app = await flutterApp(c, "viewer");
  const [settings, releases, platforms, rArts, patches, pArts, chans, channels] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT require_signing, public_key_pem, updated_at FROM flutter_settings WHERE app_id = ?").bind(app.id),
    c.env.DB.prepare("SELECT id, version, flutter_revision, flutter_version, notes, created_at, updated_at FROM sb_releases WHERE app_id = ? ORDER BY created_at DESC").bind(app.id),
    c.env.DB.prepare("SELECT rp.release_id, rp.platform, rp.status, rp.signing_mode, rp.updated_at FROM sb_release_platforms rp JOIN sb_releases r ON r.id = rp.release_id WHERE r.app_id = ?").bind(app.id),
    c.env.DB.prepare("SELECT a.release_id, a.platform, a.arch, a.size, a.state FROM sb_release_artifacts a JOIN sb_releases r ON r.id = a.release_id WHERE r.app_id = ?").bind(app.id),
    c.env.DB.prepare(
      "SELECT p.id, p.release_id, p.number, p.notes, p.created_by, p.created_by_token, p.created_at, p.git_sha, p.repository, p.ci_run_url FROM sb_patches p JOIN sb_releases r ON r.id = p.release_id WHERE r.app_id = ? ORDER BY p.number DESC",
    ).bind(app.id),
    c.env.DB.prepare(
      "SELECT a.patch_id, a.platform, a.arch, a.size, a.state, a.hash_signature IS NOT NULL AS signed FROM sb_patch_artifacts a JOIN sb_patches p ON p.id = a.patch_id JOIN sb_releases r ON r.id = p.release_id WHERE r.app_id = ?",
    ).bind(app.id),
    c.env.DB.prepare(
      `SELECT cp.patch_id, ch.name AS channel, cp.rollout_bp, cp.is_rolled_back, cp.promoted_at, cp.updated_at, cp.status, cp.requested_bp, cp.reviewed_by, cp.reviewed_at, cp.promoted_by
         FROM sb_channel_patches cp JOIN sb_channels ch ON ch.id = cp.channel_id WHERE ch.app_id = ?`,
    ).bind(app.id),
    c.env.DB.prepare("SELECT id, name FROM sb_channels WHERE app_id = ? ORDER BY id").bind(app.id),
  ]);
  const s = (settings!.results?.[0] ?? null) as { require_signing: number; public_key_pem: string | null; updated_at: string } | null;
  const by = <T extends Record<string, unknown>>(rows: unknown[] | undefined, key: string, id: unknown) => ((rows ?? []) as T[]).filter((r) => r[key] === id);
  return c.json({
    policy: await appPolicy(c.env, app.id),
    settings: { requireSigning: s ? Boolean(s.require_signing) : true, hasPublicKey: Boolean(s?.public_key_pem), publicKeyPem: s?.public_key_pem ?? null },
    channels: channels!.results ?? [],
    releases: ((releases!.results ?? []) as Array<Record<string, unknown>>).map((r) => ({
      ...r,
      platforms: by(platforms!.results, "release_id", r.id),
      artifacts: by(rArts!.results, "release_id", r.id),
      patches: by<Record<string, unknown>>(patches!.results, "release_id", r.id).map((p) => ({
        ...p,
        artifacts: by(pArts!.results, "patch_id", p.id),
        channels: by(chans!.results, "patch_id", p.id),
      })),
    })),
  });
});

adminFlutter.post("/apps/:appId/settings", async (c) => {
  const app = await flutterApp(c, "admin");
  await requireHuman(c, app.id);
  const body = await readJson<{ requireSigning?: boolean; publicKeyPem?: string | null }>(c);
  const current = await c.env.DB.prepare("SELECT require_signing, public_key_pem FROM flutter_settings WHERE app_id = ?").bind(app.id).first<{ require_signing: number; public_key_pem: string | null }>();
  const hasActiveRelease = Boolean(
    await c.env.DB.prepare("SELECT 1 FROM sb_release_platforms rp JOIN sb_releases r ON r.id = rp.release_id WHERE r.app_id = ? AND rp.status = 'active' LIMIT 1").bind(app.id).first(),
  );
  const norm = (k: string | null | undefined) => (k ?? "").replace(/\s+/g, "");
  const keyChange = body.publicKeyPem !== undefined && norm(body.publicKeyPem) !== norm(current?.public_key_pem);
  const signingOff = body.requireSigning === false && (current ? Boolean(current.require_signing) : true);
  // Once real releases exist, weakening signing needs a break-glass switch only Cloudflare account owners can flip.
  if (hasActiveRelease && c.env.ALLOW_SIGNING_CHANGES !== "1") {
    if (signingOff) throw conflict("Signing can't be turned off for an app with live releases. (Break-glass: set ALLOW_SIGNING_CHANGES=1 in wrangler.jsonc, deploy, change, then remove it.)");
    if (keyChange && current?.public_key_pem) {
      throw conflict("The patch public key is locked because releases use it. Releases built with a new key need the new key registered under a new app.");
    }
  }
  if (body.publicKeyPem) {
    if (!body.publicKeyPem.includes("BEGIN PUBLIC KEY")) throw badRequest("publicKeyPem must be an SPKI PEM (-----BEGIN PUBLIC KEY-----)");
    try {
      const b64 = body.publicKeyPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
      const der = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      await crypto.subtle.importKey("spki", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    } catch {
      throw badRequest("publicKeyPem is not a valid RSA public key");
    }
  }
  await c.env.DB.prepare(
    `INSERT INTO flutter_settings (app_id, require_signing, public_key_pem, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (app_id) DO UPDATE SET
       require_signing = COALESCE(?, flutter_settings.require_signing),
       public_key_pem = CASE WHEN ? THEN excluded.public_key_pem ELSE flutter_settings.public_key_pem END,
       updated_at = excluded.updated_at`,
  )
    .bind(
      app.id,
      body.requireSigning === false ? 0 : 1,
      body.publicKeyPem ?? null,
      new Date().toISOString(),
      body.requireSigning === undefined ? null : body.requireSigning ? 1 : 0,
      body.publicKeyPem !== undefined ? 1 : 0,
    )
    .run();
  await audit(c.env, actor(c), "flutter.settings", app.id, { requireSigning: body.requireSigning, publicKey: keyChange ? (body.publicKeyPem ? "set" : "cleared") : "unchanged" });
  if (keyChange || signingOff || body.requireSigning === true) {
    notify(c.env, c.executionCtx, `🔐 ${short(c)} changed Flutter signing for ${app.id}: ${signingOff ? "signing OFF ⚠️" : keyChange ? "public key registered" : "signing required"}`);
  }
  return c.json({ ok: true });
});

/** Attach release notes / commit / CI run to a patch (shown in approvals). */
adminFlutter.post("/apps/:appId/patches/:patchId/meta", async (c) => {
  const app = await flutterApp(c, "publisher");
  const patchId = Number(c.req.param("patchId"));
  const p = await c.env.DB.prepare("SELECT p.id, p.created_by_token FROM sb_patches p JOIN sb_releases r ON r.id = p.release_id WHERE p.id = ? AND r.app_id = ?")
    .bind(patchId, app.id)
    .first<{ id: number; created_by_token: string | null }>();
  if (!p) throw notFound("Patch not found");
  const principal = c.get("principal");
  if (principal.role !== "admin" && p.created_by_token !== principal.id) throw new HttpError(403, "Only the token that created the patch (or an admin) can annotate it", "forbidden");
  const body = await readJson<{ message?: string; gitSha?: string; repository?: string; ciRunUrl?: string }>(c);
  // Verified CI identity wins over anything the request claims.
  const ci = principal.ci;
  await c.env.DB.prepare(
    "UPDATE sb_patches SET notes = COALESCE(?, notes), git_sha = COALESCE(?, git_sha), repository = COALESCE(?, repository), ci_run_url = COALESCE(?, ci_run_url) WHERE id = ?",
  )
    .bind(
      body.message?.slice(0, 500) ?? null,
      (ci?.sha ?? body.gitSha)?.slice(0, 64) ?? null,
      (ci?.repository ?? body.repository)?.slice(0, 140) ?? null,
      (ci?.runUrl ?? body.ciRunUrl)?.slice(0, 300) ?? null,
      p.id,
    )
    .run();
  return c.json({ ok: true });
});

adminFlutter.post("/apps/:appId/patches/:patchId/action", async (c) => {
  const app = await flutterApp(c, "publisher");
  const patchId = Number(c.req.param("patchId"));
  const body = await readJson<{ channel?: string; action?: string; percent?: number; note?: string }>(c);
  const patch = await c.env.DB.prepare(
    "SELECT p.id, p.number, p.release_id, p.created_by_token, r.version FROM sb_patches p JOIN sb_releases r ON r.id = p.release_id WHERE p.id = ? AND r.app_id = ?",
  )
    .bind(patchId, app.id)
    .first<{ id: number; number: number; release_id: number; created_by_token: string | null; version: string }>();
  if (!patch) throw notFound("Patch not found");
  const channelName = (body.channel ?? "stable").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(channelName)) throw badRequest("invalid channel");
  const ch = await c.env.DB.prepare("SELECT id, name FROM sb_channels WHERE app_id = ? AND name = ?").bind(app.id, channelName).first<{ id: number; name: string }>();
  const row = ch
    ? await c.env.DB.prepare("SELECT status, requested_bp, requested_by_token FROM sb_channel_patches WHERE channel_id = ? AND patch_id = ?").bind(ch.id, patch.id).first<{ status: string; requested_bp: number | null; requested_by_token: string | null }>()
    : null;
  const principal = c.get("principal");
  const who = actor(c);
  const label = `${app.id} ${patch.version} patch #${patch.number} on ${channelName}`;
  const now = new Date().toISOString();
  const selfReview = () => isSelfReview(c, [patch.created_by_token, row?.requested_by_token]);

  switch (body.action) {
    case "approve":
    case "promote": {
      const pending = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM sb_patch_artifacts WHERE patch_id = ? AND state != 'uploaded'").bind(patch.id).first<{ n: number }>();
      if (pending && pending.n > 0) throw badRequest("Patch artifacts are not fully uploaded");
      const policy = await appPolicy(c.env, app.id);
      const pct = body.percent ?? (row?.requested_bp ?? 10000) / 100;
      if (!(pct > 0 && pct <= 100)) throw badRequest("percent must be between 0.01 and 100");
      if (row?.status === "live") throw conflict("Already live on this channel; change the percentage instead");
      let status: "live" | "pending" = "live";
      if (policy.requireApproval) {
        await requireHuman(c, app.id);
        if (await selfReview()) {
          if (body.action === "approve") throw new HttpError(403, "The token that created or submitted this patch cannot approve it. Use a different admin token.", "self_approval");
          status = "pending";
        }
      }
      await c.env.DB.prepare("INSERT OR IGNORE INTO sb_channels (app_id, name) VALUES (?, ?)").bind(app.id, channelName).run();
      const target = await c.env.DB.prepare("SELECT id FROM sb_channels WHERE app_id = ? AND name = ?").bind(app.id, channelName).first<{ id: number }>();
      await c.env.DB.prepare(
        `INSERT INTO sb_channel_patches (channel_id, patch_id, rollout_bp, promoted_by, status, requested_bp, requested_by_token, reviewed_by, reviewed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (channel_id, patch_id) DO UPDATE SET rollout_bp = excluded.rollout_bp, is_rolled_back = 0, status = excluded.status,
           requested_bp = excluded.requested_bp, reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
        .bind(target!.id, patch.id, status === "live" ? Math.round(pct * 100) : 0, row ? null : who, status, Math.round(pct * 100), row?.requested_by_token ?? principal.id, status === "live" ? who : null, status === "live" ? now : null)
        .run();
      notify(c.env, c.executionCtx, status === "live" ? `✅ ${short(c)} approved ${label} at ${pct}%` : `🕓 ${label} is waiting for approval (submitted by ${principal.name})`);
      break;
    }
    case "reject": {
      if (!ch || row?.status !== "pending") throw conflict("Nothing pending for this patch on that channel");
      await requireHuman(c, app.id);
      await c.env.DB.prepare("UPDATE sb_channel_patches SET status = 'rejected', reviewed_by = ?, reviewed_at = ? WHERE channel_id = ? AND patch_id = ?").bind(who, now, ch.id, patch.id).run();
      notify(c.env, c.executionCtx, `⛔ ${short(c)} rejected ${label}`);
      break;
    }
    case "set_percent":
    case "halt": {
      if (!ch || row?.status !== "live") throw notFound(`Patch is not live on channel ${channelName}`);
      const pct = body.action === "halt" ? 0 : Number(body.percent);
      if (!(pct >= 0 && pct <= 100)) throw badRequest("percent must be 0-100");
      await c.env.DB.prepare("UPDATE sb_channel_patches SET rollout_bp = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE channel_id = ? AND patch_id = ?")
        .bind(Math.round(pct * 100), ch.id, patch.id)
        .run();
      notify(c.env, c.executionCtx, `${body.action === "halt" ? "⏸ HALT" : `↗️ rollout ${pct}%`}: ${label}, by ${short(c)}`);
      break;
    }
    case "rollback":
    case "rollforward": {
      if (!ch || row?.status !== "live") throw notFound(`Patch is not live on channel ${channelName}`);
      await c.env.DB.prepare("UPDATE sb_channel_patches SET is_rolled_back = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE channel_id = ? AND patch_id = ?")
        .bind(body.action === "rollback" ? 1 : 0, ch.id, patch.id)
        .run();
      notify(c.env, c.executionCtx, `${body.action === "rollback" ? "⏪ ROLLBACK" : "↩️ rollforward"}: ${label}, by ${short(c)}`);
      break;
    }
    default:
      throw badRequest("action must be approve, reject, promote, set_percent, halt, rollback or rollforward");
  }
  await invalidate(sbCheckCacheKey(app.id, channelName, patch.version));
  await audit(c.env, who, `flutter.patch.${body.action}`, app.id, { version: patch.version, number: patch.number, channel: channelName, percent: body.percent, note: body.note });
  return c.json({ ok: true });
});
