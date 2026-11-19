import type { Env } from "../env";
import { notFound } from "./http";
import { sbCheckCacheKey } from "./shorebird";
import { invalidate } from "./store";

/**
 * Permanently removing an app. Two steps so the dashboard can show exactly what will go:
 *   planAppDeletion  → counts, the storage objects only this app uses, and the SQL to run
 *   executeAppDeletion → one atomic D1 batch, then storage clean-up and cache invalidation
 *
 * Expo files are content-addressed and can be shared between apps (same bytes, same hash), so a file is
 * removed only when no other app's update or patch references it. Flutter artifacts live under
 * shorebird/<app>/ and belong to the app alone. Audit-log entries are kept as history.
 */

export interface DeletionSummary {
  app: string;
  kind: string;
  updates: number;
  releases: number;
  patches: number;
  runtimes: number;
  keys: number;
  files: number;
  tokensRevoked: number;
  tokensNarrowed: number;
  trustRules: number;
}

export interface DeletionPlan {
  summary: DeletionSummary;
  fileKeys: string[];
  cacheKeys: string[];
  statements: D1PreparedStatement[];
}

/** Hex file ids referenced by a signed Expo manifest (launch asset and assets). */
function manifestFiles(manifest: string): string[] {
  try {
    const m = JSON.parse(manifest) as { launchAsset?: { url?: string }; assets?: Array<{ url?: string }> };
    return [m.launchAsset, ...(m.assets ?? [])]
      .map((a) => /([0-9a-f]{64})(?:[?#].*)?$/.exec(a?.url ?? "")?.[1])
      .filter((x): x is string => Boolean(x));
  } catch {
    return [];
  }
}

const RELEASE_IDS = "SELECT id FROM sb_releases WHERE app_id = ?1";
const PATCH_IDS = "SELECT p.id FROM sb_patches p JOIN sb_releases r ON r.id = p.release_id WHERE r.app_id = ?1";

export async function planAppDeletion(env: Env, appId: string): Promise<DeletionPlan> {
  const app = await env.DB.prepare("SELECT id, kind FROM apps WHERE id = ?").bind(appId).first<{ id: string; kind: string }>();
  if (!app) throw notFound(`App ${appId} not found`);
  const db = env.DB;
  const [mine, minePatches, others, otherPatches, counts, rollouts, channels, releases, tokens, keyIds] = await db.batch([
    db.prepare("SELECT manifest FROM expo_updates WHERE app_id = ?1").bind(appId),
    db.prepare("SELECT patch_hex FROM expo_patches WHERE app_id = ?1").bind(appId),
    db.prepare("SELECT manifest FROM expo_updates WHERE app_id != ?1").bind(appId),
    db.prepare("SELECT patch_hex FROM expo_patches WHERE app_id != ?1").bind(appId),
    db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM expo_updates WHERE app_id = ?1) AS updates,
                (SELECT COUNT(*) FROM expo_runtimes WHERE app_id = ?1) AS runtimes,
                (SELECT COUNT(*) FROM expo_keys WHERE app_id = ?1) AS keys,
                (SELECT COUNT(*) FROM sb_releases WHERE app_id = ?1) AS releases,
                (SELECT COUNT(*) FROM (${PATCH_IDS})) AS patches,
                (SELECT COUNT(*) FROM github_trust WHERE app_id = ?1) AS trust`,
      )
      .bind(appId),
    db.prepare("SELECT channel, platform, runtime_version FROM expo_rollouts WHERE app_id = ?1").bind(appId),
    db.prepare("SELECT name FROM sb_channels WHERE app_id = ?1").bind(appId),
    db.prepare("SELECT version FROM sb_releases WHERE app_id = ?1").bind(appId),
    db.prepare("SELECT id, app_scope FROM api_tokens WHERE revoked_at IS NULL AND app_scope IS NOT NULL"),
    db.prepare("SELECT key_id FROM expo_keys WHERE app_id = ?1").bind(appId),
  ]);

  // Expo files used only by this app.
  const used = new Set<string>();
  for (const r of (others!.results ?? []) as Array<{ manifest: string }>) for (const h of manifestFiles(r.manifest)) used.add(h);
  for (const r of (otherPatches!.results ?? []) as Array<{ patch_hex: string }>) used.add(r.patch_hex);
  const own = new Set<string>();
  for (const r of (mine!.results ?? []) as Array<{ manifest: string }>) for (const h of manifestFiles(r.manifest)) own.add(h);
  for (const r of (minePatches!.results ?? []) as Array<{ patch_hex: string }>) own.add(r.patch_hex);
  const fileKeys = [...own].filter((h) => !used.has(h)).map((h) => `files/${h}`);

  // Flutter artifacts: everything stored under this app's prefix.
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix: `shorebird/${appId}/`, cursor });
    for (const o of page.objects) fileKeys.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  // Tokens limited to this app: drop it from their list; revoke those left with no app.
  const now = new Date().toISOString();
  const tokenStatements: D1PreparedStatement[] = [];
  let tokensRevoked = 0;
  let tokensNarrowed = 0;
  for (const t of (tokens!.results ?? []) as Array<{ id: string; app_scope: string }>) {
    let scope: string[];
    try {
      scope = JSON.parse(t.app_scope);
    } catch {
      continue;
    }
    if (!Array.isArray(scope) || !scope.includes(appId)) continue;
    const rest = scope.filter((a) => a !== appId);
    if (rest.length) {
      tokensNarrowed++;
      tokenStatements.push(db.prepare("UPDATE api_tokens SET app_scope = ? WHERE id = ?").bind(JSON.stringify(rest), t.id));
    } else {
      tokensRevoked++;
      tokenStatements.push(db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ?").bind(now, t.id));
    }
  }

  const c = (counts!.results?.[0] ?? {}) as Record<string, number>;
  const cacheKeys = [
    `app-exists:${appId}`,
    `expo-noupdate:${appId}:`,
    ...((keyIds!.results ?? []) as Array<{ key_id: string }>).map((k) => `expo-noupdate:${appId}:${k.key_id}`),
    ...((rollouts!.results ?? []) as Array<{ channel: string; platform: string; runtime_version: string }>).map((r) => `expo-rollout:${appId}:${r.channel}:${r.platform}:${r.runtime_version}`),
  ];
  for (const ch of (channels!.results ?? []) as Array<{ name: string }>) {
    for (const r of (releases!.results ?? []) as Array<{ version: string }>) cacheKeys.push(sbCheckCacheKey(appId, ch.name, r.version));
  }

  const del = (sql: string) => db.prepare(sql).bind(appId);
  const statements = [
    del("DELETE FROM expo_patches WHERE app_id = ?1"),
    del("DELETE FROM expo_rollouts WHERE app_id = ?1"),
    del("DELETE FROM expo_updates WHERE app_id = ?1"),
    del("DELETE FROM expo_runtimes WHERE app_id = ?1"),
    del("DELETE FROM expo_keys WHERE app_id = ?1"),
    del(
      `DELETE FROM sb_upload_sessions WHERE (kind = 'release' AND artifact_id IN (SELECT id FROM sb_release_artifacts WHERE release_id IN (${RELEASE_IDS})))
                                     OR (kind = 'patch' AND artifact_id IN (SELECT id FROM sb_patch_artifacts WHERE patch_id IN (${PATCH_IDS})))`,
    ),
    del(`DELETE FROM sb_channel_patches WHERE channel_id IN (SELECT id FROM sb_channels WHERE app_id = ?1) OR patch_id IN (${PATCH_IDS})`),
    del(`DELETE FROM sb_patch_artifacts WHERE patch_id IN (${PATCH_IDS})`),
    del(`DELETE FROM sb_patches WHERE release_id IN (${RELEASE_IDS})`),
    del(`DELETE FROM sb_release_artifacts WHERE release_id IN (${RELEASE_IDS})`),
    del(`DELETE FROM sb_release_platforms WHERE release_id IN (${RELEASE_IDS})`),
    del("DELETE FROM sb_releases WHERE app_id = ?1"),
    del("DELETE FROM sb_channels WHERE app_id = ?1"),
    del("DELETE FROM flutter_settings WHERE app_id = ?1"),
    del("DELETE FROM app_settings WHERE app_id = ?1"),
    del("DELETE FROM github_trust WHERE app_id = ?1"),
    del("DELETE FROM stats_daily WHERE app_id = ?1"),
    ...tokenStatements,
    del("DELETE FROM apps WHERE id = ?1"),
  ];

  return {
    summary: {
      app: appId,
      kind: app.kind,
      updates: c.updates ?? 0,
      releases: c.releases ?? 0,
      patches: c.patches ?? 0,
      runtimes: c.runtimes ?? 0,
      keys: c.keys ?? 0,
      files: fileKeys.length,
      tokensRevoked,
      tokensNarrowed,
      trustRules: c.trust ?? 0,
    },
    fileKeys,
    cacheKeys,
    statements,
  };
}

export async function executeAppDeletion(env: Env, plan: DeletionPlan): Promise<DeletionSummary> {
  await env.DB.batch(plan.statements); // atomic: all rows go, or none
  for (let i = 0; i < plan.fileKeys.length; i += 1000) await env.BUCKET.delete(plan.fileKeys.slice(i, i + 1000));
  await Promise.all(plan.cacheKeys.map((k) => invalidate(k).catch(() => undefined)));
  return plan.summary;
}
