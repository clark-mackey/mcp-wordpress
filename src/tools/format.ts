import type { JSONSchemaProperty } from "@/types/mcp.js";

/**
 * When a post or page was last modified, in the reader's local time. Uses modified_gmt because
 * WordPress's plain `modified` is site-local time without a zone, which reads as the wrong hour
 * on a laptop in another timezone.
 */
export function formatModified(item: { modified?: string; modified_gmt?: string }): string {
  if (item.modified_gmt) return new Date(`${item.modified_gmt}Z`).toLocaleString();
  return item.modified ? new Date(item.modified).toLocaleString() : "unknown";
}

/** Ways to narrow a page or post body before it reaches the model. */
export interface ContentViewOptions {
  find?: string | undefined;
  max_chars?: number | undefined;
}

const FIND_CONTEXT_CHARS = 200;
const FIND_MAX_MATCHES = 20;

/** True when the caller asked for any part of the body. */
export const wantsContentView = ({ find, max_chars }: ContentViewOptions): boolean =>
  find !== undefined || max_chars !== undefined;

/**
 * The body as the caller asked for it: each exact (case-sensitive) `find` match with surrounding
 * context, or the first `max_chars` characters, or the whole body. Matching is the same exact
 * substring test wp_edit_content uses, so a snippet can be copied into its `old_string`.
 */
export function contentView(body: string, { find, max_chars }: ContentViewOptions): string {
  if (find) {
    const hits: number[] = [];
    for (
      let i = body.indexOf(find);
      i !== -1 && hits.length <= FIND_MAX_MATCHES;
      i = body.indexOf(find, i + find.length)
    ) {
      hits.push(i);
    }
    if (hits.length === 0) return `"${find}" not found in the content (${body.length} chars).`;
    const shown = hits.slice(0, FIND_MAX_MATCHES).map((i, n) => {
      const start = Math.max(0, i - FIND_CONTEXT_CHARS);
      const end = Math.min(body.length, i + find.length + FIND_CONTEXT_CHARS);
      return `[match ${n + 1} at char ${i}]\n${start > 0 ? "…" : ""}${body.slice(start, end)}${end < body.length ? "…" : ""}`;
    });
    const more = hits.length > FIND_MAX_MATCHES ? `\n\nMore than ${FIND_MAX_MATCHES} matches; narrow \`find\`.` : "";
    const result = `${shown.length} match(es) for "${find}" (content is ${body.length} chars):\n\n${shown.join("\n\n")}${more}`;
    return max_chars !== undefined && result.length > max_chars
      ? `${result.slice(0, max_chars)}\n\n[truncated at ${max_chars} chars; narrow \`find\` or raise \`max_chars\`]`
      : result;
  }
  if (max_chars !== undefined && body.length > max_chars) {
    return `${body.slice(0, max_chars)}\n\n[truncated: first ${max_chars} of ${body.length} chars; use \`find\` to jump to a section]`;
  }
  return body;
}

/** inputSchema properties for ContentViewOptions, shared by wp_get_page and wp_get_post. */
export const CONTENT_VIEW_PROPERTIES: Record<string, JSONSchemaProperty> = {
  find: {
    type: "string",
    description:
      "Return only the exact (case-sensitive) matches of this text in the raw content, each with 200 characters " +
      "of context, instead of the whole body. Implies include_content.",
  },
  max_chars: {
    type: "number",
    minimum: 1,
    description: "Return at most this many characters of content. Implies include_content.",
  },
};
