/**
 * Minimal Structured Field Values (RFC 8941) helpers for the dictionaries expo-updates uses
 * (`expo-signature`, `expo-expect-signature`, `expo-manifest-filters`, `Expo-Extra-Params`).
 * Only string, token, integer and boolean item values are supported, which is all the protocol needs.
 */

export type SfvValue = string | number | boolean;

export function serializeDictionary(dict: Record<string, SfvValue>): string {
  return Object.entries(dict)
    .map(([k, v]) => {
      if (v === true) return k;
      if (v === false) return `${k}=?0`;
      if (typeof v === "number") return `${k}=${Math.trunc(v)}`;
      return `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    })
    .join(", ");
}

export function parseDictionary(header: string | null | undefined): Record<string, SfvValue> {
  const out: Record<string, SfvValue> = {};
  if (!header) return out;
  let i = 0;
  const s = header;
  const skipWs = () => {
    while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  };
  while (i < s.length) {
    skipWs();
    const keyStart = i;
    while (i < s.length && /[a-z0-9_*.-]/.test(s[i]!)) i++;
    const key = s.slice(keyStart, i);
    if (!key) break;
    let value: SfvValue = true;
    if (s[i] === "=") {
      i++;
      if (s[i] === '"') {
        i++;
        let str = "";
        while (i < s.length && s[i] !== '"') {
          if (s[i] === "\\" && i + 1 < s.length) i++;
          str += s[i];
          i++;
        }
        i++; // closing quote
        value = str;
      } else if (s[i] === "?") {
        value = s[i + 1] === "1";
        i += 2;
      } else {
        const start = i;
        while (i < s.length && s[i] !== "," && s[i] !== ";") i++;
        const raw = s.slice(start, i).trim();
        value = /^-?\d+$/.test(raw) ? Number(raw) : raw;
      }
    }
    // ignore parameters
    while (i < s.length && s[i] !== ",") i++;
    out[key] = value;
    i++; // comma
  }
  return out;
}
