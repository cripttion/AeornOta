import { api } from "../api.js";
import { codeBlock, h, pageHead, set, svg } from "../ui.js";

/** Plain-language security checklist for the whole deployment, with a score. */
export async function renderSecurity(page) {
  const s = await api("GET", "/api/admin/security");
  const d = s.deployment;
  const appsNoApproval = s.apps.filter((a) => !a.requireApproval);
  const appsNoSigning = s.apps.filter((a) => !a.signingReady);

  const always = [
    ["ok", "Every update is signed on your computer or CI, never on this server", "Phones check the signature against the key built into the store build. A hacked server, database or CDN can't produce an update phones accept."],
    [d.unsignedExpoAllowed ? "bad" : "ok", "Builds that don't check signatures get nothing", d.unsignedExpoAllowed ? "ALLOW_UNSIGNED_EXPO is set. Remove it from wrangler.jsonc and deploy." : `Blocked ${s.unsignedBuildsBlocked7d} update checks from unsigned builds in the last 7 days.`],
    [d.signingChangesUnlocked ? "bad" : "ok", "Signing keys are locked once an app has live releases", d.signingChangesUnlocked ? "ALLOW_SIGNING_CHANGES is set. Remove it as soon as you're done." : "Nobody can swap or switch off a key from this dashboard or the API."],
    ["ok", "Every file is checked", "Each file's fingerprint (SHA-256) is inside the signed manifest, and phones verify patches after download."],
  ];
  const yours = [
    [appsNoApproval.length ? "bad" : "ok", "Four-eyes approval on every app", appsNoApproval.length ? `Off for: ${appsNoApproval.map((a) => a.id).join(", ")}. Turn it on in each app's Settings tab.` : "New code from CI or a token waits under Approvals until a different admin approves it.", appsNoApproval[0] ? `#/apps/${appsNoApproval[0].id}/settings` : null],
    [appsNoSigning.length ? "todo" : "ok", "Signing keys registered for every app", appsNoSigning.length ? `Missing for: ${appsNoSigning.map((a) => a.id).join(", ")}. Follow each app's Setup guide.` : "Every app has its public key registered.", appsNoSigning[0] ? `#/apps/${appsNoSigning[0].id}/setup` : null],
    [d.accessEnforced ? "ok" : "todo", "Company login + MFA for approvals (Cloudflare Access)", d.accessEnforced ? "Approving, and changing keys, tokens and policies, needs a person signed in through Access." : "Recommended. Then a stolen admin token can't approve anything. Needs a custom domain; steps below.", d.accessEnforced ? null : "#access-steps"],
    [d.notificationsConfigured ? "ok" : "todo", "Instant alerts for publishes, approvals, rollbacks and key changes", d.notificationsConfigured ? "Alerts go to your Slack or Discord channel." : "Get a message within seconds if someone publishes or approves unexpectedly.", "#/integrations"],
    [d.bootstrapTokenActive ? "bad" : "ok", "One-time setup token removed", d.bootstrapTokenActive ? "Delete it: cd apps/server && npx wrangler secret delete BOOTSTRAP_ADMIN_TOKEN" : "The setup token no longer works.", d.bootstrapTokenActive ? "#/settings" : null],
    [s.tokens.noExpiry ? "todo" : "ok", "Every token expires", s.tokens.noExpiry ? `${s.tokens.noExpiry} token(s) never expire. Replace them with expiring ones and revoke the old ones.` : `${s.tokens.total} active tokens (${s.tokens.admins} admin). ${s.tokens.expiringSoon} expire within 14 days.`, "#/tokens"],
    [s.githubRules ? "ok" : "todo", "CI publishes through GitHub OIDC, not stored tokens", s.githubRules ? `${s.githubRules} trust rule(s). Workflows get one-hour tokens tied to a repository and branch.` : "Set it up under Integrations, so no long-lived Aeron token sits in GitHub.", "#/integrations"],
    [d.customDomain ? "ok" : "todo", "Your own domain for update URLs", d.customDomain ? "Update URLs use a domain you control." : "You're on *.workers.dev. A domain you control lets you move later without new store builds, and Cloudflare Access needs one.", "#/docs/setup/custom-domain"],
  ];
  const all = [...always, ...yours];
  const ok = all.filter((x) => x[0] === "ok").length;
  const bad = all.filter((x) => x[0] === "bad").length;

  const item = ([status, title, how, href]) =>
    h(
      "li",
      {},
      h("span", { class: status === "ok" ? "mark-ok" : status === "bad" ? "mark-bad" : "mark-todo", "aria-label": status === "ok" ? "on" : status === "bad" ? "problem" : "to do" }, status === "ok" ? "✓" : status === "bad" ? "!" : "·"),
      h("div", {}, h("strong", {}, title), how ? h("div", { class: "how" }, how) : null),
      status !== "ok" && href
        ? href.startsWith("#access")
          ? h("button", { type: "button", class: "btn ghost small go", onclick: () => document.getElementById("access-steps")?.scrollIntoView({ behavior: "smooth", block: "start" }) }, "Steps")
          : h("a", { class: "btn ghost small go", href }, "Fix")
        : h("span"),
    );

  const R = 26;
  const C = 2 * Math.PI * R;
  const ring = svg(
    "svg",
    { viewBox: "0 0 64 64", class: "ring", role: "img", "aria-label": `${ok} of ${all.length} protections on` },
    svg("circle", { cx: 32, cy: 32, r: R, class: "bg" }),
    svg("circle", { cx: 32, cy: 32, r: R, class: "fg", "stroke-dasharray": `${(ok / all.length) * C} ${C}` }),
    svg("text", { x: 32, y: 37, "text-anchor": "middle" }, `${ok}/${all.length}`),
  );

  set(
    page,
    pageHead({ title: "Security", sub: "Everything that stops someone from pushing malicious code to your apps, and what's left to switch on.", doc: "security" }),
    h(
      "section",
      { class: "card score" },
      ring,
      h(
        "div",
        { class: "stack", style: { gap: "4px" } },
        h("h2", {}, bad ? `${bad} problem${bad === 1 ? "" : "s"} to fix` : ok === all.length ? "Every protection is on" : `${ok} of ${all.length} protections on`),
        h("p", { class: "muted" }, bad ? "Fix the red items first: they weaken protections that should always be on." : ok === all.length ? "Nothing to do. Keep approving carefully and rotate tokens when they expire." : "The remaining items are recommended. Each line says what to do."),
      ),
    ),
    h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "Built in"), h("span", { class: "sub" }, "Always on, for every app")), h("ul", { class: "checklist" }, always.map(item))),
    h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "Your settings"), h("span", { class: "sub" }, "Switch these on once")), h("ul", { class: "checklist" }, yours.map(item))),
    h(
      "section",
      { class: "card stack", id: "access-steps", style: { gap: "10px" } },
      h("h2", {}, "Turn on Cloudflare Access (free for up to 50 people)"),
      h(
        "ol",
        { class: "md", style: { fontSize: "14px" } },
        h("li", {}, "Put Aeron on your own domain (see Deploying → Custom domain in the docs)."),
        h("li", {}, "Cloudflare dashboard → Zero Trust → Access → Applications → Add → Self-hosted. Domain: your Aeron domain, with two paths: ", h("code", {}, "/dashboard"), " and ", h("code", {}, "/api/admin/*"), ". Policy: allow your email(s), and require MFA. Everything else stays public, as phones and CI need."),
        h("li", {}, "Copy the application's Audience (AUD) tag and your team domain into wrangler.jsonc, then deploy:"),
      ),
      codeBlock('# apps/server/wrangler.jsonc → "vars"\n"ACCESS_TEAM_DOMAIN": "yourteam.cloudflareaccess.com",\n"ACCESS_AUD": "<audience tag>"\n\ncd apps/server && npm run deploy'),
      h("p", { class: "muted small" }, "Automation that calls the admin API through Access needs a service token (AERON_CF_ACCESS_CLIENT_ID / _SECRET). Service tokens can publish, but never approve."),
    ),
  );
}
