import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv, CiIdentity, Env, Principal, Role } from "../env";
import { sha256Hex, timingSafeEqual } from "./crypto";
import { forbidden, unauthorized } from "./http";
import { JwtError, verifyJwt } from "./jwt";

const RANK: Record<Role, number> = { viewer: 1, publisher: 2, admin: 3 };

export function bearer(c: Context): string | null {
  const h = c.req.header("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]!.trim() : null;
}

export async function resolveToken(env: Env, token: string): Promise<Principal | null> {
  if (env.BOOTSTRAP_ADMIN_TOKEN && env.BOOTSTRAP_ADMIN_TOKEN.length >= 24 && timingSafeEqual(token, env.BOOTSTRAP_ADMIN_TOKEN)) {
    return { id: "bootstrap", name: "bootstrap", role: "admin", apps: null, source: "bootstrap" };
  }
  if (token.length < 20 || token.length > 200) return null;
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    "SELECT id, name, role, app_scope, last_used_at, expires_at, source, ci FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL",
  )
    .bind(hash)
    .first<{ id: string; name: string; role: Role; app_scope: string | null; last_used_at: string | null; expires_at: string | null; source: string; ci: string | null }>();
  if (!row) return null;
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return null;
  // Update last_used_at at most once an hour to keep D1 writes low.
  const last = row.last_used_at ? Date.parse(row.last_used_at) : 0;
  if (Date.now() - last > 3_600_000) {
    await env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").bind(new Date().toISOString(), row.id).run();
  }
  let ci: CiIdentity | null = null;
  try {
    ci = row.ci ? (JSON.parse(row.ci) as CiIdentity) : null;
  } catch {
    ci = null;
  }
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    apps: row.app_scope ? (JSON.parse(row.app_scope) as string[]) : null,
    source: row.source,
    ci,
    expiresAt: row.expires_at,
  };
}

/** Require a valid Aeron API token on every request under this middleware. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearer(c);
  if (!token) throw unauthorized();
  const principal = await resolveToken(c.env, token);
  if (!principal) throw unauthorized("Missing, invalid, revoked or expired token");
  c.set("principal", principal);
  await next();
};

export function assertRole(c: Context<AppEnv>, role: Role, appId?: string) {
  const p = c.get("principal");
  if (RANK[p.role] < RANK[role]) throw forbidden(`Requires ${role} role`);
  if (appId && p.apps && !p.apps.includes(appId)) throw forbidden(`Token is not scoped to app ${appId}`);
}

export function accessEnforced(env: Env) {
  return Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
}

/**
 * Sensitive actions (approvals, keys, tokens, policies): admin token, and — when Cloudflare Access
 * is configured — a human signed in through Access (SSO + MFA). A stolen token alone is not enough,
 * and CI service tokens can never approve their own work.
 */
/**
 * The Access login travels as the cf-access-jwt-assertion header on paths Access protects (/dashboard), and as
 * the CF_Authorization cookie on the rest of the domain (the dashboard's /api/admin calls). Both are the same
 * signed JWT and are verified the same way. The admin API also needs a bearer token, so the cookie alone can't
 * be used by another site (no CSRF).
 */
function accessJwt(c: Context<AppEnv>): string | null {
  const header = c.req.header("cf-access-jwt-assertion");
  if (header) return header;
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(c.req.header("cookie") ?? "");
  return m ? decodeURIComponent(m[1]!) : null;
}

export async function requireHuman(c: Context<AppEnv>, appId?: string) {
  assertRole(c, "admin", appId);
  if (!accessEnforced(c.env)) return;
  const jwt = accessJwt(c);
  if (!jwt) throw forbidden("This action needs a person signed in through Cloudflare Access. Use the console in a browser.");
  const team = c.env.ACCESS_TEAM_DOMAIN!.replace(/^https?:\/\//, "").replace(/\/$/, "");
  try {
    const claims = await verifyJwt(c.env, jwt, `https://${team}/cdn-cgi/access/certs`, { issuer: `https://${team}`, audience: c.env.ACCESS_AUD! });
    if (typeof claims.email !== "string" || !claims.email) throw forbidden("Cloudflare Access service tokens cannot approve or change security settings");
    c.set("humanEmail", claims.email);
  } catch (e) {
    if (e instanceof JwtError) throw forbidden(`Cloudflare Access check failed: ${e.message}`);
    throw e;
  }
}

/**
 * Four-eyes rule. The approving token may not be the one that submitted the work, nor the admin token
 * that minted a short-lived CLI token for it. Exception: with Cloudflare Access enforced, a person who
 * passed SSO + MFA for this request may approve their own submission (solo developers), because the
 * approval itself is then bound to their identity, not to a copyable token.
 */
export async function isSelfReview(c: Context<AppEnv>, submitterTokenIds: Array<string | null | undefined>): Promise<boolean> {
  if (accessEnforced(c.env) && c.get("humanEmail")) return false;
  const me = c.get("principal").id;
  for (const id of submitterTokenIds) {
    if (!id) continue;
    if (id === me) return true;
    const row = await c.env.DB.prepare("SELECT source, created_by FROM api_tokens WHERE id = ?").bind(id).first<{ source: string; created_by: string | null }>();
    const parent = row?.source === "cli-ephemeral" ? /\(([^)]+)\)/.exec(row.created_by ?? "")?.[1] : undefined;
    if (parent && parent === me) return true;
  }
  return false;
}

export function actor(c: Context<AppEnv>): string {
  const p = c.get("principal");
  const human = c.get("humanEmail");
  return `${p.name} (${p.id})${human ? ` via ${human}` : ""}`;
}

export function short(c: Context<AppEnv>): string {
  const human = c.get("humanEmail");
  return human ?? c.get("principal").name;
}
