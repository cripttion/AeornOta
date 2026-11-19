import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { fromBase64 } from "../src/lib/crypto";
import { parseMultipartMixed } from "../src/lib/multipart";
import { parseDictionary } from "../src/lib/sfv";
import { env } from "cloudflare:test";
import { sha256Hex } from "../src/lib/crypto";
import { api, fileRef, reviewerToken, rsaKeyPair } from "./helpers";

const APP = "calmi";
const RT = "1.4.0";
let key: Awaited<ReturnType<typeof rsaKeyPair>>;
let bundleHex = "";

async function publish(opts: { createdAt: string; percent: number; bundle: Uint8Array; tamper?: boolean }) {
  const ref = await fileRef(opts.bundle);
  const up = await api("PUT", `/api/admin/files/${ref.hex}`, opts.bundle, undefined, { "content-type": "application/javascript" });
  expect(up.status).toBe(201);
  const id = crypto.randomUUID();
  const manifest = JSON.stringify({
    id,
    createdAt: opts.createdAt,
    runtimeVersion: RT,
    launchAsset: { hash: ref.b64url, key: "bundle", contentType: "application/javascript", fileExtension: ".bundle", url: `https://ota.test/files/${ref.hex}` },
    assets: [],
    metadata: {},
    extra: { expoClient: { name: "Calmi" } },
  });
  const undo = JSON.stringify({ type: "rollBackToEmbedded", parameters: { commitTime: new Date(Date.parse(opts.createdAt) + 1).toISOString() } });
  const signature = await key.sign(opts.tamper ? manifest + " " : manifest);
  const res = await api("POST", `/api/admin/expo/apps/${APP}/updates`, {
    channel: "production",
    platform: "android",
    runtimeVersion: RT,
    manifest,
    signature,
    keyId: "main",
    undoDirective: undo,
    undoSignature: await key.sign(undo),
    rolloutPercent: opts.percent,
    message: "test",
  });
  return { id, res, hex: ref.hex };
}

async function approve(id: string, percent?: number) {
  const r = await api("POST", `/api/admin/expo/updates/${id}/review`, { decision: "approve", percent }, await reviewerToken());
  expect(r.status).toBe(200);
  return r;
}

async function check(headers: Record<string, string>) {
  const res = await SELF.fetch(`https://ota.test/expo/${APP}/manifest`, {
    headers: {
      "expo-protocol-version": "1",
      "expo-platform": "android",
      "expo-runtime-version": RT,
      "expo-channel-name": "production",
      "expo-expect-signature": 'sig, keyid="main", alg="rsa-v1_5-sha256"',
      "eas-client-id": "device-a",
      ...headers,
    },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("expo-protocol-version")).toBe("1");
  const parts = parseMultipartMixed(await res.text(), res.headers.get("content-type")!);
  const first = parts[0]!;
  const name = /name="([^"]+)"/.exec(first.headers["content-disposition"] ?? "")![1];
  const sig = parseDictionary(first.headers["expo-signature"]);
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key.publicKey,
    fromBase64(String(sig.sig)),
    new TextEncoder().encode(first.body),
  );
  return { name, body: JSON.parse(first.body), verified, keyid: sig.keyid };
}

describe("Expo Updates flow", () => {
  beforeAll(async () => {
    key = await rsaKeyPair();
    expect((await api("POST", "/api/admin/apps", { id: APP, name: "Calmi", kind: "expo" })).status).toBe(201);
    const noUpdate = JSON.stringify({ type: "noUpdateAvailable" });
    const reg = await api("POST", `/api/admin/expo/apps/${APP}/keys`, {
      keyId: "main",
      publicKeyPem: key.pem,
      noUpdateDirective: noUpdate,
      noUpdateSignature: await key.sign(noUpdate),
    });
    expect(reg.status).toBe(201);
    expect((await api("POST", `/api/admin/expo/apps/${APP}/runtimes`, { platform: "android", runtimeVersion: RT })).status).toBe(201);
  });

  it("returns a signed noUpdateAvailable before anything is published", async () => {
    const r = await check({});
    expect(r.name).toBe("directive");
    expect(r.body).toEqual({ type: "noUpdateAvailable" });
    expect(r.verified).toBe(true);
  });

  it("rejects a manifest whose signature does not verify", async () => {
    const { res } = await publish({ createdAt: "2026-11-01T00:00:00.000Z", percent: 100, bundle: new TextEncoder().encode("bad"), tamper: true });
    expect(res.status).toBe(400);
  });

  let u1 = "";
  let u2 = "";
  it("holds a new update for approval, refuses self-approval, then serves it signed", async () => {
    const p = await publish({ createdAt: "2026-11-02T00:00:00.000Z", percent: 100, bundle: new TextEncoder().encode("console.log('v1')") });
    expect(p.res.status).toBe(201);
    expect(p.res.json.status).toBe("pending");
    u1 = p.id;
    bundleHex = p.hex;
    const before = await check({});
    expect(before.body.type).toBe("noUpdateAvailable"); // pending code never reaches devices
    const list = await api("GET", "/api/admin/approvals");
    expect(list.json.expo.map((u: { id: string }) => u.id)).toContain(u1);
    const self = await api("POST", `/api/admin/expo/updates/${u1}/review`, { decision: "approve" });
    expect(self.status).toBe(403);
    await approve(u1);
    const r = await check({});
    expect(r.name).toBe("manifest");
    expect(r.body.id).toBe(u1);
    expect(r.verified).toBe(true);
    expect(r.keyid).toBe("main");
  });

  it("serves the file immutably", async () => {
    const res = await SELF.fetch(`https://ota.test/files/${bundleHex}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log('v1')");
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  it("says no update when the device already runs it", async () => {
    const r = await check({ "expo-current-update-id": u1 });
    expect(r.name).toBe("directive");
    expect(r.body.type).toBe("noUpdateAvailable");
  });

  it("refuses to publish an update older than the current one", async () => {
    const { res } = await publish({ createdAt: "2026-11-01T12:00:00.000Z", percent: 100, bundle: new TextEncoder().encode("old") });
    expect(res.status).toBe(409);
  });

  it("keeps devices outside a 0% rollout on the stable update", async () => {
    const p = await publish({ createdAt: "2026-11-03T00:00:00.000Z", percent: 0, bundle: new TextEncoder().encode("console.log('v2')") });
    expect(p.res.status).toBe(201);
    u2 = p.id;
    await approve(u2);
    const fresh = await check({});
    expect(fresh.body.id).toBe(u1);
    const onV1 = await check({ "expo-current-update-id": u1 });
    expect(onV1.body.type).toBe("noUpdateAvailable");
  });

  it("moves devices forward when the rollout reaches 100%", async () => {
    const r = await api("POST", `/api/admin/expo/apps/${APP}/rollouts/action`, {
      channel: "production",
      platform: "android",
      runtimeVersion: RT,
      action: "set_percent",
      percent: 100,
    });
    expect(r.status).toBe(200);
    const onV1 = await check({ "expo-current-update-id": u1 });
    expect(onV1.body.id).toBe(u2);
  });

  it("undo sends devices on the bad update back to the store build, and others to stable", async () => {
    const r = await api("POST", `/api/admin/expo/apps/${APP}/rollouts/action`, {
      channel: "production",
      platform: "android",
      runtimeVersion: RT,
      action: "undo",
    });
    expect(r.status).toBe(200);
    const onBad = await check({ "expo-current-update-id": u2 });
    expect(onBad.name).toBe("directive");
    expect(onBad.body.type).toBe("rollBackToEmbedded");
    expect(onBad.verified).toBe(true);
    const onEmbedded = await check({ "expo-current-update-id": "11111111-1111-1111-1111-111111111111" });
    expect(onEmbedded.body.id).toBe(u1);
  });

  it("serves a registered bsdiff patch as 226 IM Used to devices on the base update", async () => {
    const patchBytes = new TextEncoder().encode("BSDIFF40-fake-patch");
    const ref = await fileRef(patchBytes);
    expect((await api("PUT", `/api/admin/files/${ref.hex}`, patchBytes)).status).toBe(201);
    const reg = await api("POST", `/api/admin/expo/apps/${APP}/patches`, { baseUpdateId: u1, targetUpdateId: u2, patchHex: ref.hex });
    expect(reg.status).toBe(201);
    const { json } = await api("GET", `/api/admin/expo/updates/${u2}`);
    const target = JSON.parse(json.update.manifest).launchAsset.url as string;
    const res = await SELF.fetch(target, { headers: { "a-im": "bsdiff", "expo-current-update-id": u1 } });
    expect(res.status).toBe(226);
    expect(res.headers.get("im")).toBe("bsdiff");
    expect(res.headers.get("expo-base-update-id")).toBe(u1);
    expect(await res.text()).toBe("BSDIFF40-fake-patch");
    const other = await SELF.fetch(target, { headers: { "a-im": "bsdiff", "expo-current-update-id": "22222222-2222-2222-2222-222222222222" } });
    expect(other.status).toBe(200);
    expect(await other.text()).toBe("console.log('v2')");
  });

  // Regression: a 286 KB patch hung in production (headers, then no body) while 300-byte ones worked.
  it("serves a large (>64 KB) patch completely, from R2 and then from the edge cache", async () => {
    const big = new Uint8Array(300 * 1024);
    for (let i = 0; i < big.length; i += 65536) crypto.getRandomValues(big.subarray(i, Math.min(i + 65536, big.length)));
    big.set(new TextEncoder().encode("BSDIFF40"), 0);
    const ref = await fileRef(big);
    expect((await api("PUT", `/api/admin/files/${ref.hex}`, big)).status).toBe(201);
    expect((await api("POST", `/api/admin/expo/apps/${APP}/patches`, { baseUpdateId: u1, targetUpdateId: u2, patchHex: ref.hex })).status).toBe(201);
    const { json } = await api("GET", `/api/admin/expo/updates/${u2}`);
    const target = JSON.parse(json.update.manifest).launchAsset.url as string;
    for (let round = 0; round < 2; round++) {
      const res = await SELF.fetch(target, { headers: { "a-im": "bsdiff", "expo-current-update-id": u1 } });
      expect(res.status).toBe(226);
      expect(res.headers.get("content-length")).toBe(String(big.length));
      const got = new Uint8Array(await res.arrayBuffer());
      expect(got.length).toBe(big.length);
      expect((await fileRef(got)).hex).toBe(ref.hex);
      const plain = await SELF.fetch(`https://ota.test/files/${ref.hex}`);
      expect(plain.status).toBe(200);
      expect((await fileRef(new Uint8Array(await plain.arrayBuffer()))).hex).toBe(ref.hex);
    }
    const head = await SELF.fetch(`https://ota.test/files/${ref.hex}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(big.length));
    expect((await SELF.fetch(`https://ota.test/files/${"0".repeat(64)}`, { method: "HEAD" })).status).toBe(404);
  });

  it("refuses an upload whose bytes don't match the hash in the path", async () => {
    const ref = await fileRef(new TextEncoder().encode("real"));
    const r = await api("PUT", `/api/admin/files/${ref.hex}`, new TextEncoder().encode("tampered"));
    expect(r.status).toBe(400);
  });

  it("never serves updates to builds that don't verify signatures", async () => {
    const res = await SELF.fetch(`https://ota.test/expo/${APP}/manifest`, {
      headers: { "expo-protocol-version": "1", "expo-platform": "android", "expo-runtime-version": RT, "expo-channel-name": "production" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("x-aeron-reason")).toBe("unsigned-build");
  });

  it("rejected updates never go live", async () => {
    const p = await publish({ createdAt: "2026-11-04T00:00:00.000Z", percent: 100, bundle: new TextEncoder().encode("console.log('evil')") });
    expect(p.res.json.status).toBe("pending");
    const r = await api("POST", `/api/admin/expo/updates/${p.id}/review`, { decision: "reject" }, await reviewerToken());
    expect(r.json.status).toBe("rejected");
    const again = await api("POST", `/api/admin/expo/updates/${p.id}/review`, { decision: "approve" }, await reviewerToken());
    expect(again.status).toBe(409);
    const d = await check({ "expo-current-update-id": u2 });
    expect(d.body.type).not.toBe("manifest");
  });

  it("expired tokens are refused", async () => {
    const token = "aer_expired_test_token_0123456789abcdef";
    await env.DB.prepare("INSERT INTO api_tokens (id, name, token_hash, role, expires_at) VALUES ('t-exp', 'old', ?, 'admin', '2020-01-01T00:00:00.000Z')")
      .bind(await sha256Hex(token))
      .run();
    expect((await api("GET", "/api/admin/me", undefined, token)).status).toBe(401);
  });

  it("requires a token for the admin API", async () => {
    const r = await api("GET", "/api/admin/apps", undefined, "nope");
    expect(r.status).toBe(401);
  });

  it("scoped publisher tokens cannot touch other apps", async () => {
    const t = await api("POST", "/api/admin/tokens", { name: "ci-other", role: "publisher", apps: ["other-app"] });
    expect(t.status).toBe(201);
    const r = await api("POST", `/api/admin/expo/apps/${APP}/runtimes`, { platform: "ios", runtimeVersion: "9" }, t.json.token);
    expect(r.status).toBe(403);
  });
});
