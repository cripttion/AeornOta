import { createPublicKey, createPrivateKey, sign, verify } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Api, loadConfig } from "./api.js";
import { detectRnProject, resolveRuntimeVersion } from "./expo.js";
import { findShorebird, readShorebirdYaml } from "./flutter.js";
import { appEntryFile, rnProjectFixes, robustCliLookups } from "./rn-fixes.js";
import { bad, flag, log, ok, run, warn, type Args } from "./util.js";

/** Read-only health check of the CLI login and a project (Expo, bare React Native or Flutter). */
export async function doctorCommand(args: Args) {
  const project = resolve(flag(args, "project", ".")!);
  let problems = 0;
  const fail = (m: string) => {
    problems++;
    bad(m);
  };
  log("Aeron");
  let api: Api | null = null;
  try {
    api = new Api(await loadConfig());
    const me = await api.request("GET", "/api/admin/me");
    ok(`signed in to ${api.server} as ${me.principal.name} (${me.principal.role})${me.principal.expiresAt ? `, token expires ${String(me.principal.expiresAt).slice(0, 10)}` : ""}`);
  } catch (e) {
    fail(`not signed in or server unreachable: ${(e as Error).message}`);
  }

  const isFlutter = existsSync(join(project, "pubspec.yaml"));
  if (isFlutter) problems += await flutterChecks(api, project, flag(args, "app"));
  else problems += await rnChecks(api, project, flag(args, "app"));

  log("");
  if (problems) log(`${problems} problem${problems === 1 ? "" : "s"} found. Most can be fixed with: aeron ${isFlutter ? "flutter" : "expo"} init --app <id> --write`);
  else log("All good.");
  process.exitCode = problems ? 1 : 0;
}

async function gitSafety(project: string, secretPath: string): Promise<string | null> {
  if (!existsSync(join(project, ".git"))) return null;
  const tracked = await run("git", ["ls-files", "--error-unmatch", secretPath], { cwd: project, quiet: true }).then(
    () => true,
    () => false,
  );
  if (tracked) return `${secretPath} is committed to git. Remove it from history and rotate the key.`;
  const ignored = await run("git", ["check-ignore", "-q", secretPath], { cwd: project, quiet: true }).then(
    () => true,
    () => false,
  );
  return ignored ? null : `${secretPath} is not in .gitignore`;
}

async function flutterChecks(api: Api | null, project: string, appArg?: string): Promise<number> {
  let n = 0;
  const fail = (m: string) => {
    n++;
    bad(m);
  };
  log("\nFlutter project");
  const y = readShorebirdYaml(project);
  const appId = appArg ?? y?.app_id;
  if (!y) fail("shorebird.yaml missing");
  else {
    ok(`shorebird.yaml app_id: ${y.app_id}`);
    if (api && (y.base_url ?? "").replace(/\/$/, "") !== api.server) fail(`base_url is "${y.base_url ?? "(missing)"}", must be ${api.server} — phones would talk to Shorebird's servers`);
    else if (y.base_url) ok(`base_url points at Aeron`);
  }
  const pubspec = existsSync(join(project, "pubspec.yaml")) ? readFileSync(join(project, "pubspec.yaml"), "utf8") : "";
  if (/^\s+-\s+shorebird\.yaml\s*$/m.test(pubspec)) ok("shorebird.yaml is bundled (pubspec assets)");
  else fail("pubspec.yaml doesn't list shorebird.yaml under flutter: assets:");
  const manifest = join(project, "android", "app", "src", "main", "AndroidManifest.xml");
  if (existsSync(manifest)) {
    if (/android\.permission\.INTERNET/.test(readFileSync(manifest, "utf8"))) ok("Android INTERNET permission present");
    else fail("android/app/src/main/AndroidManifest.xml lacks the INTERNET permission (the updater can't reach Aeron)");
  }
  const pub = join(project, "keys", "patch-public.pem");
  const priv = join(project, "keys", "patch-private.pem");
  if (existsSync(pub)) ok("patch public key found");
  else fail("keys/patch-public.pem missing (aeron flutter keys generate)");
  if (existsSync(priv)) {
    try {
      const s = sign("sha256", Buffer.from("x"), createPrivateKey(readFileSync(priv, "utf8")));
      if (existsSync(pub) && verify("sha256", Buffer.from("x"), createPublicKey(readFileSync(pub, "utf8")), s)) ok("private key matches the public key");
      else if (existsSync(pub)) fail("private key does NOT match keys/patch-public.pem");
    } catch {
      fail("keys/patch-private.pem can't be read (encrypted? use AERON_FLUTTER_PRIVATE_KEY in CI)");
    }
    const g = await gitSafety(project, "keys/patch-private.pem");
    if (g) fail(g);
    else ok("private key is not committed");
  } else warn("keys/patch-private.pem not on this machine (fine if patches are built in CI)");
  try {
    ok(`shorebird CLI: ${findShorebird()}`);
  } catch (e) {
    fail((e as Error).message);
  }
  if (api && appId) {
    try {
      const d = await api.request("GET", `/api/admin/flutter/apps/${appId}`);
      ok(`app "${appId}" exists on Aeron`);
      if (d.settings.requireSigning) ok("server requires signed patches");
      else fail("server does NOT require signed patches");
      if (!d.settings.hasPublicKey) fail("no patch public key registered on Aeron (aeron flutter keys register)");
      else if (existsSync(pub) && d.settings.publicKeyPem.replace(/\s+/g, "") !== readFileSync(pub, "utf8").replace(/\s+/g, "")) fail("the public key registered on Aeron differs from keys/patch-public.pem");
      else ok("registered public key matches");
      if (d.policy.requireApproval) ok("approvals required before patches reach phones");
      else warn("approvals are OFF for this app");
    } catch (e) {
      fail(`app "${appId}" not found on Aeron (${(e as Error).message})`);
    }
  }
  return n;
}

function bareNativeConfig(project: string): { androidUrl: string | null; androidCert: boolean; iosUrl: string | null; iosCert: boolean } {
  const out = { androidUrl: null as string | null, androidCert: false, iosUrl: null as string | null, iosCert: false };
  const manifest = join(project, "android", "app", "src", "main", "AndroidManifest.xml");
  if (existsSync(manifest)) {
    const s = readFileSync(manifest, "utf8");
    out.androidUrl = /expo\.modules\.updates\.EXPO_UPDATE_URL"\s+android:value="([^"]+)"/.exec(s)?.[1] ?? null;
    out.androidCert = /expo\.modules\.updates\.CODE_SIGNING_CERTIFICATE/.test(s);
  }
  const iosDir = join(project, "ios");
  if (existsSync(iosDir)) {
    for (const d of readdirSync(iosDir)) {
      const p = join(iosDir, d, "Supporting", "Expo.plist");
      if (!existsSync(p)) continue;
      const s = readFileSync(p, "utf8");
      out.iosUrl = /<key>EXUpdatesURL<\/key>\s*<string>([^<]+)<\/string>/.exec(s)?.[1] ?? null;
      out.iosCert = /EXUpdatesCodeSigningCertificate/.test(s);
    }
  }
  return out;
}

async function rnChecks(api: Api | null, project: string, appArg?: string): Promise<number> {
  let n = 0;
  const fail = (m: string) => {
    n++;
    bad(m);
  };
  log("\nReact Native project");
  const d = detectRnProject(project);
  if (d.kind === "not-rn") {
    fail(`${project} is not a React Native or Flutter project (pass --project)`);
    return n;
  }
  ok({ "expo-managed": "Expo (managed)", "expo-bare": "Expo / React Native with native folders (bare)", "rn-no-expo": "React Native without Expo modules", "not-rn": "" }[d.kind]);
  if (d.kind === "rn-no-expo") {
    fail("expo-updates needs Expo modules: run npx install-expo-modules@latest, then npx expo install expo-updates");
    return n;
  }
  if (d.hasUpdates) ok("expo-updates installed");
  else fail("expo-updates is not installed (npx expo install expo-updates)");
  let expo: Record<string, any> = {};
  if (d.dynamicConfig) warn(`${d.dynamicConfig} is dynamic; checking app.json only`);
  try {
    const j = JSON.parse(readFileSync(join(project, "app.json"), "utf8"));
    expo = j.expo ?? j;
  } catch {
    if (!d.dynamicConfig) fail("app.json missing or invalid");
  }
  const upd = expo.updates ?? {};
  const appId = appArg ?? /\/expo\/([a-z0-9-]+)\/manifest/.exec(upd.url ?? "")?.[1];
  const expectedUrl = api && appId ? `${api.server}/expo/${appId}/manifest` : null;
  if (!upd.url) fail("expo.updates.url is not set");
  else if (expectedUrl && upd.url !== expectedUrl) fail(`expo.updates.url is ${upd.url}, expected ${expectedUrl}`);
  else ok(`updates.url → ${upd.url}`);
  const certRel = upd.codeSigningCertificate;
  const certPath = certRel ? join(project, certRel) : null;
  if (!certPath || !existsSync(certPath)) fail("codeSigningCertificate is not set or the file is missing — builds without it are refused updates");
  else ok(`code signing certificate: ${certRel}`);
  if (upd.codeSigningMetadata?.alg !== "rsa-v1_5-sha256") fail('codeSigningMetadata.alg must be "rsa-v1_5-sha256"');
  if (d.kind === "expo-bare" && typeof expo.runtimeVersion !== "string") fail("bare projects need a fixed runtimeVersion string (policies don't work with native folders)");
  else if (d.kind === "expo-managed" && expo.runtimeVersion?.policy !== "fingerprint") warn('runtimeVersion {"policy":"fingerprint"} is the safest choice for managed apps');
  else ok(`runtimeVersion: ${JSON.stringify(expo.runtimeVersion)}`);
  if (d.kind === "expo-bare") {
    const nat = bareNativeConfig(project);
    if (d.hasAndroid) {
      if (nat.androidUrl && (!expectedUrl || nat.androidUrl === expectedUrl)) ok("Android native config points at Aeron");
      else fail(`Android native config URL is ${nat.androidUrl ?? "(missing)"} — run npx expo-updates configuration:syncnative --platform android --workflow generic`);
      if (!nat.androidCert) fail("Android native config has no code signing certificate (run configuration:syncnative)");
    }
    if (d.hasIos) {
      if (nat.iosUrl && (!expectedUrl || nat.iosUrl === expectedUrl)) ok("iOS Expo.plist points at Aeron");
      else fail(`iOS Expo.plist URL is ${nat.iosUrl ?? "(missing)"} — run npx expo-updates configuration:syncnative --platform ios --workflow generic`);
      if (!nat.iosCert) fail("iOS Expo.plist has no code signing certificate (run configuration:syncnative)");
    }
  }
  const fixes = rnProjectFixes(project);
  for (const fix of fixes) {
    if (fix.status === "broken") fail(`${fix.problem}. Fix: aeron expo init --app <id> --write`);
    else warn(`${fix.problem}. aeron expo init --app <id> --write hardens it`);
  }
  const entry = appEntryFile(project);
  if (entry && !fixes.some((f) => f.id === "expo-import")) ok(`${entry} loads Expo (images and fonts in updates resolve)`);
  for (const file of robustCliLookups(project)) ok(`${file} finds @expo/cli`);
  if (existsSync(join(project, "keys", "private-key.pem"))) {
    const g = await gitSafety(project, "keys/private-key.pem");
    if (g) fail(g);
    else ok("private key is not committed");
  }
  if (api && appId) {
    try {
      const keys = (await api.request("GET", `/api/admin/expo/apps/${appId}/keys`)).keys as Array<{ key_id: string; public_key_pem: string; retired_at: string | null }>;
      const kid = upd.codeSigningMetadata?.keyid ?? "main";
      const k = keys.find((x) => x.key_id === kid && !x.retired_at);
      if (!k) fail(`signing key "${kid}" is not registered on Aeron (aeron expo keys register)`);
      else if (certPath && existsSync(certPath)) {
        const certKey = createPublicKey(readFileSync(certPath, "utf8")).export({ type: "spki", format: "pem" }).toString();
        if (certKey.replace(/\s+/g, "") === k.public_key_pem.replace(/\s+/g, "")) ok(`certificate matches registered key "${kid}"`);
        else fail(`certificate ${certRel} does NOT match registered key "${kid}" — phones would reject every update`);
      }
      const runtimes = (await api.request("GET", `/api/admin/expo/apps/${appId}/runtimes`)).runtimes as Array<{ platform: string; runtime_version: string }>;
      for (const p of ["android", "ios"] as const) {
        if ((p === "android" && d.kind === "expo-bare" && !d.hasAndroid) || (p === "ios" && d.kind === "expo-bare" && !d.hasIos)) continue;
        const rt = await resolveRuntimeVersion(project, p).catch(() => null);
        if (!rt) warn(`couldn't resolve the ${p} runtime version`);
        else if (runtimes.some((r) => r.platform === p && r.runtime_version === rt)) ok(`${p} runtime ${rt} is registered`);
        else warn(`${p} runtime ${rt} isn't registered yet (do it when the store build ships: aeron expo runtime register --app ${appId} --platform ${p})`);
      }
      const s = await api.request("GET", `/api/admin/apps/${appId}/settings`);
      if (s.policy.requireApproval) ok("approvals required before updates reach phones");
      else warn("approvals are OFF for this app");
    } catch (e) {
      fail(`app "${appId}" not found on Aeron (${(e as Error).message})`);
    }
  }
  return n;
}
