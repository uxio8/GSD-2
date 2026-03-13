/**
 * MCPorter Extension — Lazy MCP server integration for pi
 *
 * Provides on-demand access to configured MCP servers without eagerly
 * registering every remote tool into the session.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

interface McpServer {
  name: string;
  status: string;
  transport?: string;
  tools: { name: string; description: string }[];
}

interface McpListResponse {
  mode: string;
  counts: { ok: number; auth: number; offline: number; http: number; error: number };
  servers: McpServer[];
}

interface McpToolSchema {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

interface McpServerDetail {
  name: string;
  status: string;
  tools: McpToolSchema[];
}

let serverListCache: McpServer[] | null = null;
const serverDetailCache = new Map<string, McpServerDetail>();

function escapeShellArg(arg: string): string {
  if (process.platform === "win32") {
    return `"${arg.replace(/"/g, '""')}"`;
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

async function runMcporter(
  args: string[],
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<string> {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync("mcporter", args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      signal,
      env: { ...process.env },
      shell: true,
    });
    return stdout;
  }

  const escaped = args.map((arg) => escapeShellArg(arg)).join(" ");
  const { stdout } = await execAsync(`mcporter ${escaped}`, {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    signal,
    env: { ...process.env },
  });
  return stdout;
}

async function getServerList(signal?: AbortSignal): Promise<McpServer[]> {
  if (serverListCache) return serverListCache;

  const raw = await runMcporter(["list", "--json"], signal, 60_000);
  let data: McpListResponse;
  try {
    data = JSON.parse(raw) as McpListResponse;
  } catch {
    throw new Error(`Failed to parse mcporter output: ${raw.slice(0, 300)}`);
  }

  if (!Array.isArray(data.servers)) {
    throw new Error(`Unexpected mcporter response shape: ${JSON.stringify(Object.keys(data))}`);
  }

  serverListCache = data.servers;
  return serverListCache;
}

async function getServerDetail(serverName: string, signal?: AbortSignal): Promise<McpServerDetail> {
  if (serverDetailCache.has(serverName)) {
    return serverDetailCache.get(serverName)!;
  }

  const raw = await runMcporter(["list", serverName, "--schema", "--json"], signal);
  const data = JSON.parse(raw) as McpServerDetail;
  serverDetailCache.set(serverName, data);
  return data;
}

function formatServerList(servers: McpServer[]): string {
  if (servers.length === 0) return "No MCP servers found.";

  const lines: string[] = [`${servers.length} MCP servers available:\n`];
  for (const server of servers) {
    const tools = server.tools ?? [];
    const status = server.status === "ok" ? "✓" : server.status === "auth" ? "🔑" : "✗";
    lines.push(`${status} ${server.name} — ${tools.length} tools (${server.status})`);
    for (const tool of tools) {
      lines.push(`    ${tool.name}: ${tool.description?.slice(0, 100) ?? ""}`);
    }
  }
  lines.push("\nUse mcp_discover to inspect a server schema.");
  lines.push("Use mcp_call(server, tool, args) to invoke a tool.");
  return lines.join("\n");
}

function formatServerDetail(detail: McpServerDetail): string {
  const lines: string[] = [`${detail.name} — ${detail.tools.length} tools:\n`];
  for (const tool of detail.tools) {
    lines.push(`## ${tool.name}`);
    if (tool.description) lines.push(tool.description);
    if (tool.inputSchema) {
      lines.push("```json");
      lines.push(JSON.stringify(tool.inputSchema, null, 2));
      lines.push("```");
    }
    lines.push("");
  }
  lines.push(`Call with: mcp_call(server="${detail.name}", tool="<tool_name>", args={...})`);
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "mcp_servers",
    label: "MCP Servers",
    description:
      "List available MCP servers discovered from system config (Claude Desktop, Cursor, VS Code, mcporter config).",
    promptSnippet: "List available MCP servers and their tools via mcporter",
    promptGuidelines: [
      "Use mcp_servers first to discover which MCP servers are available.",
      "Then use mcp_discover for schemas and mcp_call to invoke a tool.",
    ],
    parameters: Type.Object({
      refresh: Type.Optional(Type.Boolean({ description: "Force refresh instead of using cache." })),
    }),

    async execute(_id, params, signal) {
      if (params.refresh) serverListCache = null;

      try {
        const servers = await getServerList(signal);
        return {
          content: [{ type: "text", text: formatServerList(servers) }],
          details: {
            serverCount: servers.length,
            cached: !params.refresh && serverListCache !== null,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to list MCP servers. Is mcporter installed? (npm i -g mcporter)\n${message}`);
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("mcp_servers"));
      if (args.refresh) text += theme.fg("warning", " (refresh)");
      return new Text(text, 0, 0);
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Discovering MCP servers..."), 0, 0);
      const details = result.details as { serverCount: number } | undefined;
      return new Text(theme.fg("success", `${details?.serverCount ?? 0} servers found`), 0, 0);
    },
  });

  pi.registerTool({
    name: "mcp_discover",
    label: "MCP Discover",
    description:
      "Inspect tool signatures and JSON schemas for a specific MCP server before invoking its tools.",
    promptSnippet: "Get detailed tool schemas for a specific MCP server",
    promptGuidelines: [
      "Use mcp_discover with a server name from mcp_servers output.",
      "Read the schema before calling mcp_call.",
    ],
    parameters: Type.Object({
      server: Type.String({ description: "Server name from mcp_servers output." }),
    }),

    async execute(_id, params, signal) {
      try {
        const detail = await getServerDetail(params.server, signal);
        const text = formatServerDetail(detail);
        const truncation = truncateHead(text, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        });
        let finalText = truncation.content;
        if (truncation.truncated) {
          finalText += `\n\n[Truncated: ${truncation.outputLines}/${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
        }

        return {
          content: [{ type: "text", text: finalText }],
          details: {
            server: params.server,
            toolCount: detail.tools.length,
            cached: serverDetailCache.has(params.server),
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to discover tools for "${params.server}": ${message}`);
      }
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("mcp_discover")) + theme.fg("dim", ` ${args.server}`),
        0,
        0,
      );
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Loading server schema..."), 0, 0);
      const details = result.details as { toolCount: number } | undefined;
      return new Text(theme.fg("success", `${details?.toolCount ?? 0} tools`), 0, 0);
    },
  });

  pi.registerTool({
    name: "mcp_call",
    label: "MCP Call",
    description: "Call a specific tool exposed by an MCP server discovered through mcporter.",
    promptSnippet: "Invoke a tool on an MCP server",
    promptGuidelines: [
      "Use mcp_servers and mcp_discover first so you know the server and tool schema.",
      "Pass a JSON object for args that matches the advertised input schema.",
    ],
    parameters: Type.Object({
      server: Type.String({ description: "MCP server name." }),
      tool: Type.String({ description: "Tool name exposed by that server." }),
      args: Type.Optional(Type.Any({ description: "JSON-serializable input arguments." })),
    }),

    async execute(_id, params, signal) {
      try {
        const raw = await runMcporter(
          ["call", params.server, params.tool, "--json", JSON.stringify(params.args ?? {})],
          signal,
          60_000,
        );

        const truncation = truncateHead(raw, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        });
        let finalText = truncation.content;
        if (truncation.truncated) {
          finalText += `\n\n[Truncated: ${truncation.outputLines}/${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
        }

        return {
          content: [{ type: "text", text: finalText || "(empty result)" }],
          details: {
            server: params.server,
            tool: params.tool,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to call ${params.server}.${params.tool}: ${message}`);
      }
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("mcp_call")) + theme.fg("dim", ` ${args.server}.${args.tool}`),
        0,
        0,
      );
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Calling MCP tool..."), 0, 0);
      const details = result.details as { server?: string; tool?: string } | undefined;
      return new Text(
        theme.fg("success", `${details?.server ?? "server"}.${details?.tool ?? "tool"} completed`),
        0,
        0,
      );
    },
  });
}
