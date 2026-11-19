import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * Two problems React Native projects pick up when Expo modules are added to them (install-expo-modules),
 * which break OTA updates or native release builds. `aeron expo init` lists and fixes them,
 * `aeron doctor` reports them.
 */
export type RnFix = {
  id: "expo-cli-path" | "expo-import";
  /** Path relative to the project. */
  file: string;
  /** broken = fails today; fragile = works today, breaks after a future npm install. */
  status: "broken" | "fragile";
  /** What is wrong, for doctor. */
  problem: string;
  /** What `init --write` changes, for the step list. */
  change: string;
  apply(): void;
};

// ------------------------------------------------------------------ native build scripts → @expo/cli

/** The plain form install-expo-modules writes: `require.resolve('@expo/cli')`. */
const PLAIN_CLI_RESOLVE = /require\.resolve\((['"])@expo\/cli\1\)/g;

/** Where the native builds look up the Expo CLI, and the folder each lookup runs from. */
function cliLookups(project: string): Array<{ file: string; from: string; platform: "android" | "ios" }> {
  const out: Array<{ file: string; from: string; platform: "android" | "ios" }> = [];
  if (existsSync(join(project, "android", "app", "build.gradle"))) out.push({ file: "android/app/build.gradle", from: "android", platform: "android" });
  const ios = join(project, "ios");
  if (existsSync(ios)) {
    for (const d of readdirSync(ios)) {
      if (d.endsWith(".xcodeproj") && existsSync(join(ios, d, "project.pbxproj"))) out.push({ file: `ios/${d}/project.pbxproj`, from: "ios", platform: "ios" });
    }
  }
  return out;
}

/** Files (relative) whose Expo CLI lookup is already the robust form. For doctor's ✓ line. */
export function robustCliLookups(project: string): string[] {
  return cliLookups(project)
    .filter(({ file }) => {
      const src = readFileSync(join(project, file), "utf8");
      return src.includes("@expo/cli") && !new RegExp(PLAIN_CLI_RESOLVE.source).test(src);
    })
    .map((l) => l.file);
}

function expoCliPathFixes(project: string): RnFix[] {
  const fixes: RnFix[] = [];
  for (const { file, from, platform } of cliLookups(project)) {
    const path = join(project, file);
    const src = readFileSync(path, "utf8");
    if (!new RegExp(PLAIN_CLI_RESOLVE.source).test(src)) continue;
    // The build runs `node --print "require.resolve('@expo/cli')"` from android/ or ios/. Resolve it the same way.
    let resolves = true;
    try {
      createRequire(join(project, from, "noop.js")).resolve("@expo/cli");
    } catch {
      resolves = false;
    }
    const symptom =
      platform === "android"
        ? 'Android release builds fail with "createBundleReleaseJsAndAssets uses this output of task … without declaring a dependency"'
        : 'iOS release builds fail in the "Bundle React Native code and images" step';
    fixes.push({
      id: "expo-cli-path",
      file,
      status: resolves ? "fragile" : "broken",
      problem: resolves
        ? `${file}: the Expo CLI lookup uses require.resolve('@expo/cli'), which breaks if npm nests @expo/cli under expo/node_modules`
        : `${file}: the Expo CLI lookup can't find @expo/cli (npm nested it under expo/node_modules). ${symptom}`,
      change: `${resolves ? "harden" : "fix"} ${file}: find @expo/cli through expo/package.json${resolves ? " (the plain path breaks when npm nests it)" : ` (${platform === "android" ? "Android" : "iOS"} release builds fail without this)`}`,
      apply() {
        const next = src.replace(PLAIN_CLI_RESOLVE, (_m, q: string) => `require.resolve(${q}@expo/cli${q}, { paths: [require.resolve(${q}expo/package.json${q})] })`);
        writeFileSync(path, next);
      },
    });
  }
  return fixes;
}

// ------------------------------------------------------------------ app entry → import 'expo'

/** Any of these in the entry file loads Expo's runtime (which registers expo-asset's resolver for update assets). */
const LOADS_EXPO = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*)['"](?:expo|expo-router\/entry|expo\/AppEntry(?:\.js)?)['"]/;
/** package.json "main" values that are Expo's own entry points. */
const EXPO_MAIN = /^(?:\.\/)?(?:node_modules\/)?(?:expo-router\/entry|expo\/AppEntry)(?:\.js)?$/;
const ENTRY_EXTS = ["", ".js", ".ts", ".tsx", ".jsx"];

/** The app's JS entry file relative to the project, or null when it's Expo's own entry (nothing to check). */
export function appEntryFile(project: string): string | null {
  let main: string | undefined;
  try {
    main = (JSON.parse(readFileSync(join(project, "package.json"), "utf8")) as { main?: string }).main;
  } catch {
    /* no package.json → no entry */
  }
  if (main) {
    if (EXPO_MAIN.test(main)) return null;
    for (const ext of ENTRY_EXTS) {
      const rel = main.replace(/^\.\//, "") + ext;
      if (existsSync(join(project, rel)) && !rel.endsWith("/")) return rel;
    }
  }
  for (const f of ["index.js", "index.ts", "index.tsx", "index.jsx"]) if (existsSync(join(project, f))) return f;
  return null;
}

function expoImportFix(project: string): RnFix | null {
  const file = appEntryFile(project);
  if (!file) return null;
  const path = join(project, file);
  const src = readFileSync(path, "utf8");
  if (LOADS_EXPO.test(src)) return null;
  const esm = /^\s*import\b/m.test(src) || !/\brequire\s*\(/.test(src);
  const line = esm ? "import 'expo'; // lets images and fonts in OTA updates load (added by aeron expo init)" : "require('expo'); // lets images and fonts in OTA updates load (added by aeron expo init)";
  return {
    id: "expo-import",
    file,
    status: "broken",
    problem: `${file} doesn't load Expo (no import 'expo'), so images and fonts in OTA updates won't load; only the code changes`,
    change: `add ${esm ? "import 'expo';" : "require('expo');"} at the top of ${file} (without it, images and fonts in OTA updates don't load)`,
    apply() {
      // Insert before the first import/require so it runs first; otherwise at the very top.
      const m = /^[ \t]*(?:import\b|(?:const|let|var)\s+[\w{}\s,]+=\s*require\s*\(|require\s*\()/m.exec(src);
      const at = m ? m.index : 0;
      writeFileSync(path, src.slice(0, at) + line + "\n" + src.slice(at));
    },
  };
}

/** Problems in a React Native project that already has Expo modules (managed or bare). */
export function rnProjectFixes(project: string): RnFix[] {
  const entry = expoImportFix(project);
  return [...expoCliPathFixes(project), ...(entry ? [entry] : [])];
}
