export interface Part {
  name: "manifest" | "directive" | "extensions";
  body: string;
  headers?: Record<string, string>;
}

/** Build a multipart/mixed body in the shape expo-updates expects. */
export function multipartMixed(parts: Part[]): { body: string; contentType: string } {
  const boundary = "aeron-" + crypto.randomUUID().replace(/-/g, "");
  let body = "";
  for (const p of parts) {
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="${p.name}"\r\n`;
    body += `Content-Type: application/json; charset=utf-8\r\n`;
    for (const [k, v] of Object.entries(p.headers ?? {})) body += `${k}: ${v}\r\n`;
    body += `\r\n${p.body}\r\n`;
  }
  body += `--${boundary}--\r\n`;
  return { body, contentType: `multipart/mixed; boundary=${boundary}` };
}

/** Parse a multipart/mixed body (used by tests and the CLI's smoke checks). */
export function parseMultipartMixed(body: string, contentType: string): Array<{ headers: Record<string, string>; body: string }> {
  const m = /boundary=([^;]+)/.exec(contentType);
  if (!m) throw new Error("no boundary");
  const boundary = m[1]!.trim();
  const chunks = body.split(`--${boundary}`);
  const parts: Array<{ headers: Record<string, string>; body: string }> = [];
  for (const chunk of chunks) {
    if (!chunk || chunk.startsWith("--")) continue;
    const trimmed = chunk.replace(/^\r\n/, "");
    const sep = trimmed.indexOf("\r\n\r\n");
    if (sep < 0) continue;
    const headers: Record<string, string> = {};
    for (const line of trimmed.slice(0, sep).split("\r\n")) {
      const idx = line.indexOf(":");
      if (idx > 0) headers[line.slice(0, idx).toLowerCase()] = line.slice(idx + 1).trim();
    }
    parts.push({ headers, body: trimmed.slice(sep + 4).replace(/\r\n$/, "") });
  }
  return parts;
}
