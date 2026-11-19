import type { Env } from "../env";
import { notFound } from "./http";

export interface AppRow {
  id: string;
  name: string;
  kind: "expo" | "flutter";
  created_at: string;
}

export async function getApp(env: Env, id: string): Promise<AppRow> {
  const row = await env.DB.prepare("SELECT id, name, kind, created_at FROM apps WHERE id = ?").bind(id).first<AppRow>();
  if (!row) throw notFound(`App ${id} not found`);
  return row;
}

/** Per-app policy. Apps without a row (should not happen) are treated as requiring approval. */
export async function appPolicy(env: Env, appId: string): Promise<{ requireApproval: boolean }> {
  const row = await env.DB.prepare("SELECT require_approval FROM app_settings WHERE app_id = ?").bind(appId).first<{ require_approval: number }>();
  return { requireApproval: row ? Boolean(row.require_approval) : true };
}

export async function createAppRow(env: Env, id: string, name: string, kind: "expo" | "flutter") {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO apps (id, name, kind) VALUES (?, ?, ?)").bind(id, name, kind),
    env.DB.prepare("INSERT OR IGNORE INTO app_settings (app_id, require_approval) VALUES (?, 1)").bind(id),
    ...(kind === "flutter" ? [env.DB.prepare("INSERT OR IGNORE INTO flutter_settings (app_id) VALUES (?)").bind(id)] : []),
  ]);
}

export async function audit(env: Env, actor: string, action: string, appId: string | null, detail: unknown) {
  await env.DB.prepare("INSERT INTO audit_log (actor, action, app_id, detail) VALUES (?, ?, ?, ?)")
    .bind(actor, action, appId, detail === undefined ? null : JSON.stringify(detail))
    .run();
}

/** Increment a daily counter, honouring EVENT_SAMPLE_RATE (counts are scaled back up). */
export async function bumpStat(env: Env, appId: string, subject: string, metric: string, by = 1) {
  const rate = Math.min(1, Math.max(0, Number(env.EVENT_SAMPLE_RATE ?? "1") || 0));
  if (rate <= 0) return;
  if (rate < 1) {
    if (Math.random() >= rate) return;
    by = Math.round(by / rate);
  }
  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare(
    `INSERT INTO stats_daily (day, app_id, subject, metric, count) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (day, app_id, subject, metric) DO UPDATE SET count = count + excluded.count`,
  )
    .bind(day, appId, subject, metric, by)
    .run();
}

/**
 * Resolves to `fallback` if `p` hasn't settled within `ms` (or rejects). The edge cache is an
 * optimisation, so a slow cache operation must never hold up a phone's request.
 */
export async function withTimeout<T, F>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([p.catch(() => fallback), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const CACHE_OP_TIMEOUT_MS = 1500;

/** Small edge cache in front of D1 for hot, short-lived lookups. */
export async function cached<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
  const cache = (globalThis as unknown as { caches?: { default: Cache } }).caches?.default;
  const url = `https://aeron.internal/cache/${encodeURIComponent(key)}`;
  if (cache) {
    const hit = await withTimeout(cache.match(url), CACHE_OP_TIMEOUT_MS, undefined);
    if (hit) return (await hit.json()) as T;
  }
  const value = await load();
  if (cache) {
    await withTimeout(
      cache.put(url, new Response(JSON.stringify(value), { headers: { "cache-control": `max-age=${ttlSeconds}` } })),
      CACHE_OP_TIMEOUT_MS,
      undefined,
    );
  }
  return value;
}

export async function invalidate(key: string) {
  const cache = (globalThis as unknown as { caches?: { default: Cache } }).caches?.default;
  if (cache) await cache.delete(`https://aeron.internal/cache/${encodeURIComponent(key)}`);
}

export function filesBaseUrl(env: Env): string {
  return (env.FILES_BASE_URL || `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/files`).replace(/\/$/, "");
}
