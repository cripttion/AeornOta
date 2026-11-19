import { api } from "../api.js";
import { state } from "../main.js";
import { qmark, term } from "../help.js";
import { chartCard, codeBlock, columnChart, confirmButton, fmt, h, icon, lineChart, notice, pill, set, splitBar, table, toast } from "../ui.js";
import { appHeader, appSettings, checklistCard } from "./app.js";
import { auditTable } from "./app-expo.js";

const TABS = [
  ["releases", "Releases & patches", "Store releases and the patches made for them"],
  ["signing", "Signing", "Signed-patch requirement and public key"],
  ["activity", "Activity", "Downloads, failures and recent changes"],
  ["settings", "Settings", "Approval policy"],
  ["setup", "Setup guide", "Connect this app, step by step"],
];

export async function renderFlutterApp(page, app, tab) {
  const current = TABS.some(([k]) => k === tab) ? tab : "releases";
  const body = h("div", { class: "stack", style: { gap: "18px" } });
  set(page, ...appHeader(app, TABS, current), body);
  const views = { releases, signing, activity, settings: appSettings, setup };
  await views[current](body, app);
}

const canPublish = (app) => ["admin", "publisher"].includes(state.me.role) && (!state.me.apps || state.me.apps.includes(app.id));

function flutterChecklist(app, data) {
  const patches = data.releases.flatMap((r) => r.patches);
  return checklistCard(app, [
    { done: true, title: "App added to Aeron" },
    { done: data.settings.hasPublicKey, title: "Project connected and patch signing key registered", how: h("span", {}, "In the Flutter project: ", h("code", {}, `aeron flutter init --app ${app.id} --write`)), href: `#/apps/${app.id}/setup`, cta: "Show me" },
    { done: data.releases.some((r) => r.platforms.some((p) => p.status === "active")), title: "Store release built with Shorebird", how: h("span", {}, h("code", {}, `aeron flutter release --app ${app.id}`), ", then upload the .aab / .ipa to the stores"), href: `#/apps/${app.id}/setup`, cta: "Show me" },
    { done: patches.length > 0, title: "First patch published", how: h("span", {}, h("code", {}, `aeron flutter patch --app ${app.id} --message "…"`)), href: `#/apps/${app.id}/setup`, cta: "Show me" },
    { done: data.policy.requireApproval, title: "Four-eyes approval on", how: "Settings tab", href: `#/apps/${app.id}/settings`, cta: "Turn on" },
  ]);
}

function channelLine(app, r, p, c, act, editable) {
  const pct = c.rollout_bp / 100;
  let status;
  let sentence;
  if (c.status === "pending") {
    status = pill("waiting for approval", "warn", { dot: true });
    sentence = h("span", { class: "muted" }, "No phone has it yet. ", h("a", { href: "#/approvals" }, "Review it under Approvals"), ".");
  } else if (c.status === "rejected") {
    status = pill("rejected", "bad", { dot: true });
    sentence = h("span", { class: "muted" }, "It will never go live.");
  } else if (c.is_rolled_back) {
    status = pill("rolled back", "bad", { dot: true });
    sentence = h("span", { class: "muted" }, "Phones removed it (or will on their next launch).");
  } else {
    status = pct === 100 ? pill("all phones", "good", { dot: true }) : pct === 0 ? pill("halted", "warn", { dot: true }) : pill("rolling out", "warn", { dot: true });
    sentence = h("span", {}, pct === 0 ? "Halted: no new phones get it." : `${pct === 100 ? "All" : `${pct}% of`} phones on release ${r.version} get it.`);
  }
  return h(
    "div",
    { class: "stack", style: { gap: "8px", paddingTop: "10px", borderTop: "1px solid var(--line-2)" } },
    h("div", { class: "btn-row" }, h("strong", {}, `${c.channel} track`), status, sentence),
    c.status === "live" && !c.is_rolled_back && pct > 0 && pct < 100 ? splitBar(pct, "get this patch", "stay on the previous code") : null,
    editable && c.status === "live"
      ? c.is_rolled_back
        ? h("div", { class: "btn-row" }, h("button", { type: "button", class: "btn ghost small", onclick: () => act(p, c.channel, "rollforward") }, "Restore"))
        : h(
            "div",
            { class: "btn-row" },
            h("span", { class: "muted small" }, "Who gets it:"),
            [10, 25, 50, 100].map((n) => h("button", { type: "button", class: `btn ghost small ${n === pct ? "active" : ""}`, "aria-pressed": String(n === pct), onclick: () => act(p, c.channel, "set_percent", n) }, `${n}%`)),
            h("button", { type: "button", class: "btn ghost small", onclick: () => act(p, c.channel, "halt"), tip: "Stop new phones getting it. Phones that have it keep it." }, icon("pause"), "Halt"),
            confirmButton("Roll back", "Click again: remove from phones", () => act(p, c.channel, "rollback")),
          )
      : null,
  );
}

async function releases(body, app) {
  const data = await api("GET", `/api/admin/flutter/apps/${app.id}`);
  const checklist = flutterChecklist(app, data);
  if (!data.releases.length) {
    set(body, checklist, notice("", h("p", {}, "No releases yet. Build one with ", h("code", {}, `aeron flutter release --app ${app.id}`), " and upload it to the stores. Phones with that build can then receive patches.")));
    return;
  }
  const act = async (patch, channel, action, percent) => {
    try {
      await api("POST", `/api/admin/flutter/apps/${app.id}/patches/${patch.id}/action`, { channel, action, percent });
      toast(action === "rollback" ? `Patch #${patch.number} rolled back` : action === "rollforward" ? `Patch #${patch.number} restored` : action === "halt" ? "Halted" : `Now ${percent}% of phones get patch #${patch.number}`);
      await releases(body, app);
    } catch (e) {
      toast(e.message, "bad");
    }
  };
  const editable = canPublish(app);

  set(
    body,
    checklist,
    !data.settings.requireSigning ? notice("warn", h("p", {}, "Patch signing is off for this app. Anyone with a publisher token could ship unsigned code. Turn it on under ", h("a", { href: `#/apps/${app.id}/signing` }, "Signing"), ".")) : null,
    h("p", { class: "intro" }, "A ", term("release", "release"), " is a store build. ", term("patch", "Patches"), " replace its Dart code on phones. Each phone runs the newest patch on its track whose rollout includes it; a rolled-back patch is removed on the next launch."),
    ...data.releases.map((r) => {
      const active = r.platforms.filter((p) => p.status === "active");
      return h(
        "section",
        { class: "card stack", style: { gap: "14px" } },
        h(
          "div",
          { class: "card-head", style: { marginBottom: 0 } },
          h("div", { class: "stack", style: { gap: "2px" } }, h("h2", {}, `Release ${r.version}`), h("span", { class: "sub" }, `Flutter ${r.flutter_version || r.flutter_revision.slice(0, 8)} · built ${fmt.ago(r.created_at)}`)),
          h(
            "span",
            { class: "btn-row" },
            r.platforms.map((p) =>
              pill(`${p.platform === "ios" ? "iOS" : p.platform === "android" ? "Android" : p.platform}${p.status === "active" ? "" : " · draft"}${p.signing_mode === "customer" ? " · signed" : ""}`, p.status === "active" ? (p.signing_mode === "customer" ? "good" : "warn") : "", {
                dot: p.status === "active",
                tip: p.status === "active" ? (p.signing_mode === "customer" ? "Built with your public key: phones only accept patches signed with your private key" : "Built without patch signing") : "The release upload hasn't finished",
              }),
            ),
          ),
        ),
        active.length ? null : notice("warn", "Draft: the release upload hasn't finished. Run the release command again."),
        r.patches.length
          ? r.patches.map((p) =>
              h(
                "div",
                { class: "card stack", style: { boxShadow: "none", background: "var(--surface-2)", gap: "10px" } },
                h(
                  "div",
                  { class: "card-head", style: { marginBottom: 0 } },
                  h("div", { class: "stack", style: { gap: "2px" } }, h("h3", { style: { fontSize: "15px" } }, `Patch #${p.number} · `, p.notes || h("span", { class: "muted" }, "no message")), h("span", { class: "muted small" }, `${fmt.ago(p.created_at)}${p.created_by ? ` by ${p.created_by.split(" (")[0]}` : ""}`, p.git_sha ? [" · commit ", p.repository ? h("a", { href: `https://github.com/${p.repository}/commit/${p.git_sha}`, target: "_blank", rel: "noopener noreferrer", class: "mono" }, p.git_sha.slice(0, 7)) : h("span", { class: "mono" }, p.git_sha.slice(0, 7))] : null)),
                  h("span", { class: "btn-row" }, p.artifacts.map((a) => pill(`${a.platform} ${fmt.bytes(a.size)}${a.signed ? " · signed" : ""}`, a.state !== "uploaded" ? "warn" : a.signed ? "good" : "", { tip: a.state !== "uploaded" ? "Upload not finished" : `${a.platform}/${a.arch}${a.signed ? ", signature verified on upload" : ""}` }))),
                ),
                p.channels.length
                  ? p.channels.map((c) => channelLine(app, r, p, c, act, editable))
                  : editable
                    ? h("div", { class: "btn-row" }, h("span", { class: "muted small" }, "Not on any track yet."), h("button", { type: "button", class: "btn small", onclick: () => act(p, "stable", "promote", 100) }, "Send to stable"))
                    : h("span", { class: "muted" }, "Not on any track yet"),
              ),
            )
          : h("p", { class: "muted" }, "No patches for this release yet."),
      );
    }),
  );
}

async function signing(body, app) {
  const data = await api("GET", `/api/admin/flutter/apps/${app.id}`);
  const s = data.settings;
  const isAdmin = state.me.role === "admin";
  const pem = h("textarea", { id: "pubkey", rows: 6, placeholder: "-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----", style: { fontFamily: "var(--mono)", fontSize: "12px" } }, s.publicKeyPem || "");
  const require = h("input", { type: "checkbox", id: "req-sign", checked: s.requireSigning });
  set(
    body,
    h("p", { class: "intro" }, "Phones check every patch against the public key built into the release. Aeron also checks each uploaded patch against the key below, so a badly signed patch is rejected before any phone sees it. Private keys never reach this server."),
    h(
      "div",
      { class: "tiles" },
      h("div", { class: `tile ${s.requireSigning ? "" : "bad"}` }, h("span", { class: "k" }, "Signed patches ", qmark("signing")), h("span", { class: "v" }, s.requireSigning ? "Required" : "Off")),
      h("div", { class: `tile ${s.hasPublicKey ? "" : "warn"}` }, h("span", { class: "k" }, "Public key for upload checks"), h("span", { class: "v" }, s.hasPublicKey ? "Registered" : "Missing")),
    ),
    isAdmin
      ? h(
          "form",
          {
            class: "card stack",
            onsubmit: async (e) => {
              e.preventDefault();
              try {
                await api("POST", `/api/admin/flutter/apps/${app.id}/settings`, { requireSigning: require.checked, publicKeyPem: pem.value.trim() || null });
                toast("Signing settings saved");
                await signing(body, app);
              } catch (e2) {
                toast(e2.message, "bad");
              }
            },
          },
          h("h2", {}, "Settings"),
          h("label", { class: "checks" }, require, "Require signed patches (recommended)"),
          h("div", { class: "field" }, h("label", { for: "pubkey" }, "Patch public key (keys/patch-public.pem)"), pem, h("span", { class: "hint" }, "Locked once a release is live, so nobody can swap it.")),
          h("div", {}, h("button", { type: "submit", class: "btn" }, "Save")),
        )
      : null,
    h("h3", {}, "Create and register a key pair by hand"),
    codeBlock(`aeron flutter keys generate --out keys\naeron flutter keys register --app ${app.id} --public-key keys/patch-public.pem`),
  );
}

async function activity(body, app) {
  const [{ stats }, { entries }] = await Promise.all([
    api("GET", `/api/admin/apps/${app.id}/stats?days=14`),
    api("GET", `/api/admin/audit?app=${encodeURIComponent(app.id)}&limit=50`),
  ]);
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));
  const daily = days.map((day) => {
    const row = { day, downloads: 0, installs: 0, failures: 0 };
    for (const s of stats.filter((x) => x.day === day)) {
      if (s.metric === "patch_served") row.downloads += s.count;
      else if (s.metric === "install_success") row.installs += s.count;
      else if (/fail/.test(s.metric)) row.failures += s.count;
    }
    row.rate = row.installs + row.failures ? row.failures / (row.installs + row.failures) : null;
    return row;
  });
  const bySubject = new Map();
  for (const s of stats) {
    const r = bySubject.get(s.subject) || { subject: s.subject, downloads: 0, installs: 0, failures: 0 };
    if (s.metric === "patch_served") r.downloads += s.count;
    else if (s.metric === "install_success") r.installs += s.count;
    else if (/fail/.test(s.metric)) r.failures += s.count;
    bySubject.set(s.subject, r);
  }
  set(
    body,
    h(
      "div",
      { class: "grid-2" },
      chartCard({
        title: "Patch downloads per day",
        sub: "Last 14 days",
        chart: columnChart(daily, { key: "downloads", label: "patch downloads", partialLast: true }),
        rows: daily,
        cols: [
          { label: "Day", get: (r) => fmt.day(r.day) },
          { label: "Downloads", num: true, get: (r) => r.downloads.toLocaleString() },
        ],
      }),
      chartCard({
        title: "Install failure rate per day",
        sub: "Failures ÷ (successful installs + failures)",
        chart: lineChart(daily, { key: "rate", label: "install failure rate", minMax: 0.005, partialLast: true }),
        rows: daily,
        cols: [
          { label: "Day", get: (r) => fmt.day(r.day) },
          { label: "Installs", num: true, get: (r) => r.installs.toLocaleString() },
          { label: "Failures", num: true, get: (r) => r.failures.toLocaleString() },
          { label: "Failure rate", num: true, get: (r) => fmt.rate(r.rate) },
        ],
      }),
    ),
    h("h2", {}, "By release and patch"),
    table(
      [
        { label: "Release · patch", get: (r) => h("span", { class: "mono" }, r.subject.replace("#", " · patch #")) },
        { label: "Downloads", num: true, get: (r) => fmt.num(r.downloads) },
        { label: "Installed", num: true, get: (r) => fmt.num(r.installs) },
        { label: "Failed", num: true, get: (r) => fmt.num(r.failures) },
        { label: "Failure rate", num: true, get: (r) => fmt.rate(r.installs + r.failures ? r.failures / (r.installs + r.failures) : null) },
      ],
      [...bySubject.values()],
      { empty: "No phone activity yet" },
    ),
    h("h2", {}, "Recent changes"),
    auditTable(entries),
  );
}

async function setup(body, app) {
  const base = state.settings?.publicBaseUrl || location.origin;
  const data = await api("GET", `/api/admin/flutter/apps/${app.id}`);
  const step = (n, title, ...content) => h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, h("span", { class: "step-n" }, n), title)), h("div", { class: "stack", style: { gap: "10px" } }, ...content));
  set(
    body,
    flutterChecklist(app, data),
    notice("", h("p", {}, "You keep Shorebird's engine and CLI; only the server is Aeron, so you need no Shorebird account. The ", h("code", {}, "aeron flutter"), " commands pass the right flags, keys and tokens to shorebird for you, and work the same on macOS and Windows. Full guide: ", h("a", { href: "#/docs/flutter" }, "Flutter apps"), ".")),
    step(
      "1",
      "Connect the project (once)",
      codeBlock(`cd path/to/your-flutter-app
aeron flutter init --app ${app.id}          # shows what it will change
aeron flutter init --app ${app.id} --write  # makes the changes
aeron doctor`),
      h("p", { class: "muted small" }, "Creates your patch keys and registers the public half, writes shorebird.yaml (app_id and base_url), adds it to pubspec assets, adds Android's INTERNET permission, and git-ignores the private key. Back up keys/patch-private.pem: without it this release can never be patched again."),
    ),
    step(
      "2",
      "Build the store release",
      codeBlock(`aeron flutter release --app ${app.id} --platform android
aeron flutter release --app ${app.id} --platform ios      # on a Mac`),
      h("p", { class: "muted small" }, "Upload the .aab / .ipa to the stores as usual. Phones with this build can receive patches."),
    ),
    step("3", "Ship a change", h("p", {}, "Change your Dart code, then:"), codeBlock(`aeron flutter patch --app ${app.id} --message "Fix paywall copy"`), h("p", { class: "muted small" }, "The patch waits under Approvals. After approval, phones download it on their next launch and run it on the launch after.")),
    h(
      "details",
      { class: "card" },
      h("summary", {}, "Using the shorebird CLI directly instead"),
      h(
        "div",
        { class: "stack", style: { gap: "10px", marginTop: "10px" } },
        codeBlock(`export SHOREBIRD_HOSTED_URL=${base}
export SHOREBIRD_TOKEN=sb_api_...   # aeron tokens create --name ${app.id}-ci --role publisher --apps ${app.id} --shorebird
shorebird release android --public-key-path=keys/patch-public.pem
shorebird patch android --release-version=latest --public-key-path=keys/patch-public.pem --private-key-path=keys/patch-private.pem`),
        h("p", { class: "muted small" }, "On Windows PowerShell use $env:SHOREBIRD_HOSTED_URL = \"…\" instead of export. Never run shorebird login: it signs in to Shorebird's own service."),
      ),
    ),
  );
}
