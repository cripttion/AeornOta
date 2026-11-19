import { api } from "../api.js";
import { refreshApprovalBadge, state } from "../main.js";
import { term } from "../help.js";
import { confirmButton, fmt, h, icon, notice, pageHead, pill, set, toast } from "../ui.js";

const PHONES = { ios: "iPhones", android: "Android phones" };

/** The four-eyes queue: new code waits here until a second person approves it. */
export async function renderApprovals(page) {
  const r = await api("GET", "/api/admin/approvals");
  const total = r.expo.length + r.flutter.length;
  refreshApprovalBadge();
  const appName = (id) => state.apps.find((a) => a.id === id)?.name || id;

  const review = async (kind, item, decision, percent) => {
    try {
      if (kind === "expo") {
        await api("POST", `/api/admin/expo/updates/${item.id}/review`, { decision, percent });
      } else {
        await api("POST", `/api/admin/flutter/apps/${item.app_id}/patches/${item.patch_id}/action`, { channel: item.channel, action: decision, percent });
      }
      toast(decision === "approve" ? `Approved: ${percent}% of phones get it within about 15 seconds` : "Rejected: it will never go live");
      await renderApprovals(page);
    } catch (e) {
      toast(e.message, "bad");
    }
  };

  const card = (kind, item) => {
    const expo = kind === "expo";
    const requested = (expo ? item.requested_percent_bp : item.requested_bp) ?? 10000;
    const pct = h("input", { type: "number", min: 1, max: 100, step: 1, value: String(requested / 100), "aria-label": "Share of phones after approval, in percent" });
    const effect = h("span");
    const describe = () =>
      set(
        effect,
        expo
          ? `If you approve, ${pct.value}% of ${PHONES[item.platform] || "phones"} on store build ${item.runtime_version} (${item.channel} channel) get this update on their next check, within about 15 seconds. The rest stay on what they run now.`
          : `If you approve, ${pct.value}% of phones on release ${item.release_version} (${item.channel} track) download this patch on their next launch and run it on the one after.`,
      );
    pct.addEventListener("input", describe);
    describe();
    const commit = item.git_sha ? (item.repository ? h("a", { href: `https://github.com/${item.repository}/commit/${item.git_sha}`, target: "_blank", rel: "noopener noreferrer", class: "mono" }, item.git_sha.slice(0, 7)) : h("span", { class: "mono" }, item.git_sha.slice(0, 7))) : null;
    const run = item.ci_run_url ? h("a", { href: item.ci_run_url, target: "_blank", rel: "noopener noreferrer" }, "CI run", icon("external")) : null;
    const canReview = r.canReview && !(item.selfSubmitted && !r.accessEnforced);
    const who = String((expo ? item.published_by : item.created_by) || "—").split(" (")[0];
    return h(
      "section",
      { class: "card approval" },
      h(
        "div",
        { class: "card-head", style: { marginBottom: 0 } },
        h("div", { class: "stack", style: { gap: "4px" } }, h("span", { class: "eyebrow" }, h("strong", {}, appName(item.app_id)), expo ? `${item.platform === "ios" ? "iOS" : "Android"} · ${item.channel}` : `Release ${item.release_version} · patch #${item.number}`), h("span", { class: "what" }, (expo ? item.message : item.notes) || h("span", { class: "muted" }, "No description given"))),
        h("span", { class: "btn-row" }, pill(expo ? "Expo update" : "Flutter patch", "accent"), item.critical ? pill("critical: applies immediately", "warn") : null),
      ),
      h("div", { class: "effect" }, icon("info"), effect),
      h(
        "div",
        { class: "meta" },
        h("span", {}, "Submitted by ", h("strong", {}, who), " ", fmt.ago(expo ? item.published_at : item.created_at)),
        commit ? h("span", {}, "Commit ", commit) : h("span", {}, "No commit recorded"),
        run,
        h("span", {}, "Size ", h("strong", {}, fmt.bytes(item.total_bytes))),
        expo && item.smallest_patch_bytes !== null ? h("span", {}, term("bsdiff", "Download for most phones"), " ", h("strong", {}, fmt.bytes(item.smallest_patch_bytes))) : null,
        kind === "flutter" ? h("span", {}, "Signed files ", h("strong", {}, `${item.signed_artifacts}/${item.artifacts}`)) : h("span", {}, "Signed with key ", h("strong", {}, item.key_id)),
      ),
      h(
        "details",
        { class: "checks-before" },
        h("summary", {}, "Before you approve, check:"),
        h(
          "ul",
          {},
          h("li", {}, "The message matches a change you expected."),
          h("li", {}, commit ? "The commit link opens the change you expected, on the right branch." : "Ask the submitter which commit this is. Publishing from GitHub Actions records it automatically."),
          h("li", {}, "The size didn't jump unexpectedly compared with the last update."),
          h("li", {}, "Start small (10%). You can raise it from the app page once the error rate looks fine."),
        ),
      ),
      canReview
        ? h(
            "div",
            { class: "approval-actions" },
            h("label", { class: "small" }, "Start with ", pct, " % of phones"),
            confirmButton("Approve", "Click again to go live", () => review(kind, item, "approve", Number(pct.value)), "btn small"),
            confirmButton("Reject", "Click again to reject", () => review(kind, item, "reject"), "btn danger small"),
          )
        : notice("", !r.canReview ? "Only admins can approve or reject." : "You submitted this with the token you're signed in with. A different admin token has to approve it: that's the point of four-eyes review. Sign in with your separate admin token, or ask a teammate."),
    );
  };

  set(
    page,
    pageHead({
      title: "Approvals",
      sub: "New code waits here until a second person approves it. Nothing on this page has reached any phone yet.",
      doc: "rollouts",
    }),
    !r.accessEnforced && state.me.role === "admin"
      ? notice("warn", h("p", {}, "Tip: put this dashboard behind ", term("access", "Cloudflare Access"), ", so approving also needs your company login and MFA. Then a stolen token alone can't approve anything. ", h("a", { href: "#/security" }, "How to turn it on →")))
      : null,
    total
      ? h("div", { class: "stack", style: { gap: "14px" } }, ...r.expo.map((u) => card("expo", u)), ...r.flutter.map((x) => card("flutter", x)))
      : h(
          "section",
          { class: "card stack", style: { gap: "8px", alignItems: "flex-start" } },
          h("h2", {}, "Nothing waiting"),
          h("p", { class: "muted" }, "When you, CI or a teammate publishes an update or patch, it appears here for a second person to check. You'll also get an alert if security alerts are set up."),
          h("a", { class: "btn ghost small", href: "#/docs/walkthrough" }, "How publishing works"),
        ),
  );
}
