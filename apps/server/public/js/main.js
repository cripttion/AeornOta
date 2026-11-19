import { api, getToken, setToken } from "./api.js";
import { h, icon, initTips, set, toast, hideTip } from "./ui.js";
import { openHelp } from "./help.js";
import { renderOverview } from "./views/overview.js";
import { renderApp, renderNewApp } from "./views/app.js";
import { renderTokens } from "./views/tokens.js";
import { renderAudit } from "./views/audit.js";
import { renderSettings } from "./views/settings.js";
import { renderDocs } from "./views/docs.js";
import { renderApprovals } from "./views/approvals.js";
import { renderSecurity } from "./views/security.js";
import { renderIntegrations } from "./views/integrations.js";

export const state = { me: null, apps: [], settings: null, attention: new Map(), pending: 0, helpKey: "overview" };

const $ = (id) => document.getElementById(id);
const main = $("main");

export async function refreshApps() {
  state.apps = (await api("GET", "/api/admin/apps")).apps;
  renderNav();
}

export function setAttention(map) {
  state.attention = map;
  renderNav();
}

/** Views call this so the top-bar Help button opens the right panel (e.g. "app-expo-rollouts"). */
export function setHelpKey(key) {
  state.helpKey = key;
}

const NAV = [
  { items: [["overview", "Overview", "overview"], ["approvals", "Approvals", "approvals"]] },
  { apps: true },
  {
    label: "Manage",
    items: [
      ["security", "Security", "security", "admin"],
      ["tokens", "Access tokens", "tokens", "admin"],
      ["integrations", "Integrations", "integrations"],
      ["audit", "Audit log", "audit"],
      ["settings", "Settings", "settings"],
    ],
  },
  { label: "Learn", items: [["docs", "Documentation", "docs"], ["how", "How Aeron works", "bulb"]] },
];

function navLink([key, label, ico], route) {
  const href = key === "how" ? "#/docs/how-it-works" : `#/${key}`;
  const current = key === "how" ? route.name === "docs" && route.page === "how-it-works" : key === "docs" ? route.name === "docs" && route.page !== "how-it-works" : route.name === key;
  return h(
    "a",
    { href, "data-nav": key, "aria-current": current ? "page" : undefined },
    icon(ico),
    h("span", { class: "grow" }, label),
    key === "approvals" && state.pending ? h("span", { class: "badge", "aria-label": `${state.pending} waiting` }, String(state.pending)) : null,
  );
}

function renderNav() {
  const route = parseRoute();
  const isAdmin = state.me?.role === "admin";
  const groups = NAV.map((g) => {
    if (g.apps) {
      return h(
        "div",
        { class: "nav-group" },
        h("div", { class: "nav-label" }, "Apps", isAdmin ? h("a", { href: "#/apps/new", class: "nav-add", "aria-label": "Add app" }, icon("plus"), "Add") : null),
        state.apps.length
          ? state.apps.map((a) => {
              const attn = state.attention.get(a.id);
              return h(
                "a",
                {
                  href: `#/apps/${a.id}`,
                  class: "app-link",
                  "aria-current": route.name === "app" && route.id === a.id ? "page" : undefined,
                  title: `${a.name || a.id} · ${a.kind === "expo" ? "Expo / React Native" : "Flutter"}`,
                },
                h("span", { class: `app-avatar ${a.kind}`, "aria-hidden": "true" }, (a.name || a.id).slice(0, 1).toUpperCase()),
                h("span", { class: "grow" }, a.name || a.id),
                attn ? h("span", { class: `attn ${attn === "undo" ? "bad" : ""}`, role: "img", "aria-label": attn === "undo" ? "Undo active" : "Rolling out", tip: attn === "undo" ? "Undo is active on this app" : "An update is rolling out to part of the phones" }) : null,
              );
            })
          : h("span", { class: "nav-empty" }, isAdmin ? "No apps yet. Click Add." : "No apps yet"),
      );
    }
    const items = g.items.filter(([, , , need]) => !need || (need === "admin" && isAdmin));
    return h("div", { class: "nav-group" }, g.label ? h("div", { class: "nav-label" }, g.label) : null, items.map((it) => navLink(it, route)));
  });
  set(
    $("sidebar"),
    ...groups,
    h("div", { class: "sidebar-foot" }, h("span", {}, `Aeron ${state.settings?.version ? `v${state.settings.version}` : ""}`), h("span", {}, "Runs on your Cloudflare account")),
  );
}

/** Keep the sidebar's "Approvals" badge current. */
export async function refreshApprovalBadge() {
  try {
    const r = await api("GET", "/api/admin/approvals");
    const n = r.expo.length + r.flutter.length;
    if (n !== state.pending) {
      state.pending = n;
      renderNav();
    }
  } catch {
    /* viewer without access */
  }
}

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const [a, b, c] = parts;
  if (!a || a === "overview") return { name: "overview" };
  if (a === "apps" && b === "new") return { name: "new-app" };
  if (a === "apps" && b) return { name: "app", id: b, tab: c };
  if (a === "docs") return { name: "docs", page: b || "getting-started", anchor: c };
  if (["tokens", "audit", "settings", "approvals", "security", "integrations"].includes(a)) return { name: a, app: b };
  return { name: "overview" };
}

function closeOverlays() {
  for (const el of document.querySelectorAll(".drawer, .drawer-bg")) el.remove();
  hideTip();
}

let lastRouteKey = "";

async function route() {
  if (!state.me) return;
  const r = parseRoute();
  closeOverlays();
  renderNav();
  closeMobileNav();
  state.helpKey = r.name;
  // Docs: stay on the same page when only the anchor changes.
  const routeKey = r.name === "docs" ? `docs/${r.page}` : location.hash;
  const sameDoc = r.name === "docs" && routeKey === lastRouteKey && main.querySelector(".md");
  lastRouteKey = routeKey;
  if (sameDoc) {
    if (r.anchor) document.getElementById(r.anchor)?.scrollIntoView({ block: "start" });
    return;
  }
  const page = h("div", { class: "page" }, h("p", { class: "muted" }, "Loading…"));
  set(main, page);
  try {
    switch (r.name) {
      case "overview":
        await renderOverview(page);
        break;
      case "new-app":
        await renderNewApp(page);
        break;
      case "app":
        await renderApp(page, r.id, r.tab);
        break;
      case "tokens":
        await renderTokens(page);
        break;
      case "audit":
        await renderAudit(page, r.app);
        break;
      case "settings":
        await renderSettings(page);
        break;
      case "docs":
        await renderDocs(page, r.page, r.anchor);
        break;
      case "approvals":
        await renderApprovals(page);
        break;
      case "security":
        await renderSecurity(page);
        break;
      case "integrations":
        await renderIntegrations(page, r.app);
        break;
    }
  } catch (e) {
    if (e.status === 401) return signOut("Your token is no longer valid.");
    set(page, h("div", { class: "notice bad" }, icon("alert"), h("div", {}, e.message || String(e))));
  }
  if (r.name !== "docs") main.focus({ preventScroll: true });
}

/** Signed-out page chrome: no sidebar, no account buttons. Used by the sign-in page and public docs. */
function signedOutChrome() {
  document.querySelector(".layout").classList.add("no-nav");
  $("sidebar").hidden = true;
  $("menu-btn").hidden = true;
  $("logout").hidden = true;
  $("help-btn").hidden = true;
  $("who").textContent = "";
}

function renderLogin(error = "") {
  signedOutChrome();
  const input = h("input", { type: "password", id: "token", autocomplete: "off", required: true, placeholder: "aer_…", "aria-describedby": "token-hint" });
  const remember = h("input", { type: "checkbox", id: "remember", checked: true });
  const err = h("p", { class: "error-text", role: "alert" }, error);
  const form = h(
    "form",
    {
      class: "card login",
      onsubmit: async (e) => {
        e.preventDefault();
        setToken(input.value.trim(), remember.checked);
        input.value = "";
        await boot();
      },
    },
    h("h1", {}, "Sign in to Aeron"),
    h("p", { class: "muted", id: "token-hint" }, "Paste your Aeron access token. An admin creates one under ", h("strong", {}, "Access tokens"), ", or with ", h("code", {}, "aeron tokens create"), ". On a brand-new server, use the setup token printed by ", h("code", {}, "npm run setup"), "."),
    h("div", { class: "field" }, h("label", { for: "token" }, "Access token"), input),
    h("label", { class: "checks" }, remember, "Keep me signed in on this browser (untick on shared computers)"),
    h("button", { type: "submit", class: "btn" }, "Sign in"),
    err,
  );
  const about = h(
    "div",
    { class: "login-about" },
    h("h2", {}, "Ship app fixes in minutes, without a store review"),
    h("p", { class: "muted" }, "Aeron sends JavaScript (Expo, React Native) and Dart (Flutter) changes straight to your users' phones. It runs on your own Cloudflare account."),
    h(
      "ol",
      {},
      h("li", {}, h("strong", {}, "Publish"), " a change from your terminal or GitHub Actions. It's signed with a key only you hold."),
      h("li", {}, h("strong", {}, "Approve"), " it here. A second person checks it before any phone sees it."),
      h("li", {}, h("strong", {}, "Roll out"), " to 10% of phones, watch errors, then go to 100%."),
      h("li", {}, h("strong", {}, "Undo"), " in one click if something's wrong."),
    ),
    h("div", { class: "btn-row" }, h("a", { class: "btn ghost", href: "#/docs/how-it-works" }, icon("bulb"), "How Aeron works"), h("a", { class: "btn ghost", href: "#/docs/setup" }, icon("terminal"), "Set up your own server"), h("a", { class: "btn ghost", href: "#/docs/getting-started" }, icon("docs"), "Documentation")),
  );
  set(main, h("div", { class: "page" }, h("div", { class: "login-wrap" }, form, about)));
  input.focus();
}

async function renderPublicDocs() {
  signedOutChrome();
  closeOverlays();
  const page = h("div", { class: "page" });
  set(main, page);
  const r = parseRoute();
  await renderDocs(page, r.page, r.anchor, { onBack: () => renderLogin() });
}

function signOut(message = "") {
  setToken("");
  state.me = null;
  renderLogin(message);
}

async function boot() {
  if (!getToken()) {
    if (parseRoute().name === "docs") return renderPublicDocs();
    return renderLogin();
  }
  try {
    state.me = (await api("GET", "/api/admin/me")).principal;
  } catch (e) {
    setToken("");
    return renderLogin(e.status === 401 ? "That token was not accepted. Check you copied all of it, and that it hasn't expired or been revoked." : e.message);
  }
  document.querySelector(".layout").classList.remove("no-nav");
  $("sidebar").hidden = false;
  $("menu-btn").hidden = false;
  $("logout").hidden = false;
  $("help-btn").hidden = false;
  $("who").textContent = `${state.me.name} · ${state.me.role}`;
  try {
    state.settings = await api("GET", "/api/admin/settings");
    $("server").textContent = state.settings.publicBaseUrl.replace(/^https?:\/\//, "");
  } catch {
    /* viewers may still use the console */
  }
  await refreshApps();
  refreshApprovalBadge();
  setInterval(refreshApprovalBadge, 60_000);
  if (state.me.id === "bootstrap") {
    toast("You're signed in with the one-time setup token. Create your own admin token under Access tokens, then delete the setup token.");
  }
  await route();
}

function closeMobileNav() {
  $("sidebar").classList.remove("open");
  $("menu-btn").setAttribute("aria-expanded", "false");
}

// ------------------------------------------------------------------ theme

const THEMES = [
  ["system", "auto", "Theme: same as your system"],
  ["light", "sun", "Theme: light"],
  ["dark", "moon", "Theme: dark"],
];

function currentTheme() {
  try {
    return localStorage.getItem("aeron.theme") || "system";
  } catch {
    return "system";
  }
}

function applyTheme(t) {
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  try {
    if (t === "system") localStorage.removeItem("aeron.theme");
    else localStorage.setItem("aeron.theme", t);
  } catch {
    /* not persisted */
  }
  const [, ico, label] = THEMES.find((x) => x[0] === t) || THEMES[0];
  const btn = $("theme-btn");
  set(btn, icon(ico));
  btn.setAttribute("aria-label", `${label}. Click to change.`);
  btn._tip = `${label}. Click to change.`;
}

// ------------------------------------------------------------------ wiring

set($("menu-btn"), icon("menu"));
set($("help-btn"), icon("help"), h("span", { class: "lbl" }, "Help"));
set($("logout"), icon("logout"), h("span", { class: "lbl" }, "Sign out"));
applyTheme(currentTheme());
initTips();

$("theme-btn").addEventListener("click", () => {
  const i = THEMES.findIndex((x) => x[0] === currentTheme());
  applyTheme(THEMES[(i + 1) % THEMES.length][0]);
});
$("help-btn").addEventListener("click", () => openHelp(state.helpKey));
$("menu-btn").addEventListener("click", () => {
  const open = !$("sidebar").classList.contains("open");
  $("sidebar").classList.toggle("open", open);
  $("menu-btn").setAttribute("aria-expanded", String(open));
});
$("logout").addEventListener("click", () => signOut());
window.addEventListener("hashchange", () => (state.me ? route() : parseRoute().name === "docs" ? renderPublicDocs() : renderLogin()));
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-copy]");
  if (btn) {
    const code = btn.parentElement.querySelector("code")?.textContent ?? "";
    navigator.clipboard.writeText(code).then(
      () => toast("Copied"),
      () => toast("Copy failed: select the text manually", "bad"),
    );
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "?" && !e.target.closest("input, textarea, select") && state.me) openHelp(state.helpKey);
});

// /docs opens the documentation directly.
if (location.pathname.replace(/\/$/, "") === "/docs" && !location.hash.startsWith("#/")) location.replace("#/docs/getting-started");
boot();
