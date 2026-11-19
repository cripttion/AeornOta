import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { api, fileRef, reviewerToken, rsaKeyPair } from "./helpers";

const RT = "2.0.0";
let key: Awaited<ReturnType<typeof rsaKeyPair>>;
const enc = (s: string) => new TextEncoder().encode(s);

async function upload(bytes: Uint8Array) {
  const ref = await fileRef(bytes);
  expect((await api("PUT", `/api/admin/files/${ref.hex}`, bytes)).status).toBe(201);
  return ref;
}

async function setupExpoApp(id: string) {
  expect((await api("POST", "/api/admin/apps", { id, name: id, kind: "expo" })).status).toBe(201);
  const noUpdate = JSON.stringify({ type: "noUpdateAvailable" });
  expect((await api("POST", `/api/admin/expo/apps/${id}/keys`, { keyId: "main", publicKeyPem: key.pem, noUpdateDirective: noUpdate, noUpdateSignature: await key.sign(noUpdate) })).status).toBe(201);
  expect((await api("POST", `/api/admin/expo/apps/${id}/runtimes`, { platform: "android", runtimeVersion: RT })).status).toBe(201);
}

async function publishAndApprove(appId: string, launch: { hex: string; b64url: string }, assets: Array<{ hex: string; b64url: string }>) {
  const createdAt = new Date().toISOString();
  const file = (r: { hex: string; b64url: string }, k: string) => ({ hash: r.b64url, key: k, contentType: "application/octet-stream", fileExtension: ".bin", url: `https://ota.test/files/${r.hex}` });
  const manifest = JSON.stringify({ id: crypto.randomUUID(), createdAt, runtimeVersion: RT, launchAsset: file(launch, "bundle"), assets: assets.map((a, i) => file(a, `a${i}`)), metadata: {}, extra: {} });
  const undo = JSON.stringify({ type: "rollBackToEmbedded", parameters: { commitTime: new Date(Date.parse(createdAt) + 1).toISOString() } });
  const res = await api("POST", `/api/admin/expo/apps/${appId}/updates`, {
    channel: "production",
    platform: "android",
    runtimeVersion: RT,
    manifest,
    signature: await key.sign(manifest),
    keyId: "main",
    undoDirective: undo,
    undoSignature: await key.sign(undo),
    rolloutPercent: 100,
  });
  expect(res.status).toBe(201);
  const id = JSON.parse(manifest).id as string;
  expect((await api("POST", `/api/admin/expo/updates/${id}/review`, { decision: "approve" }, await reviewerToken())).status).toBe(200);
  return id;
}

const manifestFor = (appId: string) =>
  SELF.fetch(`https://ota.test/expo/${appId}/manifest`, {
    headers: { "expo-protocol-version": "1", "expo-platform": "android", "expo-runtime-version": RT, "expo-channel-name": "production", "expo-expect-signature": 'sig, keyid="main", alg="rsa-v1_5-sha256"', "eas-client-id": "d1" },
  });

describe("Deleting an app", () => {
  let shared: { hex: string; b64url: string };
  let unique: { hex: string; b64url: string };
  let onlyScoped = "";
  let twoApps = "";

  beforeAll(async () => {
    key = await rsaKeyPair();
    await setupExpoApp("keep-app");
    await setupExpoApp("gone-app");
    shared = await upload(enc("shared image bytes"));
    unique = await upload(enc("bundle only gone-app uses"));
    const keepBundle = await upload(enc("keep-app bundle"));
    await publishAndApprove("gone-app", unique, [shared]);
    await publishAndApprove("keep-app", keepBundle, [shared]);
    onlyScoped = (await api("POST", "/api/admin/tokens", { name: "ci-gone", role: "publisher", apps: ["gone-app"] })).json.token;
    twoApps = (await api("POST", "/api/admin/tokens", { name: "ci-both", role: "publisher", apps: ["gone-app", "keep-app"] })).json.token;
    expect((await api("POST", "/api/admin/apps", { id: "gone-flutter", name: "gone-flutter", kind: "flutter" })).status).toBe(201);
  });

  it("is refused to publishers", async () => {
    const r = await api("DELETE", "/api/admin/apps/gone-app", { confirm: "gone-app" }, onlyScoped);
    expect(r.status).toBe(403);
  });

  it("previews what would be removed without removing anything", async () => {
    const r = await api("DELETE", "/api/admin/apps/gone-app", { dryRun: true });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ dryRun: true, app: "gone-app", kind: "expo", updates: 1, runtimes: 1, keys: 1, files: 1, tokensRevoked: 1, tokensNarrowed: 1 });
    expect((await api("GET", "/api/admin/apps/gone-app")).status).toBe(200);
  });

  it("requires typing the app id", async () => {
    expect((await api("DELETE", "/api/admin/apps/gone-app", { confirm: "keep-app" })).status).toBe(400);
    expect((await api("DELETE", "/api/admin/apps/gone-app")).status).toBe(400);
    expect((await api("GET", "/api/admin/apps/gone-app")).status).toBe(200);
  });

  it("removes the app, its rows and the files only it used", async () => {
    const r = await api("DELETE", "/api/admin/apps/gone-app", { confirm: "gone-app" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ deleted: true, updates: 1, files: 1 });
    expect((await api("GET", "/api/admin/apps/gone-app")).status).toBe(404);
    for (const table of ["expo_updates", "expo_rollouts", "expo_runtimes", "expo_keys", "app_settings"]) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE app_id = 'gone-app'`).first<{ n: number }>();
      expect(row!.n, table).toBe(0);
    }
    expect((await SELF.fetch(`https://ota.test/files/${unique.hex}`)).status).toBe(404);
    const audit = await api("GET", "/api/admin/audit?app=gone-app");
    expect(audit.json.entries.map((e: { action: string }) => e.action)).toContain("app.delete");
  });

  it("keeps files and updates that another app still uses", async () => {
    const f = await SELF.fetch(`https://ota.test/files/${shared.hex}`);
    expect(f.status).toBe(200);
    expect(await f.text()).toBe("shared image bytes");
    const m = await manifestFor("keep-app");
    expect(m.status).toBe(200);
    expect(await m.text()).toContain('name="manifest"');
  });

  it("revokes tokens limited to the app, and narrows tokens shared with other apps", async () => {
    expect((await api("GET", "/api/admin/me", undefined, onlyScoped)).status).toBe(401);
    const me = await api("GET", "/api/admin/me", undefined, twoApps);
    expect(me.status).toBe(200);
    expect(me.json.principal.apps).toEqual(["keep-app"]);
  });

  it("deletes Flutter apps too", async () => {
    const r = await api("DELETE", "/api/admin/apps/gone-flutter", { confirm: "gone-flutter" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ deleted: true, kind: "flutter" });
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM flutter_settings WHERE app_id = 'gone-flutter'").first<{ n: number }>();
    expect(row!.n).toBe(0);
  });

  it("answers 404 for an app that doesn't exist", async () => {
    expect((await api("DELETE", "/api/admin/apps/never-was", { confirm: "never-was" })).status).toBe(404);
  });
});
