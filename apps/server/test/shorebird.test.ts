import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { api, githubOidcToken, reviewerToken, rsaKeyPair } from "./helpers";
import { base64, hex, sha256 } from "../src/lib/crypto";

const APP = "fitloop";
const VERSION = "1.0.0+1";
const REV = "b628c8acb78d46883cbbb94fe8af68909064f5a1";
let sbToken = "";
let key: Awaited<ReturnType<typeof rsaKeyPair>>;

/** Mimic the Dart CLI: bearer token, JSON sent as text/plain. */
async function cli(method: string, path: string, body?: unknown, token = sbToken) {
  const res = await SELF.fetch(`https://ota.test/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "text/plain; charset=utf-8", "x-cli-version": "1.6.143" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function form(path: string, fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await SELF.fetch(`https://ota.test/api/v1${path}`, { method: "POST", headers: { authorization: `Bearer ${sbToken}` }, body: fd });
  return { status: res.status, json: await res.json<any>() };
}

async function resumableUpload(url: string, bytes: Uint8Array) {
  const CHUNK = 8 * 1024 * 1024;
  let offset = 0;
  let last: Response | null = null;
  while (offset < bytes.length) {
    const end = Math.min(offset + CHUNK, bytes.length) - 1;
    last = await SELF.fetch(url, {
      method: "PUT",
      headers: { "content-range": `bytes ${offset}-${end}/${bytes.length}`, authorization: `Bearer ${sbToken}` },
      body: bytes.slice(offset, end + 1),
    });
    if (last.status === 308) {
      const range = last.headers.get("range");
      offset = range ? Number(range.split("-")[1]) + 1 : 0;
      await last.arrayBuffer();
      continue;
    }
    break;
  }
  return last!;
}

const zstd = (n: number) => {
  const b = new Uint8Array(n);
  b.set([0x28, 0xb5, 0x2f, 0xfd]);
  for (let i = 4; i < n; i++) b[i] = i % 251;
  return b;
};

async function check(extra: Record<string, unknown> = {}) {
  const res = await SELF.fetch("https://ota.test/api/v1/patches/check", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: APP, channel: "stable", release_version: VERSION, platform: "android", arch: "aarch64", client_id: "device-1", ...extra }),
  });
  expect(res.headers.get("cache-control")).toBe("no-store");
  return res.json<any>();
}

describe("Shorebird-compatible flow (stock CLI call order)", () => {
  let releaseId = 0;
  let patchId = 0;
  let channelId = 0;
  const libapp = zstd(1000); // stands in for libapp.so
  let libappHash = "";

  beforeAll(async () => {
    const t = await api("POST", "/api/admin/tokens", { name: "shorebird-ci", role: "admin", format: "shorebird" });
    expect(t.status).toBe(201);
    sbToken = t.json.token;
    expect(sbToken.startsWith("sb_api_")).toBe(true);
    key = await rsaKeyPair();
    libappHash = hex(await sha256(libapp));
  });

  it("rejects bad credentials with 401 and a Shorebird error body", async () => {
    const r = await cli("GET", "/organizations", undefined, "sb_api_nope");
    expect(r.status).toBe(401);
    expect(r.json.code).toBe("unauthorized");
  });

  it("init: lists one organization and creates the app", async () => {
    const orgs = await cli("GET", "/organizations");
    expect(orgs.json.organizations[0].role).toBe("owner");
    const app = await cli("POST", "/apps", { display_name: "fitloop", organization_id: 1 });
    expect(app.status).toBe(201);
    expect(app.json).toEqual({ id: "fitloop", display_name: "fitloop" });
    const meta = await cli("GET", `/apps/${APP}`);
    expect(meta.json.organization_id).toBe(1);
    const set = await api("POST", `/api/admin/flutter/apps/${APP}/settings`, { publicKeyPem: key.pem });
    expect(set.status).toBe(200);
  });

  it("refuses managed signing (the server never holds a private key)", async () => {
    const r = await cli("GET", `/apps/${APP}/signing-key`);
    expect(r.status).toBe(503);
    expect(r.json.message).toContain("--public-key-path");
  });

  it("release: create, draft, upload artifacts (single and chunked), activate", async () => {
    const created = await cli("POST", `/apps/${APP}/releases`, { version: VERSION, flutter_revision: REV, flutter_version: "3.38.0" });
    expect(created.status).toBe(201);
    releaseId = created.json.release.id;
    expect((await cli("PATCH", `/apps/${APP}/releases/${releaseId}`, { status: "draft", platform: "android" })).status).toBe(204);

    const unsigned = await form(`/apps/${APP}/releases/${releaseId}/artifacts`, {
      arch: "aarch64", platform: "android", hash: libappHash, filename: "libapp.so", can_sideload: "false", size: String(libapp.length), signing: '{"mode":"unsigned"}',
    });
    expect(unsigned.status).toBe(400);
    expect(unsigned.json.code).toBe("patch_signing_required");

    const reg = await form(`/apps/${APP}/releases/${releaseId}/artifacts`, {
      arch: "aarch64", platform: "android", hash: libappHash, filename: "libapp.so", can_sideload: "false", size: String(libapp.length), signing: '{"mode":"customer"}',
    });
    expect(reg.status).toBe(201);
    expect(reg.json.upload_method).toBe("resumable");
    expect((await resumableUpload(reg.json.url, libapp)).status).toBe(200);

    const aab = zstd(9 * 1024 * 1024 + 123); // two chunks → R2 multipart
    const aabReg = await form(`/apps/${APP}/releases/${releaseId}/artifacts`, {
      arch: "aab", platform: "android", hash: hex(await sha256(aab)), filename: "app.aab", can_sideload: "true", size: String(aab.length), signing: '{"mode":"customer"}',
    });
    const up = await resumableUpload(aabReg.json.url, aab);
    expect(up.status).toBe(200);

    const active = await cli("PATCH", `/apps/${APP}/releases/${releaseId}`, { status: "active", platform: "android", metadata: { release_platform: "android" } });
    expect(active.status).toBe(204);
    const list = await cli("GET", `/apps/${APP}/releases`);
    expect(list.json.releases[0].platforms.android).toEqual({ status: "active", signing_mode: "customer" });
  });

  it("patch: fetches release artifacts (empty list for missing archs) and downloads them", async () => {
    const missing = await cli("GET", `/apps/${APP}/releases/${releaseId}/artifacts?arch=x86_64&platform=android`);
    expect(missing.status).toBe(200);
    expect(missing.json.artifacts).toEqual([]);
    const a = await cli("GET", `/apps/${APP}/releases/${releaseId}/artifacts?arch=aab&platform=android`);
    expect(a.json.artifacts).toHaveLength(1);
    const dl = await SELF.fetch(a.json.artifacts[0].url);
    expect(dl.status).toBe(200);
    expect((await dl.arrayBuffer()).byteLength).toBe(9 * 1024 * 1024 + 123);
  });

  it("patch: requires a valid signature, uploads, creates channel and promotes", async () => {
    const p = await cli("POST", `/apps/${APP}/patches`, { release_id: releaseId, metadata: { release_platform: "android" } });
    expect(p.status).toBe(201);
    expect(p.json.number).toBe(1);
    patchId = p.json.id;
    const patchBytes = zstd(400);
    const newLibHash = hex(await sha256(new TextEncoder().encode("new libapp")));
    const base = { arch: "aarch64", platform: "android", hash: newLibHash, size: String(patchBytes.length) };
    expect((await form(`/apps/${APP}/patches/${patchId}/artifacts`, base)).json.code).toBe("patch_signature_required");
    expect((await form(`/apps/${APP}/patches/${patchId}/artifacts`, { ...base, hash_signature: base64(new Uint8Array(256)) })).json.code).toBe("patch_signature_invalid");
    const sig = await key.sign(newLibHash);
    const reg = await form(`/apps/${APP}/patches/${patchId}/artifacts`, { ...base, hash_signature: sig });
    expect(reg.status).toBe(201);
    expect((await resumableUpload(reg.json.url, patchBytes)).status).toBe(200);

    expect((await cli("GET", `/apps/${APP}/channels`)).json).toEqual([]);
    const ch = await cli("POST", `/apps/${APP}/channels`, { channel: "stable" });
    channelId = ch.json.id;
    const promote = await cli("POST", `/apps/${APP}/patches/promote`, { patch_id: patchId, channel_id: channelId });
    expect(promote.status).toBe(204);
    expect((await check()).patch_available).toBe(false); // waiting for approval
    const approvals = await api("GET", "/api/admin/approvals");
    expect(approvals.json.flutter[0].number).toBe(1);
    const ok = await api("POST", `/api/admin/flutter/apps/${APP}/patches/${patchId}/action`, { channel: "stable", action: "approve" }, await reviewerToken());
    expect(ok.status).toBe(200);
  });

  it("device: gets the signed patch, can resume the download, and reports events", async () => {
    const r = await check();
    expect(r.patch_available).toBe(true);
    expect(r.patch.number).toBe(1);
    expect(r.patch.hash_signature).toBeTruthy();
    const ranged = await SELF.fetch(r.patch.download_url, { headers: { range: "bytes=100-" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe("bytes 100-399/400");
    expect((await ranged.arrayBuffer()).byteLength).toBe(300);
    const ev = await SELF.fetch("https://ota.test/api/v1/patches/events", {
      method: "POST",
      body: JSON.stringify({ event: { app_id: APP, arch: "aarch64", client_id: "device-1", type: "__patch_install__", patch_number: 1, platform: "android", release_version: VERSION, timestamp: 1, message: null, event_id: crypto.randomUUID() } }),
    });
    expect(ev.status).toBe(204);
    expect((await check({ patch_number: 1 })).patch_available).toBe(false); // legacy updater already has it
  });

  it("a 0% rollout hides the patch; rollback tells devices to uninstall", async () => {
    await api("POST", `/api/admin/flutter/apps/${APP}/patches/${patchId}/action`, { channel: "stable", action: "halt" });
    expect((await check()).patch_available).toBe(false);
    await api("POST", `/api/admin/flutter/apps/${APP}/patches/${patchId}/action`, { channel: "stable", action: "set_percent", percent: 100 });
    expect((await check()).patch_available).toBe(true);
    const rb = await cli("POST", `/apps/${APP}/releases/${releaseId}/patches/${patchId}/rollback`);
    expect(rb.status).toBe(204);
    const r = await check({ current_patch_number: 1 });
    expect(r.patch_available).toBe(false);
    expect(r.rolled_back_patch_numbers).toEqual([1]);
    expect((await cli("POST", `/apps/${APP}/releases/${releaseId}/patches/${patchId}/rollback`)).status).toBe(304);
  });

  it("the signing key and the signing requirement are locked once a release is live", async () => {
    const other = await rsaKeyPair();
    const swap = await api("POST", `/api/admin/flutter/apps/${APP}/settings`, { publicKeyPem: other.pem });
    expect(swap.status).toBe(409);
    const off = await api("POST", `/api/admin/flutter/apps/${APP}/settings`, { requireSigning: false });
    expect(off.status).toBe(409);
  });

  it("GitHub Actions OIDC: trusted repo gets a 1-hour scoped token with verified provenance", async () => {
    const rule = await api("POST", "/api/admin/github/trust", { appId: APP, repository: "Acme/FitLoop", ref: "main" });
    expect(rule.status).toBe(201);
    const good = await githubOidcToken({ repository: "acme/fitloop", ref: "refs/heads/main", sha: "abc1234def", run_id: "42", sub: "repo:acme/fitloop:ref:refs/heads/main" });
    const ex = await SELF.fetch("https://ota.test/api/auth/github", { method: "POST", body: JSON.stringify({ token: good }) });
    expect(ex.status).toBe(200);
    const j = await ex.json<any>();
    expect(j.token.startsWith("sb_api_")).toBe(true);
    expect(j.apps).toEqual([APP]);
    expect(j.ci.runUrl).toBe("https://github.com/acme/fitloop/actions/runs/42");
    const me = await api("GET", "/api/admin/me", undefined, j.token);
    expect(me.json.principal.role).toBe("publisher");
    expect(me.json.principal.ci.sha).toBe("abc1234def");
    const branch = await githubOidcToken({ repository: "acme/fitloop", ref: "refs/heads/feature", run_id: "43" });
    expect((await SELF.fetch("https://ota.test/api/auth/github", { method: "POST", body: JSON.stringify({ token: branch }) })).status).toBe(403);
    const forged = good.slice(0, -4) + "AAAA";
    expect((await SELF.fetch("https://ota.test/api/auth/github", { method: "POST", body: JSON.stringify({ token: forged }) })).status).toBe(401);
  });

  it("unknown apps get a quiet no-patch answer", async () => {
    expect(await check({ app_id: "nope" })).toEqual({ patch_available: false, rolled_back_patch_numbers: [] });
  });

  it("console data includes releases, patches and channels", async () => {
    const r = await api("GET", `/api/admin/flutter/apps/${APP}`);
    expect(r.json.releases[0].patches[0].channels[0].channel).toBe("stable");
    const o = await api("GET", "/api/admin/overview");
    expect(o.status).toBe(200);
  });
});
