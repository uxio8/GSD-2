import type { SearchResultFormatted } from "./format.ts";

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
  raw_content?: string | null;
  published_date?: string | null;
  favicon?: string | null;
}

export interface TavilySearchResponse {
  query: string;
  answer?: string | null;
  results: TavilyResult[];
  response_time: string | number;
  usage?: { credits: number } | null;
  request_id?: string | null;
}

export function normalizeTavilyResult(r: TavilyResult): SearchResultFormatted {
  return {
    title: r.title || "(untitled)",
    url: r.url,
    description: r.content || "",
    age: r.published_date ? publishedDateToAge(r.published_date) : undefined,
  };
}

export function publishedDateToAge(isoDate: string): string | undefined {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return undefined;

  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return undefined;

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? "day" : "days"} ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months} ${months === 1 ? "month" : "months"} ago`;

  const years = Math.floor(months / 12);
  return `${years} ${years === 1 ? "year" : "years"} ago`;
}

const BRAVE_TO_TAVILY_FRESHNESS: Record<string, string> = {
  pd: "day",
  pw: "week",
  pm: "month",
  py: "year",
};

export function mapFreshnessToTavily(braveFreshness: string | null): string | null {
  if (braveFreshness === null) return null;
  return BRAVE_TO_TAVILY_FRESHNESS[braveFreshness] ?? null;
}
