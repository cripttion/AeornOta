// Minimal, safe Markdown renderer for the bundled docs.
// Supports headings, lists, tables, code, links, emphasis, plus three docs conveniences that still read fine on GitHub:
//   • OS tabs: consecutive code blocks each preceded by a bold label line (**macOS**, **Windows**) become tabs.
//   • Callouts: a blockquote starting with **Note:**, **Tip:**, **Important:** or **Warning:**.
//   • Flow: a ```flow block "A → B → C" becomes a row of steps.
// Input is escaped first, so docs can't inject HTML.

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/`/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function inline(text, linkFor) {
  const codes = [];
  let s = esc(text).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    const target = linkFor(url.replace(/&amp;/g, "&"));
    if (!target) return label;
    const ext = /^https?:/.test(target);
    return `<a href="${esc(target)}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ""}>${label}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[\s(])_([^_]+)_(?=[\s).,:;!?]|$)/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));
}

const LABEL_RE = /^\*\*([^*]{1,40})\*\*\s*(\([^)]{0,40}\))?:?\s*$/;

function codeHtml(lang, body) {
  return `<div class="code-wrap"><pre><code data-lang="${esc(lang)}">${esc(body)}</code></pre><button type="button" class="btn ghost small copy" data-copy>Copy</button></div>`;
}

function osKey(label) {
  const l = label.toLowerCase();
  if (l.includes("windows") || l.includes("powershell")) return "windows";
  if (l.includes("mac") || l.includes("linux") || l.includes("terminal")) return "mac";
  return l.replace(/[^a-z0-9]+/g, "-");
}

/** Returns an HTML string. linkFor(url) maps a markdown link to an href (or null for plain text). */
export function renderMarkdown(src, linkFor = (u) => u) {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  const isBlockStart = (l) => /^(#{1,4}\s|```|>|\s*([-*]|\d+\.)\s|\|.*\|\s*$|---\s*$)/.test(l);

  /** At line j: a bold label line, optional blank lines, then a fence. Returns {label, sub, lang, body, next} or null. */
  const labelledFence = (j) => {
    const m = LABEL_RE.exec(lines[j] || "");
    if (!m) return null;
    let k = j + 1;
    while (k < lines.length && !lines[k].trim()) k++;
    const f = /^```(\w*)/.exec(lines[k] || "");
    if (!f) return null;
    const buf = [];
    k++;
    while (k < lines.length && !/^```/.test(lines[k])) buf.push(lines[k++]);
    k++;
    return { label: m[1].trim(), sub: (m[2] || "").replace(/[()]/g, "").trim(), lang: f[1], body: buf.join("\n"), next: k };
  };

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    // OS tabs: two or more labelled fences in a row.
    const first = labelledFence(i);
    if (first) {
      const group = [first];
      let j = first.next;
      for (;;) {
        let k = j;
        while (k < lines.length && !lines[k].trim()) k++;
        const nxt = labelledFence(k);
        if (!nxt) break;
        group.push(nxt);
        j = nxt.next;
      }
      if (group.length >= 2) {
        const keys = group.map((g) => osKey(g.label));
        out.push(
          `<div class="os-tabs" data-os-group><div class="os-bar" role="tablist">${group
            .map((g, n) => `<button type="button" role="tab" data-os="${esc(keys[n])}" aria-selected="${n === 0}">${esc(g.label)}${g.sub ? ` <span class="muted">(${esc(g.sub)})</span>` : ""}</button>`)
            .join("")}</div>${group.map((g, n) => `<div class="os-panel" data-os="${esc(keys[n])}"${n ? " hidden" : ""}>${codeHtml(g.lang, g.body)}</div>`).join("")}</div>`,
        );
        i = j;
        continue;
      }
    }

    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      if (fence[1] === "flow") {
        const steps = buf.join(" ").split(/\s*(?:→|->)\s*/).filter(Boolean);
        out.push(`<div class="flow-chips" role="list">${steps.map((s, n) => `${n ? '<span class="arrow" aria-hidden="true">→</span>' : ""}<span class="chip" role="listitem">${inline(s, linkFor)}</span>`).join("")}</div>`);
      } else out.push(codeHtml(fence[1], buf.join("\n")));
      continue;
    }
    const hd = /^(#{1,4})\s+(.*)$/.exec(line);
    if (hd) {
      const level = hd[1].length;
      out.push(`<h${level} id="${slugify(hd[2])}">${inline(hd[2], linkFor)}</h${level}>`);
      i++;
      continue;
    }
    if (/^---\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (/^-+:$/.test(c) ? "num" : ""));
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(splitRow(lines[i++]));
      out.push(
        `<div class="table-wrap"><table><thead><tr>${head.map((c, j) => `<th class="${align[j]}">${inline(c, linkFor)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c, j) => `<td class="${align[j]}">${inline(c, linkFor)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }
    if (/^>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      const text = buf.join(" ");
      const c = /^\*\*(Note|Tip|Important|Warning|Danger):?\*\*:?\s*/i.exec(text);
      if (c) {
        const kind = { note: "note", tip: "hint", important: "warn", warning: "warn", danger: "bad" }[c[1].toLowerCase()];
        out.push(`<div class="callout ${kind}"><strong>${esc(c[1])}:</strong> ${inline(text.slice(c[0].length), linkFor)}</div>`);
      } else out.push(`<blockquote>${inline(text, linkFor)}</blockquote>`);
      continue;
    }
    const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (m && m[1].length < 2) {
          items.push({ text: m[3], sub: [] });
          i++;
        } else if (m && items.length) {
          items[items.length - 1].sub.push(m[3]);
          i++;
        } else if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length) {
          items[items.length - 1].text += " " + lines[i].trim();
          i++;
        } else break;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(
        `<${tag}>${items
          .map((it) => `<li>${inline(it.text, linkFor)}${it.sub.length ? `<ul>${it.sub.map((s) => `<li>${inline(s, linkFor)}</li>`).join("")}</ul>` : ""}</li>`)
          .join("")}</${tag}>`,
      );
      continue;
    }
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i]) && !LABEL_RE.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(" "), linkFor)}</p>`);
  }
  return out.join("\n");
}

/** Plain text of a markdown section, for search. */
export function plainText(md) {
  return md
    .replace(/```[\s\S]*?```/g, (b) => b.replace(/```\w*/g, " "))
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_>#|]/g, " ")
    .replace(/-{3,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
