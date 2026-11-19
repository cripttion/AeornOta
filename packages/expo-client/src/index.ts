/**
 * Aeron client kit for expo-updates apps (optional, but makes updates land much faster).
 *
 * Stock behaviour: expo-updates checks on cold start only, and the update runs on the *next* cold start.
 * Many users keep apps in the background for days, so fixes can take a long time to arrive.
 *
 * This adds:
 *  - a check whenever the app comes back to the foreground (throttled),
 *  - immediate apply for updates published with `--critical` (at a moment you choose),
 *  - anonymous launch telemetry so Aeron can tell a healthy update from a broken one.
 *
 * Usage (once, near the root of the app):
 *
 *   import { useAeronUpdates } from "@aeron/expo-client";
 *   export default function App() {
 *     useAeronUpdates({ server: "https://ota.example.com", appId: "calmi" });
 *     ...
 *   }
 */
import { useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";
import * as Updates from "expo-updates";

export interface AeronOptions {
  server: string;
  appId: string;
  /** Minimum minutes between foreground checks. Default 30. */
  minIntervalMinutes?: number;
  /**
   * Called when a critical update has been downloaded. Return true to reload now.
   * Default: reload immediately. Use it to show a "Restarting to apply a fix" toast, or to defer
   * until the user is not mid-purchase.
   */
  onCriticalUpdate?: () => boolean | Promise<boolean>;
  /** Send launch telemetry (default true). No personal data is sent. */
  telemetry?: boolean;
}

function send(opts: AeronOptions, event: string) {
  if (opts.telemetry === false || __DEV__) return;
  fetch(`${opts.server.replace(/\/$/, "")}/expo/${opts.appId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event, updateId: Updates.updateId ?? null }),
  }).catch(() => undefined);
}

export async function checkNow(opts: AeronOptions): Promise<"none" | "downloaded" | "applied"> {
  if (__DEV__ || !Updates.isEnabled) return "none";
  const result = await Updates.checkForUpdateAsync();
  if (!result.isAvailable) return "none";
  const fetched = await Updates.fetchUpdateAsync();
  if (!fetched.isNew) return "none";
  send(opts, "update_downloaded");
  const manifest = fetched.manifest as { extra?: { aeron?: { critical?: boolean } } } | undefined;
  if (manifest?.extra?.aeron?.critical) {
    const go = opts.onCriticalUpdate ? await opts.onCriticalUpdate() : true;
    if (go) {
      await Updates.reloadAsync();
      return "applied";
    }
  }
  return "downloaded";
}

export function useAeronUpdates(opts: AeronOptions) {
  const last = useRef(0);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    // Report a healthy launch once the first screen has rendered.
    send(optsRef.current, Updates.isEmergencyLaunch ? "emergency_launch" : "launch_ok");

    const minGap = (opts.minIntervalMinutes ?? 30) * 60_000;
    const onChange = (s: AppStateStatus) => {
      if (s !== "active" || Date.now() - last.current < minGap) return;
      last.current = Date.now();
      checkNow(optsRef.current).catch(() => send(optsRef.current, "update_failed"));
    };
    last.current = Date.now(); // the cold-start check is done by expo-updates itself
    const sub = AppState.addEventListener("change", onChange);
    return () => sub.remove();
  }, []);
}

/** Call from your global error handler to count JS errors per update. */
export function reportJsError(opts: AeronOptions) {
  send(opts, "js_error");
}
