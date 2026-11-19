// Text edits on apps/server/wrangler.jsonc, used by setup.mjs. Pure functions on the file's text, so they can be
// tested without Cloudflare. The file is JSONC (comments allowed), so it's edited in place, never re-serialised.

/** The string value of "key" (first occurrence), or "". */
export function getValue(text, key) {
  return new RegExp(`"${key}":\\s*"([^"]*)"`).exec(text)?.[1] ?? "";
}

/** Set the string value of "key" (first occurrence). */
export function setValue(text, key, value) {
  return text.replace(new RegExp(`("${key}":\\s*)"[^"]*"`), `$1"${value}"`);
}

/** Hostnames in "routes" (custom domains), in order. */
export function customDomains(text) {
  const m = /"routes":\s*\[([^\]]*)\]/.exec(text);
  return m ? [...m[1].matchAll(/"pattern":\s*"([^"]+)"/g)].map((x) => x[1]) : [];
}

/**
 * Serve the Worker on `domain` (plus www.<domain> for a root domain, which the Worker redirects), and keep the
 * free *.workers.dev address working: with routes, wrangler would otherwise switch it off.
 */
export function setCustomDomain(text, domain) {
  let s = text;
  const hosts = domain.split(".").length === 2 ? [domain, `www.${domain}`] : [domain];
  const routes = `"routes": [${hosts.map((h) => `{ "pattern": "${h}", "custom_domain": true }`).join(", ")}],`;
  if (/"routes":\s*\[[^\]]*\],?/.test(s)) s = s.replace(/"routes":\s*\[[^\]]*\],?/, routes);
  else s = s.replace(/("compatibility_date":\s*"[^"]*",)/, `$1\n  ${routes}`);
  if (!/"workers_dev":/.test(s)) s = s.replace(routes, `${routes}\n  "workers_dev": true,\n  "preview_urls": false,`);
  return s;
}

/** Drop the custom domains (the server then lives on its *.workers.dev address only). */
export function removeCustomDomains(text) {
  return text.replace(/^[ \t]*"routes":\s*\[[^\]]*\],?[ \t]*\r?\n/m, "");
}

/**
 * The server's public address: the domain passed to setup, else the first custom domain already in the config,
 * else the *.workers.dev address wrangler printed, else whatever the config says.
 */
export function choosePublicUrl({ domain, text, workersUrl }) {
  if (domain) return `https://${domain}`;
  const configured = customDomains(text);
  if (configured.length) return `https://${configured[0]}`;
  return workersUrl || getValue(text, "PUBLIC_BASE_URL");
}
