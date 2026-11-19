import { api } from "../api.js";
import { state } from "../main.js";
import { codeBlock, confirmButton, fmt, h, pageHead, set, table, toast } from "../ui.js";

const isWindows = () => /^win/i.test(navigator.userAgentData?.platform || navigator.platform || "");

/** macOS / Windows switch for the CLI install commands (remembers the choice). */
function osInstall(base) {
  const cmds = {
    mac: `mkdir -p ~/.aeron && curl -fsSL ${base}/cli/aeron.mjs -o ~/.aeron/aeron.mjs\necho 'alias aeron="node ~/.aeron/aeron.mjs"' >> ~/.zshrc && source ~/.zshrc\naeron login --server ${base} --token <your token>`,
    windows: `New-Item -ItemType Directory -Force "$HOME\\.aeron" | Out-Null\nInvoke-WebRequest ${base}/cli/aeron.mjs -OutFile "$HOME\\.aeron\\aeron.mjs"\nAdd-Content $PROFILE 'function aeron { node "$HOME\\.aeron\\aeron.mjs" @args }'\n. $PROFILE\naeron login --server ${base} --token <your token>`,
  };
  let os;
  try {
    os = localStorage.getItem("aeron.os");
  } catch {
    /* ignore */
  }
  os = os === "windows" || os === "mac" ? os : isWindows() ? "windows" : "mac";
  const box = h("div");
  const hint = h("p", { class: "muted small" });
  const btns = {};
  const show = (k) => {
    os = k;
    try {
      localStorage.setItem("aeron.os", k);
    } catch {
      /* ignore */
    }
    for (const [key, b] of Object.entries(btns)) b.setAttribute("aria-pressed", String(key === k));
    set(box, codeBlock(cmds[k]));
    set(hint, k === "mac" ? "Paste into Terminal. Linux works the same (use ~/.bashrc if you use bash)." : "Paste into PowerShell. If it refuses to load your profile, run Set-ExecutionPolicy -Scope CurrentUser RemoteSigned once.");
  };
  btns.mac = h("button", { type: "button", onclick: () => show("mac") }, "macOS / Linux");
  btns.windows = h("button", { type: "button", onclick: () => show("windows") }, "Windows");
  show(os);
  return h("div", { class: "stack", style: { gap: "8px" } }, h("div", { class: "seg", role: "group", "aria-label": "Your computer" }, btns.mac, btns.windows), box, hint);
}

export async function renderIntegrations(page, appParam) {
  const isAdmin = state.me.role === "admin";
  const [{ rules } = { rules: [] }, sha] = await Promise.all([
    isAdmin ? api("GET", "/api/admin/github/trust") : Promise.resolve({ rules: [] }),
    fetch("/cli/aeron.mjs.sha256").then((r) => (r.ok ? r.text() : "")).then((t) => t.trim().split(/\s+/)[0] || ""),
  ]);
  const base = state.settings?.publicBaseUrl || location.origin;
  const appSel = h("select", { id: "wf-app", "aria-label": "App" }, state.apps.map((a) => h("option", { value: a.id, selected: a.id === appParam }, `${a.id} (${a.kind})`)));
  const wfBox = h("div", { class: "page", style: { gap: "10px" } });
  const loadWorkflow = async () => {
    if (!appSel.value) return set(wfBox, h("p", { class: "muted" }, "Add an app first."));
    const w = await api("GET", `/api/admin/github/workflow?app=${encodeURIComponent(appSel.value)}`);
    set(
      wfBox,
      h("p", {}, "Save this as ", h("code", {}, w.path), " in the app's repository:"),
      codeBlock(w.yaml),
      h("h3", {}, "Then in GitHub → Settings → Secrets and variables → Actions"),
      table(
        [
          { label: "Type", get: (r) => r.type },
          { label: "Name", get: (r) => h("code", {}, r.name) },
          { label: "Value", wrap: true, get: (r) => r.value },
        ],
        [
          { type: "Variable", name: "AERON_SERVER", value: h("code", {}, w.variables.AERON_SERVER) },
          { type: "Variable", name: "AERON_CLI_SHA256", value: h("code", {}, sha || "build the CLI first") },
          { type: "Secret", name: w.secret.name, value: `Contents of ${w.secret.from}` },
        ],
      ),
      h("p", { class: "muted small" }, "AERON_CLI_SHA256 pins the exact CLI the workflow may run. If anyone tampers with the download, the run stops before your key is used. Update it when you upgrade Aeron."),
    );
  };
  appSel.addEventListener("change", loadWorkflow);

  const repo = h("input", { type: "text", id: "gh-repo", placeholder: "owner/repo", required: true });
  const branch = h("input", { type: "text", id: "gh-branch", value: "main", placeholder: "main" });
  const envName = h("input", { type: "text", id: "gh-env", placeholder: "optional" });
  const ruleApp = h("select", { id: "gh-app" }, state.apps.map((a) => h("option", { value: a.id }, a.id)));

  set(
    page,
    pageHead({ title: "Integrations", sub: "Publish from GitHub Actions without storing tokens, install the aeron command-line tool, and get security alerts in Slack or Discord.", doc: "github" }),

    h(
      "section",
      { class: "card page", style: { gap: "12px" } },
      h("div", { class: "card-head" }, h("h2", {}, "1 · GitHub Actions"), h("span", { class: "muted small" }, "Publish from CI without storing any Aeron token")),
      h(
        "p",
        { class: "muted" },
        "A workflow proves which repository and branch it runs from (GitHub OIDC). Aeron then gives it a one-hour token for the apps you trust it with. The commit and run link appear on the approval card, taken from GitHub's signed claims, so they can't be faked.",
      ),
      isAdmin
        ? h(
            "form",
            {
              class: "form-grid",
              onsubmit: async (e) => {
                e.preventDefault();
                try {
                  await api("POST", "/api/admin/github/trust", { appId: ruleApp.value, repository: repo.value.trim(), ref: branch.value.trim() || null, environment: envName.value.trim() || null });
                  toast("Trust rule added");
                  await renderIntegrations(page, appSel.value);
                } catch (e2) {
                  toast(e2.message, "bad");
                }
              },
            },
            h("div", { class: "field" }, h("label", { for: "gh-app" }, "App"), ruleApp),
            h("div", { class: "field" }, h("label", { for: "gh-repo" }, "Repository"), repo),
            h("div", { class: "field" }, h("label", { for: "gh-branch" }, "Branch"), branch, h("span", { class: "hint" }, "Leave empty to allow any branch (not recommended)")),
            h("div", { class: "field" }, h("label", { for: "gh-env" }, "GitHub environment"), envName),
            h("button", { type: "submit", class: "btn" }, "Trust repository"),
          )
        : null,
      table(
        [
          { label: "App", get: (r) => r.app_id },
          { label: "Repository", get: (r) => h("code", {}, r.repository) },
          { label: "Branch", get: (r) => (r.ref ? r.ref.replace("refs/heads/", "") : h("span", { class: "pill warn" }, "any")) },
          { label: "Environment", get: (r) => r.environment || "any" },
          { label: "Added", get: (r) => fmt.ago(r.created_at) },
          {
            label: "",
            get: (r) =>
              isAdmin
                ? confirmButton("Remove", "Confirm remove", async () => {
                    await api("DELETE", `/api/admin/github/trust/${r.id}`);
                    toast("Removed");
                    await renderIntegrations(page, appSel.value);
                  })
                : "",
          },
        ],
        rules,
        { empty: "No repositories trusted yet" },
      ),
      h("h3", {}, "Workflow file"),
      h("div", { class: "btn-row" }, h("label", { for: "wf-app" }, "Generate for"), appSel),
      wfBox,
    ),

    h(
      "section",
      { class: "card page", style: { gap: "10px" } },
      h("div", { class: "card-head" }, h("h2", {}, "2 · The aeron command-line tool"), h("span", { class: "muted small" }, "One file, Mac / Windows / Linux, needs Node.js 20+")),
      h("p", { class: "muted" }, "Install it once on each computer you publish from. It's downloaded from your own server, so it always matches this version of Aeron. Then check it with ", h("code", {}, "aeron whoami"), "."),
      osInstall(base),
      h("p", { class: "small" }, h("a", { href: "/cli/aeron.mjs", download: "aeron.mjs" }, "Download aeron.mjs directly"), sha ? h("span", { class: "muted" }, ` · sha256 ${sha}`) : null),
    ),

    h(
      "section",
      { class: "card page", style: { gap: "10px" } },
      h("div", { class: "card-head" }, h("h2", {}, "3 · Security alerts"), h("span", { class: "muted small" }, state.settings?.notificationsConfigured ? "Configured" : "Not configured")),
      h("p", { class: "muted" }, "Aeron posts to a Slack or Discord channel whenever code is submitted, approved, rejected, halted or rolled back, and when keys, tokens, trust rules or policies change."),
      codeBlock("cd apps/server\nnpx wrangler secret put NOTIFY_WEBHOOK_URL   # paste a Slack or Discord incoming-webhook URL"),
      isAdmin
        ? h(
            "div",
            {},
            h(
              "button",
              {
                type: "button",
                class: "btn ghost",
                onclick: async () => {
                  try {
                    await api("POST", "/api/admin/notifications/test", {});
                    toast("Test alert sent");
                  } catch (e) {
                    toast(e.message, "bad");
                  }
                },
              },
              "Send test alert",
            ),
          )
        : null,
    ),
  );
  await loadWorkflow();
}
