import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { Rule } from "./ttsr-manager.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function parseFrontmatter(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of raw.split("\n")) {
    const trimmed = line.trimEnd();

    if (currentKey && /^\s+-\s+/.test(trimmed)) {
      const value = trimmed.replace(/^\s+-\s+/, "").replace(/^["']|["']$/g, "");
      currentArray!.push(value);
      continue;
    }

    if (currentKey && currentArray) {
      result[currentKey] = currentArray;
      currentKey = null;
      currentArray = null;
    }

    const kvMatch = trimmed.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kvMatch) continue;

    const [, key, value] = kvMatch;
    if (value.length === 0) {
      currentKey = key;
      currentArray = [];
      continue;
    }

    result[key] = value.replace(/^["']|["']$/g, "");
  }

  if (currentKey && currentArray) {
    result[currentKey] = currentArray;
  }

  return result;
}

function parseRuleFile(filePath: string): Rule | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const match = FRONTMATTER_RE.exec(content);
  if (!match) return null;

  const [, frontmatterRaw, body] = match;
  const meta = parseFrontmatter(frontmatterRaw);
  const condition = meta.condition;
  if (!Array.isArray(condition) || condition.length === 0) return null;

  return {
    name: basename(filePath, ".md"),
    path: filePath,
    content: body.trim(),
    condition: condition as string[],
    scope: Array.isArray(meta.scope) ? (meta.scope as string[]) : undefined,
    globs: Array.isArray(meta.globs) ? (meta.globs as string[]) : undefined,
  };
}

function scanDir(dir: string): Rule[] {
  if (!existsSync(dir)) return [];

  const rules: Rule[] = [];
  try {
    const files = readdirSync(dir).filter((file) => file.endsWith(".md"));
    for (const file of files) {
      const rule = parseRuleFile(join(dir, file));
      if (rule) rules.push(rule);
    }
  } catch {
    // Ignore unreadable rules directories.
  }

  return rules;
}

export function loadRules(cwd: string): Rule[] {
  const globalDir = join(homedir(), ".gsd", "agent", "rules");
  const projectDir = join(cwd, ".gsd", "rules");

  const byName = new Map<string, Rule>();
  for (const rule of scanDir(globalDir)) byName.set(rule.name, rule);
  for (const rule of scanDir(projectDir)) byName.set(rule.name, rule);

  return Array.from(byName.values());
}
