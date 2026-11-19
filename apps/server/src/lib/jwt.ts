import type { Env } from "../env";
import { fromBase64 } from "./crypto";

/** Minimal RS256 JWT verification against a JWKS endpoint (GitHub Actions OIDC, Cloudflare Access). */

export interface JwtClaims {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  email?: string;
  [k: string]: unknown;
}

interface Jwk {
  kid?: string;
  kty: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
}

const decoder = new TextDecoder();

async function loadJwks(env: Env, url: string): Promise<Jwk[]> {
  if (env.JWKS_OVERRIDE) {
    const map = JSON.parse(env.JWKS_OVERRIDE) as Record<string, { keys: Jwk[] }>;
    if (map[url]) return map[url]!.keys;
  }
  const cache = caches.default;
  const key = new Request(`https://aeron.internal/jwks/${encodeURIComponent(url)}`);
  const hit = await cache.match(key);
  if (hit) return ((await hit.json()) as { keys: Jwk[] }).keys;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = await res.text();
  await cache.put(key, new Response(body, { headers: { "cache-control": "max-age=3600" } }));
  return (JSON.parse(body) as { keys: Jwk[] }).keys;
}

export class JwtError extends Error {}

export async function verifyJwt(env: Env, token: string, jwksUrl: string, opts: { issuer: string; audience: string }): Promise<JwtClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtError("malformed token");
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let claims: JwtClaims;
  try {
    header = JSON.parse(decoder.decode(fromBase64(h)));
    claims = JSON.parse(decoder.decode(fromBase64(p)));
  } catch {
    throw new JwtError("malformed token");
  }
  if (header.alg !== "RS256") throw new JwtError("unsupported alg");
  let keys = await loadJwks(env, jwksUrl);
  let jwk = keys.find((k) => k.kid === header.kid && k.kty === "RSA");
  if (!jwk) {
    // Keys rotate: refetch once, bypassing the cache.
    await caches.default.delete(new Request(`https://aeron.internal/jwks/${encodeURIComponent(jwksUrl)}`));
    keys = await loadJwks(env, jwksUrl);
    jwk = keys.find((k) => k.kid === header.kid && k.kty === "RSA");
  }
  if (!jwk) throw new JwtError("unknown signing key");
  const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromBase64(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new JwtError("bad signature");
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp < now - 60) throw new JwtError("token expired");
  if (typeof claims.nbf === "number" && claims.nbf > now + 60) throw new JwtError("token not yet valid");
  if (claims.iss !== opts.issuer) throw new JwtError("wrong issuer");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(opts.audience)) throw new JwtError("wrong audience");
  return claims;
}
