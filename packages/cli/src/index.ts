#!/usr/bin/env node
import { Api, loadConfig, saveConfig } from "./api.js";
import { approvalsCommand, ciCommand, githubCommand, reviewCommand } from "./ci.js";
import { doctorCommand } from "./doctor.js";
import { expoCommand } from "./expo.js";
import { flutterCommand } from "./flutter.js";
import { CliError, bool, flag, log, parseArgs, requireFlag, table, type Args } from "./util.js";

const VERSION = "0.2.0";

const HELP = `aeron ${VERSION}: signed over-the-air updates for Expo / React Native and Flutter apps

Get started
  aeron login --server https://ota.example.com --token <token>
  aeron doctor [--project .]                   check this project and your login (read-only)

Expo and bare React Native
  aeron expo init --app calmi [--write]        set the project up (keys, app.json, native files)
  aeron expo publish --app calmi --key keys/private-key.pem --message "Fix paywall" [--rollout 10]
  aeron expo runtime register --app calmi      after a store build ships
  aeron expo status | rollout | republish | keys | export | configure   (see docs: CLI reference)

Flutter (Shorebird engine, Aeron server)
  aeron flutter init --app fitloop [--write]  set the project up (shorebird.yaml, keys, permission)
  aeron flutter release --app fitloop [--platform android|ios]
  aeron flutter patch --app fitloop [--release latest] [--message "Fix crash"]
  aeron flutter status | rollout | keys | signing

Review and security
  aeron approvals                              what's waiting for a second person
  aeron review expo <update-id> --approve|--reject [--percent 10]
  aeron review flutter --app A --release V --patch N --approve|--reject
  aeron ci github --app calmi [--write]        GitHub Actions workflow (no stored tokens)
  aeron github trust add --app calmi --repo owner/name --branch main
  aeron tokens create --name ci --role publisher --apps calmi [--shorebird] [--expires-days 90]
  aeron tokens list | revoke <id>      aeron apps list | create <id> --kind expo|flutter | delete <id>
  aeron audit [--app calmi]            aeron whoami

Environment: AERON_SERVER, AERON_TOKEN, AERON_EXPO_PRIVATE_KEY(_PATH), AERON_FLUTTER_PRIVATE_KEY(_PATH),
AERON_KEY_PASSPHRASE, SHOREBIRD_BIN, AERON_CF_ACCESS_CLIENT_ID / _SECRET (Cloudflare Access service token)
Docs: <your server>/docs
`;

async function main(argv: string[]) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd || cmd === "help" || args.flags.help) {
    log(HELP);
    return;
  }
  if (cmd === "version" || args.flags.version) {
    log(VERSION);
    return;
  }
  if (cmd === "login") {
    const server = requireFlag(args, "server").replace(/\/$/, "");
    const token = requireFlag(args, "token");
    const api = new Api({ server, token });
    const me = await api.request("GET", "/api/admin/me");
    const path = await saveConfig({ server, token });
    log(`Logged in to ${server} as ${me.principal.name} (${me.principal.role}). Saved to ${path}`);
    return;
  }
  if (cmd === "doctor") return doctorCommand(args);
  const api = new Api(await loadConfig());
  switch (cmd) {
    case "whoami": {
      const me = await api.request("GET", "/api/admin/me");
      const p = me.principal;
      log(`${p.name} (${p.role}) on ${api.server}${p.apps ? `, apps: ${p.apps.join(", ")}` : ""}${p.expiresAt ? `, expires ${String(p.expiresAt).slice(0, 10)}` : ""}`);
      return;
    }
    case "apps":
      return appsCommand(api, args);
    case "tokens":
      return tokensCommand(api, args);
    case "audit": {
      const app = flag(args, "app");
      const r = await api.request("GET", `/api/admin/audit${app ? `?app=${encodeURIComponent(app)}` : ""}`);
      table(r.entries.map((e: any) => ({ at: e.at, actor: e.actor, action: e.action, app: e.app_id ?? "", detail: e.detail ?? "" })));
      return;
    }
    case "expo":
      return expoCommand(api, args);
    case "flutter":
      return flutterCommand(api, args);
    case "approvals":
      return approvalsCommand(api);
    case "review":
      return reviewCommand(api, args);
    case "ci":
      return ciCommand(api, args);
    case "github":
      return githubCommand(api, args);
    default:
      throw new CliError(`Unknown command "${cmd}". Run: aeron help`);
  }
}

async function appsCommand(api: Api, args: Args) {
  const sub = args._[1] ?? "list";
  if (sub === "list") {
    const r = await api.request("GET", "/api/admin/apps");
    table(r.apps.map((a: any) => ({ id: a.id, name: a.name, kind: a.kind, approvals: a.require_approval ? "required" : "off", created: a.created_at })));
    return;
  }
  if (sub === "create") {
    const id = args._[2] ?? requireFlag(args, "id");
    const kind = requireFlag(args, "kind", "expo or flutter");
    const r = await api.request("POST", "/api/admin/apps", { id, kind, name: flag(args, "name", id) });
    log(`Created ${r.app.kind} app ${r.app.id} (approvals required by default)`);
    return;
  }
  if (sub === "delete") {
    const id = args._[2] ?? requireFlag(args, "id");
    const p = await api.request("DELETE", `/api/admin/apps/${id}`, { dryRun: true });
    log(`Deleting ${p.kind} app "${id}" permanently removes ${p.updates} update(s), ${p.releases} release(s), ${p.patches} patch(es), ${p.runtimes} store build(s), ${p.keys} signing key(s) and ${p.files} stored file(s).`);
    if (p.tokensRevoked || p.tokensNarrowed) log(`It revokes ${p.tokensRevoked} token(s) limited to this app, and removes it from ${p.tokensNarrowed} other token(s).`);
    log("Phones with this app keep the code they already have, but get no more updates from Aeron. This can't be undone.");
    if (args.flags["dry-run"]) return;
    if (flag(args, "confirm") !== id) throw new CliError(`Nothing was deleted. To confirm, run: aeron apps delete ${id} --confirm ${id}`);
    await api.request("DELETE", `/api/admin/apps/${id}`, { confirm: id });
    log(`Deleted ${id}.`);
    return;
  }
  throw new CliError("Usage: aeron apps list | aeron apps create <id> --kind expo|flutter | aeron apps delete <id> [--dry-run] [--confirm <id>]");
}

async function tokensCommand(api: Api, args: Args) {
  const sub = args._[1] ?? "list";
  if (sub === "create") {
    const apps = flag(args, "apps")?.split(",").map((s) => s.trim()).filter(Boolean);
    const r = await api.request("POST", "/api/admin/tokens", {
      name: requireFlag(args, "name"),
      role: flag(args, "role", "publisher"),
      apps,
      format: bool(args, "shorebird") ? "shorebird" : "aeron",
      expiresInDays: flag(args, "expires-days") ? Number(flag(args, "expires-days")) : undefined,
      noExpiry: bool(args, "no-expiry"),
    });
    log(
      `Token for ${r.name} (${r.role}${r.apps ? `, apps: ${r.apps.join(",")}` : ""}${r.expiresAt ? `, expires ${String(r.expiresAt).slice(0, 10)}` : ", no expiry"}):\n\n  ${r.token}\n\nStore it now (password manager or CI secret). It is not shown again.`,
    );
    return;
  }
  if (sub === "list") {
    const r = await api.request("GET", "/api/admin/tokens");
    table(
      r.tokens.map((t: any) => ({
        id: t.id,
        name: t.name,
        role: t.role,
        apps: t.app_scope ?? "all",
        expires: t.expires_at ? String(t.expires_at).slice(0, 10) : "never",
        last_used: t.last_used_at ?? "",
        revoked: t.revoked_at ?? "",
      })),
    );
    return;
  }
  if (sub === "revoke") {
    const id = args._[2] ?? requireFlag(args, "id");
    await api.request("DELETE", `/api/admin/tokens/${id}`);
    log(`Revoked ${id}`);
    return;
  }
  throw new CliError("Usage: aeron tokens create|list|revoke");
}

main(process.argv.slice(2)).catch((e) => {
  if (e instanceof CliError) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`${(e as Error).stack ?? e}\n`);
  process.exit(2);
});
