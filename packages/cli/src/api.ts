import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError } from "./util.js";

export interface CliConfig {
  server: string;
  token: string;
}

const CONFIG_PATH = join(process.env.AERON_CONFIG_DIR ?? join(homedir(), ".aeron"), "config.json");

/**
 * Inside GitHub Actions with `permissions: id-token: write`, trade GitHub's OIDC token for a
 * one-hour Aeron token. No Aeron secret needs to be stored in the repository.
 */
async function githubOidcLogin(server: string): Promise<string | null> {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const reqToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !reqToken) return null;
  const sep = url.includes("?") ? "&" : "?";
  const res = await fetch(`${url}${sep}audience=${encodeURIComponent(server)}`, { headers: { authorization: `Bearer ${reqToken}` } });
  if (!res.ok) throw new CliError(`Could not get a GitHub OIDC token (${res.status}). Does the workflow have permissions: id-token: write?`);
  const { value } = (await res.json()) as { value: string };
  const ex = await fetch(`${server}/api/auth/github`, { method: "POST", headers: { "content-type": "application/json", ...accessHeaders() }, body: JSON.stringify({ token: value }) });
  const body = (await ex.json().catch(() => null)) as { token?: string; error?: { message?: string } } | null;
  if (!ex.ok || !body?.token) throw new CliError(`Aeron refused this GitHub workflow: ${body?.error?.message ?? ex.statusText}`);
  // Mask it in GitHub logs, and expose it to later steps (e.g. the shorebird CLI) as SHOREBIRD_TOKEN.
  process.stdout.write(`::add-mask::${body.token}\n`);
  return body.token;
}

export async function loadConfig(): Promise<CliConfig> {
  const envServer = process.env.AERON_SERVER?.replace(/\/$/, "");
  const envToken = process.env.AERON_TOKEN;
  if (envServer && envToken) return { server: envServer, token: envToken };
  if (envServer && process.env.GITHUB_ACTIONS === "true") {
    const t = await githubOidcLogin(envServer);
    if (t) {
      process.env.AERON_TOKEN = t;
      return { server: envServer, token: t };
    }
  }
  let file: Partial<CliConfig> = {};
  try {
    file = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch {
    /* no config yet */
  }
  const server = (envServer ?? file.server ?? "").replace(/\/$/, "");
  const token = envToken ?? file.token ?? "";
  if (!server || !token) throw new CliError("Not logged in. Run: aeron login --server https://ota.example.com --token <token>  (or set AERON_SERVER and AERON_TOKEN)");
  return { server, token };
}

export async function saveConfig(cfg: CliConfig) {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  await chmod(CONFIG_PATH, 0o600).catch(() => undefined); // no-op on Windows
  return CONFIG_PATH;
}

/** Cloudflare Access service-token headers, when the admin API sits behind Access. */
function accessHeaders(): Record<string, string> {
  const id = process.env.AERON_CF_ACCESS_CLIENT_ID;
  const secret = process.env.AERON_CF_ACCESS_CLIENT_SECRET;
  return id && secret ? { "cf-access-client-id": id, "cf-access-client-secret": secret } : {};
}

export class Api {
  constructor(private cfg: CliConfig) {}

  get server() {
    return this.cfg.server;
  }

  get token() {
    return this.cfg.token;
  }

  async request<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const h: Record<string, string> = { authorization: `Bearer ${this.cfg.token}`, ...accessHeaders(), ...headers };
    let payload: Uint8Array | string | undefined;
    if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
      payload = body as Uint8Array;
    } else if (body !== undefined) {
      h["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await fetch(`${this.cfg.server}${path}`, { method, headers: h, body: payload });
    } catch (e) {
      throw new CliError(`Cannot reach ${this.cfg.server}: ${(e as Error).message}`);
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const msg = json?.error?.message ?? json?.message ?? json?.raw ?? res.statusText;
      throw new CliError(`${method} ${path} failed (${res.status}): ${msg}`);
    }
    return json as T;
  }
}
