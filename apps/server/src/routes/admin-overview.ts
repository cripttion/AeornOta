import { Hono } from "hono";
import type { AppEnv } from "../env";
import { accessEnforced, assertRole } from "../lib/auth";

export const VERSION = "0.2.0";

/** Aggregated data for the console's overview page. Mounted under /api/admin. */
export const adminOverview = new Hono<AppEnv>();

interface Rollout {
  app_id: string;
  channel: string;
  platform: string;
  runtime_version: string;
  current_update_id: string | null;
  stable_update_id: string | null;
  percent_bp: number;
  undo_active: number;
  updated_at: string;
}

adminOverview.get("/overview", async (c) => {
  assertRole(c, "viewer");
  const p = c.get("principal");
  const days = Math.min(30, Math.max(1, Number(c.req.query("days") ?? "14") || 14));
  const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);

  const [appsRes, rolloutsRes, lastRes, statsRes, sbRes, sbLastRes] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT id, name, kind, created_at FROM apps ORDER BY id"),
    c.env.DB.prepare(
      "SELECT app_id, channel, platform, runtime_version, current_update_id, stable_update_id, percent_bp, undo_active, updated_at FROM expo_rollouts",
    ),
    c.env.DB.prepare("SELECT app_id, MAX(published_at) AS last_published_at, COUNT(*) AS updates FROM expo_updates GROUP BY app_id"),
    c.env.DB.prepare("SELECT app_id, day, metric, SUM(count) AS count FROM stats_daily WHERE day >= ? GROUP BY app_id, day, metric").bind(since),
    c.env.DB.prepare(
      `SELECT ch.app_id, ch.name AS channel, r.version AS release_version, p.number AS patch_number, cp.rollout_bp AS percent_bp, cp.is_rolled_back, cp.updated_at
         FROM sb_channel_patches cp JOIN sb_channels ch ON ch.id = cp.channel_id JOIN sb_patches p ON p.id = cp.patch_id JOIN sb_releases r ON r.id = p.release_id
        ORDER BY r.created_at DESC, p.number DESC`,
    ),
    c.env.DB.prepare(
      `SELECT r.app_id, MAX(COALESCE(p.created_at, r.created_at)) AS last_published_at, COUNT(p.id) AS updates
         FROM sb_releases r LEFT JOIN sb_patches p ON p.release_id = r.id GROUP BY r.app_id`,
    ),
  ]);
  const sbRows = (sbRes!.results ?? []) as Array<{ app_id: string; channel: string; release_version: string; patch_number: number; percent_bp: number; is_rolled_back: number }>;
  for (const r of (sbLastRes!.results ?? []) as Array<{ app_id: string; last_published_at: string; updates: number }>) {
    (lastRes!.results as unknown[]).push(r);
  }

  const visible = (id: string) => !p.apps || p.apps.includes(id);
  const apps = ((appsRes!.results ?? []) as Array<{ id: string; name: string; kind: string; created_at: string }>).filter((a) => visible(a.id));
  const rollouts = (rolloutsRes!.results ?? []) as unknown as Rollout[];
  const last = new Map(((lastRes!.results ?? []) as Array<{ app_id: string; last_published_at: string; updates: number }>).map((r) => [r.app_id, r]));
  const stats = (statsRes!.results ?? []) as Array<{ app_id: string; day: string; metric: string; count: number }>;

  const dayList: string[] = [];
  for (let i = days - 1; i >= 0; i--) dayList.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));

  const totals: Record<string, number> = {};
  const out = apps.map((a) => {
    const appStats = stats.filter((s) => s.app_id === a.id);
    const sums: Record<string, number> = {};
    for (const s of appStats) {
      sums[s.metric] = (sums[s.metric] ?? 0) + Number(s.count);
      totals[s.metric] = (totals[s.metric] ?? 0) + Number(s.count);
    }
    const daily = dayList.map((day) => {
      const row: Record<string, number | string> = { day };
      for (const s of appStats.filter((x) => x.day === day)) row[s.metric] = Number(s.count);
      return row;
    });
    const rs = rollouts.filter((r) => r.app_id === a.id);
    const l = last.get(a.id);
    // Flutter: newest live (not rolled back) patch per channel, newest release first.
    const seen = new Set<string>();
    const channels = sbRows.filter((r) => {
      if (r.app_id !== a.id || r.is_rolled_back || seen.has(r.channel)) return false;
      seen.add(r.channel);
      return true;
    });
    return {
      ...a,
      rollouts: rs,
      channels,
      lastPublishedAt: l?.last_published_at ?? null,
      updates: l?.updates ?? 0,
      stats: sums,
      daily,
      attention: rs.some((r) => r.undo_active)
        ? "undo"
        : rs.some((r) => r.percent_bp < 10000) || channels.some((r) => r.percent_bp < 10000)
          ? "partial"
          : null,
    };
  });

  const pending = await c.env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM expo_updates WHERE status = 'pending') + (SELECT COUNT(*) FROM sb_channel_patches WHERE status = 'pending') AS n",
  ).first<{ n: number }>();
  return c.json({
    days: dayList,
    totals,
    pendingApprovals: pending?.n ?? 0,
    apps: out,
    activeRollouts: rollouts.filter((r) => visible(r.app_id) && r.percent_bp > 0 && r.percent_bp < 10000).length,
    undoActive: rollouts.filter((r) => visible(r.app_id) && r.undo_active).length,
  });
});

adminOverview.get("/settings", (c) => {
  assertRole(c, "viewer");
  const base = c.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  return c.json({
    version: VERSION,
    publicBaseUrl: base,
    filesBaseUrl: (c.env.FILES_BASE_URL || `${base}/files`).replace(/\/$/, ""),
    eventSampleRate: Number(c.env.EVENT_SAMPLE_RATE ?? "1"),
    bootstrapTokenActive: Boolean(c.env.BOOTSTRAP_ADMIN_TOKEN),
    accessEnforced: accessEnforced(c.env),
    notificationsConfigured: Boolean(c.env.NOTIFY_WEBHOOK_URL),
    cliUrl: `${base}/cli/aeron.mjs`,
    githubAudience: base,
    endpoints: {
      expoManifest: `${base}/expo/<app>/manifest`,
      expoEvents: `${base}/expo/<app>/events`,
      files: `${base}/files/<sha256>`,
      shorebird: `${base}`,
    },
  });
});

/** Security posture: what's protecting your apps right now, and what to fix. */
adminOverview.get("/security", async (c) => {
  assertRole(c, "admin");
  const now = new Date().toISOString();
  const soon = new Date(Date.now() + 14 * 86_400_000).toISOString();
  const [apps, expoKeys, flutter, tokens, rules, blocked] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT a.id, a.kind, COALESCE(s.require_approval, 1) AS require_approval FROM apps a LEFT JOIN app_settings s ON s.app_id = a.id ORDER BY a.id"),
    c.env.DB.prepare("SELECT app_id, COUNT(*) AS n FROM expo_keys WHERE retired_at IS NULL GROUP BY app_id"),
    c.env.DB.prepare("SELECT app_id, require_signing, public_key_pem IS NOT NULL AS has_key FROM flutter_settings"),
    c.env.DB.prepare(
      `SELECT role, source, expires_at FROM api_tokens WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND source != 'cli-ephemeral' AND source != 'github-oidc'`,
    ).bind(now),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM github_trust"),
    c.env.DB.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM stats_daily WHERE metric = 'unsigned_client_blocked' AND day >= ?").bind(new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)),
  ]);
  const keyCount = new Map(((expoKeys!.results ?? []) as Array<{ app_id: string; n: number }>).map((r) => [r.app_id, r.n]));
  const fl = new Map(((flutter!.results ?? []) as Array<{ app_id: string; require_signing: number; has_key: number }>).map((r) => [r.app_id, r]));
  const toks = (tokens!.results ?? []) as Array<{ role: string; expires_at: string | null }>;
  return c.json({
    deployment: {
      accessEnforced: accessEnforced(c.env),
      bootstrapTokenActive: Boolean(c.env.BOOTSTRAP_ADMIN_TOKEN),
      notificationsConfigured: Boolean(c.env.NOTIFY_WEBHOOK_URL),
      unsignedExpoAllowed: c.env.ALLOW_UNSIGNED_EXPO === "1",
      signingChangesUnlocked: c.env.ALLOW_SIGNING_CHANGES === "1",
      customDomain: !/\.workers\.dev$/.test(new URL(c.env.PUBLIC_BASE_URL).host),
    },
    apps: ((apps!.results ?? []) as Array<{ id: string; kind: string; require_approval: number }>).map((a) => ({
      id: a.id,
      kind: a.kind,
      requireApproval: Boolean(a.require_approval),
      signingReady: a.kind === "expo" ? (keyCount.get(a.id) ?? 0) > 0 : Boolean(fl.get(a.id)?.require_signing && fl.get(a.id)?.has_key),
      requireSigning: a.kind === "expo" ? c.env.ALLOW_UNSIGNED_EXPO !== "1" : Boolean(fl.get(a.id)?.require_signing ?? 1),
    })),
    tokens: {
      admins: toks.filter((t) => t.role === "admin").length,
      total: toks.length,
      noExpiry: toks.filter((t) => !t.expires_at).length,
      expiringSoon: toks.filter((t) => t.expires_at && t.expires_at < soon).length,
    },
    githubRules: (rules!.results?.[0] as { n: number } | undefined)?.n ?? 0,
    unsignedBuildsBlocked7d: (blocked!.results?.[0] as { n: number } | undefined)?.n ?? 0,
  });
});
