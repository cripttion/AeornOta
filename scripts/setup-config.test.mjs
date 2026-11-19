import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { choosePublicUrl, customDomains, getValue, removeCustomDomains, setCustomDomain, setValue } from "./setup-config.mjs";

const real = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../apps/server/wrangler.jsonc"), "utf8");
const bare = `{
  "name": "aeron",
  "compatibility_date": "2026-08-01",
  "d1_databases": [{ "binding": "DB", "database_name": "aeron", "database_id": "old-id" }],
  "vars": { "PUBLIC_BASE_URL": "https://aeron.someone.workers.dev" }
}
`;

test("reads and writes string values without touching the rest", () => {
  assert.equal(getValue(bare, "database_id"), "old-id");
  const s = setValue(bare, "database_id", "new-id");
  assert.equal(getValue(s, "database_id"), "new-id");
  assert.equal(s.replace("new-id", "old-id"), bare);
});

test("a clone of a deployment with a custom domain drops that domain and keeps everything else", () => {
  const domains = customDomains(real);
  if (!domains.length) return; // this checkout has no custom domain configured
  const s = removeCustomDomains(real);
  assert.deepEqual(customDomains(s), []);
  assert.ok(!/"routes"/.test(s));
  assert.equal(s.split("\n").length, real.split("\n").length - 1, "only the routes line is removed");
  assert.equal(getValue(s, "database_id"), getValue(real, "database_id"));
  assert.ok(/"workers_dev":\s*true/.test(s), "workers.dev stays on");
});

test("a root domain gets www too, and keeps workers.dev on", () => {
  const s = setCustomDomain(bare, "example.com");
  assert.deepEqual(customDomains(s), ["example.com", "www.example.com"]);
  assert.ok(/"workers_dev":\s*true/.test(s));
  assert.ok(/"preview_urls":\s*false/.test(s));
});

test("a subdomain gets only itself", () => {
  assert.deepEqual(customDomains(setCustomDomain(bare, "ota.example.com")), ["ota.example.com"]);
});

test("setting a domain twice replaces it instead of adding a second list", () => {
  const s = setCustomDomain(setCustomDomain(bare, "one.example.com"), "two.example.com");
  assert.deepEqual(customDomains(s), ["two.example.com"]);
  assert.equal((s.match(/"routes"/g) || []).length, 1);
  assert.equal((s.match(/"workers_dev"/g) || []).length, 1);
});

test("removing domains from a config without any is a no-op", () => {
  assert.equal(removeCustomDomains(bare), bare);
});

test("re-running setup keeps your custom domain as the main address", () => {
  const withDomain = setCustomDomain(bare, "ota.example.com");
  assert.equal(choosePublicUrl({ text: withDomain, workersUrl: "https://aeron.me.workers.dev" }), "https://ota.example.com");
  assert.equal(choosePublicUrl({ domain: "new.example.com", text: withDomain, workersUrl: "https://aeron.me.workers.dev" }), "https://new.example.com");
});

test("without a custom domain the workers.dev address is the main address", () => {
  assert.equal(choosePublicUrl({ text: bare, workersUrl: "https://aeron.me.workers.dev" }), "https://aeron.me.workers.dev");
  assert.equal(choosePublicUrl({ text: removeCustomDomains(real), workersUrl: "https://aeron.me.workers.dev" }), "https://aeron.me.workers.dev");
});
