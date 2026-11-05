import type { UsagePayload } from "./types.js";

const ID_KEYS = new Set(["id", "parent", "author", "post", "featured_media"]);
export const SEARCH_ARGUMENTS_BY_TOOL: Readonly<Record<string, readonly string[]>> = {
  wp_list_posts: ["search"],
  wp_list_pages: ["search"],
  wp_list_media: ["search"],
  wp_list_users: ["search"],
  wp_list_categories: ["search"],
  wp_list_tags: ["search"],
  wp_search_site: ["term"],
  wp_seo_track_serp: ["keywords"],
  wp_seo_keyword_research: ["seedKeyword"],
};

function isIdKey(key: string): boolean {
  return ID_KEYS.has(key) || key.endsWith("_id");
}

export function usagePayload(toolName: string | null, args: Record<string, unknown>): UsagePayload {
  const ids: Record<string, number | number[]> = {};
  const searchText: Record<string, string | string[]> = {};
  const searchKeys = new Set(toolName === null ? [] : (SEARCH_ARGUMENTS_BY_TOOL[toolName] ?? []));
  let truncated = false;
  for (const [key, value] of Object.entries(args)) {
    if (isIdKey(key)) {
      if (Number.isSafeInteger(value) && (value as number) >= 0) ids[key] = value as number;
      else if (Array.isArray(value)) {
        const kept = value.filter((item): item is number => Number.isSafeInteger(item) && item >= 0).slice(0, 50);
        if (kept.length > 0) ids[key] = kept;
      }
      continue;
    }
    if (!searchKeys.has(key)) continue;
    const clean = (text: string): string => {
      const trimmed = text.trim();
      if (trimmed.length > 256) truncated = true;
      return trimmed.slice(0, 256);
    };
    if (typeof value === "string") searchText[key] = clean(value);
    else if (Array.isArray(value)) {
      const kept = value
        .filter((item): item is string => typeof item === "string")
        .slice(0, 20)
        .map(clean);
      if (kept.length > 0) searchText[key] = kept;
    }
  }
  return {
    ...(Object.keys(ids).length > 0 ? { ids } : {}),
    ...(Object.keys(searchText).length > 0 ? { search_text: searchText } : {}),
    ...(truncated ? { search_text_truncated: true as const } : {}),
  };
}

export function parseClient(userAgent: string | undefined): { name: string | null; version: string | null } {
  if (userAgent === undefined) return { name: null, version: null };
  const claude = /^claude-code\/(\d+(?:\.\d+){1,3})/.exec(userAgent);
  if (claude) return { name: "claude_code", version: claude[1] ?? null };
  const codex = /^codex-mcp-client\/(\d+(?:\.\d+){1,3})/.exec(userAgent);
  if (codex) return { name: "codex", version: codex[1] ?? null };
  return { name: "other", version: null };
}
