const encoder = new TextEncoder();

export function toBytes(data: string | ArrayBuffer | Uint8Array): Uint8Array {
  if (typeof data === "string") return encoder.encode(data);
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (const x of b) out += x.toString(16).padStart(2, "0");
  return out;
}

export function base64(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  return base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64(s: string): Uint8Array {
  const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256(data: string | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", toBytes(data)));
}

export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  return hex(await sha256(data));
}

export function randomToken(prefix = "aer_"): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return prefix + base64Url(b);
}

export function randomId(): string {
  return crypto.randomUUID();
}

/** Constant-time comparison of two strings (length leak only). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}

function pemBody(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  return fromBase64(body);
}

/** Verify an RSASSA-PKCS1-v1_5 / SHA-256 signature (what expo-updates calls rsa-v1_5-sha256). */
export async function verifyRsaSha256(publicKeyPem: string, data: string, signatureB64: string): Promise<boolean> {
  if (!publicKeyPem.includes("BEGIN PUBLIC KEY")) {
    throw new Error("public key must be an SPKI PEM (-----BEGIN PUBLIC KEY-----)");
  }
  const key = await crypto.subtle.importKey(
    "spki",
    pemBody(publicKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  let sig: Uint8Array;
  try {
    sig = fromBase64(signatureB64);
  } catch {
    return false;
  }
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, toBytes(data));
}

/**
 * Stable rollout bucket in [0, 10000) for a device. The salt is per rollout pointer so the same
 * device lands in different buckets across apps/channels, but stays put as the percentage grows.
 */
export async function rolloutBucket(clientId: string | null | undefined, salt: string): Promise<number> {
  if (!clientId) return 9999; // unknown devices only get fully rolled-out updates
  const d = await sha256(`${salt}:${clientId}`);
  const n = ((d[0]! << 24) | (d[1]! << 16) | (d[2]! << 8) | d[3]!) >>> 0;
  return n % 10000;
}
