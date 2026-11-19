import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Same as vitest.config.ts, with Cloudflare Access switched on. A throwaway "GitHub"/Access signing key so tests can mint OIDC tokens the Worker will verify.
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pubJwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
const privJwk = { ...privateKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256" };

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            BOOTSTRAP_ADMIN_TOKEN: "test-bootstrap-token-0123456789",
            PUBLIC_BASE_URL: "https://ota.test",
            JWKS_OVERRIDE: JSON.stringify({
              "https://token.actions.githubusercontent.com/.well-known/jwks": { keys: [pubJwk] },
              "https://team.cloudflareaccess.com/cdn-cgi/access/certs": { keys: [pubJwk] },
            }),
            // Cloudflare Access switched on: sensitive actions need a signed-in person.
            ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
            ACCESS_AUD: "aud-test",
            TEST_OIDC_PRIVATE_JWK: JSON.stringify(privJwk),
          },
        },
      }),
    ],
    test: {
      include: ["test/access/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
