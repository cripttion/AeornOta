import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Website and page routes", () => {
  it("redirects www to the bare domain, keeping the path and query", async () => {
    const res = await SELF.fetch("https://www.ota.test/docs?x=1#/docs/faq", { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://ota.test/docs?x=1");
  });

  it("serves the website at /, the dashboard at /dashboard and the docs reader at /docs", async () => {
    const home = await SELF.fetch("https://ota.test/");
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("Self-hosted OTA updates");
    for (const path of ["/dashboard", "/docs"]) {
      const res = await SELF.fetch(`https://ota.test${path}`);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toContain("Aeron Console");
    }
  });

  it("sends strict security headers on pages", async () => {
    const res = await SELF.fetch("https://ota.test/");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});
