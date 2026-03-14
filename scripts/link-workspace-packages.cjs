#!/usr/bin/env node

const { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, symlinkSync, unlinkSync } = require("fs");
const { join, resolve } = require("path");

const root = resolve(__dirname, "..");
const packagesDir = join(root, "packages");
const scopeDir = join(root, "node_modules", "@gsd");

function readWorkspacePackages() {
  if (!existsSync(packagesDir)) return [];

  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name))
    .map((dir) => {
      const packageJsonPath = join(dir, "package.json");
      if (!existsSync(packageJsonPath)) return null;
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
        if (typeof pkg.name !== "string" || !pkg.name.startsWith("@gsd/")) {
          return null;
        }
        return { dir, name: pkg.name.slice("@gsd/".length) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function ensureLinked(target, source) {
  if (existsSync(target)) {
    try {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) {
        const linked = readlinkSync(target);
        const resolved = resolve(scopeDir, linked);
        if (resolved === source || linked === source) {
          return false;
        }
        unlinkSync(target);
      } else {
        return false;
      }
    } catch {
      return false;
    }
  }

  try {
    symlinkSync(source, target, "junction");
    return true;
  } catch {
    return false;
  }
}

const workspacePackages = readWorkspacePackages();
if (workspacePackages.length === 0) {
  process.exit(0);
}

mkdirSync(scopeDir, { recursive: true });

let linkedCount = 0;
for (const workspacePackage of workspacePackages) {
  const target = join(scopeDir, workspacePackage.name);
  if (ensureLinked(target, workspacePackage.dir)) {
    linkedCount += 1;
  }
}

if (linkedCount > 0) {
  process.stderr.write(`  Linked ${linkedCount} workspace package${linkedCount === 1 ? "" : "s"}\n`);
}
