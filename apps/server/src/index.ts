import { Hono } from "hono";
import type { AppEnv, Env } from "./env";
import { errorResponse } from "./lib/http";
import { admin } from "./routes/admin";
import { adminApprovals } from "./routes/admin-approvals";
import { adminExpo } from "./routes/admin-expo";
import { adminFlutter } from "./routes/admin-flutter";
import { adminOverview } from "./routes/admin-overview";
import { expoPublic } from "./routes/expo-public";
import { files } from "./routes/files";
import { adminGithub, githubAuth } from "./routes/github";
import { shorebirdCli } from "./routes/shorebird-cli";
import { shorebirdDevice } from "./routes/shorebird-device";

const app = new Hono<AppEnv>();

app.onError((err, c) => errorResponse(c, err));

app.get("/healthz", (c) => c.json({ ok: true, service: "aeron" }));

// Device-facing (public, hot path): update checks and downloads.
app.route("/", expoPublic);
app.route("/", files);
app.route("/", shorebirdDevice); // /api/v1/patches/check, /api/v1/patches/events, /sb/*, /api/v1/uploads/*

// GitHub Actions OIDC → short-lived publisher token.
app.route("/", githubAuth);

// Stock Shorebird CLI (token required, Shorebird error format).
app.route("/api/v1", shorebirdCli);

// Aeron operator API (token required).
admin.route("/expo", adminExpo);
admin.route("/flutter", adminFlutter);
admin.route("/github", adminGithub);
admin.route("/", adminApprovals);
admin.route("/", adminOverview);
app.route("/api/admin", admin);

// Everything else is the static console, served with strict browser security headers.
const CONSOLE_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "cross-origin-opener-policy": "same-origin",
};

// Pages: "/" is the project website, "/dashboard" the console, "/docs" the console's public docs reader.
app.get("/docs", (c) => serveAsset(c.env, c.req.raw, "/dashboard"));
app.get("/docs/", (c) => serveAsset(c.env, c.req.raw, "/dashboard"));
app.all("*", async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CONSOLE_HEADERS)) out.headers.set(k, v);
  return out;
});

async function serveAsset(env: Env, req: Request, path: string) {
  const url = new URL(req.url);
  url.pathname = path;
  url.search = "";
  const res = await env.ASSETS.fetch(new Request(url.toString(), { method: "GET", headers: req.headers }));
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CONSOLE_HEADERS)) out.headers.set(k, v);
  return out;
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    // A base_url with a trailing slash makes clients call //api/v1/...; normalise it.
    const url = new URL(req.url);
    if (url.pathname.includes("//")) {
      url.pathname = url.pathname.replace(/\/{2,}/g, "/");
      req = new Request(url.toString(), req);
    }
    return app.fetch(req, env, ctx);
  },
};
