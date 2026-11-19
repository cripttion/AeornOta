#!/usr/bin/env node
// Measures update-check latency the way a phone sees it: one HTTPS request per check.
//
//   node scripts/bench.mjs expo   <url> [--runtime 1.0.0] [--platform android] [--n 50] [--concurrency 5]
//   node scripts/bench.mjs shorebird <base_url> --app-id <id> --release 1.0.0+1 [--n 50]
//
// Run it against your Aeron Worker and, for comparison, against any other OTA endpoint you use.
// Keep --n small when pointing at services you don't own.

const [mode, target, ...rest] = process.argv.slice(2);
const opt = (name, def) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : def;
};
if (!mode || !target) {
  console.error("usage: bench.mjs expo|shorebird <url> [options]");
  process.exit(1);
}
const n = Number(opt("n", "50"));
const concurrency = Number(opt("concurrency", "5"));

function request() {
  if (mode === "expo") {
    return fetch(target, {
      headers: {
        "expo-protocol-version": "1",
        "expo-platform": opt("platform", "android"),
        "expo-runtime-version": opt("runtime", "1.0.0"),
        "expo-channel-name": opt("channel", "production"),
        accept: "multipart/mixed",
        "eas-client-id": crypto.randomUUID(),
      },
    });
  }
  return fetch(`${target.replace(/\/$/, "")}/api/v1/patches/check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      release_version: opt("release", "1.0.0+1"),
      patch_number: null,
      platform: opt("platform", "android"),
      arch: "aarch64",
      app_id: opt("app-id", "00000000-0000-0000-0000-000000000000"),
      channel: opt("channel", "stable"),
      client_id: crypto.randomUUID(),
    }),
  });
}

const times = [];
const statuses = new Map();
let next = 0;
async function worker() {
  while (next < n) {
    next++;
    const t0 = performance.now();
    try {
      const res = await request();
      await res.arrayBuffer();
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
    } catch (e) {
      statuses.set("error", (statuses.get("error") ?? 0) + 1);
    }
    times.push(performance.now() - t0);
  }
}
const t0 = performance.now();
await Promise.all(Array.from({ length: concurrency }, worker));
const wall = performance.now() - t0;
times.sort((a, b) => a - b);
const p = (q) => times[Math.min(times.length - 1, Math.floor(q * times.length))].toFixed(1);
console.log(`${mode} ${target}`);
console.log(`requests ${times.length}  p50 ${p(0.5)} ms  p90 ${p(0.9)} ms  p99 ${p(0.99)} ms  max ${times.at(-1).toFixed(1)} ms  (${(times.length / (wall / 1000)).toFixed(1)} req/s)`);
console.log(`status codes: ${[...statuses].map(([k, v]) => `${k}×${v}`).join(", ")}`);
