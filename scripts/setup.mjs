#!/usr/bin/env node
// One-command Aeron server setup on Cloudflare. Works on macOS, Linux and Windows.
//
//   npm run setup                          first-time setup, or re-run any time to update
//   npm run setup -- --domain ota.acme.com use your own domain (its DNS must be on Cloudflare)
//   npm run setup -- --account <id>        pick the Cloudflare account when you have several
//
// Safe to run again: it reuses the database and storage it finds, applies only new database changes,
// and creates the one-time setup token only while the server has no access tokens yet.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "apps", "server");
const CONFIG = join(SERVER, "wrangler.jsonc");
const WIN = process.platform === "win32";
const TOTAL = 9;

// ------------------------------------------------------------------ output

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\u001b[${code}m${s}\u001b[0m` : s);
const bold = paint(1);
const green = paint(32);
const red = paint(31);
const yellow = paint(33);
const dim = paint(2);

let n = 0;
const step = (text) => console.log(`\n${bold(`[${++n}/${TOTAL}]`)} ${bold(text)}`);
const ok = (text) => console.log(`  ${green("✓")} ${text}`);
const info = (text) => console.log(`  ${dim(text)}`);
const warn = (text) => console.log(`  ${yellow("!")} ${text}`);
function fail(text, ...help) {
  console.log(`  ${red("✗")} ${text}`);
  for (const line of help) console.log(`    ${line}`);
  console.log(`\n  Fix that, then run ${bold("npm run setup")} again. It picks up where it left off.`);
  console.log(`  Step-by-step guide: docs/SETUP.md (or Documentation → "Set up your Aeron server").\n`);
  process.exit(1);
}

// ------------------------------------------------------------------ processes

const quote = (a) => (WIN && /[\s"&|<>^()*]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

/** Runs a command. capture: collect output quietly; otherwise the user sees it (and can answer prompts). */
function run(cmd, args, { cwd = SERVER, capture = true, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, WIN ? args.map(quote) : args, {
      cwd,
      shell: WIN,
      env: { ...process.env, FORCE_COLOR: "0", WRANGLER_SEND_METRICS: "false" },
      stdio: capture ? ["pipe", "pipe", "pipe"] : "inherit",
    });
    let out = "";
    if (capture) {
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      if (input !== undefined) child.stdin.end(input);
      else child.stdin.end();
    }
    child.on("error", (e) => resolve({ code: 1, out: String(e) }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const wrangler = (args, opts) => run("npx", ["--no-install", "wrangler", ...args], opts);
const lastLines = (s, k = 15) => s.trim().split(/\r?\n/).slice(-k).map((l) => dim(l));

// ------------------------------------------------------------------ config file

const readConfig = () => readFileSync(CONFIG, "utf8");
const writeConfig = (s) => writeFileSync(CONFIG, s);
const configValue = (key) => new RegExp(`"${key}":\\s*"([^"]*)"`).exec(readConfig())?.[1] ?? "";
function setConfigValue(key, value) {
  const s = readConfig();
  const next = s.replace(new RegExp(`("${key}":\\s*)"[^"]*"`), `$1"${value}"`);
  if (next !== s) writeConfig(next);
  return next !== s;
}
function setCustomDomain(domain) {
  let s = readConfig();
  // A root domain (example.com) also gets www.example.com, which redirects to it.
  const hosts = domain.split(".").length === 2 ? [domain, `www.${domain}`] : [domain];
  const routes = `"routes": [${hosts.map((h) => `{ "pattern": "${h}", "custom_domain": true }`).join(", ")}],`;
  if (/"routes":\s*\[[^\]]*\],?/.test(s)) s = s.replace(/"routes":\s*\[[^\]]*\],?/, routes);
  else s = s.replace(/("compatibility_date":\s*"[^"]*",)/, `$1\n  ${routes}`);
  // With routes, wrangler would switch the *.workers.dev address off; keep both working.
  if (!/"workers_dev":/.test(s)) s = s.replace(routes, `${routes}\n  "workers_dev": true,\n  "preview_urls": false,`);
  writeConfig(s);
}

// ------------------------------------------------------------------ args

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`Aeron server setup

  npm run setup                            set up (or update) your Aeron server on Cloudflare
  npm run setup -- --domain ota.acme.com   serve it on your own domain (DNS must be on Cloudflare)
  npm run setup -- --account <account id>  choose the Cloudflare account when you have several

Without CLOUDFLARE_API_TOKEN set, a browser window opens so you can sign in to Cloudflare.`);
  process.exit(0);
}
const domain = flag("domain")?.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
if (argv.includes("--domain") && !domain) fail("--domain needs a value, for example: npm run setup -- --domain ota.acme.com");

// ------------------------------------------------------------------ main

console.log(bold("\nSetting up your Aeron server on Cloudflare"));
info("This takes about 3 minutes. You can run it again safely at any time.");

// 1. Computer
step("Checking your computer");
const major = Number(process.versions.node.split(".")[0]);
if (major < 20) fail(`Node.js ${process.versions.node} is too old. Aeron needs version 20 or newer.`, "Install the LTS version from https://nodejs.org, open a new terminal window, and try again.");
ok(`Node.js ${process.versions.node}`);
if (!existsSync(CONFIG)) fail("Can't find apps/server/wrangler.jsonc.", "Run this from the aeron folder you cloned or copied.");

// 2. Dependencies
step("Installing Aeron's building blocks");
if (existsSync(join(ROOT, "node_modules", "wrangler")) || existsSync(join(SERVER, "node_modules", "wrangler"))) ok("Already installed");
else {
  info("Downloading packages (1-2 minutes; warnings are normal)…");
  const r = await run("npm", ["install", "--legacy-peer-deps"], { cwd: ROOT });
  if (r.code !== 0) fail("npm install failed.", ...lastLines(r.out));
  ok("Installed");
}

// 3. Cloudflare sign-in and account
step("Signing in to Cloudflare");
let who = await wrangler(["whoami"]);
const signedIn = (o) => o.code === 0 && !/not authenticated|not logged in/i.test(o.out);
if (!signedIn(who)) {
  if (process.env.CLOUDFLARE_API_TOKEN) fail("Cloudflare didn't accept CLOUDFLARE_API_TOKEN.", "Check the token, or unset it to sign in with your browser instead.", ...lastLines(who.out, 5));
  info("A browser window will open. Sign in to Cloudflare and click Allow, then come back here.");
  const login = await wrangler(["login"], { capture: false });
  who = await wrangler(["whoami"]);
  if (login.code !== 0 || !signedIn(who)) fail("Couldn't sign in to Cloudflare.", "If no browser opened (for example over SSH), use an API token instead: see the guide, section \"Using an API token\".");
}
const accounts = [...who.out.matchAll(/│\s*(.+?)\s*│\s*([0-9a-f]{32})\s*│/g)].map((m) => ({ name: m[1], id: m[2] }));
let account = flag("account") || process.env.CLOUDFLARE_ACCOUNT_ID;
if (!account) {
  if (accounts.length === 1) account = accounts[0].id;
  else if (accounts.length > 1) {
    if (!process.stdin.isTTY) fail("You have several Cloudflare accounts.", "Choose one: npm run setup -- --account <account id>", ...accounts.map((a) => `${a.id}  ${a.name}`));
    console.log("  You have several Cloudflare accounts. Which one should Aeron live in?");
    accounts.forEach((a, i) => console.log(`    ${i + 1}) ${a.name}`));
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const pick = Number(await rl.question("  Type a number and press Enter: "));
    rl.close();
    if (!accounts[pick - 1]) fail("That isn't one of the numbers listed.");
    account = accounts[pick - 1].id;
  }
}
if (account) process.env.CLOUDFLARE_ACCOUNT_ID = account;
ok(`Signed in${account ? `, using account "${accounts.find((a) => a.id === account)?.name ?? account}"` : ""}`);

// 4. Database (D1)
step("Database (Cloudflare D1)");
const listDbs = async () => {
  const r = await wrangler(["d1", "list", "--json"]);
  try {
    return JSON.parse(r.out.slice(r.out.indexOf("[")));
  } catch {
    fail("Couldn't list your D1 databases.", ...lastLines(r.out));
  }
};
let db = (await listDbs()).find((d) => d.name === "aeron");
if (db) ok("Found the database \"aeron\"");
else {
  const r = await wrangler(["d1", "create", "aeron"]);
  if (r.code !== 0) fail("Couldn't create the database.", ...lastLines(r.out));
  db = (await listDbs()).find((d) => d.name === "aeron");
  if (!db) fail("The database was created but can't be found. Run setup again in a minute.");
  ok("Created the database \"aeron\"");
}
if (setConfigValue("database_id", db.uuid)) info("Saved its id in apps/server/wrangler.jsonc");

// 5. File storage (R2)
step("File storage (Cloudflare R2)");
const buckets = await wrangler(["r2", "bucket", "list"]);
if (/^name:\s+aeron\s*$/m.test(buckets.out)) ok("Found the storage bucket \"aeron\"");
else {
  const r = await wrangler(["r2", "bucket", "create", "aeron"]);
  if (r.code !== 0 && !/already exists/i.test(r.out)) {
    if (/10042|enable R2|R2 through the Cloudflare Dashboard|purchase/i.test(r.out + buckets.out)) {
      fail(
        "R2 file storage isn't switched on for this Cloudflare account yet.",
        "1. Open https://dash.cloudflare.com and choose your account.",
        "2. In the left menu: Storage & databases → R2 → Overview, and follow the steps to activate R2.",
        "   Cloudflare may ask for a card or PayPal. Usage inside the free allowance (10 GB stored,",
        "   1 million uploads and 10 million downloads a month) costs $0.",
      );
    }
    fail("Couldn't create the storage bucket.", ...lastLines(r.out));
  }
  ok("Created the storage bucket \"aeron\"");
}

// 6. Database tables
step("Database tables");
const mig = await wrangler(["d1", "migrations", "apply", "aeron", "--remote"]);
if (mig.code !== 0) fail("Couldn't set up the database tables.", ...lastLines(mig.out));
ok(/No migrations to apply/i.test(mig.out) ? "Already up to date" : "Tables created or updated");

// 7. Deploy
step("Putting your server online (Cloudflare Workers)");
if (domain) {
  setCustomDomain(domain);
  setConfigValue("PUBLIC_BASE_URL", `https://${domain}`);
  info(`Using your domain ${domain}`);
}
info("Building the dashboard, docs and CLI, then uploading (about 30 seconds)…");
let dep = await run("npm", ["run", "deploy"]);
if (dep.code !== 0) {
  if (/workers\.dev subdomain|register a workers\.dev|subdomain/i.test(dep.out)) {
    fail(
      "Your Cloudflare account doesn't have a workers.dev address yet.",
      "1. Open https://dash.cloudflare.com → Workers & Pages.",
      "2. Choose a subdomain when asked (for example your company name). Your server will be at",
      "   https://aeron.<subdomain>.workers.dev",
    );
  }
  if (domain && /zone|custom domain|hostname/i.test(dep.out)) fail(`Cloudflare couldn't attach ${domain}.`, "The domain's DNS must be managed by this Cloudflare account (Websites → Add a site).", ...lastLines(dep.out, 8));
  fail("Deploying failed.", ...lastLines(dep.out));
}
const workersUrl = /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i.exec(dep.out)?.[0];
const publicUrl = domain ? `https://${domain}` : workersUrl || configValue("PUBLIC_BASE_URL");
if (setConfigValue("PUBLIC_BASE_URL", publicUrl)) {
  info(`Saving your server address (${publicUrl}) and deploying once more…`);
  dep = await wrangler(["deploy"]);
  if (dep.code !== 0) fail("The second deploy failed.", ...lastLines(dep.out));
}
ok(`Online at ${bold(publicUrl)}`);

// 8. One-time setup token
step("One-time setup token");
const count = await wrangler(["d1", "execute", "aeron", "--remote", "--json", "--command", "SELECT COUNT(*) AS n FROM api_tokens"]);
let tokens = -1;
try {
  tokens = JSON.parse(count.out.slice(count.out.indexOf("[")))[0].results[0].n;
} catch {
  /* unknown: treat as existing so we never re-open a server by accident */
}
let setupToken = null;
if (tokens === 0) {
  setupToken = `aer_boot_${randomBytes(32).toString("base64url")}`;
  const r = await wrangler(["secret", "put", "BOOTSTRAP_ADMIN_TOKEN"], { input: `${setupToken}\n` });
  if (r.code !== 0) fail("Couldn't save the setup token on Cloudflare.", ...lastLines(r.out));
  const dir = join(ROOT, ".secrets");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "setup-token.txt");
  writeFileSync(file, `${setupToken}\n`);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows */
  }
  ok("Created (shown below, and saved in .secrets/setup-token.txt, which git ignores)");
} else if (tokens > 0) ok("Not needed: your server already has access tokens. Sign in with your admin token.");
else warn("Couldn't check for existing tokens, so no setup token was created. If this is a brand-new server, run setup again.");

// 9. Health check
step("Checking your server answers");
let healthy = false;
for (let i = 0; i < 12 && !healthy; i++) {
  try {
    const r = await fetch(`${publicUrl}/healthz`, { signal: AbortSignal.timeout(8000) });
    healthy = r.ok;
  } catch {
    /* retry */
  }
  if (!healthy) await new Promise((r) => setTimeout(r, 5000));
}
if (healthy) ok("It answers");
else warn("It isn't answering yet. A brand-new address can take a few minutes; open it in your browser shortly.");

// ------------------------------------------------------------------ summary

console.log(`\n${green(bold("Your Aeron server is ready."))}\n`);
console.log(`  Website:      ${publicUrl}`);
console.log(`  Dashboard:    ${bold(`${publicUrl}/dashboard`)}`);
if (setupToken) console.log(`  Setup token:  ${bold(setupToken)}`);
console.log(`\n${bold("Next steps")}`);
if (setupToken) {
  console.log(`  1. Open ${publicUrl}/dashboard and sign in with the setup token above.`);
  console.log(`  2. Go to Access tokens → create an Admin token for yourself → copy it somewhere safe.`);
  console.log(`  3. Sign out, then sign in with your new token.`);
  console.log(`  4. Turn the setup token off (in this folder):`);
  console.log(`       cd apps/server`);
  console.log(`       npx wrangler secret delete BOOTSTRAP_ADMIN_TOKEN`);
  console.log(`  5. Install the aeron CLI: dashboard → Integrations.`);
} else {
  console.log(`  Open ${publicUrl}/dashboard and sign in with your admin token.`);
}
if (!domain && /workers\.dev/.test(publicUrl)) {
  console.log(`\n  ${yellow("Tip:")} this address is built into your app builds. If you'd like your own domain`);
  console.log(`  (for example ota.yourcompany.com), set it up before shipping store builds:`);
  console.log(`    npm run setup -- --domain ota.yourcompany.com`);
}
console.log(`\n  Guide: ${publicUrl}/docs#/docs/setup\n`);
