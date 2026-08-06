#!/usr/bin/env node
/**
 * Brand-identity guard.
 *
 * OpenOutposts is a fork of Open-Inspect and syncs from it continuously, so
 * upstream code carrying the old name keeps arriving. Anything that names a
 * resource in the operator's infrastructure, an artifact in a git repository,
 * or a string shown to a user must say OpenOutposts.
 *
 * This is a BASELINE check, not a blanket ban. `baseline.txt` records the
 * occurrences that are deliberately allowed today — sample repository fixtures
 * in tests, the MIT copyright, the upstream URL, prose describing the fork's
 * origin, and the OpenComputer runtime paths that are contracts with a
 * prebuilt image. Any occurrence NOT in the baseline fails the build.
 *
 * The internal npm package scope (`@open-inspect/*`) is ignored outright
 * rather than baselined. It is unpublished, names nothing an operator or a
 * user can see, and is allowed in every file, so recording it per-file only
 * meant that adding an ordinary import of `@open-inspect/shared` broke the
 * build. That churn is what the scope rename will retire; until then the
 * guard has no reason to look at it.
 *
 *   node scripts/check-brand-identity.mjs           # verify
 *   node scripts/check-brand-identity.mjs --update  # re-record the baseline
 *
 * When a sync introduces a genuine new occurrence, rename it. Only re-record
 * the baseline when the new occurrence is legitimately allowed, and say why in
 * the commit message.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts", "brand-identity-baseline.txt");

/** Case-insensitive forms of the inherited name. */
const PATTERN = /open[-_ ]?inspect/gi;

/** Paths whose contents are prose about the fork's origin, or legally fixed. */
const EXEMPT_PATHS = [
  /^LICENSE$/,
  /^\.github\/workflows\/sync-upstream\.yml$/,
  /^scripts\/check-brand-identity\.mjs$/,
  /^scripts\/brand-identity-baseline\.txt$/,
  /^docs\//,
  /\.md$/,
];

/**
 * True when this occurrence is the internal npm package scope — the match sits
 * between an `@` and the `/` that starts the package name, as in an import of
 * `@open-inspect/shared` or a doc comment naming it.
 *
 * Deliberately narrow: `@open-inspect-bot`, the GitHub App handle, has the `@`
 * but no `/`, so it stays a baselined occurrence like every other identity the
 * guard watches.
 */
function isInternalPackageScope(line, index, length) {
  return line[index - 1] === "@" && line[index + length] === "/";
}

/** Binary and vendored paths that are never scanned. */
const SKIP_PATHS = [
  /^package-lock\.json$/,
  /\/dist\//,
  /node_modules\//,
  /\.(png|jpg|ico|woff2?)$/,
];

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

/**
 * One entry per occurrence, as `path\tmatched-text`. Line numbers are
 * deliberately excluded so unrelated edits above an allowed occurrence do not
 * churn the baseline.
 */
function collect() {
  const found = new Map();
  for (const path of trackedFiles()) {
    if (SKIP_PATHS.some((r) => r.test(path))) continue;
    if (EXEMPT_PATHS.some((r) => r.test(path))) continue;

    let text;
    try {
      text = readFileSync(join(REPO_ROOT, path), "utf8");
    } catch {
      continue; // unreadable or binary
    }
    if (!text.includes("\0")) {
      for (const line of text.split("\n")) {
        for (const match of line.matchAll(PATTERN)) {
          if (isInternalPackageScope(line, match.index, match[0].length)) continue;
          // Keep a little context so a prefixed occurrence is distinguishable
          // from a bare `open-inspect` resource name.
          const start = Math.max(0, match.index - 1);
          const key = `${path}\t${line.slice(start, match.index + match[0].length + 24).trim()}`;
          found.set(key, (found.get(key) ?? 0) + 1);
        }
      }
    }
  }
  return found;
}

const found = collect();
const serialized = [...found.keys()].sort().join("\n");

if (process.argv.includes("--update")) {
  writeFileSync(BASELINE_PATH, serialized + "\n");
  console.log(`Recorded ${found.size} allowed occurrences to ${BASELINE_PATH}`);
  process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
  console.error(`Missing baseline. Run: node scripts/check-brand-identity.mjs --update`);
  process.exit(1);
}

const baseline = new Set(
  readFileSync(BASELINE_PATH, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
);

const added = [...found.keys()].filter((k) => !baseline.has(k)).sort();

if (added.length === 0) {
  console.log(`Brand identity OK (${found.size} baselined occurrences).`);
  process.exit(0);
}

console.error(
  `\nNew Open-Inspect references (${added.length}). Rename them to OpenOutposts, or\n` +
    `re-record the baseline if they are legitimately allowed:\n`
);
for (const entry of added) {
  const [path, text] = entry.split("\t");
  console.error(`  ${path}\n      ${text}`);
}
console.error(
  `\nIf allowed, run: node scripts/check-brand-identity.mjs --update\n` +
    `and explain why in the commit message.\n`
);
process.exit(1);
