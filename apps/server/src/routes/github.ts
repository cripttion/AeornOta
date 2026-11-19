import { Hono } from "hono";
import type { AppEnv } from "../env";
import { actor, assertRole, requireHuman, short } from "../lib/auth";
import { randomId, randomToken, sha256Hex } from "../lib/crypto";
import { APP_ID_RE, HttpError, badRequest, notFound, readJson, requireMatch } from "../lib/http";
import { JwtError, verifyJwt } from "../lib/jwt";
import { notify } from "../lib/notify";
import { audit, getApp } from "../lib/store";
import { expoWorkflow, flutterWorkflow } from "../../../../packages/cli/src/workflows";

const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_JWKS = `${GITHUB_ISSUER}/.well-known/jwks`;

/**
 * GitHub Actions → Aeron without stored secrets. A workflow with `permissions: id-token: write`
 * gets a short-lived OIDC token from GitHub (audience = this server), and exchanges it here for a
 * 60-minute publisher token scoped to the apps whose trust rules match the repository/branch/environment.
 * The commit and run are taken from GitHub's signed claims, so provenance shown in approvals can't be faked.
 */
export const githubAuth = new Hono<AppEnv>();

githubAuth.post("/api/auth/github", async (c) => {
  let body: { token?: string };
  try {
    body = JSON.parse(await c.req.text());
  } catch {
    return c.json({ error: { code: "bad_request", message: "Body must be JSON {\"token\": \"<GitHub OIDC token>\"}" } }, 400);
  }
  const audience = c.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  let claims;
  try {
    claims = await verifyJwt(c.env, body.token ?? "", GITHUB_JWKS, { issuer: GITHUB_ISSUER, audience });
  } catch (e) {
    const msg = e instanceof JwtError ? e.message : "verification failed";
    return c.json({ error: { code: "unauthorized", message: `GitHub OIDC token rejected: ${msg}. Request it with audience ${audience}.` } }, 401);
  }
  const repository = String(claims.repository ?? "").toLowerCase();
  const ref = String(claims.ref ?? "");
  const environment = claims.environment ? String(claims.environment) : null;
  const rules = await c.env.DB.prepare(
    `SELECT app_id FROM github_trust WHERE repository = ? AND (ref IS NULL OR ref = ?) AND (environment IS NULL OR environment = ?)`,
  )
    .bind(repository, ref, environment ?? "")
    .all<{ app_id: string }>();
  const apps = [...new Set((rules.results ?? []).map((r) => r.app_id))];
  if (!apps.length) {
    return c.json(
      { error: { code: "forbidden", message: `No trust rule for ${repository} (${ref}${environment ? `, environment ${environment}` : ""}). Add one under Integrations in the console.` } },
      403,
    );
  }
  const runUrl = claims.run_id ? `https://github.com/${claims.repository}/actions/runs/${claims.run_id}` : undefined;
  const ci = { repository: String(claims.repository), sha: claims.sha ? String(claims.sha) : undefined, ref, runUrl };
  const token = randomToken("sb_api_"); // works for aeron and as SHOREBIRD_TOKEN
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const id = randomId();
  const name = `github:${claims.repository}#${claims.run_id ?? "?"}`.slice(0, 80);
  await c.env.DB.prepare(
    "INSERT INTO api_tokens (id, name, token_hash, role, app_scope, created_by, expires_at, source, ci) VALUES (?, ?, ?, 'publisher', ?, ?, ?, 'github-oidc', ?)",
  )
    .bind(id, name, await sha256Hex(token), JSON.stringify(apps), `github-oidc ${claims.sub ?? ""}`.slice(0, 200), expiresAt, JSON.stringify(ci))
    .run();
  await audit(c.env, name, "github.oidc.exchange", null, { apps, ref, environment, sha: ci.sha, runUrl });
  return c.json({ token, expiresAt, apps, ci });
});

/** Trust rules, managed by admins (a person, when Cloudflare Access is on). Mounted under /api/admin/github. */
export const adminGithub = new Hono<AppEnv>();

adminGithub.get("/trust", async (c) => {
  assertRole(c, "admin");
  const rows = await c.env.DB.prepare("SELECT * FROM github_trust ORDER BY created_at DESC").all();
  return c.json({ rules: rows.results ?? [], audience: c.env.PUBLIC_BASE_URL.replace(/\/$/, "") });
});

adminGithub.post("/trust", async (c) => {
  const body = await readJson<{ appId?: string; repository?: string; ref?: string | null; environment?: string | null }>(c);
  const appId = requireMatch(body.appId, APP_ID_RE, "appId");
  await requireHuman(c, appId);
  await getApp(c.env, appId);
  const repository = (body.repository ?? "").trim().toLowerCase().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)) throw badRequest("repository must look like owner/name");
  let ref = (body.ref ?? "").trim() || null;
  if (ref && !ref.startsWith("refs/")) ref = `refs/heads/${ref}`;
  if (ref && !/^refs\/(heads|tags)\/[A-Za-z0-9._\/-]{1,200}$/.test(ref)) throw badRequest("ref must be a branch name like main or refs/heads/main");
  const environment = (body.environment ?? "").trim() || null;
  if (environment && !/^[A-Za-z0-9 _.-]{1,100}$/.test(environment)) throw badRequest("invalid environment name");
  const id = randomId();
  await c.env.DB.prepare("INSERT INTO github_trust (id, app_id, repository, ref, environment, created_by) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, appId, repository, ref, environment, actor(c))
    .run();
  await audit(c.env, actor(c), "github.trust.add", appId, { repository, ref, environment });
  notify(c.env, c.executionCtx, `🔗 ${short(c)} allowed GitHub ${repository}${ref ? ` (${ref})` : " (any branch)"}${environment ? ` env ${environment}` : ""} to publish to ${appId}`);
  return c.json({ id, appId, repository, ref, environment }, 201);
});

adminGithub.delete("/trust/:id", async (c) => {
  assertRole(c, "admin");
  const row = await c.env.DB.prepare("SELECT app_id, repository FROM github_trust WHERE id = ?").bind(c.req.param("id")).first<{ app_id: string; repository: string }>();
  if (!row) throw notFound("Rule not found");
  await requireHuman(c, row.app_id);
  await c.env.DB.prepare("DELETE FROM github_trust WHERE id = ?").bind(c.req.param("id")).run();
  await audit(c.env, actor(c), "github.trust.remove", row.app_id, { repository: row.repository });
  notify(c.env, c.executionCtx, `🔗 ${short(c)} removed GitHub trust ${row.repository} → ${row.app_id}`);
  return c.json({ ok: true });
});

/** Ready-to-commit workflow for an app (same template as `aeron ci github`). */
adminGithub.get("/workflow", async (c) => {
  const appId = requireMatch(c.req.query("app"), APP_ID_RE, "app");
  assertRole(c, "viewer", appId);
  const app = await getApp(c.env, appId);
  const pm = c.req.query("pm") === "yarn" ? "yarn" : c.req.query("pm") === "pnpm" ? "pnpm" : "npm";
  const yaml = app.kind === "flutter" ? flutterWorkflow(appId) : expoWorkflow(appId, pm);
  return c.json({
    yaml,
    path: `.github/workflows/aeron-${appId}.yml`,
    variables: { AERON_SERVER: c.env.PUBLIC_BASE_URL.replace(/\/$/, "") },
    secret: app.kind === "flutter" ? { name: "AERON_FLUTTER_PRIVATE_KEY", from: "keys/patch-private.pem" } : { name: "AERON_EXPO_PRIVATE_KEY", from: "keys/private-key.pem" },
  });
});

export function forbidden(msg: string) {
  return new HttpError(403, msg, "forbidden");
}
