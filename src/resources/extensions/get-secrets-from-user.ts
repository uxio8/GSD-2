/**
 * get-secrets-from-user — paged secure env var collection + apply
 *
 * Collects secrets one-per-page via masked TUI input, then writes them
 * to .env (local), Vercel, or Convex. No ctx.callTool, no external deps.
 * Uses Node fs/promises for file I/O and pi.exec() for CLI sinks.
 */

import { existsSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { CURSOR_MARKER, Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { makeUI, type ProgressStatus } from "./shared/ui.js";
import { formatSecretsManifest, parseSecretsManifest } from "./gsd/files.js";
import { resolveMilestoneFile } from "./gsd/paths.js";
import type { SecretsManifestEntry } from "./gsd/types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CollectedSecret {
	key: string;
	value: string | null; // null = skipped
}

interface ToolResultDetails {
	destination: string;
	environment?: string;
	applied: string[];
	skipped: string[];
	existingSkipped?: string[];
	detectedDestination?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function maskPreview(value: string): string {
	if (!value) return "";
	if (value.length <= 8) return "*".repeat(value.length);
	return `${value.slice(0, 4)}${"*".repeat(Math.max(4, value.length - 8))}${value.slice(-4)}`;
}

/**
 * Replace editor visible text with masked characters while preserving ANSI cursor/sequencer codes.
 */
function maskEditorLine(line: string): string {
	// Keep border / metadata lines readable.
	if (line.startsWith("─")) {
		return line;
	}

	let output = "";
	let i = 0;
	while (i < line.length) {
		if (line.startsWith(CURSOR_MARKER, i)) {
			output += CURSOR_MARKER;
			i += CURSOR_MARKER.length;
			continue;
		}

		const ansiMatch = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
		if (ansiMatch) {
			output += ansiMatch[0];
			i += ansiMatch[0].length;
			continue;
		}

		const ch = line[i] as string;
		output += ch === " " ? " " : "*";
		i += 1;
	}

	return output;
}

function shellEscapeSingle(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function writeEnvKey(filePath: string, key: string, value: string): Promise<void> {
	let content = "";
	try {
		content = await readFile(filePath, "utf8");
	} catch {
		content = "";
	}
	const escaped = value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "");
	const line = `${key}=${escaped}`;
	const regex = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=.*$`, "m");
	if (regex.test(content)) {
		content = content.replace(regex, line);
	} else {
		if (content.length > 0 && !content.endsWith("\n")) content += "\n";
		content += `${line}\n`;
	}
	await writeFile(filePath, content, "utf8");
}

export async function checkExistingEnvKeys(keys: string[], envFilePath: string): Promise<string[]> {
	let fileContent = "";
	try {
		fileContent = await readFile(envFilePath, "utf8");
	} catch {
		// ENOENT or unreadable .env file — still check process.env.
	}

	const existing: string[] = [];
	for (const key of keys) {
		const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(`^${escaped}\\s*=`, "m");
		if (regex.test(fileContent) || key in process.env) {
			existing.push(key);
		}
	}
	return existing;
}

export function detectDestination(basePath: string): "dotenv" | "vercel" | "convex" {
	if (existsSync(resolve(basePath, "vercel.json"))) {
		return "vercel";
	}

	const convexPath = resolve(basePath, "convex");
	try {
		if (existsSync(convexPath) && statSync(convexPath).isDirectory()) {
			return "convex";
		}
	} catch {
		// Ignore stat errors and fall back to dotenv.
	}

	return "dotenv";
}

// ─── Paged secure input UI ────────────────────────────────────────────────────

/**
 * Show a single-key masked input page via ctx.ui.custom().
 * Returns the entered value, or null if skipped/cancelled.
 */
async function collectOneSecret(
	ctx: { ui: any; hasUI: boolean },
	pageIndex: number,
	totalPages: number,
	keyName: string,
	hint: string | undefined,
	guidance: string[] | undefined,
): Promise<string | null> {
	if (!ctx.hasUI) return null;

	return ctx.ui.custom<string | null>((tui: any, theme: any, _kb: any, done: (r: string | null) => void) => {
		let value = "";
		let cachedLines: string[] | undefined;

		const editorTheme: EditorTheme = {
			borderColor: (s: string) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t: string) => theme.fg("accent", t),
				selectedText: (t: string) => theme.fg("accent", t),
				description: (t: string) => theme.fg("muted", t),
				scrollInfo: (t: string) => theme.fg("dim", t),
				noMatch: (t: string) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme, { paddingX: 1 });

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function handleInput(data: string) {
			if (matchesKey(data, Key.enter)) {
				value = editor.getText().trim();
				done(value.length > 0 ? value : null);
				return;
			}
			if (matchesKey(data, Key.escape)) {
				done(null);
				return;
			}
			// ctrl+s = skip this key
			if (data === "\x13") {
				done(null);
				return;
			}
			editor.handleInput(data);
			refresh();
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;
			const lines: string[] = [];
			const add = (s: string) => lines.push(truncateToWidth(s, width));

			add(theme.fg("accent", "─".repeat(width)));
			add(theme.fg("dim", ` Page ${pageIndex + 1}/${totalPages} · Secure Env Setup`));
			lines.push("");

			// Key name as big header
			add(theme.fg("accent", theme.bold(` ${keyName}`)));
			if (hint) {
				add(theme.fg("muted", `  ${hint}`));
			}
			if (guidance && guidance.length > 0) {
				lines.push("");
				add(theme.fg("muted", "  Where to find it:"));
				for (const step of guidance) {
					add(theme.fg("muted", `   - ${step}`));
				}
			}
			lines.push("");

			// Masked preview
			const raw = editor.getText();
			const preview = raw.length > 0 ? maskPreview(raw) : theme.fg("dim", "(empty — press enter to skip)");
			add(theme.fg("text", `  Preview: ${preview}`));
			lines.push("");

			// Editor
			add(theme.fg("muted", " Enter value:"));
			for (const line of editor.render(width - 2)) {
				add(theme.fg("text", maskEditorLine(line)));
			}

			lines.push("");
			add(theme.fg("dim", ` enter to confirm  |  ctrl+s or esc to skip  |  esc cancels`));
			add(theme.fg("accent", "─".repeat(width)));

			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => { cachedLines = undefined; },
			handleInput,
		};
	});
}

export const collectOneSecretWithGuidance = collectOneSecret;

export async function showSecretsSummary(
	ctx: { ui: any; hasUI: boolean },
	entries: SecretsManifestEntry[],
	existingKeys: string[],
): Promise<void> {
	if (!ctx.hasUI) return;

	const existingSet = new Set(existingKeys);

	await ctx.ui.custom<void>((tui: any, theme: Theme, _kb: any, done: () => void) => {
		let cachedLines: string[] | undefined;

		function handleInput(_data: string) {
			done();
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;

			const ui = makeUI(theme, width);
			const lines: string[] = [];
			const push = (...rows: string[][]) => { for (const row of rows) lines.push(...row); };

			push(ui.bar());
			push(ui.blank());
			push(ui.header("  Secrets Summary"));
			push(ui.blank());

			for (const entry of entries) {
				let status: ProgressStatus = "pending";
				let detail: string | undefined;

				if (existingSet.has(entry.key)) {
					status = "done";
					detail = "already set";
				} else if (entry.status === "collected") {
					status = "done";
				} else if (entry.status === "skipped") {
					status = "skipped";
				}

				push(ui.progressItem(entry.key, status, { detail }));
			}

			push(ui.blank());
			push(ui.hints(["any key to continue"]));
			push(ui.bar());

			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => { cachedLines = undefined; },
			handleInput,
		};
	});
}

async function applySecrets(
	provided: Array<{ key: string; value: string }>,
	destination: "dotenv" | "vercel" | "convex",
	options: {
		envFilePath: string;
		environment?: string;
		exec?: (cmd: string, args: string[]) => Promise<{ code: number; stderr: string }>;
	},
): Promise<{ applied: string[]; errors: string[] }> {
	const applied: string[] = [];
	const errors: string[] = [];

	if (destination === "dotenv") {
		for (const { key, value } of provided) {
			try {
				await writeEnvKey(options.envFilePath, key, value);
				applied.push(key);
			} catch (err: any) {
				errors.push(`${key}: ${err.message}`);
			}
		}
	}

	if (destination === "vercel") {
		if (!options.exec) {
			errors.push("vercel: command execution unavailable");
		} else {
			const env = options.environment ?? "development";
			for (const { key, value } of provided) {
				try {
					const result = await options.exec("sh", [
						"-c",
						`printf %s ${shellEscapeSingle(value)} | vercel env add ${key} ${env}`,
					]);
					if (result.code !== 0) {
						errors.push(`${key}: ${result.stderr.slice(0, 200)}`);
					} else {
						applied.push(key);
					}
				} catch (err: any) {
					errors.push(`${key}: ${err.message}`);
				}
			}
		}
	}

	if (destination === "convex") {
		if (!options.exec) {
			errors.push("convex: command execution unavailable");
		} else {
			for (const { key, value } of provided) {
				try {
					const result = await options.exec("sh", [
						"-c",
						`npx convex env set ${key} ${shellEscapeSingle(value)}`,
					]);
					if (result.code !== 0) {
						errors.push(`${key}: ${result.stderr.slice(0, 200)}`);
					} else {
						applied.push(key);
					}
				} catch (err: any) {
					errors.push(`${key}: ${err.message}`);
				}
			}
		}
	}

	return { applied, errors };
}

export async function collectSecretsFromManifest(
	base: string,
	milestoneId: string,
	ctx: { ui: any; hasUI: boolean },
	options?: {
		cwd?: string;
		environment?: string;
		exec?: (cmd: string, args: string[]) => Promise<{ code: number; stderr: string }>;
	},
): Promise<{ applied: string[]; skipped: string[]; existingSkipped: string[]; errors: string[] }> {
	const manifestPath = resolveMilestoneFile(base, milestoneId, "SECRETS");
	if (!manifestPath) {
		throw new Error(`Secrets manifest not found for milestone ${milestoneId}`);
	}

	const content = await readFile(manifestPath, "utf8");
	const manifest = parseSecretsManifest(content);
	const cwd = options?.cwd ?? base;
	const envPath = resolve(cwd, ".env");
	const existingKeys = await checkExistingEnvKeys(
		manifest.entries.map((entry) => entry.key),
		envPath,
	);
	const existingSet = new Set(existingKeys);
	const existingSkipped: string[] = [];
	const alreadySkipped: string[] = [];
	const pendingEntries: SecretsManifestEntry[] = [];

	for (const entry of manifest.entries) {
		if (existingSet.has(entry.key)) {
			existingSkipped.push(entry.key);
		} else if (entry.status === "skipped") {
			alreadySkipped.push(entry.key);
		} else if (entry.status === "pending") {
			pendingEntries.push(entry);
		}
	}

	await showSecretsSummary(ctx, manifest.entries, existingKeys);

	const collected: CollectedSecret[] = [];
	for (let i = 0; i < pendingEntries.length; i++) {
		const entry = pendingEntries[i];
		const value = await collectOneSecret(
			ctx,
			i,
			pendingEntries.length,
			entry.key,
			entry.formatHint || undefined,
			entry.guidance.length > 0 ? entry.guidance : undefined,
		);
		collected.push({ key: entry.key, value });
	}

	for (const { key, value } of collected) {
		const entry = manifest.entries.find((candidate) => candidate.key === key);
		if (entry) {
			entry.status = value !== null ? "collected" : "skipped";
		}
	}

	await writeFile(manifestPath, formatSecretsManifest(manifest), "utf8");

	const defaultDestination = detectDestination(cwd);
	const providedByDestination = new Map<"dotenv" | "vercel" | "convex", Array<{ key: string; value: string }>>();
	for (const collectedSecret of collected) {
		if (collectedSecret.value === null) continue;
		const entry = manifest.entries.find((candidate) => candidate.key === collectedSecret.key);
		const destination = entry?.destination === "vercel" || entry?.destination === "convex" || entry?.destination === "dotenv"
			? entry.destination
			: defaultDestination;
		const existing = providedByDestination.get(destination) ?? [];
		existing.push({ key: collectedSecret.key, value: collectedSecret.value });
		providedByDestination.set(destination, existing);
	}

	const applied: string[] = [];
	const errors: string[] = [];
	for (const [destination, provided] of providedByDestination.entries()) {
		const result = await applySecrets(provided, destination, {
			envFilePath: envPath,
			environment: options?.environment,
			exec: options?.exec,
		});
		applied.push(...result.applied);
		errors.push(...result.errors);
	}

	const skipped = [
		...alreadySkipped,
		...collected.filter((entry) => entry.value === null).map((entry) => entry.key),
	];

	return { applied, skipped, existingSkipped, errors };
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function secureEnv(pi: ExtensionAPI) {
	pi.registerTool({
		name: "secure_env_collect",
		label: "Secure Env Collect",
		description:
			"Collect one or more env vars through a paged masked-input UI, then write them to .env, Vercel, or Convex. " +
			"Values are shown masked to the user (e.g. sk-ir***dgdh) and never echoed in tool output.",
		promptSnippet: "Collect and apply env vars securely without asking user to edit files manually.",
		promptGuidelines: [
			"NEVER ask the user to manually edit .env files, copy-paste into a terminal, or open a dashboard to set env vars. Always use secure_env_collect instead.",
			"When a command fails due to a missing env var (e.g. 'OPENAI_API_KEY is not set', 'Missing required environment variable', 'Invalid API key', 'authentication required'), immediately call secure_env_collect with the missing keys before retrying.",
			"When starting a new project or running setup steps that require secrets (API keys, tokens, database URLs), proactively call secure_env_collect before the first command that needs them.",
			"Detect the right destination: use 'dotenv' for local dev, 'vercel' when deploying to Vercel, 'convex' when using Convex backend.",
			"After secure_env_collect completes, re-run the originally blocked command to verify the fix worked.",
			"Never echo, log, or repeat secret values in your responses. Only report key names and applied/skipped status.",
		],
		parameters: Type.Object({
			destination: Type.Optional(Type.Union([
				Type.Literal("dotenv"),
				Type.Literal("vercel"),
				Type.Literal("convex"),
			], { description: "Where to write the collected secrets" })),
			keys: Type.Array(
				Type.Object({
					key: Type.String({ description: "Env var name, e.g. OPENAI_API_KEY" }),
					hint: Type.Optional(Type.String({ description: "Format hint shown to user, e.g. 'starts with sk-'" })),
					required: Type.Optional(Type.Boolean()),
					guidance: Type.Optional(Type.Array(Type.String(), { description: "Step-by-step guidance for where to find this key" })),
				}),
				{ minItems: 1 },
			),
			envFilePath: Type.Optional(Type.String({ description: "Path to .env file (dotenv only). Defaults to .env in cwd." })),
			environment: Type.Optional(
				Type.Union([
					Type.Literal("development"),
					Type.Literal("preview"),
					Type.Literal("production"),
				], { description: "Target environment (vercel only)" }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: UI not available (interactive mode required for secure env collection)." }],
					isError: true,
				};
			}

			const destinationAutoDetected = params.destination == null;
			const destination = params.destination ?? detectDestination(ctx.cwd);
			const collected: CollectedSecret[] = [];

			// Collect one key per page
			for (let i = 0; i < params.keys.length; i++) {
				const item = params.keys[i];
				const value = await collectOneSecret(ctx, i, params.keys.length, item.key, item.hint, item.guidance);
				collected.push({ key: item.key, value });
			}

			const provided = collected.filter((c) => c.value !== null) as Array<{ key: string; value: string }>;
			const skipped = collected.filter((c) => c.value === null).map((c) => c.key);
			const { applied, errors } = await applySecrets(provided, destination, {
				envFilePath: resolve(ctx.cwd, params.envFilePath ?? ".env"),
				environment: params.environment,
				exec: (cmd, args) => pi.exec(cmd, args),
			});

			const details: ToolResultDetails = {
				destination,
				environment: params.environment,
				applied,
				skipped,
				...(destinationAutoDetected ? { detectedDestination: destination } : {}),
			};

			const lines = [
				`destination: ${destination}${destinationAutoDetected ? " (auto-detected)" : ""}${params.environment ? ` (${params.environment})` : ""}`,
				...applied.map((k) => `✓ ${k}: applied`),
				...skipped.map((k) => `• ${k}: skipped`),
				...errors.map((e) => `✗ ${e}`),
			];

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details,
				isError: errors.length > 0 && applied.length === 0,
			};
		},

		renderCall(args, theme) {
			const count = Array.isArray(args.keys) ? args.keys.length : 0;
			return new Text(
				theme.fg("toolTitle", theme.bold("secure_env_collect ")) +
				theme.fg("muted", `→ ${args.destination ?? "auto"}`) +
				theme.fg("dim", `  ${count} key${count !== 1 ? "s" : ""}`),
				0, 0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as ToolResultDetails | undefined;
			if (!details) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "", 0, 0);
			}
			const lines = [
				`${theme.fg("success", "✓")} ${details.destination}${details.environment ? ` (${details.environment})` : ""}`,
				...details.applied.map((k) => `  ${theme.fg("success", "✓")} ${k}: applied`),
				...details.skipped.map((k) => `  ${theme.fg("warning", "•")} ${k}: skipped`),
			];
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
