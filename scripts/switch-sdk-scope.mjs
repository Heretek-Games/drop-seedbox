#!/usr/bin/env node
/* global process, console */

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const LEGACY_SCOPE = "@droposs";
const NEW_SCOPE = "@drop-oss";
const SKIP_DIRS = new Set(["node_modules", ".git", "dist-package", "dist-packages"]);
const LOCKFILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "deno.lock"]);
const TEXT_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml"]);

const configPath = path.resolve(process.cwd(), ".sdk-scope.json");
if (!existsSync(configPath)) {
  console.error("Missing .sdk-scope.json in repo root");
  process.exit(1);
}
const config = JSON.parse(readFileSync(configPath, "utf-8"));
const scope = config.sdk;
if (scope !== NEW_SCOPE && scope !== LEGACY_SCOPE) {
  console.error(`Unknown scope '${scope}'; .sdk-scope.json sdk must be '${NEW_SCOPE}' or '${LEGACY_SCOPE}'`);
  process.exit(1);
}
const sdkVersion = config["sdkVersion"];
const cliVersion = config["cliVersion"];
if (typeof sdkVersion !== "string" || typeof cliVersion !== "string") {
  console.error(".sdk-scope.json must define sdkVersion and cliVersion");
  process.exit(1);
}

const OTHER_SCOPES = scope === NEW_SCOPE ? [LEGACY_SCOPE] : [NEW_SCOPE];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (SKIP_DIRS.has(entry.name)) continue;
    if (statSync(full).isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

function normalizeSpecifiers(text) {
  let out = text;
  for (const other of OTHER_SCOPES) {
    out = out
      .replaceAll(`${other}/plugin-sdk`, `${scope}/plugin-sdk`)
      .replaceAll(`${other}/plugin-cli`, `${scope}/plugin-cli`);
  }
  return out;
}

function rewritePackageJson(file, text) {
  const indent = detectIndent(text);
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    return text;
  }
  for (const sectionName of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const section = pkg[sectionName];
    if (!section) continue;
    const rebuilt = {};
    for (const dep of Object.keys(section)) {
      const kind = parseSdkDep(dep);
      if (!kind) {
        rebuilt[dep] = section[dep];
        continue;
      }
      const target = `${scope}/${kind}`;
      rebuilt[target] = kind === "plugin-sdk" ? sdkVersion : cliVersion;
    }
    pkg[sectionName] = rebuilt;
  }
  return JSON.stringify(pkg, null, indent) + (text.endsWith("\n") ? "\n" : "");
}

function parseSdkDep(dep) {
  for (const scopeName of [LEGACY_SCOPE, NEW_SCOPE, "@drop"]) {
    if (dep === `${scopeName}/plugin-sdk`) return "plugin-sdk";
    if (dep === `${scopeName}/plugin-cli`) return "plugin-cli";
  }
  return null;
}

function detectIndent(text) {
  const match = text.match(/\n([ \t]+)"/);
  return match ? match[1] : "\t";
}

const edited = [];

const files = walk(process.cwd());
for (const file of files) {
  if (LOCKFILES.has(path.basename(file))) continue;
  if (!TEXT_EXT.has(path.extname(file))) continue;
  const before = readFileSync(file, "utf-8");
  let after = normalizeSpecifiers(before);
  if (path.basename(file) === "package.json") {
    after = rewritePackageJson(file, after);
  }
  if (after !== before) {
    writeFileSync(file, after);
    edited.push(path.relative(process.cwd(), file));
  }
}

console.log(`Scope set to '${scope}' (sdk ${sdkVersion}, cli ${cliVersion})`);
if (edited.length) {
  for (const f of edited) console.log(`  rewrote ${f}`);
} else {
  console.log("  no specifier changes needed");
}

const installDir = process.cwd();

if (existsSync(path.join(installDir, "package-lock.json"))) {
  try {
    execSync("npm install --no-audit --no-fund", { cwd: installDir, stdio: "inherit" });
  } catch {
    execSync("npm install --no-audit --no-fund --legacy-peer-deps", { cwd: installDir, stdio: "inherit" });
  }
} else if (existsSync(path.join(installDir, "pnpm-lock.yaml"))) {
  execSync("pnpm install", { cwd: installDir, stdio: "inherit" });
} else {
  console.warn("no lockfile found; skipping dependency install");
}
