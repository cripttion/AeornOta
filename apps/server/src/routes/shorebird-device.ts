import { Hono, type Context } from "hono";
import type { AppEnv, Env } from "../env";
import { rolloutBucket, sha256Hex } from "../lib/crypto";
import { baseUrl, sbCheckCacheKey } from "../lib/shorebird";
import { bumpStat, cached } from "../lib/store";

/**
 * Device-facing Shorebird endpoints (no auth): patch check, events, patch download.
 * Plus the CLI's byte-upload URLs and release-artifact downloads, which are authorised by
 * unguessable tokens in the path.
 */
export const shorebirdDevice = new Hono<AppEnv>();

interface CheckRow {
  patch_id: number;
  number: number;
  rollout_bp: number;
  is_rolled_back: number;
  platform: string;
  arch: string;
  hash: string;
  hash_signature: string | null;
  download_token: string;
}

async function channelState(env: Env, appId: string, channel: string, version: string) {
  return cached<CheckRow[] | null>(sbCheckCacheKey(appId, channel, version), 15, async () => {
    const app = await env.DB.prepare("SELECT kind FROM apps WHERE id = ?").bind(appId).first<{ kind: string }>();
    if (!app || app.kind !== "flutter") return null;
    const rows = await env.DB.prepare(
      `SELECT p.id AS patch_id, p.number, cp.rollout_bp, cp.is_rolled_back, a.platform, a.arch, a.hash, a.hash_signature, a.download_token
         FROM sb_channels c
         JOIN sb_channel_patches cp ON cp.channel_id = c.id AND cp.status = 'live'
         JOIN sb_patches p ON p.id = cp.patch_id
         JOIN sb_releases r ON r.id = p.release_id
         JOIN sb_patch_artifacts a ON a.patch_id = p.id AND a.state = 'uploaded'
        WHERE c.app_id = ? AND c.name = ? AND r.app_id = ? AND r.version = ?`,
    )
      .bind(appId, channel, appId, version)
      .all<CheckRow>();
    return rows.results ?? [];
  });
}

const NO_STORE = { "cache-control": "no-store" };

shorebirdDevice.post("/api/v1/patches/check", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await c.req.text());
  } catch {
    return c.json({ code: "bad_request", message: "Body must be JSON" }, 400);
  }
  const appId = String(body.app_id ?? "");
  const channel = String(body.channel ?? "stable");
  const version = String(body.release_version ?? "");
  const platform = String(body.platform ?? "");
  const arch = String(body.arch ?? "");
  const clientId = typeof body.client_id === "string" ? body.client_id : null;
  const current = typeof body.current_patch_number === "number" ? body.current_patch_number : null;
  const legacy = typeof body.patch_number === "number" ? body.patch_number : null;
  const none = (rolled: number[] = []) => c.json({ patch_available: false, rolled_back_patch_numbers: rolled }, 200, NO_STORE);
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(appId) || !version || version.length > 100) return none();

  const rows = await channelState(c.env, appId, channel, version);
  if (!rows) return none();
  const mine = rows.filter((r) => r.platform === platform && r.arch === arch);
  const rolledBack = [...new Set(mine.filter((r) => r.is_rolled_back).map((r) => r.number))].sort((a, b) => a - b);
  const live = mine.filter((r) => !r.is_rolled_back).sort((a, b) => b.number - a.number);
  let pick: CheckRow | undefined;
  for (const r of live) {
    if (r.rollout_bp >= 10000 || (await rolloutBucket(clientId, `sb:${r.patch_id}`)) < r.rollout_bp) {
      pick = r;
      break;
    }
  }
  if (!pick || (legacy !== null && legacy >= pick.number)) return none(rolledBack);
  if (current !== pick.number) c.executionCtx.waitUntil(bumpStat(c.env, appId, `${version}#${pick.number}`, "patch_served"));
  return c.json(
    {
      patch_available: true,
      patch: {
        number: pick.number,
        hash: pick.hash,
        download_url: `${baseUrl(c.env)}/sb/patches/${pick.download_token}`,
        ...(pick.hash_signature ? { hash_signature: pick.hash_signature } : {}),
      },
      rolled_back_patch_numbers: rolledBack,
    },
    200,
    NO_STORE,
  );
});

const EVENT_METRIC: Record<string, string> = {
  __patch_download__: "patch_download",
  __patch_install__: "install_success",
  __patch_install_failure__: "install_failure",
  __patch_update_failure__: "update_failed",
};

shorebirdDevice.post("/api/v1/patches/events", async (c) => {
  let body: { event?: Record<string, unknown> };
  try {
    body = JSON.parse(await c.req.text());
  } catch {
    return c.json({ code: "bad_request", message: "Body must be JSON" }, 400);
  }
  const e = body.event;
  const metric = e && EVENT_METRIC[String(e.type)];
  const appId = e ? String(e.app_id ?? "") : "";
  if (!e || !metric || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(appId)) return c.json({ code: "bad_request", message: "Unknown event" }, 422);
  const exists = await cached(`app-exists:${appId}`, 300, async () => Boolean(await c.env.DB.prepare("SELECT 1 FROM apps WHERE id = ?").bind(appId).first()));
  if (!exists) return c.body(null, 204);
  // Best-effort de-duplication of retried events (per edge location).
  if (typeof e.event_id === "string") {
    const key = new Request(`https://aeron.internal/sb-event/${encodeURIComponent(e.event_id)}`);
    if (await caches.default.match(key)) return c.body(null, 204);
    c.executionCtx.waitUntil(caches.default.put(key, new Response("1", { headers: { "cache-control": "max-age=86400" } })));
  }
  const subject = `${String(e.release_version ?? "?").slice(0, 60)}#${Number(e.patch_number ?? 0)}`;
  c.executionCtx.waitUntil(bumpStat(c.env, appId, subject, metric));
  return c.body(null, 204);
});

// ------------------------------------------------------------------ downloads

async function artifactByToken(env: Env, table: "sb_patch_artifacts" | "sb_release_artifacts", token: string) {
  if (!/^[0-9a-f]{48}$/.test(token)) return null;
  return cached(`${table}:${token}`, 600, async () =>
    env.DB.prepare(`SELECT r2_key, size, state FROM ${table} WHERE download_token = ?`).bind(token).first<{ r2_key: string; size: number; state: string }>(),
  );
}

shorebirdDevice.get("/sb/patches/:token", async (c) => {
  const a = await artifactByToken(c.env, "sb_patch_artifacts", c.req.param("token"));
  if (!a || a.state !== "uploaded") return c.body("not found", 404);
  const head = await c.env.BUCKET.head(a.r2_key);
  if (!head) return c.body("not found", 404);
  const total = head.size;
  const range = /^bytes=(\d+)-(\d*)$/.exec(c.req.header("range") ?? "");
  const base = { "content-type": "application/octet-stream", "accept-ranges": "bytes", "cache-control": "private, max-age=3600" };
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
    if (start >= total || end < start) return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${total}` } });
    const obj = await c.env.BUCKET.get(a.r2_key, { range: { offset: start, length: end - start + 1 } });
    if (!obj) return c.body("not found", 404);
    return new Response(obj.body, { status: 206, headers: { ...base, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${total}` } });
  }
  const obj = await c.env.BUCKET.get(a.r2_key);
  if (!obj) return c.body("not found", 404);
  return new Response(obj.body, { status: 200, headers: { ...base, "content-length": String(total) } });
});

/** Release artifacts (AAB, libapp.so, xcarchive…) for the CLI's patch builds. Must answer exactly 200. */
shorebirdDevice.get("/sb/artifacts/:token", async (c) => {
  const a = await artifactByToken(c.env, "sb_release_artifacts", c.req.param("token"));
  if (!a || a.state !== "uploaded") return c.body("not found", 404);
  const obj = await c.env.BUCKET.get(a.r2_key);
  if (!obj) return c.body("not found", 404);
  return new Response(obj.body, { status: 200, headers: { "content-type": "application/octet-stream", "content-length": String(obj.size), "cache-control": "private, no-store" } });
});

// ------------------------------------------------------------------ uploads (GCS-style resumable, 8 MiB chunks)

const CHUNK = 8 * 1024 * 1024;

interface Session {
  token: string;
  kind: "release" | "patch";
  artifact_id: number;
  r2_key: string;
  total: number;
  committed: number;
  upload_id: string | null;
  parts: string;
  completed_at: string | null;
}

const err = (c: Context, status: 400 | 404 | 409, message: string) => c.json({ code: "upload_error", message }, status);
const resume = (committed: number) =>
  new Response(null, { status: 308, headers: committed > 0 ? { range: `bytes=0-${committed - 1}` } : {} });

async function finish(c: Context<AppEnv>, s: Session, firstBytes: Uint8Array | null, wholeBody: ArrayBuffer | null) {
  const table = s.kind === "release" ? "sb_release_artifacts" : "sb_patch_artifacts";
  if (s.kind === "patch" && firstBytes && !(firstBytes[0] === 0x28 && firstBytes[1] === 0xb5 && firstBytes[2] === 0x2f && firstBytes[3] === 0xfd)) {
    await c.env.BUCKET.delete(s.r2_key);
    return err(c, 400, "Patch upload is not a zstd stream");
  }
  if (s.kind === "release" && wholeBody) {
    const art = await c.env.DB.prepare("SELECT hash FROM sb_release_artifacts WHERE id = ?").bind(s.artifact_id).first<{ hash: string }>();
    if (art && (await sha256Hex(wholeBody)) !== art.hash) {
      await c.env.BUCKET.delete(s.r2_key);
      return err(c, 400, "Uploaded bytes do not match the registered sha256");
    }
  }
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE sb_upload_sessions SET committed = total, completed_at = ? WHERE token = ?").bind(new Date().toISOString(), s.token),
    c.env.DB.prepare(`UPDATE ${table} SET state = 'uploaded' WHERE id = ? AND r2_key = ?`).bind(s.artifact_id, s.r2_key),
  ]);
  return c.json({ ok: true }, 200);
}

async function session(c: Context<AppEnv>) {
  const token = c.req.param("token") ?? "";
  if (!/^[0-9a-f]{48}$/.test(token)) return null;
  return c.env.DB.prepare("SELECT * FROM sb_upload_sessions WHERE token = ?").bind(token).first<Session>();
}

shorebirdDevice.put("/api/v1/uploads/:token", async (c) => {
  const s = await session(c);
  if (!s) return err(c, 404, "Unknown upload");
  if (s.completed_at) return c.json({ ok: true }, 200);
  const cr = c.req.header("content-range") ?? "";
  const status = /^bytes \*\/(\d+)$/.exec(cr);
  if (status) return resume(s.committed);
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr);
  if (!m) return err(c, 400, "content-range is required");
  const start = Number(m[1]);
  const end = Number(m[2]);
  const total = Number(m[3]);
  if (total !== s.total) return err(c, 400, `total ${total} does not match registered size ${s.total}`);
  if (start !== s.committed) return resume(s.committed); // let the client resync to our offset
  if (start % CHUNK !== 0) return err(c, 400, "chunks must start on 8 MiB boundaries");
  const body = await c.req.arrayBuffer();
  if (body.byteLength !== end - start + 1) return err(c, 400, "chunk length does not match content-range");
  const first = start === 0 ? new Uint8Array(body.slice(0, 4)) : null;

  if (start === 0 && end + 1 === total) {
    await c.env.BUCKET.put(s.r2_key, body, { httpMetadata: { contentType: "application/octet-stream" } });
    return finish(c, s, first, body);
  }
  const mp = s.upload_id ? c.env.BUCKET.resumeMultipartUpload(s.r2_key, s.upload_id) : await c.env.BUCKET.createMultipartUpload(s.r2_key);
  const part = await mp.uploadPart(start / CHUNK + 1, body);
  const parts = JSON.parse(s.parts) as R2UploadedPart[];
  parts.push(part);
  const committed = end + 1;
  if (committed === total) {
    await mp.complete(parts.sort((a, b) => a.partNumber - b.partNumber));
    if (first === null && s.kind === "patch") {
      const head = await c.env.BUCKET.get(s.r2_key, { range: { offset: 0, length: 4 } });
      const bytes = head ? new Uint8Array(await head.arrayBuffer()) : null;
      return finish(c, s, bytes, null);
    }
    return finish(c, s, first, null);
  }
  await c.env.DB.prepare("UPDATE sb_upload_sessions SET upload_id = ?, parts = ?, committed = ? WHERE token = ?")
    .bind(mp.uploadId, JSON.stringify(parts), committed, s.token)
    .run();
  return resume(committed);
});

/** Legacy single-request multipart upload (upload_method "multipart"); kept for older CLIs. */
shorebirdDevice.post("/api/v1/uploads/:token", async (c) => {
  const s = await session(c);
  if (!s) return err(c, 404, "Unknown upload");
  if (s.completed_at) return c.json({ ok: true }, 200);
  const fd = await c.req.formData();
  const file = fd.get("file");
  if (!file || typeof file === "string") return err(c, 400, "missing file part");
  const body = await file.arrayBuffer();
  if (body.byteLength !== s.total) return err(c, 400, "size does not match registration");
  await c.env.BUCKET.put(s.r2_key, body, { httpMetadata: { contentType: "application/octet-stream" } });
  return finish(c, s, new Uint8Array(body.slice(0, 4)), body);
});
