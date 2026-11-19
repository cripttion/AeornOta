// Runs with Cloudflare Access switched on (vitest.access.config.ts): which actions need a signed-in person,
// and which keep working with a token alone so the CLI can set up apps and publish.
import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { base64Url } from "../../src/lib/crypto";
import { api, fileRef, rsaKeyPair } from "../helpers";

const TEAM = "https://team.cloudflareaccess.com";

/** A Cloudflare Access login token, signed with the test key the Worker trusts for the team's certs URL. */
async function accessToken(claims: Record<string, unknown> = {}) {
  const jwk = JSON.parse(env.TEST_OIDC_PRIVATE_JWK);
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const enc = (o: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(o)));
  const now = Math.floor(Date.now() / 1000);
  const body = `${enc({ alg: "RS256", kid: "test-key", typ: "JWT" })}.${enc({ iss: TEAM, aud: ["aud-test"], email: "owner@example.com", iat: now, nbf: now - 5, exp: now + 600, ...claims })}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(body)));
  return `${body}.${base64Url(sig)}`;
}
const asCookie = async (claims?: Record<string, unknown>) => ({ cookie: `other=1; CF_Authorization=${await accessToken(claims)}` });
const asHeader = async (claims?: Record<string, unknown>) => ({ "cf-access-jwt-assertion": await accessToken(claims) });

const RT = "3.0.0";
let key: Awaited<ReturnType<typeof rsaKeyPair>>;

async function keyBody(keyId: string) {
  const noUpdate = JSON.stringify({ type: "noUpdateAvailable" });
  return { keyId, publicKeyPem: key.pem, noUpdateDirective: noUpdate, noUpdateSignature: await key.sign(noUpdate) };
}

describe("With Cloudflare Access on", () => {
  beforeAll(async () => {
    key = await rsaKeyPair();
  });

  it("an admin token alone can still set up a new app: create it and register its first key", async () => {
    expect((await api("POST", "/api/admin/apps", { id: "shop", name: "Shop", kind: "expo" })).status).toBe(201);
    expect((await api("POST", "/api/admin/expo/apps/shop/keys", await keyBody("main"))).status).toBe(201);
    expect((await api("POST", "/api/admin/expo/apps/shop/runtimes", { platform: "android", runtimeVersion: RT })).status).toBe(201);
  });

  it("adding or changing keys later needs the login", async () => {
    const r = await api("POST", "/api/admin/expo/apps/shop/keys", await keyBody("second"));
    expect(r.status).toBe(403);
    expect(r.json.error.message).toContain("Cloudflare Access");
    expect((await api("POST", "/api/admin/expo/apps/shop/keys", await keyBody("second"), undefined, await asCookie())).status).toBe(201);
  });

  it("creating access tokens needs the login", async () => {
    expect((await api("POST", "/api/admin/tokens", { name: "x", role: "publisher" })).status).toBe(403);
    expect((await api("POST", "/api/admin/tokens", { name: "x", role: "publisher" }, undefined, await asCookie())).status).toBe(201);
  });

  it("publishing works with a token; approving needs the login (header or cookie)", async () => {
    const bytes = new TextEncoder().encode("shop bundle v1");
    const ref = await fileRef(bytes);
    expect((await api("PUT", `/api/admin/files/${ref.hex}`, bytes)).status).toBe(201);
    const createdAt = new Date().toISOString();
    const id = crypto.randomUUID();
    const manifest = JSON.stringify({ id, createdAt, runtimeVersion: RT, launchAsset: { hash: ref.b64url, key: "b", contentType: "application/javascript", fileExtension: ".bundle", url: `https://ota.test/files/${ref.hex}` }, assets: [], metadata: {}, extra: {} });
    const undo = JSON.stringify({ type: "rollBackToEmbedded", parameters: { commitTime: new Date(Date.parse(createdAt) + 1).toISOString() } });
    const pub = await api("POST", "/api/admin/expo/apps/shop/updates", { channel: "production", platform: "android", runtimeVersion: RT, manifest, signature: await key.sign(manifest), keyId: "main", undoDirective: undo, undoSignature: await key.sign(undo) });
    expect(pub.status).toBe(201);
    expect(pub.json.status).toBe("pending");
    const reviewer = (await api("POST", "/api/admin/tokens", { name: "reviewer", role: "admin" }, undefined, await asCookie())).json.token as string;
    expect((await api("POST", `/api/admin/expo/updates/${id}/review`, { decision: "approve" }, reviewer)).status).toBe(403);
    expect((await api("POST", `/api/admin/expo/updates/${id}/review`, { decision: "approve" }, reviewer, await asHeader())).status).toBe(200);
  });

  it("refuses a login for another application, an expired login, and service tokens (no person)", async () => {
    const body = { name: "y", role: "publisher" };
    expect((await api("POST", "/api/admin/tokens", body, undefined, await asCookie({ aud: ["someone-else"] }))).status).toBe(403);
    expect((await api("POST", "/api/admin/tokens", body, undefined, await asCookie({ exp: Math.floor(Date.now() / 1000) - 3600 }))).status).toBe(403);
    expect((await api("POST", "/api/admin/tokens", body, undefined, await asCookie({ email: undefined, common_name: "ci-service-token" }))).status).toBe(403);
    expect((await api("POST", "/api/admin/tokens", body, undefined, { cookie: "CF_Authorization=not-a-jwt" })).status).toBe(403);
  });

  it("Flutter: the first patch key works with a token; changing it or turning signing off needs the login", async () => {
    expect((await api("POST", "/api/admin/apps", { id: "game", name: "Game", kind: "flutter" })).status).toBe(201);
    const pem = key.pem;
    expect((await api("POST", "/api/admin/flutter/apps/game/settings", { publicKeyPem: pem, requireSigning: true })).status).toBe(200);
    const other = await rsaKeyPair();
    expect((await api("POST", "/api/admin/flutter/apps/game/settings", { publicKeyPem: other.pem })).status).toBe(403);
    expect((await api("POST", "/api/admin/flutter/apps/game/settings", { requireSigning: false })).status).toBe(403);
    expect((await api("POST", "/api/admin/flutter/apps/game/settings", { publicKeyPem: other.pem }, undefined, await asCookie())).status).toBe(200);
  });

  it("deleting an app and changing the approval policy need the login", async () => {
    expect((await api("POST", "/api/admin/apps/shop/settings", { requireApproval: false })).status).toBe(403);
    expect((await api("DELETE", "/api/admin/apps/game", { confirm: "game" })).status).toBe(403);
    expect((await api("DELETE", "/api/admin/apps/game", { confirm: "game" }, undefined, await asCookie())).status).toBe(200);
  });

  it("phones never need a login", async () => {
    const res = await SELF.fetch("https://ota.test/expo/shop/manifest", {
      headers: { "expo-protocol-version": "1", "expo-platform": "android", "expo-runtime-version": RT, "expo-channel-name": "production", "expo-expect-signature": 'sig, keyid="main", alg="rsa-v1_5-sha256"', "eas-client-id": "phone-1" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('name="manifest"');
  });
});
