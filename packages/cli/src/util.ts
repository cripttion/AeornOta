import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export class CliError extends Error {}

export interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

/** Tiny argv parser: positionals, --flag value, --flag=value, --bool. */
export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          out.flags[a.slice(2)] = next;
          i++;
        } else {
          out.flags[a.slice(2)] = true;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

export function flag(args: Args, name: string, fallback?: string): string | undefined {
  const v = args.flags[name];
  if (v === undefined || v === true) return fallback;
  return String(v);
}

export function requireFlag(args: Args, name: string, hint = ""): string {
  const v = flag(args, name);
  if (!v) throw new CliError(`Missing --${name}${hint ? ` (${hint})` : ""}`);
  return v;
}

export function bool(args: Args, name: string): boolean {
  const v = args.flags[name];
  return v === true || v === "true" || v === "1";
}

export function sha256Hex(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function sha256B64Url(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("base64url");
}

export function md5Hex(buf: Buffer | string): string {
  return createHash("md5").update(buf).digest("hex");
}

export async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new CliError(`Cannot read ${path}`);
  }
}

export const isWindows = process.platform === "win32";

/** Quote an argument for cmd.exe when we must go through a shell on Windows (npx, shorebird.bat). */
function winQuote(a: string): string {
  return /[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

/** Run a command and capture stdout. Inherits stderr so the user sees build progress. */
export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; quiet?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    // On Windows, npx/npm/shorebird are .cmd/.bat shims that need a shell.
    const child = isWindows
      ? spawn([cmd, ...args].map(winQuote).join(" "), { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", opts.quiet ? "pipe" : "inherit"], shell: true })
      : spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", opts.quiet ? "pipe" : "inherit"] });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new CliError(`${cmd} ${args.join(" ")} exited with ${code}${err ? `\n${err.slice(-2000)}` : ""}`));
    });
  });
}

/** Run a command with the terminal attached (for long builds like `shorebird release`). Resolves with the exit code. */
export function runInteractive(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = isWindows
      ? spawn([cmd, ...args].map(winQuote).join(" "), { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: "inherit", shell: true })
      : spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

export const ok = (msg: string) => log(`  ✓ ${msg}`);
export const bad = (msg: string) => log(`  ✗ ${msg}`);
export const warn = (msg: string) => log(`  ! ${msg}`);

export function log(msg = "") {
  process.stdout.write(msg + "\n");
}

export function table(rows: Array<Record<string, unknown>>) {
  if (!rows.length) {
    log("(none)");
    return;
  }
  const cols = Object.keys(rows[0]!);
  const widths = cols.map((c) => Math.min(48, Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length))));
  const fmt = (vals: string[]) => vals.map((v, i) => v.slice(0, widths[i]).padEnd(widths[i]!)).join("  ");
  log(fmt(cols));
  log(fmt(widths.map((w) => "-".repeat(w))));
  for (const r of rows) log(fmt(cols.map((c) => String(r[c] ?? ""))));
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  json: "application/json",
  lottie: "application/zip",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  html: "text/html",
  txt: "text/plain",
  pdf: "application/pdf",
  db: "application/octet-stream",
};

export function mimeFor(ext: string): string {
  return MIME[ext.toLowerCase().replace(/^\./, "")] ?? "application/octet-stream";
}
