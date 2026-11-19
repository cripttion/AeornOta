import { api } from "../api.js";
import { refreshApps, setHelpKey, state } from "../main.js";
import { term } from "../help.js";
import { codeBlock, drawer, h, icon, notice, pageHead, set, toast } from "../ui.js";
import { renderExpoApp } from "./app-expo.js";
import { renderFlutterApp } from "./app-flutter.js";

export async function renderApp(page, id, tab) {
  const app = state.apps.find((a) => a.id === id);
  if (!app) {
    set(page, notice("warn", `App "${id}" was not found, or your token can't see it.`));
    return;
  }
  if (app.kind === "expo") return renderExpoApp(page, app, tab);
  return renderFlutterApp(page, app, tab);
}

/** "Getting this app ready" card. Returns null once every step is done. */
export function checklistCard(app, items) {
  if (items.every((i) => i.done)) return null;
  const next = items.find((i) => !i.done);
  const done = items.filter((i) => i.done).length;
  return h(
    "section",
    { class: "card" },
    h(
      "div",
      { class: "card-head" },
      h("h2", {}, "Getting this app ready"),
      h("span", { class: "progress" }, h("span", { class: "track" }, h("span", { class: "fill", style: { width: `${(done / items.length) * 100}%` } })), `${done} of ${items.length} done`),
    ),
    h(
      "ul",
      { class: "checklist" },
      items.map((i) =>
        h(
          "li",
          {},
          h("span", { class: i.done ? "mark-ok" : "mark-todo", "aria-label": i.done ? "done" : "to do" }, i.done ? "✓" : "·"),
          h("div", {}, i === next ? h("strong", {}, i.title) : i.title, !i.done && i.how ? h("div", { class: "how" }, i.how) : null),
          i === next && i.href ? h("a", { class: "btn small go", href: i.href }, i.cta || "Do it") : h("span"),
        ),
      ),
    ),
  );
}

/** Per-app policy: four-eyes approval. */
export async function appSettings(body, app) {
  const { policy } = await api("GET", `/api/admin/apps/${app.id}/settings`);
  const isAdmin = state.me.role === "admin";
  const toggle = h("input", { type: "checkbox", id: "req-approval", checked: policy.requireApproval, disabled: !isAdmin });
  set(
    body,
    h(
      "section",
      { class: "card stack", style: { gap: "12px" } },
      h("h2", {}, "Four-eyes ", term("approval", "approval")),
      h(
        "p",
        { class: "muted" },
        "When on, every new ",
        app.kind === "expo" ? "update" : "patch",
        " waits under Approvals until an admin approves it with a different token than the one that published it. A leaked CI secret or publisher token then can't ship code by itself. Moving rollout percentages, halting and undoing never need approval, because they don't introduce new code.",
      ),
      h(
        "div",
        { class: "toggle-row" },
        h("label", { class: "checks", for: "req-approval" }, toggle, h("strong", {}, "Require approval before new code goes live")),
        isAdmin
          ? h(
              "button",
              {
                type: "button",
                class: "btn",
                onclick: async () => {
                  try {
                    await api("POST", `/api/admin/apps/${app.id}/settings`, { requireApproval: toggle.checked });
                    toast(toggle.checked ? "Approvals are on" : "Approvals are off for this app");
                    await appSettings(body, app);
                  } catch (e) {
                    toast(e.message, "bad");
                  }
                },
              },
              "Save",
            )
          : h("span", { class: "muted small" }, "Only admins can change this."),
      ),
      !policy.requireApproval ? notice("warn", "Approvals are off. Anything a publisher token uploads goes live immediately. Turn this on unless you have a strong reason not to.") : notice("good", "On. New code needs a second person."),
    ),
    app.kind === "flutter"
      ? h("section", { class: "card stack", style: { gap: "6px" } }, h("h2", {}, "Patch signing"), h("p", { class: "muted" }, "Managed on the ", h("a", { href: `#/apps/${app.id}/signing` }, "Signing"), " tab."))
      : h("section", { class: "card stack", style: { gap: "6px" } }, h("h2", {}, "Signing keys"), h("p", { class: "muted" }, "Managed on the ", h("a", { href: `#/apps/${app.id}/keys` }, "Signing keys"), " tab. Store builds without a code signing certificate never receive updates.")),
  );
}

function shipDrawer(app) {
  const expo = app.kind === "expo";
  drawer(
    "Ship a change",
    h("p", { class: "muted" }, expo ? "Run this in the app folder after you change your JavaScript or images. It builds, signs with your key, uploads only new files, and sends the update to Approvals." : "Run this in the Flutter project after you change Dart code. It builds the patch with Shorebird, signs it with your key, and sends it to Approvals."),
    h("h3", {}, "From your computer (macOS or Windows)"),
    codeBlock(expo ? `aeron expo publish --app ${app.id} --key keys/private-key.pem --message "What changed" --rollout 10` : `aeron flutter patch --app ${app.id} --message "What changed"`),
    h("p", { class: "muted small" }, "Then approve it under Approvals (with a different admin token), and raise the rollout from 10% when the error rate looks fine."),
    h("h3", {}, "From GitHub Actions"),
    h("p", { class: "muted" }, "Set up once under ", h("a", { href: `#/integrations/${app.id}` }, "Integrations"), ". Then go to your repository → Actions → ", h("strong", {}, expo ? `OTA update: ${app.id}` : `OTA patch: ${app.id}`), " → Run workflow."),
    notice(
      "",
      h(
        "p",
        {},
        expo ? "JavaScript, screens, text, logic and images ship this way." : "Dart code ships this way: screens, text and logic. Files under assets/ (images, fonts) don't.",
        " Native changes (new native libraries, permissions, SDK upgrades, the app icon) still need a new store build.",
      ),
    ),
  );
}

export function appHeader(app, tabs, current) {
  setHelpKey(`app-${app.kind}-${current}`);
  const expo = app.kind === "expo";
  return [
    pageHead({
      eyebrow: [h("span", { class: `app-avatar ${app.kind}`, "aria-hidden": "true" }, (app.name || app.id).slice(0, 1).toUpperCase()), expo ? "Expo / React Native app" : "Flutter app", h("span", { class: "kind" }, app.id), h("span", {}, `added ${new Date(app.created_at).toLocaleDateString()}`)],
      title: app.name || app.id,
      sub: expo ? "Sends JavaScript and image updates to phones through expo-updates." : "Sends Dart code patches to phones through Shorebird's engine.",
      actions: [
        ["admin", "publisher"].includes(state.me.role) ? h("button", { type: "button", class: "btn", onclick: () => shipDrawer(app) }, icon("upload"), "Ship a change") : null,
        h("a", { class: "btn ghost", href: `#/apps/${app.id}/setup` }, "Setup guide"),
      ],
    }),
    h(
      "nav",
      { class: "tabs", "aria-label": "App sections" },
      tabs.map(([key, label, hint]) => h("a", { href: `#/apps/${app.id}/${key}`, "aria-current": key === current ? "page" : undefined, title: hint }, label)),
    ),
  ];
}

export async function renderNewApp(page) {
  setHelpKey("new-app");
  if (state.me.role !== "admin") {
    set(page, notice("warn", "Only admins can add apps."));
    return;
  }
  const id = h("input", { type: "text", id: "app-id", required: true, pattern: "[a-z0-9][a-z0-9-]{1,39}", placeholder: "calmi", autocomplete: "off", "aria-describedby": "app-id-hint" });
  const name = h("input", { type: "text", id: "app-name", placeholder: "Calmi" });
  const kindExpo = h("input", { type: "radio", name: "kind", value: "expo", checked: true });
  const kindFlutter = h("input", { type: "radio", name: "kind", value: "flutter" });
  const err = h("p", { class: "error-text", role: "alert" });
  id.addEventListener("input", () => {
    if (!name.dataset.touched) name.placeholder = id.value ? id.value.charAt(0).toUpperCase() + id.value.slice(1) : "Calmi";
  });
  name.addEventListener("input", () => (name.dataset.touched = "1"));
  const choice = (input, title, desc) => h("label", { class: "card", style: { display: "flex", gap: "10px", alignItems: "flex-start", cursor: "pointer", boxShadow: "none" } }, input, h("span", { class: "stack", style: { gap: "2px" } }, h("strong", {}, title), h("span", { class: "muted small" }, desc)));
  set(
    page,
    pageHead({ title: "Add an app", sub: "Register one of your mobile apps. Next, its Setup guide walks you through connecting the code.", doc: "walkthrough" }),
    h(
      "form",
      {
        class: "card stack",
        style: { maxWidth: "720px", gap: "16px" },
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = "";
          const kind = kindFlutter.checked ? "flutter" : "expo";
          try {
            await api("POST", "/api/admin/apps", { id: id.value.trim(), name: name.value.trim() || id.value.trim(), kind });
            await refreshApps();
            toast(`Created ${id.value}`);
            location.hash = `#/apps/${id.value.trim()}/setup`;
          } catch (e2) {
            err.textContent = e2.message;
          }
        },
      },
      h("div", { class: "field" }, h("span", { class: "label" }, "Framework"), h("div", { class: "grid-2" }, choice(kindExpo, "Expo / React Native", "Expo (managed), bare React Native, or plain React Native. Updates JavaScript and images."), choice(kindFlutter, "Flutter", "Uses Shorebird's engine. Updates Dart code."))),
      h(
        "div",
        { class: "form-grid" },
        h("div", { class: "field" }, h("label", { for: "app-id" }, "App id"), id, h("span", { class: "hint", id: "app-id-hint" }, "Short and permanent: it's part of the update URL built into your app. Lowercase letters, digits and dashes.")),
        h("div", { class: "field" }, h("label", { for: "app-name" }, "Display name"), name, h("span", { class: "hint" }, "Shown in this dashboard. You can use spaces and capitals.")),
      ),
      h("div", { class: "btn-row" }, h("button", { type: "submit", class: "btn" }, "Create app"), h("a", { class: "btn ghost", href: "#/overview" }, "Cancel")),
      err,
    ),
  );
  id.focus();
}
