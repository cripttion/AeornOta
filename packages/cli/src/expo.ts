import { createPrivateKey, createPublicKey, randomUUID, sign as cryptoSign, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Api } from "./api.js";
import { rnProjectFixes } from "./rn-fixes.js";
import {
  CliError,
  bool,
  flag,
  log,
  md5Hex,
  mimeFor,
  readText,
  requireFlag,
  run,
  sha256B64Url,
  sha256Hex,
  table,
  type Args,
} from "./util.js";

type Platform = "ios" | "android";

// ------------------------------------------------------------------ keys & signing

export async function loadPrivateKey(args: Args): Promise<KeyObject> {
  const passphrase = process.env.AERON_KEY_PASSPHRASE;
  const inline = process.env.AERON_EXPO_PRIVATE_KEY;
  const path = flag(args, "key") ?? process.env.AERON_EXPO_PRIVATE_KEY_PATH;
  let pem: string;
  if (path) pem = await readText(resolve(path));
  else if (inline) pem = inline;
  else throw new CliError("Missing signing key: pass --key path/to/private-key.pem or set AERON_EXPO_PRIVATE_KEY(_PATH)");
  try {
    const key = createPrivateKey({ key: pem, format: "pem", passphrase });
    if (key.asymmetricKeyType !== "rsa") throw new CliError("Expo code signing needs an RSA key (rsa-v1_5-sha256)");
    return key;
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError(`Cannot load private key: ${(e as Error).message}. Encrypted keys need AERON_KEY_PASSPHRASE.`);
  }
}

export function signRsa(data: string, key: KeyObject): string {
  return cryptoSign("sha256", Buffer.from(data, "utf8"), key).toString("base64");
}

async function keysCommand(api: Api, args: Args) {
  const sub = args._[2];
  const appId = requireFlag(args, "app");
  if (sub === "generate") {
    const project = resolve(flag(args, "project", ".")!);
    const keysDir = flag(args, "key-dir", "keys")!;
    const certDir = flag(args, "cert-dir", "certs")!;
    await run(
      "npx",
      [
        "--no-install",
        "expo-updates",
        "codesigning:generate",
        "--key-output-directory",
        keysDir,
        "--certificate-output-directory",
        certDir,
        "--certificate-validity-duration-years",
        flag(args, "years", "10")!,
        "--certificate-common-name",
        `Aeron ${appId}`,
      ],
      { cwd: project },
    );
    log(`Created ${join(project, keysDir, "private-key.pem")} (keep secret, never commit)`);
    log(`Created ${join(project, certDir, "certificate.pem")} (commit this; it is compiled into the app)`);
    log(`Next: aeron expo keys register --app ${appId} --key ${join(keysDir, "private-key.pem")}`);
    return;
  }
  if (sub === "register") {
    const key = await loadPrivateKey(args);
    const keyId = flag(args, "key-id", "main")!;
    const publicKeyPem = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
    const certPath = flag(args, "certificate");
    if (certPath) {
      const certKey = createPublicKey(await readText(resolve(certPath))).export({ type: "spki", format: "pem" }).toString();
      if (certKey !== publicKeyPem) throw new CliError(`${certPath} does not match the private key`);
    }
    const noUpdateDirective = JSON.stringify({ type: "noUpdateAvailable" });
    await api.request("POST", `/api/admin/expo/apps/${appId}/keys`, {
      keyId,
      publicKeyPem,
      noUpdateDirective,
      noUpdateSignature: signRsa(noUpdateDirective, key),
    });
    log(`Registered signing key "${keyId}" for ${appId}. The private key stayed on this machine.`);
    return;
  }
  if (sub === "list") {
    const r = await api.request("GET", `/api/admin/expo/apps/${appId}/keys`);
    table(r.keys.map((k: any) => ({ key_id: k.key_id, created_at: k.created_at, retired_at: k.retired_at ?? "" })));
    return;
  }
  throw new CliError("Usage: aeron expo keys generate|register|list --app <id>");
}

// ------------------------------------------------------------------ runtime version

function nativeRuntimeVersion(project: string, platform: Platform): string | null {
  if (platform === "android") {
    const p = join(project, "android/app/src/main/res/values/strings.xml");
    if (existsSync(p)) {
      const m = /name="expo_runtime_version"[^>]*>([^<]+)</.exec(require_text(p));
      if (m) return m[1]!.trim();
    }
  } else {
    const iosDir = join(project, "ios");
    if (existsSync(iosDir)) {
      for (const d of readdirSync(iosDir)) {
        const p = join(iosDir, d, "Supporting", "Expo.plist");
        if (existsSync(p)) {
          const m = /<key>EXUpdatesRuntimeVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(require_text(p));
          if (m) return m[1]!.trim();
        }
      }
    }
  }
  return null;
}

function require_text(p: string): string {
  return readFileSync(p, "utf8"); // small native config files
}

export async function resolveRuntimeVersion(project: string, platform: Platform, override?: string): Promise<string> {
  if (override) return override;
  try {
    const out = await run("npx", ["--no-install", "expo-updates", "runtimeversion:resolve", "--platform", platform], { cwd: project, quiet: true });
    const line = out.trim().split("\n").pop() ?? "";
    const parsed = JSON.parse(line) as { runtimeVersion?: string | null };
    if (parsed.runtimeVersion) return parsed.runtimeVersion;
  } catch {
    /* fall back to native files below */
  }
  const native = nativeRuntimeVersion(project, platform);
  if (native) return native;
  throw new CliError(
    `Could not resolve the ${platform} runtime version. Pass --runtime-version, or set "runtimeVersion" in app config (use {"policy":"fingerprint"} for managed apps).`,
  );
}

async function runtimeCommand(api: Api, args: Args) {
  const sub = args._[2];
  const appId = requireFlag(args, "app");
  if (sub === "register") {
    const project = resolve(flag(args, "project", ".")!);
    const platforms = platformsFrom(args);
    for (const p of platforms) {
      const rt = await resolveRuntimeVersion(project, p, flag(args, "runtime-version"));
      await api.request("POST", `/api/admin/expo/apps/${appId}/runtimes`, { platform: p, runtimeVersion: rt, note: flag(args, "note") });
      log(`Registered ${p} runtime ${rt} for ${appId}`);
    }
    return;
  }
  if (sub === "list") {
    const r = await api.request("GET", `/api/admin/expo/apps/${appId}/runtimes`);
    table(r.runtimes);
    return;
  }
  throw new CliError("Usage: aeron expo runtime register|list --app <id> [--platform ios|android|all]");
}

function platformsFrom(args: Args): Platform[] {
  const p = flag(args, "platform", "all")!;
  if (p === "all") return ["ios", "android"];
  if (p === "ios" || p === "android") return [p];
  throw new CliError("--platform must be ios, android or all");
}

// ------------------------------------------------------------------ publish

interface ExportMetadata {
  fileMetadata: Record<string, { bundle: string; assets: Array<{ path: string; ext: string }> }>;
}

interface FileEntry {
  path: string;
  bytes: Buffer;
  hex: string;
  b64url: string;
  md5: string;
  ext: string;
  contentType: string;
}

async function loadFile(path: string, ext: string, contentType: string): Promise<FileEntry> {
  const bytes = await readFile(path);
  return { path, bytes, hex: sha256Hex(bytes), b64url: sha256B64Url(bytes), md5: md5Hex(bytes), ext, contentType };
}

async function uploadMissing(api: Api, files: FileEntry[]) {
  const unique = [...new Map(files.map((f) => [f.hex, f])).values()];
  const { missing } = await api.request<{ missing: string[] }>("POST", "/api/admin/files/missing", { hashes: unique.map((f) => f.hex) });
  const todo = unique.filter((f) => missing.includes(f.hex));
  let done = 0;
  const workers = Array.from({ length: Math.min(6, todo.length) }, async () => {
    while (todo.length) {
      const f = todo.shift()!;
      await api.request("PUT", `/api/admin/files/${f.hex}`, f.bytes, { "content-type": f.contentType });
      done++;
    }
  });
  await Promise.all(workers);
  return { uploaded: done, reused: unique.length - done, bytes: unique.filter((f) => missing.includes(f.hex)).reduce((s, f) => s + f.bytes.length, 0) };
}

function buildManifest(opts: {
  runtimeVersion: string;
  launch: FileEntry;
  assets: FileEntry[];
  filesBase: string;
  expoClient: unknown;
  aeron: Record<string, unknown>;
}) {
  const asset = (f: FileEntry, isLaunch: boolean) => ({
    hash: f.b64url,
    key: f.md5,
    contentType: isLaunch ? "application/javascript" : f.contentType,
    fileExtension: isLaunch ? ".bundle" : `.${f.ext}`,
    url: `${opts.filesBase}/${f.hex}`,
  });
  const createdAt = new Date().toISOString();
  return {
    createdAt,
    manifest: {
      id: randomUUID(),
      createdAt,
      runtimeVersion: opts.runtimeVersion,
      launchAsset: asset(opts.launch, true),
      assets: opts.assets.map((a) => asset(a, false)),
      metadata: {},
      extra: { expoClient: opts.expoClient, aeron: opts.aeron },
    },
  };
}

function undoFor(createdAt: string): string {
  return JSON.stringify({ type: "rollBackToEmbedded", parameters: { commitTime: new Date(Date.parse(createdAt) + 1).toISOString() } });
}

async function publishSigned(
  api: Api,
  appId: string,
  key: KeyObject,
  keyId: string,
  p: { channel: string; platform: Platform; runtimeVersion: string; manifest: object; createdAt: string; message?: string; gitSha?: string; critical: boolean; rollout: number; totalBytes?: number; repository?: string; ciRunUrl?: string },
) {
  const manifestStr = JSON.stringify(p.manifest);
  const undo = undoFor(p.createdAt);
  return api.request("POST", `/api/admin/expo/apps/${appId}/updates`, {
    channel: p.channel,
    platform: p.platform,
    runtimeVersion: p.runtimeVersion,
    manifest: manifestStr,
    signature: signRsa(manifestStr, key),
    keyId,
    undoDirective: undo,
    undoSignature: signRsa(undo, key),
    message: p.message,
    gitSha: p.gitSha,
    critical: p.critical,
    rolloutPercent: p.rollout,
    totalBytes: p.totalBytes,
    repository: p.repository,
    ciRunUrl: p.ciRunUrl,
  });
}

async function publishCommand(api: Api, args: Args) {
  const appId = requireFlag(args, "app");
  const project = resolve(flag(args, "project", ".")!);
  const channel = flag(args, "channel", "production")!;
  const platforms = platformsFrom(args);
  const rollout = Number(flag(args, "rollout", "100"));
  if (!Number.isFinite(rollout) || rollout < 0 || rollout > 100) throw new CliError("--rollout must be 0-100");
  const keyId = flag(args, "key-id", "main")!;
  const message = flag(args, "message");
  const critical = bool(args, "critical");
  const key = await loadPrivateKey(args);

  const { filesBaseUrl } = await api.request<{ filesBaseUrl: string }>("GET", "/api/admin/config");
  const gitSha = process.env.GITHUB_SHA || (await run("git", ["rev-parse", "HEAD"], { cwd: project, quiet: true }).catch(() => "")).trim() || undefined;
  const repository = process.env.GITHUB_REPOSITORY || undefined;
  const ciRunUrl = process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY ? `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined;

  let dist = flag(args, "dist");
  let tmp: string | null = null;
  if (!dist) {
    tmp = await mkdtemp(join(tmpdir(), "aeron-export-"));
    dist = tmp;
    log(`Exporting ${platforms.join(" + ")} bundle with expo export...`);
    await run("npx", ["--no-install", "expo", "export", "--output-dir", dist, ...platforms.flatMap((p) => ["--platform", p])], { cwd: project });
  }
  try {
    const metadata = JSON.parse(await readText(join(dist, "metadata.json"))) as ExportMetadata;
    // `aeron expo export` writes config + runtime versions next to the bundle, so the signing step
    // never has to run project code (app.config.js, Metro plugins) while the key is in the environment.
    const prebuilt = existsSync(join(dist, "aeron-export.json")) ? (JSON.parse(readFileSync(join(dist, "aeron-export.json"), "utf8")) as { expoConfig: unknown; runtimeVersions: Record<string, string> }) : null;
    const expoClient = prebuilt ? prebuilt.expoConfig : await publicExpoConfig(project);
    const results: Array<Record<string, unknown>> = [];
    let approvalUrl: string | undefined;
    const { rollouts } = await api.request<{ rollouts: Array<Record<string, any>> }>("GET", `/api/admin/expo/apps/${appId}/rollouts`);
    const patchDir = await mkdtemp(join(tmpdir(), "aeron-patch-"));
    for (const platform of platforms) {
      const meta = metadata.fileMetadata[platform];
      if (!meta) throw new CliError(`metadata.json has no ${platform} output`);
      const runtimeVersion = flag(args, "runtime-version") ?? prebuilt?.runtimeVersions[platform] ?? (await resolveRuntimeVersion(project, platform));
      const pointer = rollouts.find((r) => r.channel === channel && r.platform === platform && r.runtime_version === runtimeVersion);
      const baseIds = [...new Set([pointer?.current_update_id, pointer?.stable_update_id].filter(Boolean) as string[])];
      const launch = await loadFile(join(dist, meta.bundle), "bundle", "application/javascript");
      const assets = await Promise.all(meta.assets.map((a) => loadFile(join(dist!, a.path), a.ext, mimeFor(a.ext))));
      const up = await uploadMissing(api, [launch, ...assets]);
      const { manifest, createdAt } = buildManifest({
        runtimeVersion,
        launch,
        assets,
        filesBase: filesBaseUrl,
        expoClient,
        aeron: { message: message ?? null, gitSha: gitSha ?? null, critical },
      });
      const totalBytes = launch.bytes.length + assets.reduce((s, a) => s + a.bytes.length, 0);
      const res = await publishSigned(api, appId, key, keyId, { channel, platform, runtimeVersion, manifest, createdAt, message, gitSha, critical, rollout, totalBytes, repository, ciRunUrl });
      if (res.status === "pending") approvalUrl = res.approvalUrl;
      const patches = bool(args, "no-patches") ? [] : await publishPatches(api, appId, baseIds, { id: res.id, launch }, patchDir);
      results.push({
        platform,
        runtime: runtimeVersion,
        update: res.id,
        status: res.status ?? "live",
        rollout: `${rollout}%`,
        bundle: `${(launch.bytes.length / 1024).toFixed(0)} KB`,
        patches: patches.join(" ") || "none",
        uploaded: `${up.uploaded} files (${(up.bytes / 1024).toFixed(0)} KB)`,
        reused: up.reused,
      });
    }
    await rm(patchDir, { recursive: true, force: true });
    table(results);
    if (approvalUrl) {
      log(`\nSubmitted to ${appId}/${channel}. Nothing reaches phones until a second admin approves it:\n  ${approvalUrl}`);
    } else {
      log(`Published to ${appId}/${channel}. Devices pick it up on their next update check.`);
    }
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
}

let bsdiffAvailable: boolean | null = null;
async function hasBsdiff(): Promise<boolean> {
  if (bsdiffAvailable === null) {
    bsdiffAvailable = await run("bsdiff", [], { quiet: true }).then(
      () => true,
      (e: Error) => /usage/i.test(e.message),
    );
  }
  return bsdiffAvailable;
}

/**
 * Build BSDIFF40 patches from the bundles devices are most likely running (current + stable on this
 * pointer) to the new bundle, so expo-updates (SDK 55+) downloads a small diff instead of the full file.
 */
async function publishPatches(api: Api, appId: string, baseIds: string[], target: { id: string; launch: FileEntry }, workDir: string) {
  if (!baseIds.length) return [];
  if (!(await hasBsdiff())) {
    log("  (install bsdiff to ship smaller downloads: brew install bsdiff / apt-get install bsdiff)");
    return [];
  }
  const out: string[] = [];
  const newPath = join(workDir, `${target.launch.hex}.new`);
  await writeFile(newPath, target.launch.bytes);
  for (const baseId of baseIds) {
    try {
      const { update } = await api.request("GET", `/api/admin/expo/updates/${baseId}`);
      const baseUrl = JSON.parse(update.manifest).launchAsset.url as string;
      const res = await fetch(baseUrl);
      if (!res.ok) continue;
      const baseBytes = Buffer.from(await res.arrayBuffer());
      if (sha256Hex(baseBytes) === target.launch.hex) continue; // identical bundle
      const basePath = join(workDir, `${baseId}.base`);
      const patchPath = join(workDir, `${baseId}.patch`);
      await writeFile(basePath, baseBytes);
      await run("bsdiff", [basePath, newPath, patchPath], { quiet: true });
      const patch = await readFile(patchPath);
      if (patch.length > target.launch.bytes.length * 0.7) continue; // not worth it
      const entry: FileEntry = { path: patchPath, bytes: patch, hex: sha256Hex(patch), b64url: sha256B64Url(patch), md5: md5Hex(patch), ext: "patch", contentType: "application/octet-stream" };
      await uploadMissing(api, [entry]);
      await api.request("POST", `/api/admin/expo/apps/${appId}/patches`, { baseUpdateId: baseId, targetUpdateId: target.id, patchHex: entry.hex });
      out.push(`${baseId.slice(0, 8)}→${(patch.length / 1024).toFixed(0)} KB`);
    } catch (e) {
      log(`  (patch from ${baseId.slice(0, 8)} skipped: ${(e as Error).message.split("\n")[0]})`);
    }
  }
  return out;
}

/** Re-sign an existing update with a fresh id and timestamp, optionally into another channel (promote staging -> production, or roll back to a previous bundle). */
async function republishCommand(api: Api, args: Args) {
  const appId = requireFlag(args, "app");
  const fromId = requireFlag(args, "update", "update id to republish");
  const key = await loadPrivateKey(args);
  const keyId = flag(args, "key-id", "main")!;
  const { update } = await api.request("GET", `/api/admin/expo/updates/${fromId}`);
  if (update.app_id !== appId) throw new CliError(`Update ${fromId} belongs to ${update.app_id}`);
  const old = JSON.parse(update.manifest);
  const createdAt = new Date().toISOString();
  const manifest = { ...old, id: randomUUID(), createdAt, extra: { ...old.extra, aeron: { ...(old.extra?.aeron ?? {}), republishedFrom: fromId } } };
  const channel = flag(args, "channel", update.channel)!;
  const rollout = Number(flag(args, "rollout", "100"));
  const res = await publishSigned(api, appId, key, keyId, {
    channel,
    platform: update.platform,
    runtimeVersion: update.runtime_version,
    manifest,
    createdAt,
    message: flag(args, "message", `republish of ${fromId}`),
    gitSha: update.git_sha ?? undefined,
    critical: bool(args, "critical"),
    rollout,
  });
  log(`Republished ${fromId} as ${res.id} on ${appId}/${channel} (${update.platform}, runtime ${update.runtime_version}) at ${rollout}%.`);
  if (res.status === "pending") log(`Waiting for approval: ${res.approvalUrl}`);
}

async function rolloutCommand(api: Api, args: Args) {
  const appId = requireFlag(args, "app");
  const channel = flag(args, "channel", "production")!;
  const platforms = platformsFrom(args);
  const runtimeVersion = requireFlag(args, "runtime-version");
  let action: string;
  let percent: number | undefined;
  if (bool(args, "halt")) action = "halt";
  else if (bool(args, "undo")) action = "undo";
  else if (bool(args, "cancel-undo")) action = "cancel_undo";
  else if (flag(args, "percent") !== undefined) {
    action = "set_percent";
    percent = Number(flag(args, "percent"));
  } else throw new CliError("Pass one of --percent N, --halt, --undo, --cancel-undo");
  for (const platform of platforms) {
    const r = await api.request("POST", `/api/admin/expo/apps/${appId}/rollouts/action`, { channel, platform, runtimeVersion, action, percent });
    log(`${appId}/${channel}/${platform}/${runtimeVersion}: rollout ${r.percent}%${r.undoActive ? ", undo active" : ""}`);
  }
}

async function statusCommand(api: Api, args: Args) {
  const appId = requireFlag(args, "app");
  const r = await api.request("GET", `/api/admin/expo/apps/${appId}/rollouts`);
  table(
    r.rollouts.map((x: any) => ({
      channel: x.channel,
      platform: x.platform,
      runtime: x.runtime_version,
      current: x.current_update_id,
      rollout: `${x.percent_bp / 100}%`,
      undo: x.undo_active ? "yes" : "",
      stable: x.stable_update_id ?? "",
      message: x.current_message ?? "",
    })),
  );
}

async function configureCommand(api: Api, args: Args) {
  const appId = requireFlag(args, "app");
  const channel = flag(args, "channel", "production")!;
  const keyId = flag(args, "key-id", "main")!;
  log("Add this to app.json → expo (then ship one store build):\n");
  log(
    JSON.stringify(
      {
        runtimeVersion: { policy: "fingerprint" },
        updates: {
          url: `${api.server}/expo/${appId}/manifest`,
          requestHeaders: { "expo-channel-name": channel },
          codeSigningCertificate: "./certs/certificate.pem",
          codeSigningMetadata: { keyid: keyId, alg: "rsa-v1_5-sha256" },
          checkAutomatically: "ON_LOAD",
          fallbackToCacheTimeout: 0,
        },
      },
      null,
      2,
    ),
  );
}

export async function expoCommand(api: Api, args: Args) {
  const sub = args._[1];
  switch (sub) {
    case "keys":
      return keysCommand(api, args);
    case "runtime":
      return runtimeCommand(api, args);
    case "publish":
      return publishCommand(api, args);
    case "export":
      return exportCommand(args);
    case "republish":
      return republishCommand(api, args);
    case "rollout":
      return rolloutCommand(api, args);
    case "status":
      return statusCommand(api, args);
    case "configure":
      return configureCommand(api, args);
    case "init":
      return initCommand(api, args);
    default:
      throw new CliError("Usage: aeron expo init|keys|runtime|publish|republish|rollout|status|configure ...  (aeron help)");
  }
}

// ------------------------------------------------------------------ project detection & init

export type RnKind = "expo-managed" | "expo-bare" | "rn-no-expo" | "not-rn";

export function detectRnProject(project: string): { kind: RnKind; hasUpdates: boolean; hasAndroid: boolean; hasIos: boolean; dynamicConfig: string | null } {
  const pkgPath = join(project, "package.json");
  if (!existsSync(pkgPath)) return { kind: "not-rn", hasUpdates: false, hasAndroid: false, hasIos: false, dynamicConfig: null };
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const hasAndroid = existsSync(join(project, "android"));
  const hasIos = existsSync(join(project, "ios"));
  const dynamicConfig = ["app.config.js", "app.config.ts", "app.config.mjs", "app.config.cjs"].find((f) => existsSync(join(project, f))) ?? null;
  if (!deps["react-native"] && !deps.expo) return { kind: "not-rn", hasUpdates: false, hasAndroid, hasIos, dynamicConfig };
  const hasUpdates = Boolean(deps["expo-updates"]);
  if (!deps.expo) return { kind: "rn-no-expo", hasUpdates, hasAndroid, hasIos, dynamicConfig };
  return { kind: hasAndroid || hasIos ? "expo-bare" : "expo-managed", hasUpdates, hasAndroid, hasIos, dynamicConfig };
}

async function publicExpoConfig(project: string): Promise<unknown> {
  try {
    return JSON.parse((await run("npx", ["--no-install", "expo", "config", "--type", "public", "--json"], { cwd: project, quiet: true })).trim());
  } catch {
    try {
      const j = JSON.parse(readFileSync(join(project, "app.json"), "utf8"));
      return j.expo ?? j;
    } catch {
      return {};
    }
  }
}

export function updatesConfig(server: string, appId: string, channel: string, keyId: string) {
  return {
    url: `${server}/expo/${appId}/manifest`,
    requestHeaders: { "expo-channel-name": channel },
    codeSigningCertificate: "./certs/certificate.pem",
    codeSigningMetadata: { keyid: keyId, alg: "rsa-v1_5-sha256" },
    checkAutomatically: "ON_LOAD",
    fallbackToCacheTimeout: 0,
  };
}

function ensureGitignore(project: string, lines: string[], write: boolean): string[] {
  const p = join(project, ".gitignore");
  const cur = existsSync(p) ? readFileSync(p, "utf8") : "";
  const missing = lines.filter((l) => !cur.split(/\r?\n/).includes(l));
  if (missing.length && write) writeFileSync(p, cur + (cur.endsWith("\n") || !cur ? "" : "\n") + "# Aeron signing keys (never commit)\n" + missing.join("\n") + "\n");
  return missing;
}

/**
 * One command to make an Expo or bare React Native project ready for Aeron.
 * Without --write it only prints what it would change.
 */
async function initCommand(api: Api, args: Args) {
  const appId = requireFlag(args, "app");
  const project = resolve(flag(args, "project", ".")!);
  const channel = flag(args, "channel", "production")!;
  const keyId = flag(args, "key-id", "main")!;
  const write = bool(args, "write");
  const d = detectRnProject(project);
  log(`Project: ${project}`);
  log(`Type:    ${{ "expo-managed": "Expo (managed, no native folders)", "expo-bare": "Expo / React Native with native folders (bare)", "rn-no-expo": "React Native without Expo modules", "not-rn": "not a React Native project" }[d.kind]}\n`);
  if (d.kind === "not-rn") throw new CliError("No package.json with react-native or expo here. Use --project <path>, or aeron flutter init for Flutter apps.");
  if (d.kind === "rn-no-expo") {
    log("Plain React Native apps need Expo modules for expo-updates. In the project folder, run:\n");
    log("  npx install-expo-modules@latest");
    log("  npx expo install expo-updates");
    log("  cd ios && pod install && cd ..        # macOS only, for iOS");
    log(`\nThen re-run: aeron expo init --app ${appId} --write`);
    log("It also fixes two things install-expo-modules leaves out: the @expo/cli path in android/app/build.gradle,");
    log("and import 'expo' in index.js (without it, images in OTA updates don't load).");
    return;
  }
  const steps: string[] = [];

  // expo-updates installed?
  if (!d.hasUpdates) {
    steps.push("install expo-updates (npx expo install expo-updates)");
    if (write) await run("npx", ["expo", "install", "expo-updates"], { cwd: project });
  }

  // App on the server
  let appExists = true;
  try {
    await api.request("GET", `/api/admin/apps/${appId}`);
  } catch {
    appExists = false;
  }
  if (!appExists) {
    steps.push(`create app "${appId}" on Aeron`);
    if (write) await api.request("POST", "/api/admin/apps", { id: appId, kind: "expo", name: flag(args, "name", appId) });
  }

  // Keys
  const keyPath = join(project, "keys", "private-key.pem");
  const certPath = join(project, "certs", "certificate.pem");
  if (!existsSync(keyPath) || !existsSync(certPath)) {
    steps.push("generate keys/private-key.pem (secret) and certs/certificate.pem (public)");
    if (write) {
      await run(
        "npx",
        ["--no-install", "expo-updates", "codesigning:generate", "--key-output-directory", "keys", "--certificate-output-directory", "certs", "--certificate-validity-duration-years", "10", "--certificate-common-name", `Aeron ${appId}`],
        { cwd: project },
      );
    }
  }
  const missingIgnore = ensureGitignore(project, ["keys/"], write);
  if (missingIgnore.length) steps.push(`add ${missingIgnore.join(", ")} to .gitignore`);

  // Register the public key
  let keys: Array<{ key_id: string; retired_at: string | null }> = [];
  try {
    keys = (await api.request("GET", `/api/admin/expo/apps/${appId}/keys`)).keys;
  } catch {
    /* app may not exist yet in dry runs */
  }
  if (!keys.some((k) => k.key_id === keyId && !k.retired_at)) {
    steps.push(`register signing key "${keyId}" (public half only)`);
    if (write && existsSync(keyPath)) {
      const key = await loadPrivateKey({ ...args, flags: { ...args.flags, key: keyPath } });
      const publicKeyPem = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
      const noUpdateDirective = JSON.stringify({ type: "noUpdateAvailable" });
      await api.request("POST", `/api/admin/expo/apps/${appId}/keys`, { keyId, publicKeyPem, noUpdateDirective, noUpdateSignature: signRsa(noUpdateDirective, key) });
    }
  }

  // App config
  const cfg = updatesConfig(api.server, appId, channel, keyId);
  if (d.dynamicConfig) {
    steps.push(`edit ${d.dynamicConfig} by hand (dynamic config can't be edited automatically) — see the snippet below`);
  } else {
    const appJsonPath = join(project, "app.json");
    const j = existsSync(appJsonPath) ? JSON.parse(readFileSync(appJsonPath, "utf8")) : {};
    const expo = (j.expo ??= {});
    // Plain React Native app.json has a top-level "name" (used by index.js). Keep it, and give the
    // Expo config its own name/slug so Expo tooling doesn't warn or guess.
    if (!expo.name && typeof j.name === "string") expo.name = String(j.displayName ?? j.name);
    if (!expo.slug && typeof j.name === "string") expo.slug = String(j.name).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    const before = JSON.stringify(expo.updates ?? {});
    expo.updates = { ...(expo.updates ?? {}), ...cfg };
    let rtNote = "";
    if (d.kind === "expo-managed") {
      if (JSON.stringify(expo.runtimeVersion) !== JSON.stringify({ policy: "fingerprint" })) {
        expo.runtimeVersion = { policy: "fingerprint" };
        rtNote = 'runtimeVersion → {"policy":"fingerprint"}';
      }
    } else if (typeof expo.runtimeVersion !== "string") {
      // Bare projects need a fixed string; bump it whenever native code changes.
      expo.runtimeVersion = String(expo.version ?? "1.0.0");
      rtNote = `runtimeVersion → "${expo.runtimeVersion}" (bare apps need a fixed value; bump it with every native change)`;
    }
    if (before !== JSON.stringify(expo.updates) || rtNote) {
      steps.push(`update app.json → expo.updates${rtNote ? ` and ${rtNote}` : ""}`);
      if (write) writeFileSync(appJsonPath, JSON.stringify(j, null, 2) + "\n");
    }
  }

  // Bare: copy config into AndroidManifest.xml / Expo.plist
  if (d.kind === "expo-bare" && !d.dynamicConfig) {
    for (const [platform, has] of [["android", d.hasAndroid], ["ios", d.hasIos]] as const) {
      if (!has) continue;
      steps.push(`sync the config into ${platform === "android" ? "android/ (AndroidManifest.xml, strings.xml)" : "ios/ (Expo.plist)"}`);
      if (write) await run("npx", ["--no-install", "expo-updates", "configuration:syncnative", "--platform", platform, "--workflow", "generic"], { cwd: project });
    }
  }

  // Leftovers from adding Expo modules to a React Native app: the Android build can't find @expo/cli,
  // and an entry file that never loads Expo leaves images and fonts in updates unresolved.
  for (const fix of rnProjectFixes(project)) {
    steps.push(fix.change);
    if (write) fix.apply();
  }

  if (!steps.length) log("Everything is already set up.");
  else {
    log(write ? "Done:" : "Would do (re-run with --write to apply):");
    for (const st of steps) log(`  • ${st}`);
  }
  if (d.dynamicConfig) log(`\nAdd to ${d.dynamicConfig} → expo:\n${JSON.stringify({ runtimeVersion: d.kind === "expo-managed" ? { policy: "fingerprint" } : "1.0.0", updates: cfg }, null, 2)}`);
  log(`\nNext:\n  1. Build and ship a store release with this config.\n  2. aeron expo runtime register --app ${appId} --platform all\n  3. aeron expo publish --app ${appId} --key keys/private-key.pem --message "…"`);
  log("  Keep keys/private-key.pem in your password manager and CI secrets. Commit certs/certificate.pem.");
}

/** Build the OTA bundle without any secrets: expo export + public config + runtime versions. */
export async function exportCommand(args: Args) {
  const project = resolve(flag(args, "project", ".")!);
  const out = resolve(requireFlag(args, "out", "output folder"));
  const platforms = platformsFrom(args);
  log(`Exporting ${platforms.join(" + ")} with expo export...`);
  await run("npx", ["--no-install", "expo", "export", "--output-dir", out, ...platforms.flatMap((p) => ["--platform", p])], { cwd: project });
  const runtimeVersions: Record<string, string> = {};
  for (const p of platforms) runtimeVersions[p] = await resolveRuntimeVersion(project, p, flag(args, "runtime-version"));
  const expoConfig = await publicExpoConfig(project);
  writeFileSync(join(out, "aeron-export.json"), JSON.stringify({ expoConfig, runtimeVersions, exportedAt: new Date().toISOString() }, null, 2));
  log(`Wrote ${out} (runtime ${Object.entries(runtimeVersions).map(([k, v]) => `${k} ${v}`).join(", ")}). Publish it with: aeron expo publish --app <id> --dist ${out}`);
}
