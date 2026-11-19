declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      BUCKET: R2Bucket;
      ASSETS: Fetcher;
      TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
      BOOTSTRAP_ADMIN_TOKEN: string;
      PUBLIC_BASE_URL: string;
      FILES_BASE_URL?: string;
      EVENT_SAMPLE_RATE?: string;
      JWKS_OVERRIDE: string;
      TEST_OIDC_PRIVATE_JWK: string;
    }
  }
}
export {};
