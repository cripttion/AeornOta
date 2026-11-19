export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  /** Public origin of this Worker, e.g. https://ota.example.com */
  PUBLIC_BASE_URL: string;
  /** Optional R2 custom-domain origin that serves files directly. */
  FILES_BASE_URL?: string;
  /** 0..1, fraction of device events stored. */
  EVENT_SAMPLE_RATE?: string;
  /** Secret. One-time admin token for creating the first real token. */
  BOOTSTRAP_ADMIN_TOKEN?: string;
  /** Secret. Slack/Discord-compatible webhook that receives security-relevant events. */
  NOTIFY_WEBHOOK_URL?: string;
  /** Cloudflare Access: team domain (e.g. myteam.cloudflareaccess.com) and application AUD tag.
   *  When both are set, approvals and security settings require a human Access login (SSO + MFA). */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** Break-glass switches, settable only by someone with Cloudflare account access. Leave unset. */
  ALLOW_UNSIGNED_EXPO?: string;
  ALLOW_SIGNING_CHANGES?: string;
  /** Tests only: JSON map of JWKS URL → JWKS document, used instead of fetching. */
  JWKS_OVERRIDE?: string;
}

export type Role = "admin" | "publisher" | "viewer";

export interface CiIdentity {
  repository: string;
  sha?: string;
  ref?: string;
  runUrl?: string;
}

export interface Principal {
  id: string;
  name: string;
  role: Role;
  /** null = all apps */
  apps: string[] | null;
  source?: string;
  ci?: CiIdentity | null;
  expiresAt?: string | null;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { principal: Principal; humanEmail?: string };
};
