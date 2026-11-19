import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";
import { signRsa } from "../src/expo.js";
import { parseArgs } from "../src/util.js";

test("parseArgs handles positionals, values and booleans", () => {
  const a = parseArgs(["expo", "publish", "--app", "calmi", "--rollout=10", "--critical", "--message", "fix paywall"]);
  assert.deepEqual(a._, ["expo", "publish"]);
  assert.equal(a.flags.app, "calmi");
  assert.equal(a.flags.rollout, "10");
  assert.equal(a.flags.critical, true);
  assert.equal(a.flags.message, "fix paywall");
});

test("signRsa produces an rsa-v1_5-sha256 signature expo-updates can verify", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const body = JSON.stringify({ id: "x", createdAt: new Date().toISOString() });
  const sig = signRsa(body, privateKey);
  assert.ok(verify("sha256", Buffer.from(body), publicKey, Buffer.from(sig, "base64")));
  assert.ok(!verify("sha256", Buffer.from(body + " "), publicKey, Buffer.from(sig, "base64")));
});
