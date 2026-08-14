#!/usr/bin/env node
// Fails when a pnpm-workspace.yaml override pins a package BELOW the version a
// workspace manifest asks for.
//
// Why this exists: a pnpm override is a hard rewrite in both directions, not a
// floor. While `next` sat at "16.2.6" in the overrides block, five merged
// Dependabot PRs raised apps/web/package.json to 16.2.11 and every one of them
// was silently clamped back on install -- the shipped app stayed on 16.2.6 with
// the advisories open for two months, with nothing in CI to say so.
//
// Zero dependencies on purpose: this must be able to run before `pnpm install`,
// since a bad override is exactly what makes an install untrustworthy.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const WORKSPACE_FILE = path.join(ROOT, "pnpm-workspace.yaml");
const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

// ---------------------------------------------------------------- semver bits

const CONCRETE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function parts(version) {
  return version
    .split(/[-+]/)[0]
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
}

// -1 if a < b, 0 if equal, 1 if a > b. Prerelease tags are ignored; this repo
// pins release versions only, and treating 1.0.0-rc as 1.0.0 never turns a real
// clamp into a pass.
function compare(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) {
      return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
    }
  }
  return 0;
}

// ------------------------------------------------------------- yaml (minimal)

// Reads just the top-level `overrides:` block. A full YAML parser would mean a
// dependency, and a dependency would mean running after install.
function readOverrides(text) {
  const lines = text.split(/\r?\n/);
  const found = [];
  let inBlock = false;

  for (const line of lines) {
    if (/^overrides:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) {
      continue;
    }
    // Any non-indented, non-blank line ends the block.
    if (line.trim() !== "" && !/^\s/.test(line)) {
      break;
    }
    if (line.trim() === "" || /^\s*#/.test(line)) {
      continue;
    }

    const match = line.match(/^\s+(.+?):\s*(.+?)\s*(?:#.*)?$/);
    if (!match) {
      continue;
    }
    found.push({
      key: unquote(match[1]),
      value: unquote(match[2]),
    });
  }

  return found;
}

function unquote(raw) {
  const s = raw.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

// ------------------------------------------------------------ override keys

// An override key is either `name` or `name@selector`. The selector limits the
// rule to dependents whose requested version falls inside it, so a scoped key
// like `undici@7` must NOT be compared against a manifest asking for 8.10.0.
function splitKey(key) {
  const at = key.lastIndexOf("@");
  if (at <= 0) {
    return { name: key, selector: null };
  }
  return { name: key.slice(0, at), selector: key.slice(at + 1) };
}

// Returns true if `version` is inside `selector`, false if outside, and null if
// the selector uses syntax this guard does not model (caller skips those).
function selectorMatches(selector, version) {
  const s = selector.trim();

  if (/^\d+$/.test(s)) {
    return parts(version)[0] === Number.parseInt(s, 10);
  }
  if (/^\d+\.\d+$/.test(s)) {
    const [maj, min] = s.split(".").map(Number);
    return parts(version)[0] === maj && parts(version)[1] === min;
  }

  const bounded = s.match(/^(<=|<|>=|>)\s*(\d+\.\d+\.\d+)$/);
  if (bounded) {
    const c = compare(version, bounded[2]);
    if (bounded[1] === "<") return c < 0;
    if (bounded[1] === "<=") return c <= 0;
    if (bounded[1] === ">") return c > 0;
    return c >= 0;
  }

  if (CONCRETE.test(s)) {
    return compare(version, s) === 0;
  }

  return null;
}

// ------------------------------------------------------------------ manifests

function workspaceManifests() {
  const files = [];
  const rootPkg = path.join(ROOT, "package.json");
  if (fs.existsSync(rootPkg)) {
    files.push(rootPkg);
  }

  // Deliberately fixed to apps/* and packages/*. Globbing the tree would sweep
  // in agent worktrees under .claude/ and vendored copies under node_modules,
  // whose stale manifests are not what ships.
  for (const dir of ["apps", "packages"]) {
    const base = path.join(ROOT, dir);
    if (!fs.existsSync(base)) {
      continue;
    }
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const pkg = path.join(base, entry.name, "package.json");
      if (fs.existsSync(pkg)) {
        files.push(pkg);
      }
    }
  }

  return files;
}

// ----------------------------------------------------------------------- main

function main() {
  if (!fs.existsSync(WORKSPACE_FILE)) {
    console.error(`error: ${WORKSPACE_FILE} not found (run from the repo root)`);
    process.exit(2);
  }

  const overrides = readOverrides(fs.readFileSync(WORKSPACE_FILE, "utf8"));
  if (overrides.length === 0) {
    console.error("error: no overrides parsed -- the guard would pass vacuously");
    process.exit(2);
  }

  const violations = [];
  const skipped = [];
  let compared = 0;

  for (const manifestPath of workspaceManifests()) {
    const rel = path.relative(ROOT, manifestPath).replace(/\\/g, "/");
    const pkg = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    for (const field of DEP_FIELDS) {
      for (const [name, spec] of Object.entries(pkg[field] || {})) {
        if (!CONCRETE.test(spec)) {
          continue; // ranges/workspace:/catalog: cannot be clamped deterministically
        }

        for (const { key, value } of overrides) {
          const { name: overrideName, selector } = splitKey(key);
          if (overrideName !== name) {
            continue;
          }

          if (selector !== null) {
            const inScope = selectorMatches(selector, spec);
            if (inScope === false) {
              continue; // correctly scoped away, e.g. undici@7 vs a direct 8.x
            }
            if (inScope === null) {
              skipped.push(`${rel}: ${key} -> selector "${selector}" not modelled`);
              continue;
            }
          }

          if (!CONCRETE.test(value)) {
            skipped.push(`${rel}: ${key} -> override "${value}" is a range`);
            continue;
          }

          compared++;
          if (compare(value, spec) < 0) {
            violations.push({ rel, field, name, spec, key, value });
          }
        }
      }
    }
  }

  for (const note of skipped) {
    console.log(`note: not compared -- ${note}`);
  }

  if (violations.length > 0) {
    console.error(
      `\nFAIL: ${violations.length} override(s) pin below the manifest version.\n`
    );
    for (const v of violations) {
      console.error(`  ${v.name}`);
      console.error(`    ${v.rel} (${v.field}) asks for  ${v.spec}`);
      console.error(`    pnpm-workspace.yaml pins        ${v.value}  (key: ${v.key})`);
      console.error(
        "    -> install silently downgrades to the override; the manifest is a lie.\n"
      );
    }
    console.error(
      "Fix: raise the override to match, or scope it (e.g. `\"pkg@7\": \"7.29.0\"`)\n" +
        "so it only applies to the dependents you mean to move.\n"
    );
    process.exit(1);
  }

  console.log(
    `ok: ${compared} override/manifest pair(s) checked, none pin below the manifest.`
  );
}

main();
