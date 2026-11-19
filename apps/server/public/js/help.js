// Plain-language help: the glossary behind every dotted-underlined word, and the "Help" panel for each page.
import { drawer, h, icon } from "./ui.js";

/** `code` and **bold** inside help strings, rendered as DOM (never innerHTML). */
export function rich(text) {
  const out = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  for (const m of String(text).matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    out.push(t.startsWith("`") ? h("code", {}, t.slice(1, -1)) : h("strong", {}, t.slice(2, -2)));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export const GLOSSARY = {
  update: ["Update", "An over-the-air change for an Expo or React Native app: a new JavaScript bundle plus any changed images. Phones download it and switch to it on the next launch."],
  patch: ["Patch", "An over-the-air change for a Flutter app: a small file that replaces the app's Dart code. You build it with `aeron flutter patch`."],
  storeBuild: ["Store build", "The app people install from the App Store or Play Store. Over-the-air changes only reach store builds whose native code matches, so a JavaScript or Dart change can never crash a build that's missing something native."],
  runtime: ["Runtime version", "A label for a store build's native code, such as `2.3.0`. Aeron sends an update only to builds with the same runtime version. Change it whenever you change native code (a new native library, an SDK upgrade)."],
  release: ["Release", "A Flutter store build made with `aeron flutter release`, named versionName+versionCode, such as `1.4.0+12`. Every patch belongs to exactly one release."],
  channel: ["Channel", "A named stream of changes, such as `production` or `staging`. A store build listens to one channel, chosen when you build it. Flutter calls this a track."],
  rollout: ["Rollout", "The share of phones that get the newest change. Start small (10%), watch errors, then go to 100%. A phone keeps its place as you raise the share, so nobody flips back and forth."],
  approval: ["Approval (four-eyes)", "New code waits until a second person approves it: an admin signed in with a different token than the one that published it. A leaked CI secret or laptop token alone can't put code on phones."],
  halt: ["Halt", "Sets the rollout to 0%. No new phones get the change. Phones that already have it keep it until you undo or ship something newer."],
  undo: ["Undo", "For Expo apps. Phones running the current update go back to the code inside their store build, and everyone is offered the previous good update. Use it when an update is broken."],
  rollback: ["Roll back", "For Flutter apps. Phones remove the patch on their next launch and run the release's original code (or the previous patch)."],
  stable: ["Previous update", "The last update that was fully rolled out. Phones outside the rollout share keep running it."],
  signing: ["Code signing", "Every change is signed with your private key on your computer or in CI. Phones check the signature against a certificate built into the store build, so nobody else, not even someone who hacks the server, can make a change phones will accept."],
  token: ["Access token", "A password-like key for the CLI, CI or this dashboard. It has a role, can be limited to some apps, and expires. A token can never sign code."],
  roles: ["Roles", "**Viewer** sees everything. **Publisher** publishes from the CLI or CI and moves rollouts, but can't approve. **Admin** can do everything, including approvals, apps, tokens and keys."],
  critical: ["Critical update", "Applied as soon as it's downloaded (with the client kit) instead of on the next launch. Use it for urgent fixes."],
  clientKit: ["Client kit", "An optional helper for Expo apps (`useAeronUpdates`). It checks for updates whenever the app comes back to the foreground, and reports healthy launches and errors so you can see them here."],
  bsdiff: ["Patch download", "Phones that already have the previous update download only the bytes that changed, often a few KB instead of several MB."],
  downloads: ["Update downloads", "How many times phones downloaded an update or a patch."],
  launches: ["Healthy launches", "App starts that phones reported as successful. Expo apps report these through the client kit; Flutter apps through the Shorebird updater."],
  errorRate: ["Error rate", "Errors ÷ (healthy launches + errors), as reported by phones. Watch it after every rollout step. A jump means: halt first, investigate second."],
  oidc: ["GitHub OIDC", "GitHub proves to Aeron which repository and branch a workflow runs from. Aeron then gives it a one-hour token, so no Aeron token is stored in GitHub."],
  access: ["Cloudflare Access", "Puts this dashboard behind your company login with multi-factor authentication. Then a stolen token alone can't approve anything. Free for up to 50 people."],
  audit: ["Audit log", "A permanent record of every change: who did it, when, and what changed."],
  bootstrap: ["Setup token", "The one-time admin token printed by npm run setup on a new server. Use it once to create your own admin token, then turn it off."],
};

/** A word with a dotted underline that explains itself on hover or focus. */
export function term(key, text) {
  const g = GLOSSARY[key];
  if (!g) return text;
  return h("span", { class: "term", tabindex: "0", tip: () => h("div", {}, h("b", {}, g[0]), h("div", {}, rich(g[1]))) }, text ?? g[0]);
}

/** A small "?" that explains a heading or label. */
export function qmark(key) {
  const g = GLOSSARY[key];
  if (!g) return null;
  return h("span", { class: "qmark", tabindex: "0", "aria-label": `What is ${g[0]}?`, tip: () => h("div", {}, h("b", {}, g[0]), h("div", {}, rich(g[1]))) }, "?");
}

const T = (q, ...steps) => ({ q, steps });

const HELP = {
  overview: {
    title: "Overview",
    what: "Your home page. It shows what needs you right now, how updates move from your code to phones, and how healthy each app is.",
    tasks: [
      T("Something needs my attention", "Work down the **Needs your attention** list. Each line has a button that takes you to the fix."),
      T("Is my latest update healthy?", "Look at **Error rate**. If it jumped after a rollout, open the app, then **Halt** (Expo) or **Roll back** (Flutter)."),
      T("Add another app", "Click **Add app**, choose Expo / React Native or Flutter, then follow the app's **Setup guide** tab."),
    ],
    terms: ["approval", "rollout", "downloads", "launches", "errorRate"],
    doc: "how-it-works",
  },
  approvals: {
    title: "Approvals",
    what: "New code waits here until a second person approves it. Nothing on this page has reached any phone yet.",
    tasks: [
      T("Approve an update", "Read the message and check the commit link matches what you expect.", "Choose the starting share (10% is a safe start).", "Click **Approve**, then click again to confirm. Phones get it within about 15 seconds of their next check."),
      T("Something looks wrong", "Click **Reject** twice. It can never go live. Then check **Audit log** to see who submitted it."),
      T("I can't approve my own update", "That's four-eyes working. Approve with your separate admin token (or have a teammate do it). With Cloudflare Access on, your SSO login counts as the second check."),
    ],
    terms: ["approval", "rollout", "signing", "bsdiff"],
    doc: "rollouts",
  },
  "app-expo-rollouts": {
    title: "Live now",
    what: "What every group of phones is running right now. One card per store build and platform. Change who gets the newest update, stop it, or undo it.",
    tasks: [
      T("Give the update to more phones", "Click **25%**, **50%** or **100%** on the card. It takes effect within about 15 seconds."),
      T("Something is broken", "Click **Halt** to stop it spreading.", "If phones that have it are affected, click **Undo** twice: they go back to the code in their store build."),
      T("Ship the previous version again", "Open **History**, click the good update, and copy the **Re-ship this bundle** command."),
    ],
    terms: ["rollout", "stable", "halt", "undo", "runtime", "channel"],
    doc: "rollouts",
  },
  "app-expo-updates": {
    title: "History",
    what: "Every update ever published for this app, newest first, with its status (waiting for approval, live, rejected), size and commit.",
    tasks: [T("See the details of an update", "Click its row. The panel shows files, size, patches and the command to re-ship it.")],
    terms: ["update", "bsdiff", "critical"],
    doc: "expo",
  },
  "app-expo-runtimes": {
    title: "Store builds",
    what: "The store builds Aeron may send updates to. Register each store build once, when it ships. Updates for unregistered builds are refused, which prevents crashes.",
    tasks: [T("I shipped a new store build", "In the app folder run `aeron expo runtime register --app <id>`, or fill in the form on this tab.")],
    terms: ["storeBuild", "runtime"],
    doc: "expo/runtime-versions-the-rule-that-prevents-crashes",
  },
  "app-expo-keys": {
    title: "Signing keys",
    what: "The public halves of your signing keys. Phones only accept updates signed with the matching private key, which never leaves your computer or CI.",
    tasks: [T("Rotate a key", "Generate and register a new key under a new key id, ship store builds with the new certificate, then **Retire** the old key here.")],
    terms: ["signing"],
    doc: "security",
  },
  "app-expo-activity": {
    title: "Activity",
    what: "How phones are doing: downloads per day, error rate per day, counts per update, and recent changes to this app.",
    tasks: [T("No launches or errors show up", "Those numbers come from the optional client kit. See the **Setup guide** tab, step 5.")],
    terms: ["downloads", "launches", "errorRate", "clientKit"],
    doc: "rollouts",
  },
  "app-expo-settings": {
    title: "Settings",
    what: "Safety settings for this app. Keep four-eyes approval on, so a single leaked token can't ship code.",
    tasks: [],
    terms: ["approval"],
    doc: "security",
  },
  "app-expo-setup": {
    title: "Setup guide",
    what: "Everything needed to connect this app, in order, with commands you can copy. The checklist ticks itself off as you go.",
    tasks: [T("Fastest way", "In the app folder, run `aeron expo init --app <id> --write`, then `aeron doctor`.")],
    terms: ["signing", "runtime", "storeBuild", "clientKit"],
    doc: "expo",
  },
  "app-flutter-releases": {
    title: "Releases & patches",
    what: "Each store release and the patches made for it. A patch first waits for approval, then rolls out to the share of phones you choose.",
    tasks: [
      T("Give a patch to more phones", "Click **50%** or **100%** on its row."),
      T("A patch is broken", "Click **Roll back** twice. Phones remove it on their next launch."),
    ],
    terms: ["release", "patch", "rollout", "rollback", "channel"],
    doc: "flutter",
  },
  "app-flutter-signing": {
    title: "Signing",
    what: "Whether this app only accepts signed patches (it should), and the public key Aeron uses to reject badly signed uploads.",
    tasks: [],
    terms: ["signing"],
    doc: "security",
  },
  "app-flutter-activity": {
    title: "Activity",
    what: "Patch downloads and install failures per day, counts per release and patch, and recent changes to this app.",
    tasks: [],
    terms: ["downloads", "errorRate"],
    doc: "flutter",
  },
  "app-flutter-settings": {
    title: "Settings",
    what: "Safety settings for this app. Keep four-eyes approval on.",
    tasks: [],
    terms: ["approval"],
    doc: "security",
  },
  "app-flutter-setup": {
    title: "Setup guide",
    what: "Everything needed to connect this Flutter app, in order. `aeron flutter` wraps the shorebird CLI, so you don't manage its flags or tokens.",
    tasks: [T("Fastest way", "In the Flutter project, run `aeron flutter init --app <id> --write`, then `aeron doctor`.")],
    terms: ["release", "patch", "signing"],
    doc: "flutter",
  },
  "new-app": {
    title: "Add an app",
    what: "Register a mobile app with Aeron. You do this once per app; then the app's Setup guide walks you through connecting the code.",
    tasks: [T("Which framework?", "**Expo / React Native** for Expo, bare React Native and plain React Native apps. **Flutter** for Flutter apps (uses Shorebird's engine).")],
    terms: [],
    doc: "walkthrough",
  },
  security: {
    title: "Security",
    what: "A live checklist of everything that stops someone from pushing malicious code to your apps, with steps for anything not yet switched on.",
    tasks: [T("Make it all green", "Work through **Your settings** from top to bottom. Each item says exactly what to do.")],
    terms: ["signing", "approval", "access", "oidc", "bootstrap"],
    doc: "security",
  },
  integrations: {
    title: "Integrations",
    what: "Connect GitHub Actions (publish from CI without storing tokens), download the `aeron` command-line tool, and send security alerts to Slack or Discord.",
    tasks: [
      T("Publish from GitHub", "Add a trust rule for the repository and branch.", "Copy the workflow file into the repository.", "Add the variables and secret listed under it."),
      T("Install the CLI", "Copy the commands for your system (macOS or Windows) under **The aeron command-line tool**."),
    ],
    terms: ["oidc", "token"],
    doc: "github",
  },
  tokens: {
    title: "Access tokens",
    what: "Keys that let the CLI, CI and this dashboard talk to Aeron. Give each person or machine its own token, with the smallest role and an expiry.",
    tasks: [
      T("Set up a teammate or CI", "Create a **Publisher** token limited to the app, 90 days. Copy it right away: it's shown once."),
      T("A token may have leaked", "Click **Revoke** twice. It stops working immediately. Then check **Audit log**."),
    ],
    terms: ["token", "roles", "bootstrap"],
    doc: "security",
  },
  audit: {
    title: "Audit log",
    what: "Every change made through the API, CLI or this dashboard: who did it, when, and the details. Entries can't be edited or deleted.",
    tasks: [T("Who approved this update?", "Filter by the app, then look for **Approved an update**.")],
    terms: ["audit"],
    doc: "security",
  },
  settings: {
    title: "Settings",
    what: "Read-only facts about this deployment, including the URLs compiled into your app builds. Values are changed in `apps/server/wrangler.jsonc` and redeployed.",
    tasks: [],
    terms: [],
    doc: "setup",
  },
  docs: {
    title: "Documentation",
    what: "Guides for every part of Aeron. Use the search box to find anything, and the macOS / Windows tabs to see commands for your computer.",
    tasks: [],
    terms: [],
    doc: "getting-started",
  },
};

export function hasHelp(key) {
  return Boolean(HELP[key]);
}

/** Opens the help panel for a page key such as "overview" or "app-expo-rollouts". */
export function openHelp(key) {
  const p = HELP[key] || HELP.overview;
  drawer(
    `Help: ${p.title}`,
    h(
      "div",
      { class: "help stack", style: { gap: "14px" } },
      h("h3", {}, "What this page is for"),
      h("p", {}, rich(p.what)),
      p.tasks.length ? h("h3", {}, "How do I…") : null,
      p.tasks.map((t) => h("div", { class: "task" }, h("strong", {}, t.q), t.steps.length > 1 ? h("ol", {}, t.steps.map((s) => h("li", {}, rich(s)))) : h("p", { class: "muted" }, rich(t.steps[0])))),
      p.terms.length ? h("h3", {}, "Words on this page") : null,
      p.terms.length ? h("dl", { class: "terms" }, p.terms.flatMap((k) => [h("dt", {}, GLOSSARY[k][0]), h("dd", {}, rich(GLOSSARY[k][1]))])) : null,
      h(
        "div",
        { class: "btn-row", style: { marginTop: "6px" } },
        h("a", { class: "btn", href: `#/docs/${p.doc}` }, icon("docs"), "Read the guide"),
        h("a", { class: "btn ghost", href: "#/docs/how-it-works" }, "How Aeron works"),
        h("a", { class: "btn ghost", href: "#/docs/glossary" }, "Glossary"),
      ),
    ),
  );
}
