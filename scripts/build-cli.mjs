#!/usr/bin/env node
// Bundles the aeron CLI into one dependency-free file and publishes it with the console at
// /cli/aeron.mjs (+ .sha256), so Mac, Windows and CI can download it straight from your server.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "apps/server/public/cli");
mkdirSync(outDir, { recursive: true });
const outfile = join(outDir, "aeron.mjs");

await build({
  entryPoints: [join(root, "packages/cli/src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile,
  // Path comments in the bundle are relative to this, so the bytes (and the pinned AERON_CLI_SHA256)
  // are the same whichever folder the build runs from.
  absWorkingDir: root,
  legalComments: "none",
  logLevel: "warning",
});

// esbuild keeps the source shebang; make sure there's exactly one.
let code = readFileSync(outfile, "utf8").replace(/^#!.*\n/, "");
code = "#!/usr/bin/env node\n" + code;
writeFileSync(outfile, code);
const sha = createHash("sha256").update(code).digest("hex");
writeFileSync(join(outDir, "aeron.mjs.sha256"), `${sha}  aeron.mjs\n`);
console.log(`built apps/server/public/cli/aeron.mjs (${(code.length / 1024).toFixed(0)} KB, sha256 ${sha})`);
