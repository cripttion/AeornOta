import { api } from "../api.js";
import { state } from "../main.js";
import { term } from "../help.js";
import { codeBlock, confirmButton, fmt, h, notice, pageHead, pill, table, toast, set } from "../ui.js";

export async function renderTokens(page) {
  if (state.me.role !== "admin") {
    set(page, notice("warn", "Only admins can manage access tokens."));
    return;
  }
  const { tokens } = await api("GET", "/api/admin/tokens");
  const name = h("input", { type: "text", id: "tk-name", required: true, maxlength: 80, placeholder: "ci-calmi" });
  const role = h(
    "select",
    { id: "tk-role" },
    h("option", { value: "publisher" }, "Publisher: publish and control rollouts"),
    h("option", { value: "viewer" }, "Viewer: read only"),
    h("option", { value: "admin" }, "Admin: everything, incl. tokens and apps"),
  );
  const appBoxes = state.apps.map((a) => h("label", {}, h("input", { type: "checkbox", value: a.id }), a.id));
  const scope = h("div", { class: "checks", id: "tk-apps" }, appBoxes);
  const sbFormat = h("input", { type: "checkbox", id: "tk-sb" });
  const expiry = h(
    "select",
    { id: "tk-exp" },
    h("option", { value: "30" }, "30 days"),
    h("option", { value: "90", selected: true }, "90 days"),
    h("option", { value: "180" }, "180 days"),
    h("option", { value: "365" }, "1 year"),
    h("option", { value: "never" }, "Never (admins only, not recommended)"),
  );
  const reveal = h("div");
  role.addEventListener("change", () => {
    for (const l of appBoxes) l.querySelector("input").disabled = role.value === "admin";
  });

  set(page, 
    pageHead({ title: "Access tokens", sub: "Keys that let the CLI, CI and this dashboard talk to Aeron. Give each person or machine its own token, with the smallest role and an expiry. A token can never sign code.", doc: "security" }),
    h(
      "div",
      { class: "roles" },
      h("div", { class: "card" }, h("strong", {}, "Viewer"), h("span", { class: "muted small" }, "For people who only watch."), h("ul", {}, h("li", {}, "Sees apps, rollouts, activity and the audit log"), h("li", {}, "Can't change anything"))),
      h("div", { class: "card" }, h("strong", {}, "Publisher"), h("span", { class: "muted small" }, "For developers and CI."), h("ul", {}, h("li", {}, "Publishes updates and patches"), h("li", {}, "Moves rollouts, halts, undoes"), h("li", {}, "Can't approve"))),
      h("div", { class: "card" }, h("strong", {}, "Admin"), h("span", { class: "muted small" }, "For the people who approve."), h("ul", {}, h("li", {}, "Approves and rejects new code"), h("li", {}, "Manages apps, tokens, keys and trust rules"), h("li", {}, "Use it in this dashboard only"))),
    ),
    reveal,
    h(
      "form",
      {
        class: "card",
        onsubmit: async (e) => {
          e.preventDefault();
          const apps = appBoxes.map((l) => l.querySelector("input")).filter((i) => i.checked && !i.disabled).map((i) => i.value);
          try {
            const r = await api("POST", "/api/admin/tokens", {
              name: name.value.trim(),
              role: role.value,
              apps: apps.length ? apps : null,
              format: sbFormat.checked ? "shorebird" : "aeron",
              ...(expiry.value === "never" ? { noExpiry: true } : { expiresInDays: Number(expiry.value) }),
            });
            name.value = "";
            set(reveal, 
              notice(
                "good",
                h("strong", {}, `Token for ${r.name} (${r.role}${r.apps ? `, ${r.apps.join(", ")}` : ", all apps"}${r.expiresAt ? `, expires ${new Date(r.expiresAt).toLocaleDateString()}` : ", never expires"})`),
                h("span", {}, "Copy it now. It's shown only once: Aeron keeps only a fingerprint of it. To use it in a terminal:"),
                codeBlock(r.token),
                codeBlock(`aeron login --server ${state.settings?.publicBaseUrl || location.origin} --token <paste the token>`),
              ),
            );
            const fresh = (await api("GET", "/api/admin/tokens")).tokens;
            set(list, tokenTable(fresh, list));
          } catch (e2) {
            toast(e2.message, "bad");
          }
        },
      },
      h("div", { class: "card-head" }, h("h2", {}, "Create a token"), h("span", { class: "sub" }, "Good default: Publisher, one app, 90 days")),
      h(
        "div",
        { class: "form-grid" },
        h("div", { class: "field" }, h("label", { for: "tk-name" }, "Name"), name, h("span", { class: "hint" }, "Who or what uses it, e.g. ci-calmi")),
        h("div", { class: "field" }, h("label", { for: "tk-role" }, term("roles", "Role")), role),
        h("div", { class: "field" }, h("label", { for: "tk-exp" }, "Expires after"), expiry),
      ),
      h("div", { class: "field", style: { marginTop: "12px" } }, h("span", { class: "label" }, "Limit to apps (leave empty for all apps)"), scope),
      h(
        "label",
        { class: "checks", style: { marginTop: "12px" } },
        sbFormat,
        "For Flutter: also make it work with the shorebird CLI (the token starts with sb_api_)",
      ),
      h("div", { style: { marginTop: "14px" } }, h("button", { type: "submit", class: "btn" }, "Create token")),
    ),
  );
  const list = h("div");
  list.append(tokenTable(tokens, list));
  page.append(h("h2", {}, "Existing tokens"), list);
}

function tokenTable(tokens, container) {
  return table(
    [
      { label: "Name", get: (t) => h("strong", {}, t.name) },
      { label: "Role", get: (t) => pill(t.role, t.role === "admin" ? "warn" : "accent") },
      { label: "Apps", wrap: true, get: (t) => (t.app_scope ? JSON.parse(t.app_scope).join(", ") : "all") },
      { label: "Expires", get: (t) => (t.expires_at ? (Date.parse(t.expires_at) < Date.now() ? pill("expired", "bad") : new Date(t.expires_at).toLocaleDateString()) : pill("never", "warn")) },
      { label: "Source", get: (t) => (t.source === "github-oidc" ? "GitHub Actions" : t.source === "cli-ephemeral" ? "CLI (short-lived)" : "manual") },
      { label: "Last used", get: (t) => fmt.ago(t.last_used_at) },
      { label: "Created", get: (t) => `${fmt.ago(t.created_at)}${t.created_by ? ` by ${t.created_by.split(" (")[0]}` : ""}` },
      {
        label: "",
        get: (t) =>
          t.revoked_at
            ? pill("revoked", "bad")
            : confirmButton("Revoke", "Confirm revoke", async () => {
                await api("DELETE", `/api/admin/tokens/${t.id}`);
                toast(`Revoked ${t.name}`);
                const fresh = (await api("GET", "/api/admin/tokens")).tokens;
                set(container, tokenTable(fresh, container));
              }),
      },
    ],
    tokens,
    { empty: "No tokens yet" },
  );
}
