/**
 * Google Search Extension
 *
 * Provides a `google_search` tool that performs web searches via Gemini's
 * Google Search grounding feature.
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
import { GoogleGenAI } from "@google/genai";

interface SearchSource {
  title: string;
  uri: string;
  domain: string;
}

interface SearchResult {
  answer: string;
  sources: SearchSource[];
  searchQueries: string[];
  cached: boolean;
}

interface SearchDetails {
  query: string;
  sourceCount: number;
  cached: boolean;
  durationMs: number;
  error?: string;
}

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (!client) {
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  }
  return client;
}

const resultCache = new Map<string, SearchResult>();

function cacheKey(query: string): string {
  return query.toLowerCase().trim();
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "google_search",
    label: "Google Search",
    description:
      "Search the web using Google Search via Gemini. " +
      "Returns an AI-synthesized answer grounded in Google Search results, plus source URLs. " +
      "Use this when you need current information from the web. Requires GEMINI_API_KEY.",
    promptSnippet: "Search the web via Google Search to get current information with sources",
    promptGuidelines: [
      "Use google_search when you need up-to-date web information that isn't in your training data.",
      "Be specific with queries for better results.",
      "The tool returns both an answer and source URLs. Cite sources when sharing results with the user.",
      "Results are cached per-session, so repeated identical queries are free.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "The search query, e.g. 'latest Node.js LTS version'",
      }),
      maxSources: Type.Optional(
        Type.Number({
          description: "Maximum number of source URLs to include (default 5, max 10).",
          minimum: 1,
          maximum: 10,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const startTime = Date.now();
      const maxSources = Math.min(Math.max(params.maxSources ?? 5, 1), 10);

      if (!process.env.GEMINI_API_KEY) {
        return {
          content: [
            {
              type: "text",
              text: "Error: GEMINI_API_KEY is not set. Please set this environment variable to use Google Search.\n\nExample: export GEMINI_API_KEY=your_key",
            },
          ],
          isError: true,
          details: {
            query: params.query,
            sourceCount: 0,
            cached: false,
            durationMs: Date.now() - startTime,
            error: "auth_error: GEMINI_API_KEY not set",
          } as SearchDetails,
        };
      }

      const key = cacheKey(params.query);
      if (resultCache.has(key)) {
        const cached = resultCache.get(key)!;
        return {
          content: [{ type: "text", text: formatOutput(cached, maxSources) }],
          details: {
            query: params.query,
            sourceCount: cached.sources.length,
            cached: true,
            durationMs: Date.now() - startTime,
          } as SearchDetails,
        };
      }

      let result: SearchResult;
      try {
        const ai = getClient();
        const response = await ai.models.generateContent({
          model: process.env.GEMINI_SEARCH_MODEL || "gemini-2.5-flash",
          contents: params.query,
          config: {
            tools: [{ googleSearch: {} }],
            abortSignal: signal,
          },
        });

        const answer = response.text ?? "";
        const candidate = response.candidates?.[0];
        const grounding = candidate?.groundingMetadata;

        const sources: SearchSource[] = [];
        const seenTitles = new Set<string>();
        if (grounding?.groundingChunks) {
          for (const chunk of grounding.groundingChunks) {
            if (chunk.web) {
              const title = chunk.web.title ?? "Untitled";
              if (seenTitles.has(title)) continue;
              seenTitles.add(title);
              sources.push({
                title,
                uri: chunk.web.uri ?? "",
                domain: chunk.web.domain ?? title,
              });
            }
          }
        }

        const searchQueries = grounding?.webSearchQueries ?? [];
        result = { answer, sources, searchQueries, cached: false };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        let errorType = "api_error";
        if (message.includes("401") || message.includes("UNAUTHENTICATED")) {
          errorType = "auth_error";
        } else if (message.includes("429") || message.includes("RESOURCE_EXHAUSTED") || message.includes("quota")) {
          errorType = "rate_limit";
        }

        return {
          content: [{ type: "text", text: `Google Search failed (${errorType}): ${message}` }],
          isError: true,
          details: {
            query: params.query,
            sourceCount: 0,
            cached: false,
            durationMs: Date.now() - startTime,
            error: `${errorType}: ${message}`,
          } as SearchDetails,
        };
      }

      resultCache.set(key, result);

      const rawOutput = formatOutput(result, maxSources);
      const truncation = truncateHead(rawOutput, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      let finalText = truncation.content;
      if (truncation.truncated) {
        finalText +=
          `\n\n[Truncated: showing ${truncation.outputLines}/${truncation.totalLines} lines` +
          ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
      }

      return {
        content: [{ type: "text", text: finalText }],
        details: {
          query: params.query,
          sourceCount: result.sources.length,
          cached: false,
          durationMs: Date.now() - startTime,
        } as SearchDetails,
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("google_search "));
      text += theme.fg("accent", `"${args.query}"`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { isPartial, expanded }, theme) {
      const details = result.details as SearchDetails | undefined;

      if (isPartial) return new Text(theme.fg("warning", "Searching Google..."), 0, 0);
      if (result.isError || details?.error) {
        return new Text(theme.fg("error", `Error: ${details?.error ?? "unknown"}`), 0, 0);
      }

      let text = theme.fg("success", `${details?.sourceCount ?? 0} sources`);
      text += theme.fg("dim", ` (${details?.durationMs ?? 0}ms)`);
      if (details?.cached) text += theme.fg("dim", " · cached");

      if (expanded) {
        const content = result.content[0];
        if (content?.type === "text") {
          const preview = content.text.split("\n").slice(0, 8).join("\n");
          text += "\n\n" + theme.fg("dim", preview);
          if (content.text.split("\n").length > 8) {
            text += "\n" + theme.fg("muted", "...");
          }
        }
      }

      return new Text(text, 0, 0);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!process.env.GEMINI_API_KEY) {
      ctx.ui.notify(
        "Google Search: No GEMINI_API_KEY set. The google_search tool will not work until this is configured.",
        "warning",
      );
    }
  });
}

function formatOutput(result: SearchResult, maxSources: number): string {
  const lines: string[] = [];

  if (result.answer) {
    lines.push(result.answer);
  } else {
    lines.push("(No answer text returned from search)");
  }

  if (result.sources.length > 0) {
    lines.push("");
    lines.push("Sources:");
    const sourcesToShow = result.sources.slice(0, maxSources);
    for (let index = 0; index < sourcesToShow.length; index++) {
      const source = sourcesToShow[index];
      lines.push(`[${index + 1}] ${source.title} - ${source.domain}`);
      lines.push(`    ${source.uri}`);
    }
    if (result.sources.length > maxSources) {
      lines.push(`(${result.sources.length - maxSources} more sources omitted)`);
    }
  } else {
    lines.push("");
    lines.push("(No source URLs found in grounding metadata)");
  }

  if (result.searchQueries.length > 0) {
    lines.push("");
    lines.push(`Searches performed: ${result.searchQueries.map((query) => `"${query}"`).join(", ")}`);
  }

  return lines.join("\n");
}
