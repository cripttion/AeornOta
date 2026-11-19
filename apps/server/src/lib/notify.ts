import type { Env } from "../env";

/**
 * Security alerts to a Slack- or Discord-compatible incoming webhook (NOTIFY_WEBHOOK_URL secret).
 * Sent for every event that could change what code reaches phones, so you notice misuse within seconds.
 */
export function notify(env: Env, ctx: { waitUntil(p: Promise<unknown>): void } | undefined, text: string) {
  if (!env.NOTIFY_WEBHOOK_URL) return;
  const host = (() => {
    try {
      return new URL(env.PUBLIC_BASE_URL).host;
    } catch {
      return "aeron";
    }
  })();
  const message = `[Aeron · ${host}] ${text}`.slice(0, 1900);
  const p = fetch(env.NOTIFY_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: message, content: message }),
  }).catch((e) => console.error("notify failed", e));
  if (ctx) ctx.waitUntil(p);
}
