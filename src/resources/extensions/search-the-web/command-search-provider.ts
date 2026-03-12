import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import {
  getBraveApiKey,
  getSearchProviderPreference,
  getTavilyApiKey,
  resolveSearchProvider,
  setSearchProviderPreference,
  type SearchProviderPreference,
} from "./provider.ts";

const VALID_PREFERENCES: SearchProviderPreference[] = ["tavily", "brave", "auto"];

function keyStatus(provider: "tavily" | "brave"): string {
  return provider === "tavily" ? (getTavilyApiKey() ? "✓" : "✗") : (getBraveApiKey() ? "✓" : "✗");
}

function buildSelectOptions(): string[] {
  return [
    `tavily (key: ${keyStatus("tavily")})`,
    `brave (key: ${keyStatus("brave")})`,
    "auto",
  ];
}

function parseSelectChoice(choice: string): SearchProviderPreference {
  if (choice.startsWith("tavily")) return "tavily";
  if (choice.startsWith("brave")) return "brave";
  return "auto";
}

export function registerSearchProviderCommand(pi: ExtensionAPI): void {
  pi.registerCommand("search-provider", {
    description: "Switch search provider (tavily, brave, auto)",

    getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
      const trimmed = prefix.trim().toLowerCase();
      return VALID_PREFERENCES
        .filter((p) => p.startsWith(trimmed))
        .map((p) => ({
          value: p,
          label: p,
          description: p === "auto"
            ? `Auto-select (tavily: ${keyStatus("tavily")}, brave: ${keyStatus("brave")})`
            : `key: ${keyStatus(p)}`,
        }));
    },

    async handler(args, ctx) {
      const trimmed = args.trim().toLowerCase();
      let chosen: SearchProviderPreference;

      if (trimmed && (VALID_PREFERENCES as string[]).includes(trimmed)) {
        chosen = trimmed as SearchProviderPreference;
      } else {
        const current = getSearchProviderPreference();
        const result = await ctx.ui.select(`Search provider (current: ${current})`, buildSelectOptions());
        if (result === undefined) return;
        chosen = parseSelectChoice(result);
      }

      setSearchProviderPreference(chosen);
      const effective = resolveSearchProvider();
      ctx.ui.notify(
        `Search provider set to ${chosen}. Effective provider: ${effective ?? "none (no API keys)"}`,
        "info",
      );
    },
  });
}
