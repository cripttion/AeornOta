import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export class HttpError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    message: string,
    public code = "error",
  ) {
    super(message);
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg, "bad_request");
export const unauthorized = (msg = "Missing or invalid token") => new HttpError(401, msg, "unauthorized");
export const forbidden = (msg = "Not allowed") => new HttpError(403, msg, "forbidden");
export const notFound = (msg = "Not found") => new HttpError(404, msg, "not_found");
export const conflict = (msg: string) => new HttpError(409, msg, "conflict");

export function errorResponse(c: Context, err: unknown) {
  if (err instanceof HttpError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status);
  }
  console.error("unhandled error", err);
  return c.json({ error: { code: "internal", message: "Internal error" } }, 500);
}

export async function readJson<T>(c: Context, maxBytes = 2_000_000): Promise<T> {
  const len = Number(c.req.header("content-length") ?? "0");
  if (len > maxBytes) throw badRequest(`Body too large (max ${maxBytes} bytes)`);
  const text = await c.req.text();
  if (text.length > maxBytes) throw badRequest(`Body too large (max ${maxBytes} bytes)`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw badRequest("Body must be valid JSON");
  }
}

export const APP_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const CHANNEL_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
export const RUNTIME_RE = /^[A-Za-z0-9][A-Za-z0-9._+()-]{0,99}$/;
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireMatch(value: unknown, re: RegExp, field: string): string {
  if (typeof value !== "string" || !re.test(value)) throw badRequest(`Invalid ${field}`);
  return value;
}

export function nowIso(): string {
  return new Date().toISOString();
}
