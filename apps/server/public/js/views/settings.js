import { api } from "../api.js";
import { state } from "../main.js";
import { codeBlock, h, notice, pageHead, set } from "../ui.js";

export async function renderSettings(page) {
  const s = state.settings || (await api("GET", "/api/admin/settings"));
  const row = (k, v) => [h("dt", {}, k), h("dd", {}, v)];
  set(
    page,
    pageHead({ title: "Settings", sub: "Facts about this deployment, including the addresses built into your app builds. To change a value, edit apps/server/wrangler.jsonc and redeploy.", doc: "setup" }),
    s.bootstrapTokenActive
      ? notice(
          "warn",
          h("strong", {}, "The one-time setup token still works."),
          h("span", {}, "Create your own admin token under Access tokens, sign in with it, then delete the setup token:"),
          codeBlock("cd apps/server && npx wrangler secret delete BOOTSTRAP_ADMIN_TOKEN"),
        )
      : null,
    h(
      "section",
      { class: "card" },
      h("div", { class: "card-head" }, h("h2", {}, "This deployment")),
      h(
        "dl",
        { class: "kv" },
        row("Aeron version", s.version),
        row("Public address", h("span", { class: "mono" }, s.publicBaseUrl)),
        row("File downloads", h("span", { class: "mono" }, s.filesBaseUrl)),
        row("Event sampling", `${Math.round(s.eventSampleRate * 100)}% of phone events are stored (counts are scaled back up)`),
        row("Signed in as", `${state.me.name} (${state.me.role}${state.me.apps ? `, apps: ${state.me.apps.join(", ")}` : ""})`),
      ),
    ),
    h(
      "section",
      { class: "card" },
      h("div", { class: "card-head" }, h("h2", {}, "Addresses built into your apps"), h("span", { class: "sub" }, "Changing these needs new store builds, so use a domain you will keep")),
      h(
        "dl",
        { class: "kv" },
        row("Expo update URL", h("span", { class: "mono" }, s.endpoints.expoManifest)),
        row("Expo client kit", h("span", { class: "mono" }, s.endpoints.expoEvents)),
        row("Shorebird base_url", h("span", { class: "mono" }, s.endpoints.shorebird)),
        row("Files", h("span", { class: "mono" }, s.endpoints.files)),
      ),
    ),
    h(
      "section",
      { class: "card" },
      h("div", { class: "card-head" }, h("h2", {}, "Sign in from the CLI"), h("span", { class: "sub" }, "Same on macOS and Windows")),
      codeBlock(`aeron login --server ${s.publicBaseUrl} --token <your token>`),
    ),
  );
}
