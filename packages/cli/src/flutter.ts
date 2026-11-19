import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Api } from "./api.js";
import { CliError, bool, flag, isWindows, log, readText, requireFlag, run, runInteractive, table, type Args } from "./util.js";

/**
 * Flutter apps use the stock `shorebird` CLI against Aeron. `aeron flutter release/patch` wrap it so
 * nobody has to remember environment variables, key flags or tokens.
 */
export async function flutterCommand(api: Api, args: Args) {
  const sub = args._[1];
  switch (sub) {
    case "init":
      return init(api, args);
    case "release":
      return release(api, args);
    case "patch":
      return patch(api, args);
    case "keys":
      return keys(api, args);
    case "configure":
      return configure(api, args);
    case "env":
      return env(api);
    case "status":
      return status(api, args);
    case "rollout":
      return rollout(api, args);
    case "signing":
      return signing(api, args);
    default:
      throw new CliError("Usage: aeron flutter init|release|patch|status|rollout|keys|configure|env|signing ...  (aeron help)");
  }
}

// ------------------------------------------------------------------ helpers

export function findShorebird(): string {
  if (process.env.SHOREBIRD_BIN && existsSync(process.env.SHOREBIRD_BIN)) return process.env.SHOREBIRD_BIN;
  const exe = isWindows ? "shorebird.bat" : "shorebird";
  for (const dir of (process.env.PATH ?? "").split(isWindows ? ";" : ":")) {
    if (dir && existsSync(join(dir, exe))) return join(dir, exe);
  }
  const home = join(homedir(), ".shorebird", "bin", exe);
  if (existsSync(home)) return home;
  throw new CliError("shorebird CLI not found. Install it (see docs: Install on Mac/Windows) or set SHOREBIRD_BIN to its path.");
}

interface ShorebirdYaml {
  app_id?: string;
  base_url?: string;
  auto_update?: string;
  [k: string]: string | undefined;
}

export function readShorebirdYaml(project: string): ShorebirdYaml | null {
  const p = join(project, "shorebird.yaml");
  if (!existsSync(p)) return null;
  const out: ShorebirdYaml = {};
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^([a-z_]+):\s*(.*?)\s*$/.exec(line);
    if (m && !line.startsWith(" ")) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

function pubspecHasShorebirdAsset(project: string): boolean {
  const p = join(project, "pubspec.yaml");
  return existsSync(p) && /^\s+-\s+shorebird\.yaml\s*$/m.test(readFileSync(p, "utf8"));
}

function addShorebirdAsset(project: string) {
  const p = join(project, "pubspec.yaml");
  let s = readFileSync(p, "utf8");
  if (/^\s+-\s+shorebird\.yaml\s*$/m.test(s)) return;
  if (/^flutter:\s*$/m.test(s) && /^  assets:\s*$/m.test(s)) s = s.replace(/^(  assets:\s*\n)/m, `$1    - shorebird.yaml\n`);
  else if (/^flutter:\s*$/m.test(s)) s = s.replace(/^(flutter:\s*\n)/m, `$1  assets:\n    - shorebird.yaml\n`);
  else s += `\nflutter:\n  assets:\n    - shorebird.yaml\n`;
  writeFileSync(p, s);
}

const MANIFEST = ["android", "app", "src", "main", "AndroidManifest.xml"];

function hasInternetPermission(project: string): boolean | null {
  const p = join(project, ...MANIFEST);
  if (!existsSync(p)) return null;
  return /android\.permission\.INTERNET/.test(readFileSync(p, "utf8"));
}

function addInternetPermission(project: string) {
  const p = join(project, ...MANIFEST);
  const s = readFileSync(p, "utf8");
  if (/android\.permission\.INTERNET/.test(s)) return;
  writeFileSync(p, s.replace(/(<manifest[^>]*>)/, `$1\n    <uses-permission android:name="android.permission.INTERNET"/>`));
}

/** A SHOREBIRD_TOKEN for this run: env, a stored sb_api_ token, or a fresh 2-hour token minted with your admin token. */
async function shorebirdToken(api: Api, appId: string): Promise<{ token: string; cleanup: () => Promise<void> }> {
  if (process.env.SHOREBIRD_TOKEN?.startsWith("sb_api_")) return { token: process.env.SHOREBIRD_TOKEN, cleanup: async () => undefined };
  if (api.token.startsWith("sb_api_")) return { token: api.token, cleanup: async () => undefined };
  const t = await api
    .request("POST", "/api/admin/tokens", { name: `cli:${appId}`, role: "publisher", apps: [appId], format: "shorebird", expiresInMinutes: 120 })
    .catch((e: Error) => {
      throw new CliError(`Need a token the shorebird CLI accepts. Either log in with an admin token, or create one: aeron tokens create --name ${appId}-ci --role publisher --apps ${appId} --shorebird  (${e.message})`);
    });
  return { token: t.token, cleanup: async () => void (await api.request("DELETE", `/api/admin/tokens/${t.id}`).catch(() => undefined)) };
}

function keyPaths(args: Args, project: string) {
  return {
    pub: resolve(project, flag(args, "public-key", "keys/patch-public.pem")!),
    priv: resolve(project, flag(args, "private-key", process.env.AERON_FLUTTER_PRIVATE_KEY_PATH ?? "keys/patch-private.pem")!),
  };
}

function preflight(project: string, appId: string, server: string, platform: string) {
  const problems: string[] = [];
  const y = readShorebirdYaml(project);
  if (!y) problems.push("shorebird.yaml is missing (run: aeron flutter init --app " + appId + " --write)");
  else {
    if (y.app_id !== appId) problems.push(`shorebird.yaml app_id is "${y.app_id}", expected "${appId}"`);
    if ((y.base_url ?? "").replace(/\/$/, "") !== server) problems.push(`shorebird.yaml base_url must be ${server} (phones would otherwise talk to Shorebird's servers)`);
  }
  if (!pubspecHasShorebirdAsset(project)) problems.push("pubspec.yaml doesn't list shorebird.yaml under flutter: assets:");
  if (platform !== "ios" && hasInternetPermission(project) === false) problems.push("android/app/src/main/AndroidManifest.xml lacks the INTERNET permission");
  if (problems.length) throw new CliError("Fix these first (or run aeron flutter init --write):\n  • " + problems.join("\n  • "));
}

// ------------------------------------------------------------------ init

async function init(api: Api, args: Args) {
  const appId = requireFlag(args, "app");
  const project = resolve(flag(args, "project", ".")!);
  const write = bool(args, "write");
  if (!existsSync(join(project, "pubspec.yaml"))) throw new CliError(`${project} has no pubspec.yaml. Use --project <flutter app folder>.`);
  const steps: string[] = [];

  let exists = true;
  try {
    const a = await api.request("GET", `/api/admin/apps/${appId}`);
    if (a.app.kind !== "flutter") throw new CliError(`Aeron app ${appId} is a ${a.app.kind} app`);
  } catch (e) {
    if (e instanceof CliError && /is a/.test(e.message)) throw e;
    exists = false;
  }
  if (!exists) {
    steps.push(`create Flutter app "${appId}" on Aeron`);
    if (write) await api.request("POST", "/api/admin/apps", { id: appId, kind: "flutter", name: flag(args, "name", appId) });
  }

  const { pub, priv } = keyPaths(args, project);
  if (!existsSync(pub) || !existsSync(priv)) {
    steps.push("generate keys/patch-public.pem and keys/patch-private.pem (secret)");
    if (write) await generateKeys(resolve(project, "keys"));
  }
  let settings: { hasPublicKey: boolean; requireSigning: boolean } | null = null;
  try {
    settings = (await api.request("GET", `/api/admin/flutter/apps/${appId}`)).settings;
  } catch {
    settings = null;
  }
  if (!settings?.hasPublicKey) {
    steps.push("register the patch public key on Aeron");
    if (write && existsSync(pub)) await api.request("POST", `/api/admin/flutter/apps/${appId}/settings`, { publicKeyPem: readFileSync(pub, "utf8").trim() + "\n", requireSigning: true });
  }

  const y = readShorebirdYaml(project);
  if (!y || y.app_id !== appId || (y.base_url ?? "").replace(/\/$/, "") !== api.server) {
    steps.push(`write shorebird.yaml (app_id: ${appId}, base_url: ${api.server})`);
    if (write) {
      const p = join(project, "shorebird.yaml");
      let s = existsSync(p) ? readFileSync(p, "utf8") : "";
      const set = (k: string, v: string) => {
        s = new RegExp(`^${k}:.*$`, "m").test(s) ? s.replace(new RegExp(`^${k}:.*$`, "m"), `${k}: ${v}`) : `${s}${s && !s.endsWith("\n") ? "\n" : ""}${k}: ${v}\n`;
      };
      set("app_id", appId);
      set("base_url", api.server);
      if (!/^auto_update:/m.test(s)) set("auto_update", "true");
      writeFileSync(p, s);
    }
  }
  if (!pubspecHasShorebirdAsset(project)) {
    steps.push("add shorebird.yaml to pubspec.yaml → flutter: assets:");
    if (write) addShorebirdAsset(project);
  }
  if (hasInternetPermission(project) === false) {
    steps.push("add the INTERNET permission to android/app/src/main/AndroidManifest.xml");
    if (write) addInternetPermission(project);
  }
  const gi = join(project, ".gitignore");
  const giText = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (!/^keys\/patch-private\.pem$|^keys\/$/m.test(giText)) {
    steps.push("add keys/patch-private.pem to .gitignore");
    if (write) writeFileSync(gi, giText + (giText.endsWith("\n") || !giText ? "" : "\n") + "# Aeron patch signing key (never commit)\nkeys/patch-private.pem\n");
  }

  if (!steps.length) log("Everything is already set up.");
  else {
    log(write ? "Done:" : "Would do (re-run with --write to apply):");
    for (const st of steps) log(`  • ${st}`);
  }
  log(`\nNext:\n  1. aeron flutter release --app ${appId} --platform android     (then upload the .aab to Play)\n  2. Change Dart code, then: aeron flutter patch --app ${appId}`);
  log("  Back up keys/patch-private.pem in your password manager. Without it this app's releases can't be patched.");
}

async function generateKeys(dir: string) {
  const priv = join(dir, "patch-private.pem");
  const pub = join(dir, "patch-public.pem");
  if (existsSync(priv) || existsSync(pub)) throw new CliError(`${dir} already has patch keys. Losing or replacing them means existing releases can no longer be patched.`);
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  await mkdir(dir, { recursive: true });
  await writeFile(priv, privateKey, { mode: 0o600 });
  await writeFile(pub, publicKey);
  return { priv, pub };
}

// ------------------------------------------------------------------ release & patch

async function release(api: Api, args: Args) {
  const appId = requireFlag(args, "app");
  const project = resolve(flag(args, "project", ".")!);
  const platforms = (flag(args, "platform", "android")!).split(",");
  preflight(project, appId, api.server, platforms.join(","));
  const { pub } = keyPaths(args, project);
  if (!existsSync(pub)) throw new CliError(`Public key not found at ${pub} (aeron flutter keys generate)`);
  const sb = findShorebird();
  const { token, cleanup } = await shorebirdToken(api, appId);
  try {
    for (const platform of platforms) {
      const extra = args.flags["flutter-version"] ? [`--flutter-version=${flag(args, "flutter-version")}`] : [];
      log(`\n→ shorebird release ${platform} (signed with ${pub})\n`);
      const code = await runInteractive(sb, ["release", platform, `--public-key-path=${pub}`, "--no-confirm", ...extra], {
        cwd: project,
        env: { SHOREBIRD_HOSTED_URL: api.server, SHOREBIRD_TOKEN: token },
      });
      if (code !== 0) throw new CliError(`shorebird release ${platform} failed (exit ${code})`);
    }
  } finally {
    await cleanup();
  }
  log("\nRelease uploaded to Aeron. Upload the store build (.aab / .ipa) as usual; phones with it can then receive patches.");
}

async function patch(api: Api, args: Args) {
  const appId = requireFlag(args, "app");
  const project = resolve(flag(args, "project", ".")!);
  const platform = flag(args, "platform", "android")!;
  const releaseVersion = flag(args, "release", "latest")!;
  const track = flag(args, "track", "stable")!;
  preflight(project, appId, api.server, platform);
  const { pub } = keyPaths(args, project);
  let { priv } = keyPaths(args, project);
  let tmp: string | null = null;
  if (process.env.AERON_FLUTTER_PRIVATE_KEY) {
    tmp = await mkdtemp(join(tmpdir(), "aeron-key-"));
    priv = join(tmp, "patch-private.pem");
    await writeFile(priv, process.env.AERON_FLUTTER_PRIVATE_KEY, { mode: 0o600 });
  }
  try {
    if (!existsSync(pub) || !existsSync(priv)) throw new CliError(`Keys not found (${pub}, ${priv}). Pass --public-key/--private-key or set AERON_FLUTTER_PRIVATE_KEY.`);
    // Refuse to build a patch phones would reject: the private key must match the release's public key.
    const sample = "0".repeat(64);
    const sig = sign("sha256", Buffer.from(sample), createPrivateKey(readFileSync(priv, "utf8")));
    if (!verify("sha256", Buffer.from(sample), createPublicKey(readFileSync(pub, "utf8")), sig)) throw new CliError("The private key does not match the public key; phones would reject this patch.");
    const sb = findShorebird();
    const { token, cleanup } = await shorebirdToken(api, appId);
    try {
      log(`\n→ shorebird patch ${platform} --release-version=${releaseVersion} --track=${track}\n`);
      const code = await runInteractive(
        sb,
        ["patch", platform, `--release-version=${releaseVersion}`, `--track=${track}`, `--public-key-path=${pub}`, `--private-key-path=${priv}`, "--no-confirm"],
        { cwd: project, env: { SHOREBIRD_HOSTED_URL: api.server, SHOREBIRD_TOKEN: token } },
      );
      if (code !== 0) throw new CliError(`shorebird patch failed (exit ${code})`);
    } finally {
      await cleanup();
    }
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
  // Attach notes / commit / CI run, then report approval status.
  const d = await api.request<FlutterData>("GET", `/api/admin/flutter/apps/${appId}`);
  const rel = releaseVersion === "latest" ? d.releases[0] : d.releases.find((r) => r.version === releaseVersion);
  const p = rel?.patches[0];
  if (p) {
    const gitSha = process.env.GITHUB_SHA || (await run("git", ["rev-parse", "HEAD"], { cwd: project, quiet: true }).catch(() => "")).trim() || undefined;
    const ciRunUrl = process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY ? `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined;
    await api
      .request("POST", `/api/admin/flutter/apps/${appId}/patches/${p.id}/meta`, { message: flag(args, "message"), gitSha, repository: process.env.GITHUB_REPOSITORY, ciRunUrl })
      .catch(() => undefined);
    const ch = p.channels.find((c) => c.channel === track);
    if (ch?.status === "pending") log(`\nPatch #${p.number} for ${rel!.version} is waiting for approval. Nothing reaches phones until a second admin approves it:\n  ${api.server}/dashboard#/approvals`);
    else log(`\nPatch #${p.number} for ${rel!.version} is live on ${track}${ch ? ` at ${ch.rollout_bp / 100}%` : ""}.`);
  }
}

// ------------------------------------------------------------------ keys / info / rollout

async function keys(api: Api, args: Args) {
  const action = args._[2];
  if (action === "generate") {
    const { priv, pub } = await generateKeys(resolve(flag(args, "out", "keys")!));
    log(`Created ${pub} (public; goes into releases via --public-key-path)`);
    log(`Created ${priv} (secret; never commit, back it up: without it the release can't be patched)`);
    return;
  }
  if (action === "register") {
    const appId = requireFlag(args, "app");
    const path = requireFlag(args, "public-key", "path to patch-public.pem");
    const pem = await readText(resolve(path));
    try {
      createPublicKey(pem);
    } catch {
      throw new CliError(`${path} is not a PEM public key`);
    }
    await api.request("POST", `/api/admin/flutter/apps/${appId}/settings`, { publicKeyPem: pem.trim() + "\n", requireSigning: true });
    log(`Registered the patch public key for ${appId}. Aeron now rejects patches whose signature doesn't verify against it.`);
    return;
  }
  throw new CliError("Usage: aeron flutter keys generate [--out keys] | aeron flutter keys register --app <id> --public-key keys/patch-public.pem");
}

async function configure(api: Api, args: Args) {
  const appId = requireFlag(args, "app");
  log("shorebird.yaml (in the Flutter project root):\n");
  log(`app_id: ${appId}\nbase_url: ${api.server}\nauto_update: true\n`);
  log("Then: aeron flutter release --app " + appId + "   and later   aeron flutter patch --app " + appId);
}

async function env(api: Api) {
  if (isWindows) {
    log(`$env:SHOREBIRD_HOSTED_URL = "${api.server}"`);
    log('$env:SHOREBIRD_TOKEN = "sb_api_..."   # aeron tokens create --name <who> --role publisher --shorebird');
  } else {
    log(`export SHOREBIRD_HOSTED_URL=${api.server}`);
    log("export SHOREBIRD_TOKEN=sb_api_...   # aeron tokens create --name <who> --role publisher --shorebird");
  }
}

interface FlutterData {
  policy: { requireApproval: boolean };
  settings: { requireSigning: boolean; hasPublicKey: boolean };
  releases: Array<{
    id: number;
    version: string;
    platforms: Array<{ platform: string; status: string; signing_mode: string | null }>;
    patches: Array<{
      id: number;
      number: number;
      created_at: string;
      artifacts: Array<{ platform: string; arch: string; size: number; signed: number }>;
      channels: Array<{ channel: string; rollout_bp: number; is_rolled_back: number; status: string }>;
    }>;
  }>;
}

async function status(api: Api, args: Args) {
  const appId = requireFlag(args, "app");
  const d = await api.request<FlutterData>("GET", `/api/admin/flutter/apps/${appId}`);
  log(`Signing: ${d.settings.requireSigning ? "required" : "OFF"}${d.settings.hasPublicKey ? ", public key registered" : ", no public key registered"} · Approvals: ${d.policy.requireApproval ? "required" : "OFF"}\n`);
  const rows: Array<Record<string, unknown>> = [];
  for (const r of d.releases) {
    const plats = r.platforms.map((p) => `${p.platform}:${p.status}`).join(" ");
    if (!r.patches.length) rows.push({ release: r.version, platforms: plats, patch: "", channels: "", artifacts: "" });
    for (const p of r.patches) {
      rows.push({
        release: r.version,
        platforms: plats,
        patch: `#${p.number}`,
        channels:
          p.channels.map((c) => `${c.channel}:${c.status === "pending" ? "awaiting approval" : c.status === "rejected" ? "rejected" : c.is_rolled_back ? "rolled-back" : `${c.rollout_bp / 100}%`}`).join(" ") ||
          "not promoted",
        artifacts: p.artifacts.map((a) => `${a.platform}/${a.arch}${a.signed ? "✓" : ""}`).join(" "),
      });
    }
  }
  table(rows);
}

async function rollout(api: Api, args: Args) {
  const appId = requireFlag(args, "app");
  const version = requireFlag(args, "release", "release version, e.g. 1.2.0+3");
  const number = Number(requireFlag(args, "patch", "patch number"));
  const channel = flag(args, "channel", "stable")!;
  const d = await api.request<FlutterData>("GET", `/api/admin/flutter/apps/${appId}`);
  const p = d.releases.find((r) => r.version === version)?.patches.find((x) => x.number === number);
  if (!p) throw new CliError(`No patch #${number} on release ${version}`);
  let action: string;
  let percent: number | undefined;
  if (bool(args, "halt")) action = "halt";
  else if (bool(args, "rollback") || bool(args, "undo")) action = "rollback";
  else if (bool(args, "rollforward")) action = "rollforward";
  else if (bool(args, "promote")) {
    action = "promote";
    percent = Number(flag(args, "percent", "100"));
  } else if (flag(args, "percent") !== undefined) {
    action = "set_percent";
    percent = Number(flag(args, "percent"));
  } else throw new CliError("Pass one of --percent N, --halt, --rollback, --rollforward, --promote [--percent N]");
  await api.request("POST", `/api/admin/flutter/apps/${appId}/patches/${p.id}/action`, { channel, action, percent });
  log(`${appId} ${version} patch #${number} on ${channel}: ${action}${percent !== undefined ? ` ${percent}%` : ""}`);
}

async function signing(api: Api, args: Args) {
  const appId = requireFlag(args, "app");
  const v = requireFlag(args, "require", "on or off");
  if (v !== "on" && v !== "off") throw new CliError("--require must be on or off");
  await api.request("POST", `/api/admin/flutter/apps/${appId}/settings`, { requireSigning: v === "on" });
  log(`Patch signing for ${appId}: ${v === "on" ? "required" : "OFF (not recommended)"}`);
}
