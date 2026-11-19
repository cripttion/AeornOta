// Line icons (24×24, stroke = currentColor). Built as DOM nodes, so the strict CSP needs no inline SVG markup.

const NS = "http://www.w3.org/2000/svg";

const P = {
  overview: ["M4 4h7v7H4z", "M13 4h7v4h-7z", "M13 10h7v10h-7z", "M4 13h7v7H4z"],
  approvals: ["M9 4h6v3H9z", "M7 5.5H5V20h14V5.5h-2", "M9 13.5l2 2 4-4.5"],
  security: ["M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z", "M9 12l2 2 4-4"],
  integrations: ["M10 14l4-4", "M8.5 11.5l-2 2a3.2 3.2 0 004.5 4.5l2-2", "M15.5 12.5l2-2A3.2 3.2 0 0013 6l-2 2"],
  tokens: ["M11.5 12.5l8-8", "M16.5 7.5l2.5 2.5", "M14 10l2 2", { c: [8, 16, 4] }],
  audit: ["M12 7.5V12l3 2", { c: [12, 12, 8.5] }],
  settings: ["M4 6h9", "M17 6h3", "M4 12h3", "M11 12h9", "M4 18h11", "M19 18h1", { c: [15, 6, 2] }, { c: [9, 12, 2] }, { c: [17, 18, 2] }],
  docs: ["M5 4.5A1.5 1.5 0 016.5 3H19v15H6.5A1.5 1.5 0 005 19.5z", "M5 19.5A1.5 1.5 0 006.5 21H19", "M9 7h6"],
  help: ["M9.5 9.2a2.6 2.6 0 015 .8c0 1.7-2.5 2.1-2.5 3.6", "M12 17.2h.01", { c: [12, 12, 9] }],
  bulb: ["M9 18h6", "M10 21h4", "M12 3a6 6 0 00-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0012 3z"],
  sun: ["M12 2.5v2", "M12 19.5v2", "M4.6 4.6l1.4 1.4", "M18 18l1.4 1.4", "M2.5 12h2", "M19.5 12h2", "M4.6 19.4L6 18", "M18 6l1.4-1.4", { c: [12, 12, 4] }],
  moon: ["M20 14.5A8.2 8.2 0 119.5 4a6.6 6.6 0 0010.5 10.5z"],
  auto: ["M12 3a9 9 0 000 18z", { c: [12, 12, 9] }],
  plus: ["M12 5v14", "M5 12h14"],
  menu: ["M4 7h16", "M4 12h16", "M4 17h16"],
  logout: ["M15 4h3.5a1.5 1.5 0 011.5 1.5v13a1.5 1.5 0 01-1.5 1.5H15", "M10 8l-4 4 4 4", "M6 12h10"],
  info: ["M12 11v5.5", "M12 7.8h.01", { c: [12, 12, 9] }],
  alert: ["M12 4l9 16H3z", "M12 10v4", "M12 17h.01"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  checkCircle: ["M8 12.5l2.7 2.7L16 9.5", { c: [12, 12, 9] }],
  upload: ["M12 15.5V4", "M7 9l5-5 5 5", "M5 20h14"],
  search: ["M20 20l-4.6-4.6", { c: [11, 11, 6.5] }],
  external: ["M14 4h6v6", "M20 4l-9 9", "M18 14v4.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 014 18.5v-11A1.5 1.5 0 015.5 6H10"],
  phone: ["M8 3h8a1.5 1.5 0 011.5 1.5v15A1.5 1.5 0 0116 21H8a1.5 1.5 0 01-1.5-1.5v-15A1.5 1.5 0 018 3z", "M11 18h2"],
  terminal: ["M4 5h16v14H4z", "M7.5 9.5l3 2.5-3 2.5", "M12.5 15h4"],
  rollout: ["M4 19h16", "M6 15l4-4 3 3 5-6", "M15 8h3v3"],
  pause: ["M9 5v14", "M15 5v14"],
  undo: ["M9 8H4V3", "M4.5 8A8 8 0 1112 20"],
  branch: ["M6 3v12", "M18 9a9 9 0 01-9 9", { c: [6, 18, 2.5] }, { c: [18, 6, 2.5] }],
  pulse: ["M3 12h4l3-7 4 14 3-7h4"],
  package: ["M12 3l8 4.5v9L12 21l-8-4.5v-9z", "M4 7.5l8 4.5 8-4.5", "M12 12v9"],
  key: ["M11.5 12.5l8-8", "M16.5 7.5l2.5 2.5", { c: [8, 16, 4] }],
  chevron: ["M9 6l6 6-6 6"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  arrowRight: ["M5 12h14", "M13 6l6 6-6 6"],
};

/** icon("overview") → <svg class="ico">…</svg> */
export function icon(name, cls = "ico") {
  const el = document.createElementNS(NS, "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("class", cls);
  el.setAttribute("aria-hidden", "true");
  el.setAttribute("focusable", "false");
  for (const d of P[name] || P.info) {
    if (typeof d === "string") {
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", d);
      el.append(p);
    } else {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", d.c[0]);
      c.setAttribute("cy", d.c[1]);
      c.setAttribute("r", d.c[2]);
      el.append(c);
    }
  }
  return el;
}
