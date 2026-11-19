import { api } from "../api.js";
import { state } from "../main.js";
import { qmark, term } from "../help.js";
import { chartCard, codeBlock, columnChart, confirmButton, drawer, fmt, h, icon, lineChart, notice, pill, set, splitBar, table, toast } from "../ui.js";
import { appHeader, appSettings, checklistCard } from "./app.js";

const TABS = [
  ["rollouts", "Live now", "What phones run right now, and who gets the newest update"],
  ["updates", "History", "Every update published for this app"],
  ["runtimes", "Store builds", "The store builds that may receive updates"],
  ["keys", "Signing keys", "The public keys phones trust"],
  ["activity", "Activity", "Downloads, errors and recent changes"],
  ["settings", "Settings", "Approval policy"],
  ["setup", "Setup guide", "Connect this app, step by step"],
];
const PLATFORM = { ios: "iOS", android: "Android" };
const PHONES = { ios: "iPhones", android: "Android phones" };

export async function renderExpoApp(page, app, tab) {
  const current = TABS.some(([k]) => k === tab) ? tab : "rollouts";
  const body = h("div", { class: "stack", style: { gap: "18px" } });
  set(page, ...appHeader(app, TABS, current), body);
  const views = { rollouts, updates, runtimes, keys, activity, settings: appSettings, setup };
  await views[current](body, app);
}

const canPublish = (app) => ["admin", "publisher"].includes(state.me.role) && (!state.me.apps || state.me.apps.includes(app.id));

// ------------------------------------------------------------------ checklist

async function expoChecklist(app) {
  const [{ keys }, { runtimes }, { updates }, { policy }] = await Promise.all([
    api("GET", `/api/admin/expo/apps/${app.id}/keys`),
    api("GET", `/api/admin/expo/apps/${app.id}/runtimes`),
    api("GET", `/api/admin/expo/apps/${app.id}/updates?limit=1`),
    api("GET", `/api/admin/apps/${app.id}/settings`),
  ]);
  return checklistCard(app, [
    { done: true, title: "App added to Aeron" },
    { done: keys.some((k) => !k.retired_at), title: "Project connected and signing key registered", how: h("span", {}, "In the app folder: ", h("code", {}, `aeron expo init --app ${app.id} --write`)), href: `#/apps/${app.id}/setup`, cta: "Show me" },
    { done: runtimes.length > 0, title: "Store build shipped and registered", how: h("span", {}, "After the store build with Aeron's config is live: ", h("code", {}, `aeron expo runtime register --app ${app.id}`)), href: `#/apps/${app.id}/runtimes`, cta: "Register" },
    { done: updates.length > 0, title: "First update published", how: h("span", {}, h("code", {}, `aeron expo publish --app ${app.id} --key keys/private-key.pem --message "…"`)), href: `#/apps/${app.id}/setup`, cta: "Show me" },
    { done: policy.requireApproval, title: "Four-eyes approval on", how: "Settings tab", href: `#/apps/${app.id}/settings`, cta: "Turn on" },
  ]);
}

// ------------------------------------------------------------------ live now

function story(r, stableMsg) {
  const pct = r.percent_bp / 100;
  const phones = PHONES[r.platform] || `${r.platform} phones`;
  const cur = h("strong", {}, r.current_message || `update ${fmt.id(r.current_update_id)}`);
  const prev = r.stable_update_id ? h("strong", {}, stableMsg || `update ${fmt.id(r.stable_update_id)}`) : "the code in their store build";
  if (r.undo_active) return h("p", { class: "story" }, `Undo is active. ${phones} that had `, cur, " are going back to the code in their store build, and everyone is offered ", prev, ".");
  if (pct === 100) return h("p", { class: "story" }, `All ${phones} on store build ${r.runtime_version} run `, cur, ".");
  if (pct === 0) return h("p", { class: "story" }, "Halted. No new phones get ", cur, `. ${phones} that already have it keep it; everyone else stays on `, prev, ".");
  return h("p", { class: "story" }, `${pct}% of ${phones} on store build ${r.runtime_version} get `, cur, `. The other ${100 - pct}% stay on `, prev, ".");
}

async function rollouts(body, app) {
  const [{ rollouts }, checklist] = await Promise.all([api("GET", `/api/admin/expo/apps/${app.id}/rollouts`), expoChecklist(app)]);
  if (!rollouts.length) {
    set(body, checklist, notice("", h("p", {}, "Nothing is live yet. Once an update is published and approved, this tab shows which phones run it. Waiting updates are under ", h("a", { href: "#/approvals" }, "Approvals"), ".")));
    return;
  }
  const stableIds = [...new Set(rollouts.map((r) => r.stable_update_id).filter(Boolean))];
  const stable = new Map(
    await Promise.all(
      stableIds.map((id) =>
        api("GET", `/api/admin/expo/updates/${id}`)
          .then((x) => [id, x.update.message])
          .catch(() => [id, null]),
      ),
    ),
  );
  const act = async (r, action, extra = {}) => {
    try {
      const res = await api("POST", `/api/admin/expo/apps/${app.id}/rollouts/action`, { channel: r.channel, platform: r.platform, runtimeVersion: r.runtime_version, action, ...extra });
      toast(res.undoActive ? "Undo is active" : action === "cancel_undo" ? "Undo cancelled" : `Now ${res.percent}% of phones get it`);
      await rollouts(body, app);
    } catch (e) {
      toast(e.message, "bad");
    }
  };
  const editable = canPublish(app);
  set(
    body,
    checklist,
    h("p", { class: "intro" }, "One card per group of phones: a ", term("channel", "channel"), ", a platform and a ", term("storeBuild", "store build"), ". Changes reach phones within about 15 seconds of their next check."),
    h(
      "div",
      { class: "rollouts" },
      rollouts.map((r) => {
        const pct = r.percent_bp / 100;
        const custom = h("input", { type: "number", min: 0, max: 100, step: 1, value: String(pct), "aria-label": "Custom percentage", style: { width: "72px" } });
        return h(
          "section",
          { class: "card rollout" },
          h(
            "div",
            { class: "title" },
            icon("phone"),
            h("h2", {}, PLATFORM[r.platform] || r.platform),
            pill(r.channel, "accent", { tip: "Channel: the stream of updates these builds listen to" }),
            pill(`store build ${r.runtime_version}`, "", { tip: "Runtime version of the store build these phones run" }),
            r.undo_active ? pill("undo active", "bad", { dot: true }) : pct === 100 ? pill("fully rolled out", "good", { dot: true }) : pct === 0 ? pill("halted", "warn", { dot: true }) : pill("rolling out", "warn", { dot: true }),
          ),
          story(r, stable.get(r.stable_update_id)),
          r.undo_active || pct === 0 || pct === 100 ? null : splitBar(pct, "get the newest update", r.stable_update_id ? "stay on the previous update" : "stay on the store build's code"),
          h(
            "dl",
            { class: "kv" },
            h("dt", {}, "Newest update"),
            h("dd", {}, h("a", { href: "#", onclick: (e) => (e.preventDefault(), openUpdate(app, r.current_update_id)) }, h("span", { class: "mono" }, fmt.id(r.current_update_id))), ` · published ${fmt.ago(r.current_created_at)}`),
            h("dt", {}, "Previous update"),
            h("dd", {}, r.stable_update_id ? h("a", { href: "#", onclick: (e) => (e.preventDefault(), openUpdate(app, r.stable_update_id)) }, h("span", { class: "mono" }, fmt.id(r.stable_update_id))) : h("span", { class: "muted" }, "none (the store build's own code)")),
            h("dt", {}, "Last change"),
            h("dd", {}, `${fmt.ago(r.updated_at)} by ${(r.updated_by || "—").split(" (")[0]}`),
          ),
          editable
            ? h(
                "div",
                { class: "controls" },
                h("span", { class: "label" }, "Who gets the newest update ", qmark("rollout")),
                h(
                  "div",
                  { class: "btn-row" },
                  [1, 10, 25, 50, 100].map((p) => h("button", { type: "button", class: `btn ghost small ${p === pct && !r.undo_active ? "active" : ""}`, "aria-pressed": String(p === pct), onclick: () => act(r, "set_percent", { percent: p }) }, `${p}%`)),
                  h("span", { class: "btn-row", style: { gap: "4px" } }, custom, h("button", { type: "button", class: "btn ghost small", onclick: () => act(r, "set_percent", { percent: Number(custom.value) }) }, "Set")),
                ),
                h("span", { class: "label" }, "If something is wrong"),
                h(
                  "div",
                  { class: "btn-row" },
                  h("button", { type: "button", class: "btn ghost small", onclick: () => act(r, "halt"), tip: "Stop new phones getting it. Phones that have it keep it." }, icon("pause"), "Halt"),
                  r.undo_active
                    ? h("button", { type: "button", class: "btn ghost small", onclick: () => act(r, "cancel_undo") }, "Cancel undo")
                    : confirmButton("Undo", "Click again: send phones back", () => act(r, "undo")),
                  h("span", { class: "muted small" }, "Halt stops it spreading. Undo takes it back from phones that have it."),
                ),
              )
            : null,
        );
      }),
    ),
    h(
      "details",
      { class: "card" },
      h("summary", {}, "What exactly do Halt and Undo do?"),
      h(
        "div",
        { class: "md", style: { marginTop: "10px", fontSize: "14px" } },
        h("p", {}, h("strong", {}, "Halt"), " sets the rollout to 0%. New phones stop getting the update; phones that already have it keep it."),
        h("p", {}, h("strong", {}, "Undo"), " sends phones running the newest update back to the code in their store build (using a rollback instruction you signed when you published), and offers everyone the previous update. Use it when an update is broken. Click Cancel undo to stop."),
        h("p", {}, "To ship an older update again as the newest one, open it in ", h("a", { href: `#/apps/${app.id}/updates` }, "History"), " and copy the re-ship command."),
      ),
    ),
  );
}

async function openUpdate(app, id) {
  if (!id) return;
  const { update, patches } = await api("GET", `/api/admin/expo/updates/${id}`);
  const m = JSON.parse(update.manifest);
  drawer(
    `Update ${fmt.id(update.id)}`,
    h("p", { class: "what", style: { fontSize: "16px", fontWeight: "600" } }, update.message || h("span", { class: "muted" }, "No message")),
    h(
      "dl",
      { class: "kv" },
      h("dt", {}, "Status"),
      h("dd", {}, update.status === "pending" ? pill("waiting for approval", "warn") : update.status === "live" ? pill("approved", "good") : pill(update.status, "bad")),
      h("dt", {}, "Goes to"),
      h("dd", {}, `${PLATFORM[update.platform] || update.platform} · ${update.channel} channel · store build ${update.runtime_version}`),
      h("dt", {}, "Commit"),
      h("dd", { class: "mono" }, update.git_sha || "—"),
      h("dt", {}, term("critical", "Critical")),
      h("dd", {}, update.critical ? "yes, applied as soon as it's downloaded (with the client kit)" : "no, applied on the next launch"),
      h("dt", {}, "Size"),
      h("dd", {}, `${fmt.bytes(update.total_bytes)} in ${m.assets.length + 1} files`),
      h("dt", {}, "Signed with"),
      h("dd", {}, `key "${update.key_id}"`),
      h("dt", {}, "Published"),
      h("dd", {}, `${fmt.when(update.published_at)} by ${update.published_by}`),
      h("dt", {}, "Id"),
      h("dd", { class: "mono" }, update.id),
    ),
    h("h3", {}, term("bsdiff", "Patch downloads"), " for phones on an earlier update"),
    patches.length
      ? table(
          [
            { label: "From update", get: (p) => h("span", { class: "mono" }, fmt.id(p.base_update_id)) },
            { label: "Download", num: true, get: (p) => fmt.bytes(p.patch_bytes) },
            { label: "Full bundle", num: true, get: (p) => fmt.bytes(p.target_bytes) },
            { label: "Saved", num: true, get: (p) => `${(100 - (p.patch_bytes / p.target_bytes) * 100).toFixed(1)}%` },
          ],
          patches,
        )
      : h("p", { class: "muted" }, "None. Phones download the full bundle. Install bsdiff on the publishing computer (macOS: brew install bsdiff) to get small patches."),
    h("h3", {}, "Ship this update again as the newest one"),
    h("p", { class: "muted small" }, "Run in the app folder. It's signed again with your key and goes through approval like any new update."),
    codeBlock(`aeron expo republish --app ${app.id} --update ${update.id} --key keys/private-key.pem`),
  );
}

// ------------------------------------------------------------------ history

async function updates(body, app) {
  const channel = h("select", { "aria-label": "Channel" }, h("option", { value: "" }, "All channels"));
  const platform = h("select", { "aria-label": "Platform" }, h("option", { value: "" }, "All platforms"), h("option", { value: "ios" }, "iOS"), h("option", { value: "android" }, "Android"));
  const list = h("div");
  const load = async () => {
    const q = new URLSearchParams({ limit: "100" });
    if (channel.value) q.set("channel", channel.value);
    if (platform.value) q.set("platform", platform.value);
    const { updates } = await api("GET", `/api/admin/expo/apps/${app.id}/updates?${q}`);
    for (const ch of new Set(updates.map((u) => u.channel))) if (![...channel.options].some((o) => o.value === ch)) channel.append(h("option", { value: ch }, ch));
    set(
      list,
      table(
        [
          { label: "Message", wrap: true, get: (u) => [h("strong", {}, u.message || "—"), u.critical ? [" ", pill("critical", "warn")] : null, h("div", { class: "muted small mono" }, fmt.id(u.id))] },
          { label: "Status", get: (u) => pill(u.status === "pending" ? "waiting for approval" : u.status === "live" ? "approved" : u.status, u.status === "live" ? "good" : u.status === "pending" ? "warn" : "bad", { dot: true }) },
          { label: "Goes to", get: (u) => `${PLATFORM[u.platform] || u.platform} · ${u.channel} · ${u.runtime_version}` },
          { label: "Size", num: true, get: (u) => fmt.bytes(u.total_bytes) },
          { label: "Patch", num: true, head: h("span", {}, "Patch ", qmark("bsdiff")), get: (u) => (u.smallest_patch_bytes !== null ? fmt.bytes(u.smallest_patch_bytes) : "—") },
          { label: "Commit", get: (u) => h("span", { class: "mono" }, (u.git_sha || "").slice(0, 7) || "—") },
          { label: "Published", get: (u) => fmt.ago(u.published_at) },
        ],
        updates,
        { onRow: (u) => openUpdate(app, u.id), empty: "No updates published yet. The Setup guide shows the publish command." },
      ),
    );
  };
  channel.addEventListener("change", load);
  platform.addEventListener("change", load);
  set(body, h("p", { class: "intro" }, "Every update published for this app, newest first. Click one for details and the command to ship it again."), h("div", { class: "btn-row" }, channel, platform), list);
  await load();
}

// ------------------------------------------------------------------ store builds

async function runtimes(body, app) {
  const { runtimes } = await api("GET", `/api/admin/expo/apps/${app.id}/runtimes`);
  const platform = h("select", { id: "rt-platform" }, h("option", { value: "android" }, "Android"), h("option", { value: "ios" }, "iOS"));
  const rt = h("input", { type: "text", id: "rt-version", required: true, placeholder: "2.3.0 or fingerprint hash" });
  const note = h("input", { type: "text", id: "rt-note", placeholder: "Play build 41" });
  set(
    body,
    h("p", { class: "intro" }, "The store builds this app may send updates to, identified by their ", term("runtime", "runtime version"), ". Register each store build once, when it ships. Aeron refuses updates for builds that aren't listed, so JavaScript never reaches a build that lacks native code it needs."),
    table(
      [
        { label: "Platform", get: (r) => PLATFORM[r.platform] || r.platform },
        { label: "Runtime version", get: (r) => h("span", { class: "mono" }, r.runtime_version) },
        { label: "Note", wrap: true, get: (r) => r.note || "—" },
        { label: "Registered", get: (r) => fmt.ago(r.created_at) },
      ],
      runtimes,
      { empty: "No store builds registered yet" },
    ),
    canPublish(app)
      ? h(
          "form",
          {
            class: "card",
            onsubmit: async (e) => {
              e.preventDefault();
              try {
                await api("POST", `/api/admin/expo/apps/${app.id}/runtimes`, { platform: platform.value, runtimeVersion: rt.value.trim(), note: note.value.trim() });
                toast("Store build registered");
                await runtimes(body, app);
              } catch (e2) {
                toast(e2.message, "bad");
              }
            },
          },
          h("div", { class: "card-head" }, h("h2", {}, "Register a store build"), h("span", { class: "sub" }, "Easier: in the app folder run ", h("code", {}, `aeron expo runtime register --app ${app.id}`))),
          h(
            "div",
            { class: "form-grid" },
            h("div", { class: "field" }, h("label", { for: "rt-platform" }, "Platform"), platform),
            h("div", { class: "field" }, h("label", { for: "rt-version" }, "Runtime version"), rt),
            h("div", { class: "field" }, h("label", { for: "rt-note" }, "Note (optional)"), note),
            h("button", { type: "submit", class: "btn" }, "Register"),
          ),
        )
      : null,
  );
}

// ------------------------------------------------------------------ keys

async function keys(body, app) {
  const { keys } = await api("GET", `/api/admin/expo/apps/${app.id}/keys`);
  set(
    body,
    h("p", { class: "intro" }, "Only public keys are stored here. Your private key stays on your computer or in CI secrets, so nobody with access to this server can make an update phones would accept. ", h("a", { href: "#/docs/security" }, "How signing protects you →")),
    table(
      [
        { label: "Key id", get: (k) => h("span", { class: "mono" }, k.key_id) },
        { label: "Status", get: (k) => (k.retired_at ? pill("retired", "warn") : pill("active", "good", { dot: true })) },
        { label: "Registered", get: (k) => fmt.when(k.created_at) },
        {
          label: "",
          get: (k) =>
            state.me.role === "admin" && !k.retired_at
              ? confirmButton("Retire", "Confirm retire", async () => {
                  await api("POST", `/api/admin/expo/apps/${app.id}/keys/${encodeURIComponent(k.key_id)}/retire`, {});
                  toast("Key retired");
                  await keys(body, app);
                })
              : "",
        },
      ],
      keys,
      { empty: "No signing key yet. Run aeron expo init in the app folder." },
    ),
    h("h3", {}, "Add a key by hand"),
    codeBlock(`aeron expo keys generate --app ${app.id}\naeron expo keys register --app ${app.id} --key keys/private-key.pem --certificate certs/certificate.pem`),
  );
}

// ------------------------------------------------------------------ activity

async function activity(body, app) {
  const [{ stats }, { entries }, { updates }] = await Promise.all([
    api("GET", `/api/admin/apps/${app.id}/stats?days=14`),
    api("GET", `/api/admin/audit?app=${encodeURIComponent(app.id)}&limit=50`),
    api("GET", `/api/admin/expo/apps/${app.id}/updates?limit=100`),
  ]);
  const msg = new Map(updates.map((u) => [u.id, u.message]));
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));
  const isErr = (m) => /error|failed|emergency/.test(m);
  const daily = days.map((day) => {
    const row = { day, downloads: 0, launches: 0, errors: 0 };
    for (const s of stats.filter((x) => x.day === day)) {
      if (s.metric === "served" || s.metric === "patch_served") row.downloads += s.count;
      else if (s.metric === "launch_ok") row.launches += s.count;
      else if (isErr(s.metric)) row.errors += s.count;
    }
    row.rate = row.launches + row.errors ? row.errors / (row.launches + row.errors) : null;
    return row;
  });
  const bySubject = new Map();
  for (const s of stats) {
    const r = bySubject.get(s.subject) || { subject: s.subject, downloads: 0, launches: 0, errors: 0 };
    if (s.metric === "served" || s.metric === "patch_served") r.downloads += s.count;
    else if (s.metric === "launch_ok") r.launches += s.count;
    else if (isErr(s.metric)) r.errors += s.count;
    bySubject.set(s.subject, r);
  }
  set(
    body,
    h(
      "div",
      { class: "grid-2" },
      chartCard({
        title: "Update downloads per day",
        sub: "Last 14 days",
        chart: columnChart(daily, { key: "downloads", label: "update downloads", partialLast: true }),
        rows: daily,
        cols: [
          { label: "Day", get: (r) => fmt.day(r.day) },
          { label: "Downloads", num: true, get: (r) => r.downloads.toLocaleString() },
        ],
      }),
      chartCard({
        title: "Error rate per day",
        sub: "Needs the client kit (Setup guide, step 5)",
        chart: lineChart(daily, { key: "rate", label: "error rate", minMax: 0.005, partialLast: true }),
        rows: daily,
        cols: [
          { label: "Day", get: (r) => fmt.day(r.day) },
          { label: "Launches", num: true, get: (r) => r.launches.toLocaleString() },
          { label: "Errors", num: true, get: (r) => r.errors.toLocaleString() },
          { label: "Error rate", num: true, get: (r) => fmt.rate(r.rate) },
        ],
      }),
    ),
    h("h2", {}, "By update"),
    table(
      [
        { label: "Update", wrap: true, get: (r) => (r.subject === "embedded" ? h("span", {}, "The store build's own code") : h("span", {}, h("strong", {}, msg.get(r.subject) || "—"), h("div", { class: "muted small mono" }, fmt.id(r.subject)))) },
        { label: "Downloads", num: true, get: (r) => fmt.num(r.downloads) },
        { label: "Healthy launches", num: true, get: (r) => fmt.num(r.launches) },
        { label: "Errors", num: true, get: (r) => fmt.num(r.errors) },
        { label: "Error rate", num: true, get: (r) => fmt.rate(r.launches + r.errors ? r.errors / (r.launches + r.errors) : null) },
      ],
      [...bySubject.values()],
      { empty: "No activity yet. Launch and error counts need the client kit (see Setup guide)." },
    ),
    h("h2", {}, "Recent changes"),
    auditTable(entries),
  );
}

export function auditTable(entries) {
  return table(
    [
      { label: "When", get: (e) => h("span", { title: fmt.when(e.at) }, fmt.ago(e.at)) },
      { label: "Who", get: (e) => e.actor.split(" (")[0] },
      { label: "What", wrap: true, get: (e) => h("span", { class: "action-text" }, actionLabel(e.action)) },
      { label: "Details", wrap: true, get: (e) => h("span", { class: "mono small" }, prettyDetail(e.detail)) },
    ],
    entries,
    { empty: "No changes yet" },
  );
}

const ACTIONS = {
  "expo.update.submit": "Submitted an update for approval",
  "expo.update.publish": "Published an update",
  "expo.update.approve": "Approved an update",
  "expo.update.reject": "Rejected an update",
  "expo.rollout.set_percent": "Changed who gets the update",
  "expo.rollout.halt": "Halted a rollout",
  "expo.rollout.undo": "Started an undo",
  "expo.rollout.cancel_undo": "Cancelled an undo",
  "expo.key.register": "Registered a signing key",
  "expo.key.retire": "Retired a signing key",
  "expo.runtime.register": "Registered a store build",
  "flutter.patch.create": "Created a patch",
  "flutter.patch.rollout": "Submitted a patch for a track",
  "flutter.patch.approve": "Approved a patch",
  "flutter.patch.reject": "Rejected a patch",
  "flutter.patch.promote": "Sent a patch to a track",
  "flutter.patch.set_percent": "Changed who gets a patch",
  "flutter.patch.halt": "Halted a patch",
  "flutter.patch.rollback": "Rolled back a patch",
  "flutter.patch.rollforward": "Restored a patch",
  "flutter.release.create": "Started a release",
  "flutter.release.activate": "Finished a release",
  "flutter.settings": "Changed signing settings",
  "app.create": "Added an app",
  "app.settings": "Changed app settings",
  "token.create": "Created an access token",
  "token.create_ephemeral": "CLI created a short-lived token",
  "token.revoke": "Revoked an access token",
  "github.trust.add": "Trusted a GitHub repository",
  "github.trust.remove": "Removed a GitHub trust rule",
  "github.oidc.exchange": "GitHub Actions signed in",
};

export function actionLabel(action) {
  if (ACTIONS[action]) return ACTIONS[action];
  const s = String(action).replace(/[._]/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function prettyDetail(detail) {
  if (!detail) return "";
  try {
    const o = JSON.parse(detail);
    return Object.entries(o)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join(" · ");
  } catch {
    return detail;
  }
}

// ------------------------------------------------------------------ setup guide

async function setup(body, app) {
  const checklist = await expoChecklist(app);
  const base = state.settings?.publicBaseUrl || location.origin;
  const appJson = JSON.stringify(
    {
      runtimeVersion: { policy: "fingerprint" },
      updates: {
        url: `${base}/expo/${app.id}/manifest`,
        requestHeaders: { "expo-channel-name": "production" },
        codeSigningCertificate: "./certs/certificate.pem",
        codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" },
        checkAutomatically: "ON_LOAD",
        fallbackToCacheTimeout: 0,
      },
    },
    null,
    2,
  );
  set(
    body,
    checklist,
    notice("", h("p", {}, "Works for Expo (managed), bare React Native, and plain React Native apps. The commands are the same on macOS and Windows. Haven't installed the CLI yet? See ", h("a", { href: "#/integrations" }, "Integrations"), ". Full guide: ", h("a", { href: "#/docs/expo" }, "Expo and React Native apps"), ".")),
    step(
      "1",
      "Connect the project (once)",
      h("p", {}, "In the app folder. The first command only shows what will change; the second makes the changes."),
      codeBlock(`aeron expo init --app ${app.id}\naeron expo init --app ${app.id} --write\naeron doctor`),
      h("p", { class: "muted small" }, "Creates your signing key (keys/private-key.pem: secret, back it up, never commit it) and certificate (certs/certificate.pem: commit it), registers the public half here, and writes the update settings into app.json (and the native files for bare apps)."),
    ),
    step(
      "2",
      "Ship one store build",
      h("p", {}, "Build and submit to the App Store / Play Store as usual. The build must include the settings from step 1. They look like this in app.json → expo:"),
      codeBlock(appJson),
    ),
    step("3", "Register that store build", h("p", {}, "Once the build is live (or installed on your test phone):"), codeBlock(`aeron expo runtime register --app ${app.id} --platform all`)),
    step(
      "4",
      "Ship a change",
      h("p", {}, "Change your JavaScript or images, then:"),
      codeBlock(`aeron expo publish --app ${app.id} --key keys/private-key.pem --message "Fix paywall copy" --rollout 10`),
      h("p", { class: "muted small" }, "The update waits under Approvals. After approval, phones download it in the background and use it on their next launch."),
    ),
    step(
      "5 · optional",
      "Faster delivery and health numbers (client kit)",
      codeBlock(`import { useAeronUpdates } from "@aeron/expo-client";\n\nexport default function App() {\n  useAeronUpdates({ server: "${base}", appId: "${app.id}" });\n  // ...\n}`),
      h("p", { class: "muted small" }, "Checks for updates again when the app returns to the foreground, applies --critical updates immediately, and reports healthy launches and errors so the Activity tab can show them."),
    ),
    h(
      "details",
      { class: "card" },
      h("summary", {}, "Plain or bare React Native: two extra fixes (done for you by init)"),
      h(
        "div",
        { class: "stack", style: { marginTop: "10px" } },
        h("p", { class: "muted" }, h("code", {}, "aeron expo init --write"), " makes both changes below, and ", h("code", {}, "aeron doctor"), " flags them. They're listed here so you know what changed."),
        h("p", {}, h("strong", {}, "Images inside updates:"), " plain React Native apps don't load Expo at startup, so images in an update wouldn't show. The first line of index.js becomes:"),
        codeBlock("import 'expo';"),
        h("p", {}, h("strong", {}, "Native release builds:"), " the line that finds Expo's CLI (android/app/build.gradle, and the same lookup in the Xcode project) looks through the expo package, so builds don't fail with \"uses this output of task … without declaring a dependency\":"),
        codeBlock(`cliFile = new File(["node", "--print", "require.resolve('@expo/cli', { paths: [require.resolve('expo/package.json')] })"].execute(null, rootDir).text.trim())`),
        h("p", { class: "muted small" }, "Details are in Troubleshooting."),
      ),
    ),
  );
}

function step(n, title, ...content) {
  return h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, h("span", { class: "step-n" }, n), title)), h("div", { class: "stack", style: { gap: "10px" } }, ...content));
}
