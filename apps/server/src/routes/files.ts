import { Hono } from "hono";
import type { AppEnv, Env } from "../env";
import { SHA256_HEX_RE, UUID_RE, notFound } from "../lib/http";
import { cached, withTimeout } from "../lib/store";

/**
 * Content-addressed, immutable files (JS bundles, images, Shorebird patches).
 * Path = sha256 hex of the bytes, so a URL can never change meaning and is cached for a year.
 *
 * Expo launch assets also support RFC 3229 delta encoding the way expo-updates (SDK 55+) asks for it:
 * request `A-IM: bsdiff` + `Expo-Current-Update-ID`, response `226 IM Used` + `IM: bsdiff` +
 * `expo-base-update-id`. The client verifies the patched bundle against the signed manifest hash.
 */
export const files = new Hono<AppEnv>();

/**
 * Edge-cache layout version. Bump it to walk away from entries written by older code: v1 filled the
 * cache from a tee'd R2 stream, and a fill that stalled held the cache lock, so every later request for
 * that file hung behind it.
 */
const CACHE_VERSION = "v2";
/** Files up to this size are read once and served + cached from memory. Bigger ones stream from R2 uncached. */
const BUFFER_LIMIT = 25 * 1024 * 1024;
/** A cache lookup that takes longer than this is abandoned in favour of R2, so a stuck fill can't block downloads. */
const CACHE_MATCH_TIMEOUT_MS = 1500;

type Ctx = { waitUntil(p: Promise<unknown>): void };

/** Collects Server-Timing entries (I/O wall time) so slow first downloads can be diagnosed from curl. */
class Timings {
  private parts: string[] = [];
  async time<T>(name: string, p: Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      return await p;
    } finally {
      this.parts.push(`${name};dur=${Date.now() - start}`);
    }
  }
  header(): string {
    return this.parts.join(", ");
  }
}

function fileHeaders(obj: R2Object, hexId: string): Headers {
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("x-content-sha256", hexId);
  headers.set("content-length", String(obj.size));
  if (!headers.has("content-type")) headers.set("content-type", "application/octet-stream");
  return headers;
}

/**
 * One immutable file, from the edge cache or R2. The body is never tee'd: a cache fill reads its own copy
 * of an in-memory buffer, so a slow or vanished client can't stall the fill (and the fill can't stall the
 * client).
 */
async function edgeCachedObject(env: Env, ctx: Ctx, origin: string, hexId: string, tm: Timings): Promise<Response | null> {
  const cache = caches.default;
  const cacheKey = new Request(`${origin}/__cache/${CACHE_VERSION}/files/${hexId}`, { method: "GET" });
  const hit = await tm.time("cache", withTimeout(cache.match(cacheKey), CACHE_MATCH_TIMEOUT_MS, undefined));
  if (hit) {
    const res = new Response(hit.body, hit);
    res.headers.set("x-aeron-cache", "hit");
    res.headers.set("server-timing", tm.header());
    return res;
  }
  const obj = await tm.time("r2", env.BUCKET.get(`files/${hexId}`));
  if (!obj) return null;
  const headers = fileHeaders(obj, hexId);
  if (obj.size > BUFFER_LIMIT) {
    headers.set("x-aeron-cache", "bypass");
    headers.set("server-timing", tm.header());
    return new Response(obj.body, { headers });
  }
  const buf = await tm.time("r2body", obj.arrayBuffer());
  ctx.waitUntil(cache.put(cacheKey, new Response(buf.slice(0), { headers })).catch(() => undefined));
  headers.set("x-aeron-cache", "miss");
  headers.set("server-timing", tm.header());
  return new Response(buf, { headers });
}

async function headObject(env: Env, hexId: string): Promise<Response | null> {
  const obj = await env.BUCKET.head(`files/${hexId}`);
  return obj ? new Response(null, { headers: fileHeaders(obj, hexId) }) : null;
}

async function findPatch(env: Env, baseUpdateId: string, targetHex: string) {
  return cached(`expo-patch:${baseUpdateId}:${targetHex}`, 3600, async () =>
    env.DB.prepare("SELECT patch_hex FROM expo_patches WHERE base_update_id = ? AND target_hex = ?")
      .bind(baseUpdateId, targetHex)
      .first<{ patch_hex: string }>(),
  );
}

files.on(["GET", "HEAD"], "/files/:hex", async (c) => {
  const hexId = c.req.param("hex").toLowerCase();
  if (!SHA256_HEX_RE.test(hexId)) throw notFound();
  const origin = new URL(c.req.url).origin;
  const tm = new Timings();

  const aim = (c.req.header("a-im") ?? "").toLowerCase();
  const base = (c.req.header("expo-current-update-id") ?? "").toLowerCase();
  if (c.req.method === "GET" && aim.split(",").map((s) => s.trim()).includes("bsdiff") && UUID_RE.test(base)) {
    const patch = await tm.time("patch", findPatch(c.env, base, hexId));
    if (patch) {
      const p = await edgeCachedObject(c.env, c.executionCtx, origin, patch.patch_hex, tm);
      if (p) {
        const headers: Record<string, string> = {
          im: "bsdiff",
          "expo-base-update-id": base,
          "content-type": "application/octet-stream",
          "cache-control": "private, max-age=0",
          vary: "A-IM, Expo-Current-Update-ID",
          "x-aeron-cache": p.headers.get("x-aeron-cache") ?? "miss",
          "server-timing": tm.header(),
        };
        const len = p.headers.get("content-length");
        if (len) headers["content-length"] = len;
        return new Response(p.body, { status: 226, headers });
      }
    }
  }

  if (c.req.method === "HEAD") {
    const head = await headObject(c.env, hexId);
    if (!head) throw notFound();
    return head;
  }
  const res = await edgeCachedObject(c.env, c.executionCtx, origin, hexId, tm);
  if (!res) throw notFound();
  return res;
});
