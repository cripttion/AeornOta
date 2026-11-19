import { Hono } from "hono";
import type { AppEnv } from "../env";
import { accessEnforced, assertRole } from "../lib/auth";

/** Everything waiting for a second person. Mounted under /api/admin. */
export const adminApprovals = new Hono<AppEnv>();

adminApprovals.get("/approvals", async (c) => {
  assertRole(c, "viewer");
  const p = c.get("principal");
  const [expo, flutter] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT u.id, u.app_id, u.channel, u.platform, u.runtime_version, u.message, u.git_sha, u.repository, u.ci_run_url, u.critical,
              u.total_bytes, u.requested_percent_bp, u.published_by, u.published_at, u.publisher_token_id, u.key_id,
              (SELECT MIN(patch_bytes) FROM expo_patches x WHERE x.target_update_id = u.id) AS smallest_patch_bytes,
              (SELECT current_update_id FROM expo_rollouts r WHERE r.app_id = u.app_id AND r.channel = u.channel AND r.platform = u.platform AND r.runtime_version = u.runtime_version) AS replaces
         FROM expo_updates u WHERE u.status = 'pending' ORDER BY u.published_at`,
    ),
    c.env.DB.prepare(
      `SELECT ch.app_id, ch.name AS channel, p.id AS patch_id, p.number, r.version AS release_version, p.notes, p.git_sha, p.repository, p.ci_run_url,
              p.created_by, p.created_at, cp.requested_bp, cp.requested_by_token, p.created_by_token,
              (SELECT COUNT(*) FROM sb_patch_artifacts a WHERE a.patch_id = p.id AND a.hash_signature IS NOT NULL) AS signed_artifacts,
              (SELECT COUNT(*) FROM sb_patch_artifacts a WHERE a.patch_id = p.id) AS artifacts,
              (SELECT SUM(size) FROM sb_patch_artifacts a WHERE a.patch_id = p.id) AS total_bytes
         FROM sb_channel_patches cp JOIN sb_channels ch ON ch.id = cp.channel_id JOIN sb_patches p ON p.id = cp.patch_id JOIN sb_releases r ON r.id = p.release_id
        WHERE cp.status = 'pending' ORDER BY p.created_at`,
    ),
  ]);
  const visible = (appId: string) => !p.apps || p.apps.includes(appId);
  const mine = (tokenIds: Array<string | null>) => tokenIds.includes(p.id);
  return c.json({
    accessEnforced: accessEnforced(c.env),
    canReview: p.role === "admin",
    expo: ((expo!.results ?? []) as Array<Record<string, any>>)
      .filter((u) => visible(u.app_id))
      .map((u) => ({ ...u, selfSubmitted: mine([u.publisher_token_id]) })),
    flutter: ((flutter!.results ?? []) as Array<Record<string, any>>)
      .filter((x) => visible(x.app_id))
      .map((x) => ({ ...x, selfSubmitted: mine([x.requested_by_token, x.created_by_token]) })),
  });
});
