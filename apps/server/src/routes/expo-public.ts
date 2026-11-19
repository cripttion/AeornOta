import { Hono, type Context } from "hono";
import type { AppEnv, Env } from "../env";
import { rolloutBucket } from "../lib/crypto";
import { APP_ID_RE, CHANNEL_RE, RUNTIME_RE, badRequest, readJson, requireMatch } from "../lib/http";
import { multipartMixed, type Part } from "../lib/multipart";
import { parseDictionary, serializeDictionary } from "../lib/sfv";
import { bumpStat, cached } from "../lib/store";

/**
 * Expo Updates protocol v1 endpoint (https://docs.expo.dev/technical-specs/expo-updates-1/).
 * Everything served here was signed by the publisher's private key; the server only selects bytes.
 */
export const expoPublic = new Hono<AppEnv>();

interface UpdateMeta {
  id: string;
  created_at: string;
  key_id: string;
}

interface RolloutState {
  current: UpdateMeta | null;
  stable: UpdateMeta | null;
  percent_bp: number;
  salt: string;
  undo_active: number;
}

export function rolloutCacheKey(appId: string, channel: string, platform: string, runtime: string) {
  return `expo-rollout:${appId}:${channel}:${platform}:${runtime}`;
}

async function loadRollout(env: Env, appId: string, channel: string, platform: string, runtime: string) {
  return cached<RolloutState | null>(rolloutCacheKey(appId, channel, platform, runtime), 15, async () => {
    const row = await env.DB.prepare(
      `SELECT r.percent_bp, r.salt, r.undo_active,
              c.id AS c_id, c.created_at AS c_created, c.key_id AS c_key,
              s.id AS s_id, s.created_at AS s_created, s.key_id AS s_key
         FROM expo_rollouts r
         LEFT JOIN expo_updates c ON c.id = r.current_update_id
         LEFT JOIN expo_updates s ON s.id = r.stable_update_id
        WHERE r.app_id = ? AND r.channel = ? AND r.platform = ? AND r.runtime_version = ?`,
    )
      .bind(appId, channel, platform, runtime)
      .first<Record<string, string | number | null>>();
    if (!row) return null;
    return {
      current: row.c_id ? { id: String(row.c_id), created_at: String(row.c_created), key_id: String(row.c_key) } : null,
      stable: row.s_id ? { id: String(row.s_id), created_at: String(row.s_created), key_id: String(row.s_key) } : null,
      percent_bp: Number(row.percent_bp),
      salt: String(row.salt),
      undo_active: Number(row.undo_active),
    };
  });
}

async function loadSignedUpdate(env: Env, id: string) {
  // Update rows are immutable, so they can be cached for a long time.
  return cached(`expo-update:${id}`, 3600, async () =>
    env.DB.prepare("SELECT manifest, signature, key_id, undo_directive, undo_signature FROM expo_updates WHERE id = ?")
      .bind(id)
      .first<{ manifest: string; signature: string; key_id: string; undo_directive: string; undo_signature: string }>(),
  );
}

async function loadNoUpdateDirective(env: Env, appId: string, preferredKeyId?: string) {
  return cached(`expo-noupdate:${appId}:${preferredKeyId ?? ""}`, 300, async () => {
    const rows = await env.DB.prepare(
      `SELECT key_id, no_update_directive, no_update_signature FROM expo_keys
        WHERE app_id = ? AND retired_at IS NULL ORDER BY created_at DESC`,
    )
      .bind(appId)
      .all<{ key_id: string; no_update_directive: string; no_update_signature: string }>();
    const list = rows.results ?? [];
    return list.find((r) => r.key_id === preferredKeyId) ?? list[0] ?? null;
  });
}

function protocolHeaders(contentType: string): HeadersInit {
  return {
    "content-type": contentType,
    "expo-protocol-version": "1",
    "expo-sfv-version": "0",
    "cache-control": "private, max-age=0",
  };
}

function signatureHeader(sig: string, keyId: string) {
  return serializeDictionary({ sig, keyid: keyId, alg: "rsa-v1_5-sha256" });
}

function directiveResponse(body: string, signature: string | null, keyId: string | null) {
  const part: Part = { name: "directive", body };
  if (signature && keyId) part.headers = { "expo-signature": signatureHeader(signature, keyId) };
  const mp = multipartMixed([part]);
  return new Response(mp.body, { status: 200, headers: protocolHeaders(mp.contentType) });
}

async function noUpdate(c: Context<AppEnv>, appId: string, wantsSignature: boolean, keyIdHint?: string) {
  if (!wantsSignature) return directiveResponse(JSON.stringify({ type: "noUpdateAvailable" }), null, null);
  const d = await loadNoUpdateDirective(c.env, appId, keyIdHint);
  // No key registered yet: an empty 204 is a valid "nothing to do" for protocol v1.
  if (!d) return new Response(null, { status: 204, headers: protocolHeaders("text/plain") });
  return directiveResponse(d.no_update_directive, d.no_update_signature, d.key_id);
}

function parseIdList(header: string | undefined): string[] {
  if (!header) return [];
  return header.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g)?.map((s) => s.toLowerCase()) ?? [];
}

expoPublic.get("/expo/:appId/manifest", async (c) => {
  const appId = requireMatch(c.req.param("appId"), APP_ID_RE, "app id");
  const protocol = c.req.header("expo-protocol-version") ?? "0";
  if (protocol !== "1") throw badRequest("Aeron requires the Expo Updates protocol v1 (expo-updates in SDK 46 or newer)");
  const platform = c.req.header("expo-platform") ?? c.req.query("platform");
  if (platform !== "ios" && platform !== "android") throw badRequest("expo-platform must be ios or android");
  const runtime = requireMatch(c.req.header("expo-runtime-version") ?? c.req.query("runtime-version"), RUNTIME_RE, "runtime version");
  const channel = requireMatch(c.req.header("expo-channel-name") ?? "production", CHANNEL_RE, "channel");
  const currentId = (c.req.header("expo-current-update-id") ?? "").toLowerCase();
  const embeddedId = (c.req.header("expo-embedded-update-id") ?? "").toLowerCase();
  const failed = parseIdList(c.req.header("expo-recent-failed-update-ids"));
  const expect = c.req.header("expo-expect-signature");
  const wantsSignature = expect !== undefined;
  const keyIdHint = typeof parseDictionary(expect).keyid === "string" ? (parseDictionary(expect).keyid as string) : undefined;
  const clientId = c.req.header("eas-client-id") ?? null;

  // Signed builds only. A build without codeSigningCertificate would run whatever this server
  // returns, so a compromised server could push code to it. Such builds get nothing.
  if (!wantsSignature && c.env.ALLOW_UNSIGNED_EXPO !== "1") {
    if (Math.random() < 0.01) c.executionCtx.waitUntil(bumpStat(c.env, appId, "unsigned-build", "unsigned_client_blocked", 100));
    return new Response(null, { status: 204, headers: { ...protocolHeaders("text/plain"), "x-aeron-reason": "unsigned-build" } });
  }

  const state = await loadRollout(c.env, appId, channel, platform, runtime);
  if (!state || (!state.current && !state.stable)) return noUpdate(c, appId, wantsSignature, keyIdHint);

  let target: UpdateMeta | null;
  if (state.undo_active && state.current) {
    // Devices running the bad update get its pre-signed rollBackToEmbedded directive.
    if (currentId === state.current.id.toLowerCase()) {
      const u = await loadSignedUpdate(c.env, state.current.id);
      if (!u) return noUpdate(c, appId, wantsSignature, keyIdHint);
      c.executionCtx.waitUntil(bumpStat(c.env, appId, state.current.id, "undo_served"));
      return directiveResponse(u.undo_directive, u.undo_signature, u.key_id);
    }
    target = state.stable;
  } else {
    const inRollout = (await rolloutBucket(clientId, state.salt)) < state.percent_bp;
    target = inRollout ? state.current : state.stable;
  }

  if (!target) return noUpdate(c, appId, wantsSignature, keyIdHint);
  const tid = target.id.toLowerCase();
  if (tid === currentId || failed.includes(tid) || (tid === embeddedId && !currentId)) {
    return noUpdate(c, appId, wantsSignature, keyIdHint);
  }

  const u = await loadSignedUpdate(c.env, target.id);
  if (!u) return noUpdate(c, appId, wantsSignature, keyIdHint);
  const mp = multipartMixed([
    { name: "manifest", body: u.manifest, headers: { "expo-signature": signatureHeader(u.signature, u.key_id) } },
    { name: "extensions", body: JSON.stringify({ assetRequestHeaders: {} }) },
  ]);
  c.executionCtx.waitUntil(bumpStat(c.env, appId, target.id, "served"));
  return new Response(mp.body, { status: 200, headers: protocolHeaders(mp.contentType) });
});

const EXPO_EVENTS = new Set(["launch_ok", "launch_error", "js_error", "emergency_launch", "update_downloaded", "update_failed"]);

/** Tiny telemetry endpoint used by the optional Aeron client kit. */
expoPublic.post("/expo/:appId/events", async (c) => {
  const appId = requireMatch(c.req.param("appId"), APP_ID_RE, "app id");
  const body = await readJson<{ event?: string; updateId?: string | null }>(c, 4096);
  if (!body.event || !EXPO_EVENTS.has(body.event)) throw badRequest("unknown event");
  const subject = body.updateId && /^[0-9a-f-]{36}$/i.test(body.updateId) ? body.updateId.toLowerCase() : "embedded";
  const exists = await cached(`app-exists:${appId}`, 300, async () =>
    Boolean(await c.env.DB.prepare("SELECT 1 FROM apps WHERE id = ?").bind(appId).first()),
  );
  if (!exists) return c.body(null, 204);
  c.executionCtx.waitUntil(bumpStat(c.env, appId, subject, body.event));
  return c.body(null, 204);
});
