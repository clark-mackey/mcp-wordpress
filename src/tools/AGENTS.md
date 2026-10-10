# src/tools/

## Purpose

The 88 MCP tools the server exposes, grouped by WordPress resource.

## Ownership

Owns `src/tools/` including `posts/`, `performance/`, `seopress/`, `redirection/`, and `seo/` (with `analyzers/`,
`auditors/`, `generators/`, `optimizers/`, `providers/`, `validators/`). Does not own the WordPress client
(`src/client/AGENTS.md`) or input sanitization internals (`src/security/AGENTS.md`) that tools call into.

## Local Contracts

**Tool anatomy**: a tool is a plain object `{ name, description, inputSchema }` matching `MCPTool`
(`src/types/mcp.ts:33-37`) with hand-written JSON-Schema `inputSchema`, paired with an `async handler(client, params)`
function. Zod is applied centrally at registration time (`src/server/ToolRegistry.ts`), not at the definition site —
don't add per-tool Zod schemas.

**Registration contract**: each exported class (`src/tools/index.ts`) must implement
`getTools(): { name, description, inputSchema, handler }[]`. `ToolRegistry.registerAllTools()` instantiates every class
(some, like `CacheTools`/`PerformanceTools`, take the `wordpressClients` map in their constructor), converts each
`inputSchema` to Zod at runtime, auto-injects a `site` parameter in multi-site mode, and wraps handlers in try/catch for
auth-error/`EnhancedError` handling. A new tool must satisfy this contract to be picked up.

**File pattern**: multiple tools per file, grouped by resource — not file-per-tool. Newer/larger categories (`posts/`,
`seo/`, `performance/`, `seopress/`, `redirection/`) split into `*ToolDefinitions.ts` (schemas) + `*Handlers.ts`
(logic) + `index.ts` (class wiring); older categories (`pages.ts`, `users.ts`, `comments.ts`, `taxonomies.ts`,
`cache.ts`, `site.ts`, `auth.ts`) are single files. `posts.ts` and `performance.ts` are `@deprecated` re-export shims —
edit the subdirectory versions, not the shims.

**Category map** (88 tools / 15 categories — verified against source):

| Category    | File(s)                                     | Count |
| ----------- | ------------------------------------------- | ----- |
| Posts       | `posts/PostToolDefinitions.ts`              | 6     |
| Pages       | `pages.ts`                                  | 6     |
| Media       | `media.ts`                                  | 5     |
| Users       | `users.ts`                                  | 6     |
| Comments    | `comments.ts`                               | 7     |
| Taxonomies  | `taxonomies.ts`                             | 10    |
| Site        | `site.ts` (settings/search)                 | 3     |
| Auth        | `auth.ts` (3) + `site.ts` app-passwords (3) | 6     |
| Cache       | `cache.ts`                                  | 4     |
| Performance | `performance/PerformanceTools.ts`           | 6     |
| SEO         | `seo/SEOToolDefinitions.ts`                 | 11    |
| SEOPress    | `seopress/SEOPressToolDefinitions.ts`       | 10    |
| Redirection | `redirection/RedirectionToolDefinitions.ts` | 6     |
| Revisions   | `revisions.ts` (restore only)               | 1     |
| System      | `version.ts` (wrapped by `system.ts`)       | 1     |

**SEO engines** (`seo/`) — each subdirectory is one engine-per-concern, orchestrated by `seo/SEOTools.ts`:
`analyzers/ContentAnalyzer.ts` (readability/keyword scoring), `auditors/SiteAuditor.ts` (site-wide audit),
`generators/MetaGenerator.ts` + `SchemaGenerator.ts` (meta tags, JSON-LD), `optimizers/InternalLinkingSuggester.ts`,
`providers/SearchConsoleProvider.ts` (Google Search Console). `validators/` is currently empty (reserved).

**Plugin REST routes**: tools for a plugin's own REST namespace (e.g. `seopress/` → `/seopress/v1`) pass an absolute URL
built with `pluginRestUrl()` (`src/tools/pluginRest.ts`), because relative endpoints are prefixed with `/wp-json/wp/v2`.
Writes are verified by reading back through `client.requestWithMetadata()`, which bypasses the GET cache, and a mismatch
is a tool error — these plugin routes report success even when they store nothing or a sanitized value. Some page caches
(LiteSpeed Cache) store plugin REST responses to Application Password requests as anonymous, so reads send `NO_CACHE`
headers and a response with a cache-hit header (`x-litespeed-cache`, `x-cache`, `cf-cache-status`) is an error, never
data (`assertNotPageCached`). Absolute URLs keep their query string.

**SEOPress** (`seopress/`): per-item tools use the `/seopress/v1/posts/{id}/*` field routes (they work on SEOPress
releases that do not expose its meta in `/wp/v2`); robots/redirect checkboxes read back as `"yes"`/`true`, and fields
SEOPress global settings force (`can_modify: false`) are refused before writing. `/options/{section}-settings` POST
replaces the whole option, so `wp_seopress_update_settings` reads, deep-merges, then writes. Sections holding
credentials (indexing, license, analytics, Pro) and the `/tools` export/import/reset routes are never called.

**Redirection** (`redirection/`): only the `/redirection/v1` redirect, bulk enable/disable, and group routes are called
— the log, 404, settings, plugin, import, and export routes hold visitor IPs or the log feed token, and redirects are
disabled, never deleted. Create and update rebuild the whole redirect, so update sends every field of the current one;
only plain URL redirects (match `url`, action `url`) are written. Writes refuse a source another redirect handles
(case-insensitive, trailing slash ignored) and loops, then read the redirect back by ID. The create route answers with a
list page, so the new redirect is the one whose ID exceeds the newest ID read before creating.
`wp_redirection_check_redirect` uses global `fetch` without credentials (`redirect: "manual"`), never the client.

**Shared imports**: `@/client/api.js` (`WordPressClient`), `@/utils/error.js`, `@/types/wordpress.js`,
`@/utils/validation/security.js` (`sanitizeHtml`), `src/tools/params.ts` (`toolParams<T>`, `parseId`,
`parseIdAndForce`).

**Auth tool isolation**: `wp_switch_auth_method` must never mutate the shared per-site `WordPressClient` instance stored
by the server for later tool invocations. When validating alternate credentials, verify them with an isolated throwaway
client and leave the shared client/config/cache untouched.

## Work Guidance

Adding a `wp_*` tool: define it alongside its category's existing tools, register a handler, and ensure the class's
`getTools()` includes it. Mirror the test layout in `tests/tools/`.

## Verification

```bash
npm run build && npx vitest run tests/tools/
```

## Child DOX Index

None — SEO engine subdirectories are covered above; no further AGENTS.md files under `src/tools/`.
