// Small DOM + formatting helpers. Everything user-supplied goes through text nodes, never innerHTML.
import { icon } from "./icons.js";

export { icon };

export function h(tag, attrs = {}, ...children) {
  const el = tag === "svg" || attrs?.["data-svg"] ? document.createElementNS("http://www.w3.org/2000/svg", tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false || k === "data-svg") continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.setAttribute("class", v);
    else if (k === "tip") el._tip = v;
    else if (k === "style" && typeof v === "object") {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith("--")) el.style.setProperty(sk, sv);
        else el.style[sk] = sv;
      }
    } else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}

/** replaceChildren that skips null/false (the DOM version would render them as text). */
export function set(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k === "tip") el._tip = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

export function toast(message, kind = "") {
  const t = h("div", { class: `toast ${kind}`, role: "status" }, message);
  document.getElementById("toasts").append(t);
  setTimeout(() => t.remove(), kind === "bad" ? 6000 : 3200);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const fmt = {
  num(n) {
    n = Number(n || 0);
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
    if (n >= 1e4) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, "") + "K";
    return n.toLocaleString();
  },
  axis(n, max) {
    if (max >= 10000) return fmt.num(n);
    return Number(n).toLocaleString();
  },
  bytes(b) {
    if (b === null || b === undefined) return "—";
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB`;
    return `${(b / 1024 / 1024).toFixed(1)} MB`;
  },
  id(id) {
    return id ? String(id).slice(0, 8) : "—";
  },
  ago(iso) {
    if (!iso) return "—";
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
    return new Date(iso).toLocaleDateString();
  },
  when(iso) {
    return iso ? new Date(iso).toLocaleString() : "—";
  },
  day(d) {
    const [, m, dd] = String(d).split("-");
    return `${MONTHS[Number(m) - 1]} ${Number(dd)}`;
  },
  pct(bp) {
    return `${Math.round(Number(bp) / 10) / 10}%`;
  },
  rate(r, digits = 2) {
    if (r === null || r === undefined || Number.isNaN(r)) return "—";
    const v = r * 100;
    return `${v < 0.01 && v > 0 ? "<0.01" : v.toFixed(v >= 10 ? 1 : digits)}%`;
  },
};

export function pill(text, kind = "", { dot = false, tip } = {}) {
  return h("span", { class: `pill ${kind}`, tip, tabindex: tip ? "0" : undefined }, dot ? h("span", { class: "dot" }) : null, text);
}

export function meter(percent) {
  return h("span", { class: "meter" }, h("span", { class: "track" }, h("span", { class: "fill", style: { width: `${percent}%` } })), `${percent}%`);
}

/** Notice box with an icon. kind: "" | "warn" | "bad" | "good". */
export function notice(kind, ...children) {
  const ico = kind === "bad" || kind === "warn" ? "alert" : kind === "good" ? "checkCircle" : "info";
  return h("div", { class: `notice ${kind}`, role: kind === "bad" ? "alert" : undefined }, icon(ico), h("div", { class: "stack", style: { gap: "6px" } }, ...children));
}

/**
 * Page header: title, one plain-language sentence, an optional "Learn more" doc link and actions.
 * doc: "rollouts" or "rollouts/anchor".
 */
export function pageHead({ title, sub, doc, docLabel = "Learn more", eyebrow, actions }) {
  return h(
    "div",
    { class: "page-head" },
    h(
      "div",
      { class: "titles" },
      eyebrow ? h("div", { class: "eyebrow" }, eyebrow) : null,
      h("h1", {}, title),
      sub ? h("p", { class: "sub" }, sub, doc ? [" ", h("a", { class: "learn", href: `#/docs/${doc}` }, `${docLabel} →`)] : null) : null,
    ),
    actions ? h("div", { class: "btn-row" }, actions) : null,
  );
}

/** cols: [{ label, get(row) → node|string, num?, wrap?, head? }] */
export function table(cols, rows, { onRow, empty = "Nothing here yet", caption } = {}) {
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      {},
      caption ? h("caption", { class: "muted small", style: { textAlign: "left", padding: "10px 12px", captionSide: "top" } }, caption) : null,
      h("thead", {}, h("tr", {}, cols.map((c) => h("th", { class: c.num ? "num" : undefined, scope: "col" }, c.head ?? c.label)))),
      h(
        "tbody",
        {},
        rows.length
          ? rows.map((r) =>
              h(
                "tr",
                {
                  class: onRow ? "clickable" : undefined,
                  tabindex: onRow ? "0" : undefined,
                  onclick: onRow ? (e) => !e.target.closest("a, button, input, select") && onRow(r) : undefined,
                  onkeydown: onRow ? (e) => e.key === "Enter" && e.target === e.currentTarget && onRow(r) : undefined,
                },
                cols.map((c) => h("td", { class: [c.num ? "num" : "", c.wrap ? "wrap" : ""].join(" ").trim() || undefined }, c.get(r))),
              ),
            )
          : h("tr", {}, h("td", { colspan: cols.length, class: "empty" }, empty)),
      ),
    ),
  );
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  } catch {
    toast("Copy failed: select the text and copy it manually", "bad");
  }
}

export function codeBlock(text) {
  return h(
    "div",
    { class: "code-wrap" },
    h("pre", {}, h("code", {}, text)),
    h("button", { type: "button", class: "btn ghost small copy", onclick: () => copyText(text) }, "Copy"),
  );
}

/** Two-step confirm on the button itself: first click arms, second click (within 4 s) runs. */
export function confirmButton(label, armedLabel, run, cls = "btn danger small") {
  let armed = false;
  let timer;
  const btn = h("button", { type: "button", class: cls }, label);
  btn.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      btn.textContent = armedLabel;
      btn.classList.add("armed");
      timer = setTimeout(() => {
        armed = false;
        btn.textContent = label;
        btn.classList.remove("armed");
      }, 4000);
      return;
    }
    clearTimeout(timer);
    btn.disabled = true;
    try {
      await run();
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

export function drawer(title, ...content) {
  const prev = document.activeElement;
  const close = () => {
    bg.remove();
    panel.remove();
    document.removeEventListener("keydown", onKey);
    hideTip();
    prev?.focus?.();
  };
  const onKey = (e) => e.key === "Escape" && close();
  const bg = h("div", { class: "drawer-bg", onclick: close });
  const panel = h(
    "aside",
    { class: "drawer", role: "dialog", "aria-modal": "true", "aria-label": title },
    h("div", { class: "page-head" }, h("h2", {}, title), h("button", { type: "button", class: "btn ghost small", onclick: close }, icon("close"), "Close")),
    ...content,
  );
  document.addEventListener("keydown", onKey);
  document.body.append(bg, panel);
  panel.querySelector("button")?.focus();
  return close;
}

// ------------------------------------------------------------------ tooltip

let tipEl = null;

function showTip(target, x, y) {
  const content = typeof target._tip === "function" ? target._tip() : target._tip ?? target.getAttribute("data-tip");
  if (!content) return;
  if (!tipEl) {
    tipEl = h("div", { class: "tip", role: "tooltip", id: "aeron-tip" });
    document.body.append(tipEl);
  }
  set(tipEl, content);
  tipEl.hidden = false;
  const r = target.getBoundingClientRect();
  const px = x ?? r.left + r.width / 2;
  const py = y ?? r.top;
  const tw = tipEl.offsetWidth;
  const th = tipEl.offsetHeight;
  let left = Math.min(Math.max(8, px - tw / 2), window.innerWidth - tw - 8);
  let top = py - th - 10;
  if (top < 60) top = (y ?? r.bottom) + 14;
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${top}px`;
  target.setAttribute("aria-describedby", "aeron-tip");
}

export function hideTip() {
  if (tipEl) tipEl.hidden = true;
}

/** One document-level listener powers every tooltip (elements with ._tip or data-tip). */
export function initTips() {
  const find = (el) => {
    while (el && el !== document) {
      if (el._tip || el.getAttribute?.("data-tip")) return el;
      el = el.parentNode;
    }
    return null;
  };
  document.addEventListener("pointerover", (e) => {
    const t = find(e.target);
    if (t && !t._follow) showTip(t);
  });
  document.addEventListener("pointerout", (e) => {
    const t = find(e.target);
    if (t && !t.contains(e.relatedTarget)) hideTip();
  });
  document.addEventListener("focusin", (e) => {
    const t = find(e.target);
    if (t) showTip(t);
    else hideTip();
  });
  document.addEventListener("focusout", hideTip);
  window.addEventListener("scroll", hideTip, { passive: true });
}

export function followTip(target, x, y) {
  showTip(target, x, y);
}

/** Tooltip body: the value leads, the label follows. */
export function tipBody(value, label, sub) {
  return h("div", {}, h("div", { class: "tv" }, value), h("div", { class: "tl" }, label), sub ? h("div", { class: "tl" }, sub) : null);
}

// ------------------------------------------------------------------ figures

/**
 * Stat tile. delta: { pct?: number (fraction), pts?: number, goodWhenUp: bool, period }.
 */
export function statTile({ label, value, sub, delta, trend, tone = "", href, tip }) {
  let d = null;
  if (delta && (delta.pct !== null && delta.pct !== undefined ? Number.isFinite(delta.pct) : Number.isFinite(delta.pts))) {
    const v = delta.pct ?? delta.pts;
    const up = v > 0;
    const flat = Math.abs(v) < (delta.pct !== undefined ? 0.005 : 0.00005);
    const good = flat ? null : up === delta.goodWhenUp;
    const text = flat
      ? "no change"
      : delta.pct !== undefined
        ? `${up ? "▲" : "▼"} ${Math.abs(v * 100).toFixed(Math.abs(v) < 0.1 ? 1 : 0)}%`
        : `${up ? "▲" : "▼"} ${Math.abs(v * 100).toFixed(2)} pts`;
    d = h("span", { class: good === null ? "" : `${up ? "up" : "down"}-${good ? "good" : "bad"}` }, text);
  }
  return h(
    href ? "a" : "div",
    { class: `tile ${tone}`, href, tip },
    h("span", { class: "k" }, label),
    h("div", { class: "row" }, h("span", { class: "v" }, value), trend ? sparkline(trend) : null),
    d || sub ? h("span", { class: "d" }, d, d && delta?.period ? h("span", {}, delta.period) : null, !d && sub ? sub : null) : null,
  );
}

/** Thin two-part bar: share a (accent) vs the rest (gray). */
export function splitBar(aPct, aLabel, bLabel) {
  const a = Math.max(0, Math.min(100, aPct));
  return h(
    "div",
    { class: "split" },
    h(
      "div",
      { class: "split-bar", role: "img", "aria-label": `${a}% ${aLabel}, ${100 - a}% ${bLabel}` },
      a > 0 ? h("span", { class: "a", style: { flex: `${a} 1 0` } }) : null,
      a < 100 ? h("span", { class: "b", style: { flex: `${100 - a} 1 0` } }) : null,
    ),
    h(
      "div",
      { class: "split-legend" },
      h("span", { class: "a" }, h("i"), h("strong", {}, `${a}%`), aLabel),
      h("span", { class: "b" }, h("i"), h("strong", {}, `${100 - a}%`), bLabel),
    ),
  );
}

// ------------------------------------------------------------------ charts

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

const W = 640;

/** Daily columns, one series. rows: [{ day, [key]: n }]. */
export function columnChart(rows, { key, label, format = (n) => Number(n).toLocaleString(), height = 190, unit = "", partialLast = false }) {
  const H = height;
  const padL = 42;
  const padR = 10;
  const padT = 18;
  const padB = 24;
  const vals = rows.map((r) => Number(r[key] || 0));
  const max = Math.max(...vals, 0);
  if (!max) return h("div", { class: "chart-empty" }, "No data in this period yet.");
  const nice = niceMax(max);
  const plotW = W - padL - padR;
  const slot = plotW / rows.length;
  const bw = Math.min(24, slot * 0.62);
  const y = (v) => padT + (H - padT - padB) * (1 - v / nice);
  const g = [];
  for (const t of [0, nice / 2, nice]) {
    g.push(svg("line", { x1: padL, x2: W - padR, y1: y(t), y2: y(t), class: "grid" }));
    g.push(svg("text", { x: padL - 8, y: y(t) + 4, "text-anchor": "end" }, fmt.axis(t, nice)));
  }
  rows.forEach((r, i) => {
    const v = vals[i];
    const x = padL + i * slot + (slot - bw) / 2;
    const y0 = y(0);
    const y1 = y(v);
    const hgt = y0 - y1;
    const rr = Math.min(4, hgt, bw / 2);
    const d = hgt <= 0 ? "" : `M${x},${y0}V${y1 + rr}Q${x},${y1} ${x + rr},${y1}H${x + bw - rr}Q${x + bw},${y1} ${x + bw},${y1 + rr}V${y0}Z`;
    g.push(
      svg("rect", {
        x: padL + i * slot,
        y: padT,
        width: slot,
        height: H - padT - padB,
        class: "bar-hit",
        tabindex: "0",
        role: "img",
        "aria-label": `${fmt.day(r.day)}: ${format(v)} ${label}`,
        tip: () => tipBody(`${format(v)}${unit}`, label, partialLast && i === rows.length - 1 ? `${fmt.day(r.day)} · today so far` : fmt.day(r.day)),
      }),
    );
    g.push(svg("path", { d, class: partialLast && i === rows.length - 1 ? "bar partial" : "bar" }));
    if (i === 0 || i === rows.length - 1 || i === Math.floor(rows.length / 2)) {
      g.push(svg("text", { x: x + bw / 2, y: H - 6, "text-anchor": "middle" }, fmt.day(r.day)));
    }
    const labelI = partialLast ? rows.length - 2 : rows.length - 1;
    if (i === labelI && v > 0) g.push(svg("text", { x: x + bw / 2, y: y1 - 6, "text-anchor": "middle", class: "end-label" }, fmt.num(v)));
  });
  return svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "group", "aria-label": `${label} per day` }, ...g);
}

/** Daily line, one series, with a crosshair. Values may be null (gap). format(v) → string. */
export function lineChart(rows, { key, label, format = fmt.rate, height = 190, minMax = 0, partialLast = false }) {
  const H = height;
  const padL = 48;
  const padR = 46;
  const padT = 18;
  const padB = 24;
  const vals = rows.map((r) => (r[key] === null || r[key] === undefined ? null : Number(r[key])));
  const present = vals.filter((v) => v !== null);
  if (!present.length) return h("div", { class: "chart-empty" }, "No data in this period yet.");
  const nice = niceMax(Math.max(minMax, ...present));
  const plotW = W - padL - padR;
  const step = rows.length > 1 ? plotW / (rows.length - 1) : 0;
  const x = (i) => padL + i * step;
  const y = (v) => padT + (H - padT - padB) * (1 - v / nice);
  const g = [];
  for (const t of [0, nice / 2, nice]) {
    g.push(svg("line", { x1: padL, x2: W - padR, y1: y(t), y2: y(t), class: "grid" }));
    g.push(svg("text", { x: padL - 8, y: y(t) + 4, "text-anchor": "end" }, format(t)));
  }
  // segments (break on gaps)
  let seg = [];
  const segs = [];
  vals.forEach((v, i) => {
    if (v === null) {
      if (seg.length) segs.push(seg);
      seg = [];
    } else seg.push([x(i), y(v)]);
  });
  if (seg.length) segs.push(seg);
  for (const s of segs) {
    const pts = s.map((p) => p.map((n) => n.toFixed(1)).join(",")).join(" L");
    if (s.length > 1) g.push(svg("path", { d: `M${s[0][0]},${y(0)} L${pts} L${s[s.length - 1][0]},${y(0)}Z`, class: "area" }));
    g.push(svg("path", { d: `M${pts}`, class: "line" }));
  }
  rows.forEach((r, i) => {
    if (i === 0 || i === rows.length - 1 || i === Math.floor(rows.length / 2)) g.push(svg("text", { x: x(i), y: H - 6, "text-anchor": "middle" }, fmt.day(r.day)));
  });
  const lastI = vals.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0).pop();
  g.push(svg("circle", { cx: x(lastI), cy: y(vals[lastI]), r: 4, class: "dot" }));
  g.push(svg("text", { x: x(lastI) + 8, y: y(vals[lastI]) + 4, class: "end-label" }, format(vals[lastI])));

  const cross = svg("line", { x1: 0, x2: 0, y1: padT, y2: H - padB, class: "cross", visibility: "hidden" });
  const hoverDot = svg("circle", { r: 4, class: "dot", visibility: "hidden" });
  g.push(cross, hoverDot);
  let idx = lastI;
  const overlay = svg("rect", { x: padL - step / 2, y: padT, width: plotW + step, height: H - padT - padB, fill: "transparent", tabindex: "0", role: "img", "aria-label": `${label} per day. Use the arrow keys to read each day.` });
  overlay._follow = true;
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart" }, ...g, overlay);
  const show = (i, clientX, clientY) => {
    idx = Math.max(0, Math.min(rows.length - 1, i));
    const v = vals[idx];
    cross.setAttribute("x1", x(idx));
    cross.setAttribute("x2", x(idx));
    cross.setAttribute("visibility", "visible");
    if (v !== null) {
      hoverDot.setAttribute("cx", x(idx));
      hoverDot.setAttribute("cy", y(v));
      hoverDot.setAttribute("visibility", "visible");
    } else hoverDot.setAttribute("visibility", "hidden");
    overlay._tip = () => tipBody(v === null ? "no data" : format(v), label, partialLast && idx === rows.length - 1 ? `${fmt.day(rows[idx].day)} · today so far` : fmt.day(rows[idx].day));
    const box = root.getBoundingClientRect();
    const sx = box.width / W;
    followTip(overlay, clientX ?? box.left + x(idx) * sx, clientY ?? box.top + (v === null ? padT : y(v)) * sx);
  };
  const hide = () => {
    cross.setAttribute("visibility", "hidden");
    hoverDot.setAttribute("visibility", "hidden");
    hideTip();
  };
  overlay.addEventListener("pointermove", (e) => {
    const box = root.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    show(Math.round((px - padL) / (step || 1)), undefined, undefined);
  });
  overlay.addEventListener("pointerleave", hide);
  overlay.addEventListener("blur", hide);
  overlay.addEventListener("focus", () => show(idx));
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      show(idx + (e.key === "ArrowRight" ? 1 : -1));
    }
  });
  return root;
}

/** Card with a title, a headline figure, the chart, and a Chart/Table switch. */
export function chartCard({ title, sub, big, chart, rows, cols }) {
  const body = h("div", {}, chart);
  const tableView = () => table(cols, rows.slice().reverse());
  const chartBtn = h("button", { type: "button", "aria-pressed": "true" }, "Chart");
  const tableBtn = h("button", { type: "button", "aria-pressed": "false" }, "Table");
  chartBtn.addEventListener("click", () => {
    chartBtn.setAttribute("aria-pressed", "true");
    tableBtn.setAttribute("aria-pressed", "false");
    set(body, chart);
  });
  tableBtn.addEventListener("click", () => {
    chartBtn.setAttribute("aria-pressed", "false");
    tableBtn.setAttribute("aria-pressed", "true");
    set(body, tableView());
  });
  return h(
    "section",
    { class: "card chart-card" },
    h("div", { class: "card-head" }, h("div", { class: "stack", style: { gap: "2px" } }, h("h2", {}, title), sub ? h("span", { class: "sub" }, sub) : null), h("div", { class: "seg", role: "group", "aria-label": "View" }, chartBtn, tableBtn)),
    big !== undefined ? h("div", { class: "big" }, big) : null,
    body,
  );
}

export function sparkline(values) {
  const SW = 96;
  const SH = 26;
  const max = Math.max(1, ...values);
  const stepX = values.length > 1 ? (SW - 4) / (values.length - 1) : SW;
  const pts = values.map((v, i) => [2 + i * stepX, SH - 3 - (v / max) * (SH - 7)]);
  const last = pts[pts.length - 1] || [SW - 2, SH - 3];
  return svg(
    "svg",
    { viewBox: `0 0 ${SW} ${SH}`, class: "spark", "aria-hidden": "true" },
    svg("polyline", { points: pts.map((p) => p.map((n) => n.toFixed(1)).join(",")).join(" "), class: "l" }),
    svg("circle", { cx: last[0], cy: last[1], r: 2.5, class: "e" }),
  );
}
