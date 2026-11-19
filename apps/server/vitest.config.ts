import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { defineConfig } from "vitest/config";

// A throwaway "GitHub" signing key so tests can mint OIDC tokens the Worker will verify.
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
            JWKS_OVERRIDE: JSON.stringify({ "https://token.actions.githubusercontent.com/.well-known/jwks": { keys: [pubJwk] } }),
            TEST_OIDC_PRIVATE_JWK: JSON.stringify(privJwk),
          },
        },
      }),
    ],
    test: {
      include: ["test/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
