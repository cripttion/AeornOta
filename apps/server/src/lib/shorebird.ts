import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv, Env, Principal, Role } from "../env";
import { bearer, resolveToken } from "./auth";
import { HttpError } from "./http";

/** Shorebird-style error body: { code, message }. The stock CLI parses this shape. */
export class SbError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 416 | 422 | 426 | 500 | 503,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function sbErrorResponse(c: Context, err: unknown) {
  if (err instanceof SbError) {
    const headers: Record<string, string> = {};
    if (err.status === 401) headers["www-authenticate"] = 'Bearer error="invalid_token"';
    return c.json({ code: err.code, message: err.message }, err.status, headers);
  }
  if (err instanceof HttpError) return c.json({ code: err.code, message: err.message }, err.status);
  console.error("shorebird route error", err);
  return c.json({ code: "internal", message: "Internal error" }, 500);
}

/** CLI requests: Bearer <Aeron token>. Bad credentials must be 401 (a 403 reads as "app not found" in the CLI). */
export const sbAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearer(c);
  if (!token) throw new SbError(401, "unauthorized", "Missing token. Set SHOREBIRD_TOKEN to an Aeron token that starts with sb_api_ (aeron tokens create --shorebird).");
  const p = await resolveToken(c.env, token);
  if (!p) throw new SbError(401, "unauthorized", "Invalid Aeron token");
  c.set("principal", p);
  await next();
};

const RANK: Record<Role, number> = { viewer: 1, publisher: 2, admin: 3 };

export function sbRequire(p: Principal, role: Role, appId?: string) {
  if (RANK[p.role] < RANK[role]) throw new SbError(403, "forbidden", `This Aeron token needs the ${role} role`);
  if (appId && p.apps && !p.apps.includes(appId)) throw new SbError(403, "forbidden", `This Aeron token is not scoped to app ${appId}`);
}

/** JSON bodies arrive as text/plain from the Dart CLI, so ignore Content-Type. */
export async function sbJson<T>(c: Context, max = 1_000_000): Promise<T> {
  const text = await c.req.text();
  if (text.length > max) throw new SbError(413, "payload_too_large", "Body too large");
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SbError(400, "bad_request", "Body must be JSON");
  }
}

export async function sbForm(c: Context): Promise<Record<string, string>> {
  let fd: FormData;
  try {
    fd = await c.req.formData();
  } catch {
    throw new SbError(400, "bad_request", "Expected multipart/form-data fields");
  }
  const out: Record<string, string> = {};
  fd.forEach((v, k) => {
    if (typeof v === "string") out[k] = v;
  });
  return out;
}

export function baseUrl(env: Env) {
  return env.PUBLIC_BASE_URL.replace(/\/$/, "");
}

export const ORG = { id: 1, name: "Aeron", organization_type: "team", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" };

export function orgRole(p: Principal): string {
  return p.role === "admin" ? "owner" : p.role === "publisher" ? "developer" : "viewer";
}

export interface ReleaseRow {
  id: number;
  app_id: string;
  version: string;
  flutter_revision: string;
  flutter_version: string | null;
  display_name: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlatformRow {
  release_id: number;
  platform: string;
  status: "draft" | "active";
  signing_mode: string | null;
}

export function releaseJson(r: ReleaseRow, platforms: PlatformRow[]) {
  const p: Record<string, { status: string; signing_mode?: string }> = {};
  const statuses: Record<string, string> = {};
  for (const x of platforms.filter((x) => x.release_id === r.id)) {
    p[x.platform] = x.signing_mode ? { status: x.status, signing_mode: x.signing_mode } : { status: x.status };
    statuses[x.platform] = x.status;
  }
  return {
    id: r.id,
    app_id: r.app_id,
    version: r.version,
    flutter_revision: r.flutter_revision,
    ...(r.flutter_version ? { flutter_version: r.flutter_version } : {}),
    ...(r.display_name ? { display_name: r.display_name } : {}),
    ...(r.notes ? { notes: r.notes } : {}),
    platforms: p,
    platform_statuses: statuses,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function randomUrlToken(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** One edge-cache entry per (app, channel, release version) holds every promoted patch + artifact. */
export function sbCheckCacheKey(appId: string, channel: string, version: string) {
  return `sb-check:${appId}:${channel}:${version}`;
}
