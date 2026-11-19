import { SELF, env } from "cloudflare:test";
import { base64, base64Url, hex, sha256 } from "../src/lib/crypto";

export const BOOT = "test-bootstrap-token-0123456789";

export async function api(method: string, path: string, body?: unknown, token = BOOT, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...extraHeaders };
  let payload: BodyInit | undefined;
  if (body instanceof Uint8Array) {
    payload = body;
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await SELF.fetch(`https://ota.test${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}

export async function rsaKeyPair() {
  const kp = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const spki = new Uint8Array((await crypto.subtle.exportKey("spki", kp.publicKey)) as ArrayBuffer);
  const b64 = base64(spki).replace(/(.{64})/g, "$1\n");
  const pem = `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`;
  const sign = async (data: string) =>
    base64(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(data))));
  return { pem, sign, publicKey: kp.publicKey };
}

let reviewer: string | null = null;
/** A second admin token: approvals must come from a different token than the publisher. */
export async function reviewerToken() {
  if (!reviewer) {
    const r = await api("POST", "/api/admin/tokens", { name: "reviewer", role: "admin" });
    reviewer = r.json.token as string;
  }
  return reviewer;
}

/** Sign a GitHub-style OIDC token with the test key the Worker trusts via JWKS_OVERRIDE. */
export async function githubOidcToken(claims: Record<string, unknown>) {
  const jwk = JSON.parse(env.TEST_OIDC_PRIVATE_JWK);
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const enc = (o: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(o)));
  const now = Math.floor(Date.now() / 1000);
  const body = `${enc({ alg: "RS256", kid: "test-key", typ: "JWT" })}.${enc({
    iss: "https://token.actions.githubusercontent.com",
    aud: "https://ota.test",
    iat: now,
    nbf: now - 5,
    exp: now + 300,
    ...claims,
  })}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(body)));
  return `${body}.${base64Url(sig)}`;
}

export async function fileRef(bytes: Uint8Array) {
  const d = await sha256(bytes);
  return { hex: hex(d), b64url: base64Url(d) };
}

export { env };
