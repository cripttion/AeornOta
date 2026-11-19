import { Hono } from "hono";
import type { AppEnv, Role } from "../env";
import { actor, assertRole, requireAuth, requireHuman, short } from "../lib/auth";
import { randomId, randomToken, sha256, sha256Hex, hex } from "../lib/crypto";
import { APP_ID_RE, SHA256_HEX_RE, badRequest, conflict, forbidden, notFound, readJson, requireMatch } from "../lib/http";
import { notify } from "../lib/notify";
import { appPolicy, audit, createAppRow, getApp } from "../lib/store";

/** Admin API used by the `aeron` CLI and the dashboard. All routes need an Aeron API token. */
export const admin = new Hono<AppEnv>();
admin.use("*", requireAuth);
admin.use("*", async (c, next) => {
  await next();
  c.header("cache-control", "no-store");
});

admin.get("/me", (c) => c.json({ principal: c.get("principal") }));

admin.get("/config", (c) =>
  c.json({
    publicBaseUrl: c.env.PUBLIC_BASE_URL,
    filesBaseUrl: (c.env.FILES_BASE_URL || `${c.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/files`).replace(/\/$/, ""),
  }),
);

// ------------------------------------------------------------------ tokens

const DEFAULT_DAYS: Record<Role, number> = { admin: 365, publisher: 90, viewer: 90 };

admin.post("/tokens", async (c) => {
  assertRole(c, "admin");
  const body = await readJson<{
    name?: string;
    role?: Role;
    apps?: string[] | null;
    format?: "aeron" | "shorebird";
    expiresInDays?: number | null;
    expiresInMinutes?: number;
    noExpiry?: boolean;
  }>(c);
  const name = (body.name ?? "").trim();
  if (!name || name.length > 80) throw badRequest("name is required (max 80 chars)");
  const role = body.role ?? "publisher";
  if (!["admin", "publisher", "viewer"].includes(role)) throw badRequest("role must be admin, publisher or viewer");
  let apps: string[] | null = null;
  if (body.apps && body.apps.length) {
    apps = body.apps.map((a) => requireMatch(a, APP_ID_RE, "app id"));
  }
  if (role === "admin" && apps) throw badRequest("admin tokens cannot be app-scoped");

  // Short-lived publisher tokens (≤ 24 h, one app) can be minted by the CLI for a single run.
  // They add no power an admin token doesn't already have, so they skip the human check.
  const ephemeral = body.expiresInMinutes !== undefined;
  let expiresAt: string | null;
  if (ephemeral) {
    const m = Number(body.expiresInMinutes);
    if (!Number.isFinite(m) || m < 5 || m > 1440) throw badRequest("expiresInMinutes must be 5-1440");
    if (role !== "publisher" || !apps || apps.length !== 1) throw badRequest("Short-lived tokens must be publisher tokens for exactly one app");
    expiresAt = new Date(Date.now() + m * 60_000).toISOString();
  } else {
    await requireHuman(c);
    if (body.noExpiry) {
      if (role !== "admin") throw badRequest("Only admin tokens may skip expiry; use expiresInDays for CI and viewer tokens");
      expiresAt = null;
    } else {
      const days = body.expiresInDays ?? DEFAULT_DAYS[role];
      if (!Number.isFinite(days) || days < 1 || days > 730) throw badRequest("expiresInDays must be 1-730");
      expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
    }
  }
  // The stock Shorebird CLI only accepts SHOREBIRD_TOKEN values that start with sb_api_.
  const token = randomToken(body.format === "shorebird" ? "sb_api_" : "aer_");
  const id = randomId();
  await c.env.DB.prepare(
    "INSERT INTO api_tokens (id, name, token_hash, role, app_scope, created_by, expires_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, name, await sha256Hex(token), role, apps ? JSON.stringify(apps) : null, actor(c), expiresAt, ephemeral ? "cli-ephemeral" : "manual")
    .run();
  await audit(c.env, actor(c), ephemeral ? "token.create_ephemeral" : "token.create", null, { id, name, role, apps, expiresAt });
  if (!ephemeral) notify(c.env, c.executionCtx, `🔑 ${short(c)} created ${role} token "${name}"${apps ? ` for ${apps.join(", ")}` : ""}${expiresAt ? `, expires ${expiresAt.slice(0, 10)}` : ", no expiry"}`);
  return c.json({ id, name, role, apps, token, expiresAt, note: "Store this token now. It is not shown again." }, 201);
});

admin.get("/tokens", async (c) => {
  assertRole(c, "admin");
  const rows = await c.env.DB.prepare(
    `SELECT id, name, role, app_scope, created_at, created_by, last_used_at, revoked_at, expires_at, source
       FROM api_tokens WHERE source != 'cli-ephemeral' OR (revoked_at IS NULL AND expires_at > ?)
      ORDER BY created_at DESC LIMIT 500`,
  )
    .bind(new Date().toISOString())
    .all();
  return c.json({ tokens: rows.results });
});

admin.delete("/tokens/:id", async (c) => {
  assertRole(c, "admin");
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT name, source FROM api_tokens WHERE id = ?").bind(id).first<{ name: string; source: string }>();
  // Revoking is always safe; only require a human for long-lived tokens (not the CLI's own short-lived ones).
  if (row && row.source !== "cli-ephemeral") await requireHuman(c);
  const res = await c.env.DB.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(new Date().toISOString(), id).run();
  if (!res.meta.changes) throw notFound("Token not found or already revoked");
  await audit(c.env, actor(c), "token.revoke", null, { id, name: row?.name });
  if (row?.source !== "cli-ephemeral") notify(c.env, c.executionCtx, `🔒 ${short(c)} revoked token "${row?.name ?? id}"`);
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ apps

admin.get("/apps", async (c) => {
  assertRole(c, "viewer");
  const p = c.get("principal");
  const rows = await c.env.DB.prepare(
    "SELECT a.id, a.name, a.kind, a.created_at, COALESCE(s.require_approval, 1) AS require_approval FROM apps a LEFT JOIN app_settings s ON s.app_id = a.id ORDER BY a.id",
  ).all<{ id: string }>();
  const list = (rows.results ?? []).filter((a) => !p.apps || p.apps.includes(a.id));
  return c.json({ apps: list });
});

admin.post("/apps", async (c) => {
  await requireHuman(c);
  const body = await readJson<{ id?: string; name?: string; kind?: string }>(c);
  const id = requireMatch(body.id, APP_ID_RE, "app id (lowercase letters, digits, dashes; 2-40 chars)");
  const kind = body.kind;
  if (kind !== "expo" && kind !== "flutter") throw badRequest("kind must be expo or flutter");
  const name = (body.name ?? id).trim().slice(0, 80);
  const exists = await c.env.DB.prepare("SELECT 1 FROM apps WHERE id = ?").bind(id).first();
  if (exists) throw conflict(`App ${id} already exists`);
  await createAppRow(c.env, id, name, kind);
  await audit(c.env, actor(c), "app.create", id, { name, kind });
  notify(c.env, c.executionCtx, `📱 ${short(c)} added ${kind} app "${id}"`);
  return c.json({ app: await getApp(c.env, id) }, 201);
});

admin.get("/apps/:id", async (c) => {
  const id = requireMatch(c.req.param("id"), APP_ID_RE, "app id");
  assertRole(c, "viewer", id);
  return c.json({ app: await getApp(c.env, id), policy: await appPolicy(c.env, id) });
});

admin.get("/apps/:id/settings", async (c) => {
  const id = requireMatch(c.req.param("id"), APP_ID_RE, "app id");
  assertRole(c, "viewer", id);
  await getApp(c.env, id);
  return c.json({ policy: await appPolicy(c.env, id) });
});

admin.post("/apps/:id/settings", async (c) => {
  const id = requireMatch(c.req.param("id"), APP_ID_RE, "app id");
  await requireHuman(c, id);
  await getApp(c.env, id);
  const body = await readJson<{ requireApproval?: boolean }>(c);
  if (typeof body.requireApproval !== "boolean") throw badRequest("requireApproval (boolean) is required");
  await c.env.DB.prepare(
    `INSERT INTO app_settings (app_id, require_approval, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT (app_id) DO UPDATE SET require_approval = excluded.require_approval, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  )
    .bind(id, body.requireApproval ? 1 : 0, new Date().toISOString(), actor(c))
    .run();
  await audit(c.env, actor(c), "app.settings", id, { requireApproval: body.requireApproval });
  notify(
    c.env,
    c.executionCtx,
    body.requireApproval ? `✅ ${short(c)} turned ON approvals for ${id}` : `⚠️ ${short(c)} turned OFF approvals for ${id}: new code now goes live without review`,
  );
  return c.json({ policy: await appPolicy(c.env, id) });
});

admin.get("/apps/:id/stats", async (c) => {
  const id = requireMatch(c.req.param("id"), APP_ID_RE, "app id");
  assertRole(c, "viewer", id);
  const days = Math.min(90, Math.max(1, Number(c.req.query("days") ?? "14") || 14));
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const rows = await c.env.DB.prepare(
    "SELECT day, subject, metric, count FROM stats_daily WHERE app_id = ? AND day >= ? ORDER BY day DESC, subject, metric",
  )
    .bind(id, since)
    .all();
  return c.json({ stats: rows.results });
});

admin.get("/audit", async (c) => {
  const p = c.get("principal");
  const appId = c.req.query("app");
  if (appId) assertRole(c, "viewer", appId);
  else if (p.role !== "admin") throw forbidden("Only admins can read the full audit log; pass ?app=");
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? "100") || 100));
  const stmt = appId
    ? c.env.DB.prepare("SELECT * FROM audit_log WHERE app_id = ? ORDER BY id DESC LIMIT ?").bind(appId, limit)
    : c.env.DB.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").bind(limit);
  return c.json({ entries: (await stmt.all()).results });
});

admin.post("/notifications/test", async (c) => {
  assertRole(c, "admin");
  if (!c.env.NOTIFY_WEBHOOK_URL) throw badRequest("No webhook configured. Run: npx wrangler secret put NOTIFY_WEBHOOK_URL");
  notify(c.env, c.executionCtx, `🔔 Test alert from ${short(c)}. Security alerts are working.`);
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ content-addressed files

admin.post("/files/missing", async (c) => {
  assertRole(c, "publisher");
  const body = await readJson<{ hashes?: string[] }>(c);
  const hashes = [...new Set(body.hashes ?? [])];
  if (hashes.length > 5000) throw badRequest("Too many hashes (max 5000)");
  for (const h of hashes) requireMatch(h, SHA256_HEX_RE, "sha256 hex");
  const missing: string[] = [];
  for (let i = 0; i < hashes.length; i += 50) {
    const batch = hashes.slice(i, i + 50);
    const heads = await Promise.all(batch.map((h) => c.env.BUCKET.head(`files/${h}`)));
    heads.forEach((h, j) => {
      if (!h) missing.push(batch[j]!);
    });
  }
  return c.json({ missing });
});

const MAX_FILE_BYTES = 95 * 1024 * 1024; // stay under the Workers request body limit

admin.put("/files/:hex", async (c) => {
  assertRole(c, "publisher");
  const want = requireMatch(c.req.param("hex").toLowerCase(), SHA256_HEX_RE, "sha256 hex");
  const len = Number(c.req.header("content-length") ?? "0");
  if (len > MAX_FILE_BYTES) throw badRequest(`File too large for direct upload (max ${MAX_FILE_BYTES} bytes)`);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength > MAX_FILE_BYTES) throw badRequest("File too large");
  const got = hex(await sha256(bytes));
  if (got !== want) throw badRequest(`Content hash mismatch: path says ${want}, body is ${got}`);
  const contentType = (c.req.header("content-type") ?? "application/octet-stream").slice(0, 100);
  await c.env.BUCKET.put(`files/${want}`, bytes, {
    httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" },
    sha256: want,
  });
  return c.json({ sha256: want, bytes: bytes.byteLength }, 201);
});
