import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";

const authFilePath = join(homedir(), ".gsd", "agent", "auth.json");

export type SearchProvider = "tavily" | "brave";
export type SearchProviderPreference = SearchProvider | "auto";

const VALID_PREFERENCES = new Set<string>(["tavily", "brave", "auto"]);
const PREFERENCE_KEY = "search_provider";

export function getTavilyApiKey(): string {
  return process.env.TAVILY_API_KEY || "";
}

export function getBraveApiKey(): string {
  return process.env.BRAVE_API_KEY || "";
}

export function getSearchProviderPreference(authPath?: string): SearchProviderPreference {
  const auth = AuthStorage.create(authPath ?? authFilePath);
  const cred = auth.get(PREFERENCE_KEY);
  if (cred?.type === "api_key" && typeof cred.key === "string" && VALID_PREFERENCES.has(cred.key)) {
    return cred.key as SearchProviderPreference;
  }
  return "auto";
}

export function setSearchProviderPreference(pref: SearchProviderPreference, authPath?: string): void {
  const auth = AuthStorage.create(authPath ?? authFilePath);
  auth.set(PREFERENCE_KEY, { type: "api_key", key: pref });
}

export function resolveSearchProvider(overridePreference?: string): SearchProvider | null {
  const hasTavily = getTavilyApiKey().length > 0;
  const hasBrave = getBraveApiKey().length > 0;

  let pref: SearchProviderPreference;
  if (overridePreference && VALID_PREFERENCES.has(overridePreference)) {
    pref = overridePreference as SearchProviderPreference;
  } else if (overridePreference !== undefined && !VALID_PREFERENCES.has(overridePreference)) {
    pref = "auto";
  } else {
    pref = getSearchProviderPreference();
  }

  if (pref === "auto") {
    if (hasTavily) return "tavily";
    if (hasBrave) return "brave";
    return null;
  }

  if (pref === "tavily") {
    if (hasTavily) return "tavily";
    if (hasBrave) return "brave";
    return null;
  }

  if (hasBrave) return "brave";
  if (hasTavily) return "tavily";
  return null;
}
