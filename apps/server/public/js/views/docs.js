import { h, icon, set } from "../ui.js";
import { plainText, renderMarkdown, slugify } from "../md.js";

let index = null;
let corpus = null;
let current = "getting-started";

async function loadIndex() {
  if (!index) {
    const res = await fetch("/docs/index.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("Documentation is not bundled with this deployment (run scripts/sync-docs.mjs before deploying).");
    index = await res.json();
  }
  return index;
}

/** All pages split into sections (by ## / ###), for search. Loaded on the first search. */
async function loadCorpus() {
  if (corpus) return corpus;
  const idx = await loadIndex();
  const pages = await Promise.all(idx.pages.map((p) => fetch(`/docs/${p.slug}.md`, { cache: "no-cache" }).then((r) => r.text()).then((t) => [p, t])));
  corpus = [];
  for (const [p, text] of pages) {
    let heading = p.title;
    let anchor = "";
    let buf = [];
    const flush = () => {
      const body = plainText(buf.join("\n"));
      if (body || anchor) corpus.push({ slug: p.slug, page: p.title, heading, anchor, body, hay: `${heading} ${body}`.toLowerCase() });
    };
    for (const line of text.split("\n")) {
      const m = /^(#{2,3})\s+(.*)$/.exec(line);
      if (m) {
        flush();
        heading = m[2].replace(/`/g, "");
        anchor = slugify(m[2]);
        buf = [];
      } else if (!/^#\s/.test(line)) buf.push(line);
    }
    flush();
  }
  return corpus;
}

function search(q) {
  const terms = q.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  if (!terms.length) return [];
  const scored = [];
  for (const s of corpus) {
    if (!terms.every((t) => s.hay.includes(t))) continue;
    const head = s.heading.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (head.includes(t)) score += 6;
      if (s.page.toLowerCase().includes(t)) score += 2;
      score += Math.min(4, s.hay.split(t).length - 1);
    }
    scored.push([score, s]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, 14).map((x) => x[1]);
}

/** Text with <mark> around matches, built as DOM. */
function highlight(text, terms) {
  const out = [];
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h("mark", {}, m[0]));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

function snippet(body, terms) {
  const lower = body.toLowerCase();
  const hits = terms.map((t) => lower.indexOf(t)).filter((n) => n >= 0);
  const at = hits.length ? Math.max(0, Math.min(...hits) - 60) : 0;
  const s = body.slice(at, at + 220);
  return (at > 0 ? "…" : "") + s + (at + 220 < body.length ? "…" : "");
}

/** Map links inside docs: other docs → in-console routes; web links stay; repo paths become plain text. */
function linkFor(url) {
  if (/^https?:\/\//.test(url)) return url;
  if (url.startsWith("#")) return `#/docs/${current}/${url.slice(1)}`;
  const m = /^(?:\.\/|\.\.\/docs\/|docs\/)?([A-Za-z0-9_-]+)\.md(?:#(.+))?$/.exec(url);
  if (m) {
    const slug = m[1].toLowerCase();
    if (index?.pages.some((p) => p.slug === slug)) return `#/docs/${slug}${m[2] ? `/${m[2]}` : ""}`;
  }
  return null;
}

const isWindows = () => /^win/i.test(navigator.userAgentData?.platform || navigator.platform || "");

function preferredOs() {
  try {
    const v = localStorage.getItem("aeron.os");
    if (v) return v;
  } catch {
    /* ignore */
  }
  return isWindows() ? "windows" : "mac";
}

/** Wire the macOS / Windows tab groups; one choice applies to every group on every page. */
function wireOsTabs(root) {
  const select = (os, save) => {
    for (const g of root.querySelectorAll("[data-os-group]")) {
      const has = g.querySelector(`.os-panel[data-os="${os}"]`);
      const pick = has ? os : g.querySelector(".os-panel")?.dataset.os;
      for (const b of g.querySelectorAll(".os-bar button")) b.setAttribute("aria-selected", String(b.dataset.os === pick));
      for (const p of g.querySelectorAll(".os-panel")) p.hidden = p.dataset.os !== pick;
    }
    if (save) {
      try {
        localStorage.setItem("aeron.os", os);
      } catch {
        /* ignore */
      }
    }
  };
  root.addEventListener("click", (e) => {
    const b = e.target.closest(".os-bar button");
    if (b) select(b.dataset.os, true);
  });
  select(preferredOs(), false);
}

function toc(article) {
  const hs = [...article.querySelectorAll("h2")];
  if (hs.length < 3) return null;
  const links = hs.map((hd) => h("a", { href: `#/docs/${current}/${hd.id}`, "data-id": hd.id }, hd.textContent));
  const nav = h("nav", { class: "docs-toc", "aria-label": "On this page" }, h("span", { class: "label" }, "On this page"), links);
  if ("IntersectionObserver" in window) {
    const obs = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          for (const l of links) l.classList.toggle("active", l.dataset.id === en.target.id);
        }
      },
      { rootMargin: "-80px 0px -70% 0px" },
    );
    for (const hd of hs) obs.observe(hd);
  }
  return nav;
}

export async function renderDocs(page, slug, anchor, opts = {}) {
  const idx = await loadIndex();
  const pageInfo = idx.pages.find((p) => p.slug === slug) || idx.pages[0];
  current = pageInfo.slug;
  const res = await fetch(`/docs/${pageInfo.slug}.md`, { cache: "no-cache" });
  const text = await res.text();
  const article = h("article", { class: "md" });
  article.innerHTML = renderMarkdown(text, linkFor); // renderer escapes all input
  wireOsTabs(article);

  const n = idx.pages.indexOf(pageInfo);
  const prev = idx.pages[n - 1];
  const next = idx.pages[n + 1];
  article.append(
    h(
      "nav",
      { class: "doc-pager", "aria-label": "Previous and next page" },
      prev ? h("a", { href: `#/docs/${prev.slug}` }, h("span", { class: "dir" }, "← Previous"), prev.title) : h("span"),
      next ? h("a", { class: "next", href: `#/docs/${next.slug}` }, h("span", { class: "dir" }, "Next →"), next.title) : null,
    ),
  );

  const tocNav = toc(article);

  // search
  const results = h("div", { class: "search-results", hidden: true, "aria-live": "polite" });
  const input = h("input", { type: "search", placeholder: "Search the docs", "aria-label": "Search the docs", autocomplete: "off" });
  let timer;
  const runSearch = async () => {
    const q = input.value.trim();
    if (q.length < 2) {
      results.hidden = true;
      article.hidden = false;
      if (tocNav) tocNav.hidden = false;
      return;
    }
    await loadCorpus();
    const terms = q.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
    const found = search(q);
    set(
      results,
      h("p", { class: "muted small" }, found.length ? `${found.length} result${found.length === 1 ? "" : "s"} for “${q}”` : `Nothing found for “${q}”. Try fewer or different words.`),
      found.map((s) =>
        h(
          "a",
          { href: `#/docs/${s.slug}${s.anchor ? `/${s.anchor}` : ""}`, onclick: () => ((input.value = ""), (results.hidden = true), (article.hidden = false)) },
          h("div", { class: "where" }, s.page),
          h("div", { class: "what" }, highlight(s.heading, terms)),
          s.body ? h("div", { class: "snip" }, highlight(snippet(s.body, terms), terms)) : null,
        ),
      ),
    );
    results.hidden = false;
    article.hidden = true;
    if (tocNav) tocNav.hidden = true;
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(runSearch, 120);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      input.value = "";
      runSearch();
    }
  });

  const groups = [];
  for (const p of idx.pages) {
    const g = p.group || "Docs";
    let entry = groups.find((x) => x.name === g);
    if (!entry) groups.push((entry = { name: g, pages: [] }));
    entry.pages.push(p);
  }
  set(
    page,
    opts.onBack ? h("p", {}, h("a", { href: "#", onclick: (e) => (e.preventDefault(), (location.hash = ""), opts.onBack()) }, "← Back to sign in")) : null,
    h(
      "div",
      { class: `docs ${tocNav ? "" : "no-toc"}` },
      h(
        "nav",
        { class: "docs-nav", "aria-label": "Documentation" },
        h("div", { class: "docs-search" }, icon("search"), input),
        h(
          "details",
          { class: "docs-pages", open: window.matchMedia("(min-width: 861px)").matches },
          h("summary", {}, `All pages · ${pageInfo.title}`),
          groups.map((g) => h("div", { class: "group" }, h("span", { class: "group-label" }, g.name), g.pages.map((p) => h("a", { href: `#/docs/${p.slug}`, "aria-current": p.slug === pageInfo.slug ? "page" : undefined }, p.title)))),
        ),
      ),
      h("div", { style: { minWidth: 0 } }, results, article),
      tocNav,
    ),
  );
  if (anchor) document.getElementById(anchor)?.scrollIntoView();
  else window.scrollTo(0, 0);
}

// "/" focuses the docs search box.
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !e.target.closest("input, textarea, select")) {
    const box = document.querySelector(".docs-search input");
    if (box) {
      e.preventDefault();
      box.focus();
    }
  }
});
