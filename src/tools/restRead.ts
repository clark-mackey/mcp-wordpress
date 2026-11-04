import { WordPressClient } from "@/client/api.js";
import { WordPressAPIError } from "@/types/client.js";
import type { MCPToolSchema } from "@/types/mcp.js";
import { preserveToolError } from "@/utils/error.js";
import { toolParams } from "./params.js";
import { pluginRestUrl } from "./pluginRest.js";

const DEFAULT_MAX_CHARS = 20_000;
const ROUTE_PATTERN = /^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/i;
const QUERY_KEY_PATTERN = /^[a-z0-9_]+(\[\])?$/i;
// Routes with their own tools, or holding account or visitor data this tool should not hand out
// (comments in edit context carry commenter emails and IPs).
const DENIED_ROUTES = new Set(["users", "settings", "application-passwords", "plugins", "themes", "comments"]);

/**
 * Read-only access to /wp/v2 routes the dedicated tools do not cover: block-theme templates and template parts,
 * reusable blocks, navigation menus, and custom post types and taxonomies that themes and plugins register there.
 *
 * ponytail: limited to the /wp/v2 namespace. Plugin namespaces (wc/v3, acf/v3, …) need per-namespace route review
 * before opening, as seopress/ and redirection/ had; add them as dedicated tools or a reviewed namespace allowlist.
 */
export class RestReadTools {
  public getTools(): Array<{
    name: string;
    description: string;
    inputSchema?: MCPToolSchema;
    handler: (client: WordPressClient, params: Record<string, unknown>) => Promise<unknown>;
  }> {
    return [
      {
        name: "wp_rest_get",
        description:
          "Read-only GET of a /wp-json/wp/v2 route that has no dedicated tool: `templates`, `template-parts`, `blocks`, " +
          "`navigation`, `menu-items`, or a custom post type or taxonomy a theme or plugin registers (list them with `types` and `taxonomies`). " +
          "Prefer the dedicated tools for pages, posts, media, users and settings. Pass `fields` to return only what you need.",
        inputSchema: {
          type: "object",
          properties: {
            route: {
              type: "string",
              description: "Route under /wp-json/wp/v2, e.g. `types`, `template-parts`, `blocks/42`.",
            },
            fields: {
              type: "array",
              items: { type: "string" },
              description: 'Fields to return (WordPress `_fields`), e.g. ["id", "title", "content.raw"].',
            },
            query: {
              type: "object",
              description:
                'Query parameters, e.g. {"search": "header", "per_page": 20}. Set `context: "edit"` to get raw content.',
            },
            max_chars: {
              type: "number",
              minimum: 1,
              description: `Truncate the JSON response to this many characters. Default ${DEFAULT_MAX_CHARS}.`,
            },
          },
          required: ["route"],
        },
        handler: this.handleRestGet.bind(this),
      },
    ];
  }

  public async handleRestGet(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const {
      route,
      fields,
      query = {},
      max_chars = DEFAULT_MAX_CHARS,
    } = toolParams<{ route: string; fields?: string[]; query?: Record<string, unknown>; max_chars?: number }>(params);
    try {
      const path = route
        .trim()
        .replace(/^\/+|\/+$/g, "")
        .replace(/^(wp-json\/)?wp\/v2\/?/, "");
      if (!ROUTE_PATTERN.test(path)) {
        throw new WordPressAPIError(
          "route must be a /wp/v2 route made of letters, digits, '-', '_' and '/', e.g. `blocks/12`.",
          400,
          "INVALID_PARAMETER",
        );
      }
      const base = path.split("/")[0]!.toLowerCase();
      if (DENIED_ROUTES.has(base)) {
        throw new WordPressAPIError(
          `wp_rest_get does not read /wp/v2/${base}; use the dedicated tools instead.`,
          400,
          "INVALID_PARAMETER",
        );
      }

      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (!QUERY_KEY_PATTERN.test(key) || !["string", "number", "boolean"].includes(typeof value)) {
          throw new WordPressAPIError(
            `query.${key}: keys must be simple names and values strings, numbers or booleans.`,
            400,
            "INVALID_PARAMETER",
          );
        }
        // WordPress reads `_method` from the query string on any request (a GET becomes a DELETE) and lets a
        // `rest_route` query var override the path (reaching denied routes). `_embed` would pull in users;
        // `_fields` is set through `fields`. So no underscore-prefixed key and no `rest_route` gets through.
        if (key.startsWith("_") || key.toLowerCase() === "rest_route") {
          throw new WordPressAPIError(
            `query.${key} is not allowed (method, route and embed overrides are blocked; use \`fields\` for _fields).`,
            400,
            "INVALID_PARAMETER",
          );
        }
        search.set(key, String(value));
      }
      if (fields && fields.length > 0) search.set("_fields", fields.join(","));

      const qs = search.toString();
      const data = await client.request<unknown>("GET", `${pluginRestUrl(client, "wp/v2", path)}${qs ? `?${qs}` : ""}`);
      const json = JSON.stringify(data);
      return json.length > max_chars
        ? `${json.slice(0, max_chars)}\n\n[truncated: first ${max_chars} of ${json.length} chars; pass \`fields\` or narrow the query]`
        : json;
    } catch (_error) {
      preserveToolError(`Failed to read /wp/v2/${route}`, _error);
    }
  }
}

export default RestReadTools;
