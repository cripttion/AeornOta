import { api } from "../api.js";
import { state } from "../main.js";
import { fmt, h, pageHead, set, table } from "../ui.js";
import { actionLabel, prettyDetail } from "./app-expo.js";

export async function renderAudit(page, appFilter) {
  const isAdmin = state.me.role === "admin";
  const app = appFilter || (isAdmin ? "" : state.apps[0]?.id || "");
  const select = h(
    "select",
    { "aria-label": "Filter by app", style: { width: "auto" }, onchange: () => (location.hash = select.value ? `#/audit/${select.value}` : "#/audit") },
    isAdmin ? h("option", { value: "" }, "All apps and settings") : null,
    state.apps.map((a) => h("option", { value: a.id, selected: a.id === app }, a.name || a.id)),
  );
  const q = new URLSearchParams({ limit: "300" });
  if (app) q.set("app", app);
  const { entries } = await api("GET", `/api/admin/audit?${q}`);
  const appName = (id) => state.apps.find((a) => a.id === id)?.name || id;
  set(
    page,
    pageHead({
      title: "Audit log",
      sub: "Every change made through the CLI, CI or this dashboard: who did it, when, and the details. Entries can't be edited or deleted.",
      doc: "security/if-something-goes-wrong",
      docLabel: "What to do if something looks wrong",
      actions: select,
    }),
    table(
      [
        { label: "When", get: (e) => h("span", { title: fmt.when(e.at) }, fmt.ago(e.at)) },
        { label: "Who", get: (e) => h("span", { title: e.actor }, e.actor.split(" (")[0]) },
        { label: "What", wrap: true, get: (e) => h("span", { class: "action-text", title: e.action }, actionLabel(e.action)) },
        { label: "App", get: (e) => (e.app_id ? appName(e.app_id) : h("span", { class: "muted" }, "—")) },
        { label: "Details", wrap: true, get: (e) => h("span", { class: "mono small" }, prettyDetail(e.detail)) },
      ],
      entries,
      { empty: "No entries yet" },
    ),
  );
}
