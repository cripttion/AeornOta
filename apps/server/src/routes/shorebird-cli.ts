import { Hono, type Context } from "hono";
import type { AppEnv, Env } from "../env";
import { verifyRsaSha256 } from "../lib/crypto";
import {
  ORG,
  SbError,
  baseUrl,
  orgRole,
  randomUrlToken,
  releaseJson,
  sbAuth,
  sbCheckCacheKey,
  sbErrorResponse,
  sbForm,
  sbJson,
  sbRequire,
  slugify,
  type PlatformRow,
  type ReleaseRow,
} from "../lib/shorebird";
import { notify } from "../lib/notify";
import { appPolicy, audit, createAppRow, invalidate } from "../lib/store";
import { requireHuman } from "../lib/auth";

/**
 * The subset of Shorebird's REST API (base /api/v1) that the stock `shorebird` CLI uses for
 * init, release, patch, patches list/rollback and whoami. Device endpoints live in shorebird-device.ts.
 */
export const shorebirdCli = new Hono<AppEnv>();
shorebirdCli.onError((err, c) => sbErrorResponse(c, err));
shorebirdCli.use("*", sbAuth);

const now = () => new Date().toISOString();
const who = (c: Context<AppEnv>) => `${c.get("principal").name} (${c.get("principal").id})`;

interface AppRow {
  id: string;
  name: string;
  kind: string;
  created_at: string;
}

async function flutterApp(c: Context<AppEnv>, role: "viewer" | "publisher" | "admin" = "viewer"): Promise<AppRow> {
  const id = c.req.param("appId") ?? "";
  const row = await c.env.DB.prepare("SELECT id, name, kind, created_at FROM apps WHERE id = ?").bind(id).first<AppRow>();
  if (!row || row.kind !== "flutter") throw new SbError(404, "not_found", `App ${id} not found`);
  sbRequire(c.get("principal"), role, row.id);
  return row;
}

async function appMetadata(env: Env, app: AppRow) {
  const latest = await env.DB.prepare(
    `SELECT r.version, (SELECT MAX(p.number) FROM sb_patches p WHERE p.release_id = r.id) AS patch
       FROM sb_releases r WHERE r.app_id = ? ORDER BY r.created_at DESC LIMIT 1`,
  )
    .bind(app.id)
    .first<{ version: string; patch: number | null }>();
  const platforms = await env.DB.prepare(
    "SELECT DISTINCT rp.platform FROM sb_release_platforms rp JOIN sb_releases r ON r.id = rp.release_id WHERE r.app_id = ?",
  )
    .bind(app.id)
    .all<{ platform: string }>();
  return {
    app_id: app.id,
    display_name: app.name,
    created_at: app.created_at,
    updated_at: app.created_at,
    organization_id: ORG.id,
    ...(latest ? { latest_release_version: latest.version } : {}),
    ...(latest?.patch ? { latest_patch_number: latest.patch } : {}),
    platforms: (platforms.results ?? []).map((p) => p.platform),
  };
}

async function loadRelease(env: Env, appId: string, releaseId: number) {
  const r = await env.DB.prepare("SELECT * FROM sb_releases WHERE id = ? AND app_id = ?").bind(releaseId, appId).first<ReleaseRow>();
  if (!r) throw new SbError(404, "not_found", `Release ${releaseId} not found`);
  return r;
}

async function settings(env: Env, appId: string) {
  const s = await env.DB.prepare("SELECT require_signing, public_key_pem FROM flutter_settings WHERE app_id = ?")
    .bind(appId)
    .first<{ require_signing: number; public_key_pem: string | null }>();
  return { requireSigning: s ? Boolean(s.require_signing) : true, publicKeyPem: s?.public_key_pem ?? null };
}

// ------------------------------------------------------------------ account stubs

shorebirdCli.get("/users/me", (c) => {
  const p = c.get("principal");
  return c.json({ id: 1, email: `${p.name.replace(/[^A-Za-z0-9._-]/g, "-")}@aeron.local`, display_name: p.name, jwt_issuer: baseUrl(c.env), has_active_subscription: true });
});

shorebirdCli.get("/plan", (c) => c.json({ level: "self_hosted" }));

shorebirdCli.get("/organizations", (c) => c.json({ organizations: [{ organization: ORG, role: orgRole(c.get("principal")) }] }));

shorebirdCli.get("/organizations/:orgId/apps", async (c) => {
  const p = c.get("principal");
  const rows = await c.env.DB.prepare("SELECT id, name, kind, created_at FROM apps WHERE kind = 'flutter' ORDER BY id").all<AppRow>();
  const apps = (rows.results ?? []).filter((a) => !p.apps || p.apps.includes(a.id));
  return c.json({ apps: await Promise.all(apps.map((a) => appMetadata(c.env, a))) });
});

shorebirdCli.get("/apps", async (c) => {
  const p = c.get("principal");
  const rows = await c.env.DB.prepare("SELECT id, name, kind, created_at FROM apps WHERE kind = 'flutter' ORDER BY id").all<AppRow>();
  const apps = (rows.results ?? []).filter((a) => !p.apps || p.apps.includes(a.id));
  return c.json({ apps: await Promise.all(apps.map((a) => appMetadata(c.env, a))) });
});

shorebirdCli.post("/runs", (c) => c.json({ id: 1 }, 201));
shorebirdCli.post("/apps/:appId/runs", (c) => c.json({ id: 1 }, 201));

// ------------------------------------------------------------------ apps

/** `shorebird init`: reuse the Aeron flutter app whose id matches the display name, or create it (admin only). */
shorebirdCli.post("/apps", async (c) => {
  const body = await sbJson<{ display_name?: string }>(c);
  const name = (body.display_name ?? "").trim();
  const id = slugify(name);
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(id)) throw new SbError(400, "bad_request", "display_name must contain letters or digits");
  const p = c.get("principal");
  const existing = await c.env.DB.prepare("SELECT id, name, kind, created_at FROM apps WHERE id = ?").bind(id).first<AppRow>();
  if (existing) {
    if (existing.kind !== "flutter") throw new SbError(409, "conflict", `Aeron app ${id} exists but is an ${existing.kind} app`);
    sbRequire(p, "publisher", id);
    return c.json({ id: existing.id, display_name: existing.name }, 201);
  }
  sbRequire(p, "admin");
  try {
    await requireHuman(c);
  } catch {
    throw new SbError(403, "forbidden", `Create the app "${id}" in the Aeron console first (Apps → +), then re-run shorebird init.`);
  }
  await createAppRow(c.env, id, name, "flutter");
  await audit(c.env, who(c), "app.create", id, { name, kind: "flutter", via: "shorebird init" });
  notify(c.env, c.executionCtx, `📱 ${p.name} added flutter app "${id}" (shorebird init)`);
  return c.json({ id, display_name: name }, 201);
});

shorebirdCli.get("/apps/:appId", async (c) => c.json(await appMetadata(c.env, await flutterApp(c))));

/** Aeron never holds patch-signing private keys, so "managed" signing is refused with guidance. */
shorebirdCli.get("/apps/:appId/signing-key", async (c) => {
  await flutterApp(c);
  throw new SbError(
    503,
    "signing_not_configured",
    "Aeron never stores signing keys. Release with --public-key-path=keys/patch-public.pem and patch with --private-key-path=keys/patch-private.pem (create them with: aeron flutter keys generate).",
  );
});

// ------------------------------------------------------------------ releases

async function listReleases(env: Env, appId: string) {
  const rels = await env.DB.prepare("SELECT * FROM sb_releases WHERE app_id = ? ORDER BY created_at").bind(appId).all<ReleaseRow>();
  const plats = await env.DB.prepare(
    "SELECT rp.release_id, rp.platform, rp.status, rp.signing_mode FROM sb_release_platforms rp JOIN sb_releases r ON r.id = rp.release_id WHERE r.app_id = ?",
  )
    .bind(appId)
    .all<PlatformRow>();
  return (rels.results ?? []).map((r) => releaseJson(r, plats.results ?? []));
}

shorebirdCli.get("/apps/:appId/releases", async (c) => {
  const app = await flutterApp(c);
  let releases = await listReleases(c.env, app.id);
  if (c.req.query("sideloadable") === "true") {
    const ids = await c.env.DB.prepare(
      "SELECT DISTINCT release_id FROM sb_release_artifacts a JOIN sb_releases r ON r.id = a.release_id WHERE r.app_id = ? AND a.can_sideload = 1 AND a.state = 'uploaded'",
    )
      .bind(app.id)
      .all<{ release_id: number }>();
    const set = new Set((ids.results ?? []).map((x) => x.release_id));
    releases = releases.filter((r) => set.has(r.id));
  }
  return c.json({ releases });
});

shorebirdCli.post("/apps/:appId/releases", async (c) => {
  const app = await flutterApp(c, "publisher");
  const body = await sbJson<{ version?: string; flutter_revision?: string; flutter_version?: string; display_name?: string }>(c);
  const version = (body.version ?? "").trim();
  const rev = (body.flutter_revision ?? "").trim();
  if (!version || version.length > 100) throw new SbError(400, "bad_request", "version is required");
  if (!/^[0-9a-f]{7,64}$/.test(rev)) throw new SbError(400, "bad_request", "flutter_revision must be a git sha");
  const existing = await c.env.DB.prepare("SELECT * FROM sb_releases WHERE app_id = ? AND version = ?").bind(app.id, version).first<ReleaseRow>();
  if (existing) throw new SbError(409, "conflict", `Release ${version} already exists`);
  await c.env.DB.prepare("INSERT INTO sb_releases (app_id, version, flutter_revision, flutter_version, display_name) VALUES (?, ?, ?, ?, ?)")
    .bind(app.id, version, rev, body.flutter_version ?? null, body.display_name ?? null)
    .run();
  const r = await c.env.DB.prepare("SELECT * FROM sb_releases WHERE app_id = ? AND version = ?").bind(app.id, version).first<ReleaseRow>();
  await audit(c.env, who(c), "flutter.release.create", app.id, { version, flutter_revision: rev });
  return c.json({ release: releaseJson(r!, []) }, 201);
});

shorebirdCli.patch("/apps/:appId/releases/:releaseId", async (c) => {
  const app = await flutterApp(c, "publisher");
  const r = await loadRelease(c.env, app.id, Number(c.req.param("releaseId")));
  const body = await sbJson<{ status?: string; platform?: string; metadata?: unknown; notes?: string }>(c);
  if (body.notes !== undefined) {
    await c.env.DB.prepare("UPDATE sb_releases SET notes = ?, updated_at = ? WHERE id = ?").bind(String(body.notes).slice(0, 2000), now(), r.id).run();
  }
  if (body.status) {
    if (body.status !== "draft" && body.status !== "active") throw new SbError(400, "bad_request", "status must be draft or active");
    const platform = body.platform ?? "";
    if (!/^[a-z]{2,10}$/.test(platform)) throw new SbError(400, "bad_request", "platform is required");
    if (body.status === "active") {
      const pending = await c.env.DB.prepare("SELECT arch FROM sb_release_artifacts WHERE release_id = ? AND platform = ? AND state != 'uploaded'")
        .bind(r.id, platform)
        .all<{ arch: string }>();
      if (pending.results?.length) {
        throw new SbError(409, "release_artifacts_incomplete", `Artifacts not uploaded yet: ${pending.results.map((p) => p.arch).join(", ")}`);
      }
    }
    const signing = await c.env.DB.prepare("SELECT signing FROM sb_release_artifacts WHERE release_id = ? AND platform = ? AND signing IS NOT NULL LIMIT 1")
      .bind(r.id, platform)
      .first<{ signing: string }>();
    let mode: string | null = null;
    try {
      mode = signing ? (JSON.parse(signing.signing).mode ?? null) : null;
    } catch {
      mode = null;
    }
    await c.env.DB.prepare(
      `INSERT INTO sb_release_platforms (release_id, platform, status, signing_mode, metadata, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (release_id, platform) DO UPDATE SET status = excluded.status,
         signing_mode = COALESCE(excluded.signing_mode, sb_release_platforms.signing_mode),
         metadata = COALESCE(excluded.metadata, sb_release_platforms.metadata), updated_at = excluded.updated_at`,
    )
      .bind(r.id, platform, body.status, mode, body.metadata === undefined ? null : JSON.stringify(body.metadata).slice(0, 100_000), now())
      .run();
    await c.env.DB.prepare("UPDATE sb_releases SET updated_at = ? WHERE id = ?").bind(now(), r.id).run();
    if (body.status === "active") await audit(c.env, who(c), "flutter.release.activate", app.id, { version: r.version, platform, signing: mode });
  }
  return c.body(null, 204);
});

function releaseArtifactJson(env: Env, a: Record<string, any>) {
  let signing: unknown;
  try {
    signing = a.signing ? JSON.parse(a.signing) : undefined;
  } catch {
    signing = undefined;
  }
  return {
    id: a.id,
    release_id: a.release_id,
    arch: a.arch,
    platform: a.platform,
    hash: a.hash,
    size: a.size,
    url: `${baseUrl(env)}/sb/artifacts/${a.download_token}`,
    can_sideload: Boolean(a.can_sideload),
    ...(a.podfile_lock_hash ? { podfile_lock_hash: a.podfile_lock_hash } : {}),
    ...(signing ? { signing } : {}),
  };
}

shorebirdCli.get("/apps/:appId/releases/:releaseId/artifacts", async (c) => {
  const app = await flutterApp(c);
  const r = await loadRelease(c.env, app.id, Number(c.req.param("releaseId")));
  const where = ["release_id = ?", "state = 'uploaded'"];
  const args: unknown[] = [r.id];
  for (const k of ["arch", "platform"] as const) {
    const v = c.req.query(k);
    if (v) {
      where.push(`${k} = ?`);
      args.push(v);
    }
  }
  const rows = await c.env.DB.prepare(`SELECT * FROM sb_release_artifacts WHERE ${where.join(" AND ")} ORDER BY id`).bind(...args).all();
  return c.json({ artifacts: (rows.results ?? []).map((a) => releaseArtifactJson(c.env, a)) });
});

async function newUploadSession(env: Env, kind: "release" | "patch", artifactId: number, r2Key: string, total: number) {
  const token = randomUrlToken();
  await env.DB.prepare("INSERT INTO sb_upload_sessions (token, kind, artifact_id, r2_key, total) VALUES (?, ?, ?, ?, ?)")
    .bind(token, kind, artifactId, r2Key, total)
    .run();
  return `${baseUrl(env)}/api/v1/uploads/${token}`;
}

const ARCH_RE = /^[a-z0-9_]{2,40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_ARTIFACT = 2 * 1024 * 1024 * 1024; // 2 GiB

shorebirdCli.post("/apps/:appId/releases/:releaseId/artifacts", async (c) => {
  const app = await flutterApp(c, "publisher");
  const r = await loadRelease(c.env, app.id, Number(c.req.param("releaseId")));
  const f = await sbForm(c);
  const arch = f.arch ?? "";
  const platform = f.platform ?? "";
  const size = Number(f.size);
  if (!ARCH_RE.test(arch) || !/^[a-z]{2,10}$/.test(platform)) throw new SbError(400, "bad_request", "arch and platform are required");
  if (!HEX64.test((f.hash ?? "").toLowerCase())) throw new SbError(400, "bad_request", "hash must be sha256 hex");
  if (!Number.isInteger(size) || size < 0 || size > MAX_ARTIFACT) throw new SbError(400, "bad_request", "invalid size");

  let mode = "unsigned";
  if (f.signing) {
    try {
      mode = JSON.parse(f.signing).mode ?? "unsigned";
    } catch {
      throw new SbError(400, "bad_request", "signing must be JSON");
    }
  }
  const s = await settings(c.env, app.id);
  if (s.requireSigning && mode !== "customer") {
    throw new SbError(
      400,
      "patch_signing_required",
      "This Aeron app requires signed patches. Re-run the release with --public-key-path=keys/patch-public.pem (aeron flutter keys generate creates the key pair).",
    );
  }
  const status = await c.env.DB.prepare("SELECT status FROM sb_release_platforms WHERE release_id = ? AND platform = ?").bind(r.id, platform).first<{ status: string }>();
  const existing = await c.env.DB.prepare("SELECT id, signing FROM sb_release_artifacts WHERE release_id = ? AND platform = ? AND arch = ?")
    .bind(r.id, platform, arch)
    .first<{ id: number; signing: string | null }>();
  if (existing && status?.status === "active") throw new SbError(409, "release_artifacts_create_conflict", `${platform}/${arch} already exists on this release`);

  const r2Key = `shorebird/${app.id}/releases/${r.id}/${platform}/${arch}/${randomUrlToken()}`;
  const fields = [f.hash!.toLowerCase(), size, (f.filename ?? "").slice(0, 200) || null, f.can_sideload === "true" ? 1 : 0, f.podfile_lock_hash ?? null, f.signing ?? null, r2Key];
  let id: number;
  if (existing) {
    // A draft release being re-run: overwrite the old registration and hand out a fresh upload URL.
    await c.env.DB.prepare(
      "UPDATE sb_release_artifacts SET hash = ?, size = ?, filename = ?, can_sideload = ?, podfile_lock_hash = ?, signing = ?, r2_key = ?, state = 'pending' WHERE id = ?",
    )
      .bind(...fields, existing.id)
      .run();
    id = existing.id;
  } else {
    const res = await c.env.DB.prepare(
      `INSERT INTO sb_release_artifacts (release_id, platform, arch, hash, size, filename, can_sideload, podfile_lock_hash, signing, r2_key, download_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
      .bind(r.id, platform, arch, ...fields, randomUrlToken())
      .first<{ id: number }>();
    id = res!.id;
  }
  const url = await newUploadSession(c.env, "release", id, r2Key, size);
  return c.json({ id, release_id: r.id, arch, platform, hash: f.hash!.toLowerCase(), size, url, upload_method: "resumable" }, 201);
});

// ------------------------------------------------------------------ patches

shorebirdCli.post("/apps/:appId/patches", async (c) => {
  const app = await flutterApp(c, "publisher");
  const body = await sbJson<{ release_id?: number; metadata?: unknown; notes?: string }>(c);
  const r = await loadRelease(c.env, app.id, Number(body.release_id));
  const meta = body.metadata === undefined ? null : JSON.stringify(body.metadata).slice(0, 100_000);
  // number = max + 1, guarded by UNIQUE(release_id, number); retry once on a race.
  for (let attempt = 0; attempt < 3; attempt++) {
    const max = await c.env.DB.prepare("SELECT COALESCE(MAX(number), 0) AS n FROM sb_patches WHERE release_id = ?").bind(r.id).first<{ n: number }>();
    const number = (max?.n ?? 0) + 1;
    try {
      const ci = c.get("principal").ci;
      const row = await c.env.DB.prepare(
        "INSERT INTO sb_patches (release_id, number, metadata, notes, created_by, created_by_token, git_sha, repository, ci_run_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      )
        .bind(r.id, number, meta, body.notes ?? null, who(c), c.get("principal").id, ci?.sha ?? null, ci?.repository ?? null, ci?.runUrl ?? null)
        .first<{ id: number }>();
      await audit(c.env, who(c), "flutter.patch.create", app.id, { version: r.version, number });
      return c.json({ id: row!.id, number }, 201);
    } catch (e) {
      if (attempt === 2) throw e;
    }
  }
  throw new SbError(500, "internal", "Could not allocate a patch number");
});

async function loadPatch(env: Env, appId: string, patchId: number) {
  const p = await env.DB.prepare(
    "SELECT p.id, p.number, p.release_id, r.version FROM sb_patches p JOIN sb_releases r ON r.id = p.release_id WHERE p.id = ? AND r.app_id = ?",
  )
    .bind(patchId, appId)
    .first<{ id: number; number: number; release_id: number; version: string }>();
  if (!p) throw new SbError(404, "not_found", `Patch ${patchId} not found`);
  return p;
}

shorebirdCli.post("/apps/:appId/patches/:patchId/artifacts", async (c) => {
  const app = await flutterApp(c, "publisher");
  const patch = await loadPatch(c.env, app.id, Number(c.req.param("patchId")));
  const f = await sbForm(c);
  const arch = f.arch ?? "";
  const platform = f.platform ?? "";
  const size = Number(f.size);
  const hash = (f.hash ?? "").toLowerCase();
  if (!ARCH_RE.test(arch) || !/^[a-z]{2,10}$/.test(platform)) throw new SbError(400, "bad_request", "arch and platform are required");
  if (!HEX64.test(hash)) throw new SbError(400, "bad_request", "hash must be sha256 hex");
  if (!Number.isInteger(size) || size <= 0 || size > MAX_ARTIFACT) throw new SbError(400, "bad_request", "invalid size");

  const s = await settings(c.env, app.id);
  const sig = f.hash_signature ?? null;
  if (s.requireSigning) {
    if (!sig) {
      throw new SbError(400, "patch_signature_required", "This Aeron app requires signed patches. Run shorebird patch with --private-key-path=keys/patch-private.pem --public-key-path=keys/patch-public.pem.");
    }
    if (s.publicKeyPem && !(await verifyRsaSha256(s.publicKeyPem, hash, sig))) {
      throw new SbError(400, "patch_signature_invalid", "hash_signature does not verify against the public key registered for this app (aeron flutter keys register).");
    }
  }
  const r2Key = `shorebird/${app.id}/patches/${patch.id}/${platform}/${arch}/${randomUrlToken()}`;
  const existing = await c.env.DB.prepare("SELECT id FROM sb_patch_artifacts WHERE patch_id = ? AND platform = ? AND arch = ?").bind(patch.id, platform, arch).first<{ id: number }>();
  let id: number;
  if (existing) {
    await c.env.DB.prepare("UPDATE sb_patch_artifacts SET hash = ?, size = ?, hash_signature = ?, podfile_lock_hash = ?, r2_key = ?, state = 'pending' WHERE id = ?")
      .bind(hash, size, sig, f.podfile_lock_hash ?? null, r2Key, existing.id)
      .run();
    id = existing.id;
  } else {
    const row = await c.env.DB.prepare(
      `INSERT INTO sb_patch_artifacts (patch_id, platform, arch, hash, size, hash_signature, podfile_lock_hash, r2_key, download_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
      .bind(patch.id, platform, arch, hash, size, sig, f.podfile_lock_hash ?? null, r2Key, randomUrlToken())
      .first<{ id: number }>();
    id = row!.id;
  }
  const url = await newUploadSession(c.env, "patch", id, r2Key, size);
  return c.json({ id, patch_id: patch.id, arch, platform, hash, size, url, upload_method: "resumable" }, 201);
});

// ------------------------------------------------------------------ channels & promotion

shorebirdCli.get("/apps/:appId/channels", async (c) => {
  const app = await flutterApp(c);
  const rows = await c.env.DB.prepare("SELECT id, app_id, name FROM sb_channels WHERE app_id = ? ORDER BY id").bind(app.id).all();
  return c.json(rows.results ?? []);
});

shorebirdCli.post("/apps/:appId/channels", async (c) => {
  const app = await flutterApp(c, "publisher");
  const body = await sbJson<{ channel?: string }>(c);
  const name = (body.channel ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(name)) throw new SbError(400, "bad_request", "invalid channel name");
  await c.env.DB.prepare("INSERT OR IGNORE INTO sb_channels (app_id, name) VALUES (?, ?)").bind(app.id, name).run();
  const row = await c.env.DB.prepare("SELECT id, app_id, name FROM sb_channels WHERE app_id = ? AND name = ?").bind(app.id, name).first();
  return c.json(row, 201);
});

export async function invalidateRelease(env: Env, appId: string, releaseId: number) {
  const rows = await env.DB.prepare("SELECT c.name, r.version FROM sb_channels c, sb_releases r WHERE c.app_id = ? AND r.id = ?").bind(appId, releaseId).all<{ name: string; version: string }>();
  await Promise.all((rows.results ?? []).map((x) => invalidate(sbCheckCacheKey(appId, x.name, x.version))));
}

shorebirdCli.post("/apps/:appId/patches/promote", async (c) => {
  const app = await flutterApp(c, "publisher");
  const body = await sbJson<{ patch_id?: number; channel_id?: number; rollout_percentage?: number; rollout_steps?: unknown }>(c);
  if (body.rollout_steps) throw new SbError(400, "rollout_schedules_unsupported", "Scheduled rollouts are not supported; promote with a percentage and raise it in the Aeron console.");
  const patch = await loadPatch(c.env, app.id, Number(body.patch_id));
  const ch = await c.env.DB.prepare("SELECT id, name FROM sb_channels WHERE id = ? AND app_id = ?").bind(Number(body.channel_id), app.id).first<{ id: number; name: string }>();
  if (!ch) throw new SbError(404, "not_found", "Channel not found");
  const pending = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM sb_patch_artifacts WHERE patch_id = ? AND state != 'uploaded'").bind(patch.id).first<{ n: number }>();
  if (pending && pending.n > 0) throw new SbError(409, "patch_artifacts_incomplete", "Patch artifacts are not fully uploaded");
  const pct = body.rollout_percentage ?? 100;
  if (!(pct > 0 && pct <= 100)) throw new SbError(400, "bad_request", "rollout_percentage must be between 0.01 and 100");
  const bp = Math.round(pct * 100);
  const principal = c.get("principal");
  const existing = await c.env.DB.prepare("SELECT status FROM sb_channel_patches WHERE channel_id = ? AND patch_id = ?").bind(ch.id, patch.id).first<{ status: string }>();
  const policy = await appPolicy(c.env, app.id);
  if (existing?.status === "live") {
    // Already approved code: only the percentage changes.
    await c.env.DB.prepare("UPDATE sb_channel_patches SET rollout_bp = ?, is_rolled_back = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE channel_id = ? AND patch_id = ?")
      .bind(bp, ch.id, patch.id)
      .run();
  } else {
    const status = policy.requireApproval ? "pending" : "live";
    await c.env.DB.prepare(
      `INSERT INTO sb_channel_patches (channel_id, patch_id, rollout_bp, is_rolled_back, promoted_by, status, requested_bp, requested_by_token) VALUES (?, ?, ?, 0, ?, ?, ?, ?)
       ON CONFLICT (channel_id, patch_id) DO UPDATE SET rollout_bp = excluded.rollout_bp, is_rolled_back = 0, status = excluded.status,
         requested_bp = excluded.requested_bp, requested_by_token = excluded.requested_by_token, promoted_by = excluded.promoted_by,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
      .bind(ch.id, patch.id, status === "live" ? bp : 0, who(c), status, bp, principal.id)
      .run();
    const label = `${app.id} ${patch.version} patch #${patch.number} → ${ch.name}`;
    notify(
      c.env,
      c.executionCtx,
      status === "pending"
        ? `🕓 Patch waiting for approval: ${label} (${pct}%). Submitted by ${principal.name}${principal.ci?.sha ? ` @ ${principal.ci.sha.slice(0, 7)}` : ""}.`
        : `🚀 Patch live (approvals are off for this app): ${label} at ${pct}%, by ${principal.name}`,
    );
  }
  await invalidate(sbCheckCacheKey(app.id, ch.name, patch.version));
  await audit(c.env, who(c), policy.requireApproval && existing?.status !== "live" ? "flutter.patch.submit" : "flutter.patch.promote", app.id, { version: patch.version, number: patch.number, channel: ch.name, percent: pct });
  return c.body(null, 204);
});

shorebirdCli.get("/apps/:appId/releases/:releaseId/patches", async (c) => {
  const app = await flutterApp(c);
  const r = await loadRelease(c.env, app.id, Number(c.req.param("releaseId")));
  const patches = await c.env.DB.prepare("SELECT id, number, notes, created_at FROM sb_patches WHERE release_id = ? ORDER BY number").bind(r.id).all<{ id: number; number: number; notes: string | null; created_at: string }>();
  const arts = await c.env.DB.prepare(
    "SELECT a.id, a.patch_id, a.arch, a.platform, a.hash, a.size, a.created_at FROM sb_patch_artifacts a JOIN sb_patches p ON p.id = a.patch_id WHERE p.release_id = ?",
  )
    .bind(r.id)
    .all<{ patch_id: number }>();
  const chans = await c.env.DB.prepare(
    "SELECT cp.patch_id, c.name, cp.rollout_bp, cp.is_rolled_back FROM sb_channel_patches cp JOIN sb_channels c ON c.id = cp.channel_id JOIN sb_patches p ON p.id = cp.patch_id WHERE p.release_id = ? AND cp.status = 'live'",
  )
    .bind(r.id)
    .all<{ patch_id: number; name: string; rollout_bp: number; is_rolled_back: number }>();
  return c.json({
    patches: (patches.results ?? []).map((p) => {
      const cs = (chans.results ?? []).filter((x) => x.patch_id === p.id);
      return {
        id: p.id,
        number: p.number,
        artifacts: (arts.results ?? []).filter((a) => a.patch_id === p.id),
        is_rolled_back: cs.length > 0 && cs.every((x) => x.is_rolled_back),
        ...(cs[0] ? { channel: cs[0].name, rollout_percentage: cs[0].rollout_bp / 100 } : {}),
        created_at: p.created_at,
        ...(p.notes ? { notes: p.notes } : {}),
      };
    }),
  });
});

async function setRolledBack(c: Context<AppEnv>, value: 0 | 1) {
  const app = await flutterApp(c, "publisher");
  const patch = await loadPatch(c.env, app.id, Number(c.req.param("patchId")));
  const res = await c.env.DB.prepare(
    "UPDATE sb_channel_patches SET is_rolled_back = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE patch_id = ? AND is_rolled_back != ? AND status = 'live'",
  )
    .bind(value, patch.id, value)
    .run();
  await invalidateRelease(c.env, app.id, patch.release_id);
  if (!res.meta.changes) return c.body(null, 304);
  await audit(c.env, who(c), value ? "flutter.patch.rollback" : "flutter.patch.rollforward", app.id, { version: patch.version, number: patch.number });
  notify(c.env, c.executionCtx, `${value ? "⏪ ROLLBACK" : "↩️ rollforward"}: ${app.id} ${patch.version} patch #${patch.number}, by ${c.get("principal").name}`);
  return c.body(null, 204);
}

shorebirdCli.post("/apps/:appId/releases/:releaseId/patches/:patchId/rollback", (c) => setRolledBack(c, 1));
shorebirdCli.post("/apps/:appId/releases/:releaseId/patches/:patchId/rollforward", (c) => setRolledBack(c, 0));

shorebirdCli.put("/apps/:appId/releases/:releaseId/patches/:patchId/rollout", async (c) => {
  const app = await flutterApp(c, "publisher");
  const patch = await loadPatch(c.env, app.id, Number(c.req.param("patchId")));
  const body = await sbJson<{ rollout_percentage?: number }>(c);
  const pct = Number(body.rollout_percentage);
  if (!(pct >= 0 && pct <= 100)) throw new SbError(400, "bad_request", "rollout_percentage must be 0-100");
  await c.env.DB.prepare("UPDATE sb_channel_patches SET rollout_bp = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE patch_id = ? AND status = 'live'")
    .bind(Math.round(pct * 100), patch.id)
    .run();
  await invalidateRelease(c.env, app.id, patch.release_id);
  await audit(c.env, who(c), "flutter.patch.rollout", app.id, { version: patch.version, number: patch.number, percent: pct });
  return c.body(null, 204);
});

shorebirdCli.all("*", () => {
  throw new SbError(404, "not_found", "This Shorebird endpoint is not supported by Aeron");
});
