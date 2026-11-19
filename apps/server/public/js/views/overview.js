import { api } from "../api.js";
import { setAttention, state } from "../main.js";
import { term } from "../help.js";
import { chartCard, columnChart, fmt, h, icon, lineChart, pageHead, pill, set, sparkline, statTile, table } from "../ui.js";

const errorsOf = (s) => (s.launch_error || 0) + (s.js_error || 0) + (s.update_failed || 0) + (s.install_failure || 0);
const downloadsOf = (s) => (s.served || 0) + (s.patch_served || 0);
const launchesOf = (s) => (s.launch_ok || 0) + (s.install_success || 0);
const rateOf = (launches, errors) => (launches + errors ? errors / (launches + errors) : null);
const PLATFORM = { ios: "iOS", android: "Android" };

function sum(rows, key) {
  return rows.reduce((s, r) => s + (r[key] || 0), 0);
}

/** Change of the last 7 days vs the 7 before. */
function weekDelta(daily, key) {
  if (daily.length < 14) return null;
  const cur = sum(daily.slice(-7), key);
  const prev = sum(daily.slice(-14, -7), key);
  return prev ? (cur - prev) / prev : null;
}

function liveChips(app) {
  if (app.kind === "flutter") {
    if (!app.channels?.length) return [h("span", { class: "muted" }, "Nothing live yet")];
    return app.channels.map((c) => {
      const pct = c.percent_bp / 100;
      return pill(`${c.channel} · patch #${c.patch_number} · ${c.is_rolled_back ? "rolled back" : pct === 100 ? "all phones" : `${pct}%`}`, c.is_rolled_back ? "bad" : pct < 100 ? "warn" : "good", {
        dot: true,
        tip: `Release ${c.release_version}, ${c.channel} track`,
      });
    });
  }
  if (!app.rollouts.length) return [h("span", { class: "muted" }, "Nothing live yet")];
  return app.rollouts.map((r) => {
    const pct = r.percent_bp / 100;
    const text = r.undo_active ? "undo active" : pct === 100 ? "all phones" : pct === 0 ? "halted" : `${pct}% rolling out`;
    return pill(`${PLATFORM[r.platform] || r.platform} · ${text}`, r.undo_active ? "bad" : pct < 100 ? "warn" : "good", { dot: true, tip: `${r.channel} channel · store build ${r.runtime_version}` });
  });
}

export async function renderOverview(page) {
  const data = await api("GET", "/api/admin/overview?days=15");
  setAttention(new Map(data.apps.filter((a) => a.attention).map((a) => [a.id, a.attention])));
  // 15 days from the API: the last 14 are shown (today included, marked "so far");
  // deltas and sparklines use complete days only, so a half-finished today never looks like a drop.
  const all = data.days.map((day) => {
    const row = { day, downloads: 0, launches: 0, errors: 0 };
    for (const a of data.apps) {
      const d = a.daily.find((x) => x.day === day) || {};
      row.downloads += downloadsOf(d);
      row.launches += launchesOf(d);
      row.errors += errorsOf(d);
    }
    row.rate = rateOf(row.launches, row.errors);
    return row;
  });
  const daily = all.slice(-14);
  const complete = all.slice(0, -1);
  const shownDays = new Set(daily.map((d) => d.day));
  const downloads = sum(daily, "downloads");
  const launches = sum(daily, "launches");
  const errors = sum(daily, "errors");
  const errRate = rateOf(launches, errors);
  const appSum = (a, of) => a.daily.filter((d) => shownDays.has(d.day)).reduce((s, d) => s + of(d), 0);
  const lastPublish = data.apps.map((a) => a.lastPublishedAt).filter(Boolean).sort().pop();
  const rate7 = complete.length >= 14 ? rateOf(sum(complete.slice(-7), "launches"), sum(complete.slice(-7), "errors")) : null;
  const ratePrev = complete.length >= 14 ? rateOf(sum(complete.slice(-14, -7), "launches"), sum(complete.slice(-14, -7), "errors")) : null;
  const isAdmin = state.me.role === "admin";

  set(
    page,
    pageHead({
      title: "Overview",
      sub: data.apps.length ? `What needs you, and how your ${data.apps.length} app${data.apps.length === 1 ? " is" : "s are"} doing over the last 14 days.` : "Welcome to Aeron. Add your first app to get started.",
      actions: isAdmin ? h("a", { class: "btn", href: "#/apps/new" }, icon("plus"), "Add app") : null,
    }),
    attention(data),
    !data.apps.length ? welcome() : null,
    flow(data, { lastPublish, downloads, errRate }),
    data.apps.length
      ? h(
          "div",
          { class: "tiles" },
          statTile({ label: "Waiting for approval", value: String(data.pendingApprovals), tone: data.pendingApprovals ? "warn" : "", href: "#/approvals", sub: data.pendingApprovals ? "Review them under Approvals" : "Nothing waiting" }),
          statTile({ label: term("downloads"), value: fmt.num(downloads), trend: complete.map((d) => d.downloads), delta: { pct: weekDelta(complete, "downloads"), goodWhenUp: true, period: "vs previous 7 days" }, sub: "Last 14 days" }),
          statTile({ label: term("launches"), value: fmt.num(launches), trend: complete.map((d) => d.launches), delta: { pct: weekDelta(complete, "launches"), goodWhenUp: true, period: "vs previous 7 days" }, sub: launches ? "Last 14 days" : "Needs the client kit" }),
          statTile({ label: term("errorRate"), value: fmt.rate(errRate), tone: errRate > 0.01 ? "bad" : "", delta: rate7 !== null && ratePrev !== null ? { pts: rate7 - ratePrev, goodWhenUp: false, period: "vs previous 7 days" } : null, sub: "Errors ÷ launches" }),
          statTile({ label: term("rollout", "Partial rollouts"), value: String(data.activeRollouts), sub: data.activeRollouts ? "Updates on part of the phones" : "Everything at 100%" }),
        )
      : null,
    data.apps.length
      ? h(
          "div",
          { class: "grid-2" },
          chartCard({
            title: "Update downloads per day",
            sub: "Updates and patches downloaded by phones, all apps",
            chart: columnChart(daily, { key: "downloads", label: "update downloads", partialLast: true }),
            rows: daily,
            cols: [
              { label: "Day", get: (r) => fmt.day(r.day) },
              { label: "Downloads", num: true, get: (r) => r.downloads.toLocaleString() },
            ],
          }),
          chartCard({
            title: "Error rate per day",
            sub: "Errors ÷ (healthy launches + errors), all apps",
            chart: lineChart(daily, { key: "rate", label: "error rate", minMax: 0.005, partialLast: true }),
            rows: daily,
            cols: [
              { label: "Day", get: (r) => fmt.day(r.day) },
              { label: "Launches", num: true, get: (r) => r.launches.toLocaleString() },
              { label: "Errors", num: true, get: (r) => r.errors.toLocaleString() },
              { label: "Error rate", num: true, get: (r) => fmt.rate(r.rate) },
            ],
          }),
        )
      : null,
    data.apps.length ? h("h2", {}, "Your apps") : null,
    data.apps.length
      ? table(
          [
            {
              label: "App",
              get: (a) =>
                h(
                  "span",
                  { class: "btn-row", style: { gap: "10px", flexWrap: "nowrap" } },
                  h("span", { class: `app-avatar ${a.kind}`, "aria-hidden": "true" }, (a.name || a.id).slice(0, 1).toUpperCase()),
                  h("span", { class: "stack", style: { gap: "0" } }, h("strong", {}, a.name || a.id), h("span", { class: "muted small" }, a.kind === "expo" ? "Expo / React Native" : "Flutter")),
                ),
            },
            { label: "What phones run now", wrap: true, get: (a) => h("span", { class: "btn-row" }, liveChips(a)) },
            { label: "Last publish", get: (a) => fmt.ago(a.lastPublishedAt) },
            { label: "Downloads", num: true, get: (a) => fmt.num(appSum(a, downloadsOf)) },
            { label: "Error rate", num: true, get: (a) => fmt.rate(rateOf(appSum(a, launchesOf), appSum(a, errorsOf))) },
            { label: "Trend", get: (a) => sparkline(complete.map((c) => downloadsOf(a.daily.find((x) => x.day === c.day) || {}))) },
          ],
          data.apps,
          { onRow: (a) => (location.hash = `#/apps/${a.id}`) },
        )
      : null,
  );
}

function attention(data) {
  const items = [];
  if (data.pendingApprovals) items.push(["warn", `${data.pendingApprovals} change${data.pendingApprovals === 1 ? " is" : "s are"} waiting for your approval. Nothing reaches phones until someone approves.`, "#/approvals", "Review"]);
  if (data.undoActive) items.push(["bad", `Undo is active on ${data.undoActive} rollout${data.undoActive === 1 ? "" : "s"}: phones on that update are going back to their store build's code.`, null, null]);
  const s = state.settings;
  if (s && state.me.role === "admin") {
    if (s.bootstrapTokenActive) items.push(["bad", "The one-time setup token still works. Create your own admin token, then delete it.", "#/settings", "Fix"]);
    if (!s.notificationsConfigured) items.push(["", "Security alerts aren't set up. Get a Slack or Discord message for every publish and approval.", "#/integrations", "Set up"]);
    if (!s.accessEnforced) items.push(["", "Approvals don't need SSO + MFA yet. Turn on Cloudflare Access so a stolen token can't approve.", "#/security", "How"]);
  }
  if (!items.length) return null;
  return h(
    "section",
    { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Needs your attention"), h("span", { class: "sub" }, `${items.length} item${items.length === 1 ? "" : "s"}`)),
    h(
      "ul",
      { class: "checklist" },
      items.map(([kind, text, href, cta]) =>
        h(
          "li",
          {},
          h("span", { class: kind === "bad" ? "mark-bad" : kind === "warn" ? "mark-warn" : "mark-todo", "aria-hidden": "true" }, kind ? "!" : "·"),
          h("div", {}, text),
          href ? h("a", { class: "btn ghost small go", href }, cta) : h("span"),
        ),
      ),
    ),
  );
}

/** The five steps every change goes through, with live status. Teaches the model and shows where things are. */
function flow(data, { lastPublish, downloads, errRate }) {
  const step = (n, title, sub, live, cls, href) =>
    h(href ? "a" : "div", { class: `flow-step ${cls}`, href }, h("span", { class: "n" }, h("span", {}, String(n)), `Step ${n}`), h("span", { class: "t" }, title), h("span", { class: "s" }, sub), h("span", { class: "live" }, live));
  return h(
    "section",
    { class: "stack" },
    h("div", { class: "flow-head" }, h("h2", {}, "How a change reaches phones"), h("a", { class: "small", href: "#/docs/how-it-works" }, "How Aeron works →")),
    h(
      "div",
      { class: "flow" },
      step(1, "Publish", "From your terminal or GitHub Actions, signed with your key", lastPublish ? `Last: ${fmt.ago(lastPublish)}` : "Nothing yet", "", "#/integrations"),
      step(2, "Approve", "A second person checks it here", data.pendingApprovals ? `${data.pendingApprovals} waiting` : "Nothing waiting", data.pendingApprovals ? "hot" : "ok", "#/approvals"),
      step(3, "Roll out", "Start with 10% of phones, then raise it", data.activeRollouts ? `${data.activeRollouts} rolling out` : "All at 100%", data.activeRollouts ? "" : "ok", null),
      step(4, "Phones update", "On their next launch, in the background", `${fmt.num(downloads)} downloads in 14 days`, "", null),
      step(5, "Watch health", "Errors per update. Halt or undo in one click", errRate === null ? "No launch data yet" : `${fmt.rate(errRate)} error rate`, errRate !== null && errRate > 0.01 ? "hot" : errRate !== null ? "ok" : "", null),
    ),
  );
}

function welcome() {
  const isAdmin = state.me.role === "admin";
  return h(
    "div",
    { class: "welcome" },
    h(
      "div",
      { class: "card" },
      h("h3", {}, h("span", {}, "1"), "Add your app"),
      h("p", { class: "muted" }, "Expo, bare React Native or Flutter. Takes a few seconds."),
      h("div", { class: "btn-row" }, isAdmin ? h("a", { class: "btn small", href: "#/apps/new" }, "Add app") : h("span", { class: "muted small" }, "Ask an admin to add it")),
    ),
    h(
      "div",
      { class: "card" },
      h("h3", {}, h("span", {}, "2"), "Install the CLI"),
      h("p", { class: "muted" }, "One file for macOS, Windows and CI. Needs Node.js 20+."),
      h("div", { class: "btn-row" }, h("a", { class: "btn ghost small", href: "#/integrations" }, "Install commands")),
    ),
    h(
      "div",
      { class: "card" },
      h("h3", {}, h("span", {}, "3"), "Follow the walkthrough"),
      h("p", { class: "muted" }, "From setup to your first approved update, about 20 minutes."),
      h("div", { class: "btn-row" }, h("a", { class: "btn ghost small", href: "#/docs/walkthrough" }, "Open the guide")),
    ),
  );
}
