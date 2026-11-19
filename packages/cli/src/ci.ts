import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Api } from "./api.js";
import { detectRnProject } from "./expo.js";
import { CliError, bool, flag, log, requireFlag, table, type Args } from "./util.js";
import { expoWorkflow, flutterWorkflow } from "./workflows.js";

async function cliSha(api: Api): Promise<string> {
  const res = await fetch(`${api.server}/cli/aeron.mjs.sha256`);
  return res.ok ? (await res.text()).trim().split(/\s+/)[0]! : "<see Integrations in the console>";
}

export async function ciCommand(api: Api, args: Args) {
  if (args._[1] !== "github") throw new CliError("Usage: aeron ci github --app <id> [--project .] [--write]");
  const appId = requireFlag(args, "app");
  const project = resolve(flag(args, "project", ".")!);
  const isFlutter = existsSync(join(project, "pubspec.yaml"));
  if (!isFlutter && detectRnProject(project).kind === "not-rn") throw new CliError("Run this in your app's folder (Flutter or React Native), or pass --project.");
  const pm = existsSync(join(project, "yarn.lock")) ? "yarn" : existsSync(join(project, "pnpm-lock.yaml")) ? "pnpm" : "npm";
  const yml = isFlutter ? flutterWorkflow(appId) : expoWorkflow(appId, pm);
  const target = join(project, ".github", "workflows", `aeron-${appId}.yml`);
  if (bool(args, "write")) {
    if (existsSync(target) && !bool(args, "force")) throw new CliError(`${target} exists (use --force to overwrite)`);
    await mkdir(join(project, ".github", "workflows"), { recursive: true });
    await writeFile(target, yml);
    log(`Wrote ${target}`);
  } else {
    log(yml);
    log(`(re-run with --write to save it as ${target})`);
  }
  let repo = "owner/name";
  try {
    const cfg = readFileSync(join(project, ".git", "config"), "utf8");
    repo = /github\.com[:/]([^/\s]+\/[^/\s]+?)(\.git)?\s/.exec(cfg)?.[1] ?? repo;
  } catch {
    /* not a git checkout */
  }
  const sha = await cliSha(api);
  log(`\nFinish setup:
  1. Trust this repository in Aeron (only its main branch can publish):
       aeron github trust add --app ${appId} --repo ${repo} --branch main
  2. In GitHub → Settings → Secrets and variables → Actions:
       Variable  AERON_SERVER       = ${api.server}
       Variable  AERON_CLI_SHA256   = ${sha}
       Secret    ${isFlutter ? "AERON_FLUTTER_PRIVATE_KEY" : "AERON_EXPO_PRIVATE_KEY"} = contents of ${isFlutter ? "keys/patch-private.pem" : "keys/private-key.pem"}
  3. Run it: GitHub → Actions → "${isFlutter ? "OTA patch" : "OTA update"}: ${appId}" → Run workflow. Then approve it in the console.`);
}

export async function githubCommand(api: Api, args: Args) {
  if (args._[1] !== "trust") throw new CliError("Usage: aeron github trust add|list|remove");
  const action = args._[2] ?? "list";
  if (action === "list") {
    const r = await api.request("GET", "/api/admin/github/trust");
    table(r.rules.map((x: any) => ({ id: x.id, app: x.app_id, repository: x.repository, branch: x.ref ?? "any", environment: x.environment ?? "any" })));
    return;
  }
  if (action === "add") {
    const r = await api.request("POST", "/api/admin/github/trust", {
      appId: requireFlag(args, "app"),
      repository: requireFlag(args, "repo", "owner/name"),
      ref: flag(args, "branch") ?? flag(args, "ref") ?? null,
      environment: flag(args, "environment") ?? null,
    });
    log(`Trusted ${r.repository}${r.ref ? ` (${r.ref})` : " (any branch)"}${r.environment ? ` environment ${r.environment}` : ""} to publish to ${r.appId}.`);
    return;
  }
  if (action === "remove") {
    const id = args._[3] ?? requireFlag(args, "id");
    await api.request("DELETE", `/api/admin/github/trust/${id}`);
    log(`Removed rule ${id}`);
    return;
  }
  throw new CliError("Usage: aeron github trust add --app <id> --repo owner/name [--branch main] [--environment prod] | list | remove <id>");
}

export async function approvalsCommand(api: Api) {
  const r = await api.request("GET", "/api/admin/approvals");
  const rows = [
    ...r.expo.map((u: any) => ({ kind: "expo", app: u.app_id, what: `${u.channel}/${u.platform} ${u.runtime_version}`, id: u.id, message: u.message ?? "", commit: (u.git_sha ?? "").slice(0, 7), by: u.published_by.split(" (")[0] })),
    ...r.flutter.map((x: any) => ({ kind: "flutter", app: x.app_id, what: `${x.release_version} #${x.number} → ${x.channel}`, id: `patch ${x.patch_id}`, message: x.notes ?? "", commit: (x.git_sha ?? "").slice(0, 7), by: (x.created_by ?? "").split(" (")[0] })),
  ];
  table(rows);
  if (rows.length) log(`\nReview in the console: ${api.server}/#/approvals  (or: aeron review ...)`);
}

export async function reviewCommand(api: Api, args: Args) {
  const decision = bool(args, "approve") ? "approve" : bool(args, "reject") ? "reject" : null;
  if (!decision) throw new CliError("Pass --approve or --reject");
  const kind = args._[1];
  if (kind === "expo") {
    const id = args._[2] ?? requireFlag(args, "update");
    const r = await api.request("POST", `/api/admin/expo/updates/${id}/review`, { decision, percent: flag(args, "percent") ? Number(flag(args, "percent")) : undefined, note: flag(args, "note") });
    log(`Update ${id}: ${r.status}${r.percent !== undefined ? ` at ${r.percent}%` : ""}`);
    return;
  }
  if (kind === "flutter") {
    const appId = requireFlag(args, "app");
    const version = requireFlag(args, "release");
    const number = Number(requireFlag(args, "patch"));
    const d = await api.request("GET", `/api/admin/flutter/apps/${appId}`);
    const p = d.releases.find((x: any) => x.version === version)?.patches.find((x: any) => x.number === number);
    if (!p) throw new CliError(`No patch #${number} on release ${version}`);
    await api.request("POST", `/api/admin/flutter/apps/${appId}/patches/${p.id}/action`, {
      channel: flag(args, "channel", "stable"),
      action: decision,
      percent: flag(args, "percent") ? Number(flag(args, "percent")) : undefined,
      note: flag(args, "note"),
    });
    log(`${appId} ${version} patch #${number}: ${decision === "approve" ? "approved" : "rejected"}`);
    return;
  }
  throw new CliError("Usage: aeron review expo <update-id> --approve|--reject [--percent N] | aeron review flutter --app A --release V --patch N --approve|--reject");
}
