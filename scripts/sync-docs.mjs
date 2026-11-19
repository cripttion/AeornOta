#!/usr/bin/env node
// Copies docs/*.md into the console's static folder so the dashboard can show them at #/docs.
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "docs");
const out = join(root, "apps/server/public/docs");

// Order and groups shown in the console.
const ORDER = [
  ["Start here", "getting-started", "GETTING-STARTED.md"],
  ["Start here", "how-it-works", "HOW-IT-WORKS.md"],
  ["Start here", "setup", "SETUP.md"],
  ["Start here", "install", "INSTALL.md"],
  ["Start here", "walkthrough", "WALKTHROUGH.md"],
  ["Guides", "dashboard", "DASHBOARD.md"],
  ["Guides", "expo", "EXPO.md"],
  ["Guides", "flutter", "FLUTTER.md"],
  ["Guides", "github", "GITHUB.md"],
  ["Guides", "rollouts", "ROLLOUTS.md"],
  ["Security", "security", "SECURITY.md"],
  ["Reference", "cli", "CLI.md"],
  ["Reference", "api", "API.md"],
  ["Reference", "glossary", "GLOSSARY.md"],
  ["Reference", "faq", "FAQ.md"],
  ["Reference", "troubleshooting", "TROUBLESHOOTING.md"],
];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const pages = [];
for (const [group, slug, file] of ORDER) {
  const p = join(src, file);
  if (!existsSync(p)) continue;
  const text = readFileSync(p, "utf8");
  const title = (/^#\s+(.+)$/m.exec(text)?.[1] ?? slug).trim();
  writeFileSync(join(out, `${slug}.md`), text);
  pages.push({ slug, title, file, group });
}
writeFileSync(join(out, "index.json"), JSON.stringify({ pages }, null, 2) + "\n");
console.log(`synced ${pages.length} docs → apps/server/public/docs`);
