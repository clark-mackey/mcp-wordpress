/**
 * SEOPress tool handlers.
 *
 * SEOPress keeps its per-post fields in post meta that older SEOPress releases do not
 * expose through the core /wp/v2 `meta` field, so writes there can be silently dropped.
 * These handlers use SEOPress's own REST routes (namespace seopress/v1), which exist
 * since SEOPress 4.7/5.0 and work for any post type the account can edit.
 *
 * Those routes answer `{"code":"success"}` whatever they stored: invalid values are
 * sanitized, emptied, or kept as sent. Every write here therefore reads the value back
 * (bypassing the client GET cache) and fails when the stored value differs from the
 * request, reporting the previous value so the change can be undone.
 */

import { WordPressClient } from "@/client/api.js";
import { WordPressAPIError } from "@/types/client.js";
import { preserveToolError } from "@/utils/error.js";
import { parseId } from "../params.js";

type Params = Record<string, unknown>;
type Stored = Record<string, string>;

interface FieldEntry {
  key: string;
  value?: unknown;
  can_modify?: boolean;
}

interface TitleDescription {
  title: string;
  description: string;
}

/** Settings sections readable through /seopress/v1/options/{section}-settings. */
export const READABLE_SETTINGS_SECTIONS = ["titles", "social", "sitemaps", "advanced", "bot", "woocommerce"] as const;

/**
 * Settings sections the tools may write. Indexing, license, analytics, and Pro
 * settings hold credentials (service-account keys, license keys, API tokens) and are
 * never read or written by these tools.
 */
export const WRITABLE_SETTINGS_SECTIONS = ["titles", "social", "sitemaps", "advanced"] as const;

const ROBOTS_FLAGS = {
  noindex: "_seopress_robots_index",
  nofollow: "_seopress_robots_follow",
  noimageindex: "_seopress_robots_imageindex",
  nosnippet: "_seopress_robots_snippet",
  freeze_modified_date: "_seopress_robots_freeze_modified_date",
} as const;

const SOCIAL_TEXT_FIELDS = {
  facebook_title: "_seopress_social_fb_title",
  facebook_description: "_seopress_social_fb_desc",
  x_title: "_seopress_social_twitter_title",
  x_description: "_seopress_social_twitter_desc",
} as const;

const SOCIAL_IMAGE_FIELDS = {
  facebook_image_id: "_seopress_social_fb",
  x_image_id: "_seopress_social_twitter",
} as const;

const NON_CONTENT_POST_TYPES = new Set([
  "attachment",
  "nav_menu_item",
  "wp_block",
  "wp_template",
  "wp_template_part",
  "wp_navigation",
  "wp_global_styles",
  "wp_font_family",
  "wp_font_face",
]);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const seopressUrl = (client: WordPressClient, path: string): string =>
  `${client.getSiteUrl()}/wp-json/seopress/v1/${path}`;

const PAGE_CACHE_HEADERS = ["x-litespeed-cache", "x-cache", "x-proxy-cache", "cf-cache-status"];

/**
 * GET without the client cache, so a read-back after a write shows what WordPress stored.
 * Some page caches (LiteSpeed Cache) store REST responses to Application Password requests
 * as if anonymous; a cached response shows stale values, so it is an error, never data.
 */
async function read<T>(client: WordPressClient, path: string): Promise<T> {
  const response = await client.requestWithMetadata<T>("GET", seopressUrl(client, path), null, {
    headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
  });
  const hit = PAGE_CACHE_HEADERS.find((name) => /^hit/i.test(response.headers?.[name] ?? ""));
  if (hit) {
    throw new Error(
      `The site's page cache answered the SEOPress request for ${path} (${hit}: ${response.headers[hit]}), so ` +
        "the values WordPress stored cannot be read or verified (a write already sent may have been saved). " +
        "Purge the page cache and " +
        "exclude logged-in REST API responses from it: a cached response to an authenticated request is also " +
        "served to anonymous visitors.",
    );
  }
  return response.data;
}

/**
 * SEOPress sanitizes text with sanitize_text_field()/sanitize_textarea_field(), which
 * trim and collapse whitespace. Compare with whitespace collapsed so only real changes
 * (stripped tags, dropped characters, rejected values) count as a mismatch.
 */
const normalize = (value: unknown): string =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

const display = (value: string | undefined): string => (value ? `"${value}"` : "(empty)");

/** SEOPress field routes answer with a list of `{ key, value, can_modify }` entries. */
function toFieldMap(response: unknown): Map<string, FieldEntry> {
  const map = new Map<string, FieldEntry>();
  if (Array.isArray(response)) {
    for (const entry of response) {
      if (entry && typeof entry === "object" && typeof (entry as FieldEntry).key === "string") {
        map.set((entry as FieldEntry).key, entry as FieldEntry);
      }
    }
  }
  return map;
}

/** Checkboxes read back as "yes"/"" (robots) or true/false (redirections). */
const checkboxValue = (value: unknown): string => (value === true || value === "yes" || value === "1" ? "yes" : "");

const storedValues = (fields: Map<string, FieldEntry>, keys: string[], checkboxes: Set<string>): Stored =>
  Object.fromEntries(
    keys.map((key) => {
      const value = fields.get(key)?.value;
      return [key, checkboxes.has(key) ? checkboxValue(value) : normalize(value)];
    }),
  );

/**
 * Throws when any sent field was not stored as sent. Lists the previous value so the
 * caller can restore it.
 */
function assertStored(
  id: number,
  sent: Stored,
  stored: Stored,
  previous: Stored,
  labels: Record<string, string>,
): void {
  const mismatches = Object.keys(sent).filter((key) => normalize(stored[key]) !== normalize(sent[key]));
  if (mismatches.length > 0) {
    const details = mismatches
      .map(
        (key) =>
          `- ${labels[key] ?? key}: sent ${display(sent[key])}, stored ${display(stored[key])}, previously ${display(previous[key])}`,
      )
      .join("\n");
    throw new Error(`SEOPress did not store the requested value for item ${id}:\n${details}`);
  }
}

function changeLines(sent: Stored, previous: Stored, labels: Record<string, string>): string {
  return Object.keys(sent)
    .map((key) => {
      const label = labels[key] ?? key;
      return normalize(previous[key]) === normalize(sent[key])
        ? `- **${label}:** unchanged, already ${display(sent[key])}`
        : `- **${label}:** ${display(sent[key])} (was ${display(previous[key])})`;
    })
    .join("\n");
}

function throwSEOPressError(prefix: string, error: unknown): never {
  if (error instanceof WordPressAPIError && error.statusCode === 404) {
    throw new Error(
      `${prefix}: the SEOPress REST route was not found. Is SEOPress active, and recent enough for this feature?`,
    );
  }
  if (error instanceof WordPressAPIError && (error.statusCode === 401 || error.statusCode === 403)) {
    throw new Error(
      `${prefix}: not permitted (${error.message}). The item may not exist, the account may not be able to edit ` +
        `it, SEOPress settings may block this account's role, or a site access policy may block this route.`,
    );
  }
  preserveToolError(prefix, error);
}

async function withErrors<T>(prefix: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throwSEOPressError(prefix, error);
  }
}

const labelsFor = (map: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(map).map(([param, key]) => [key, param]));

async function readTitleDescription(client: WordPressClient, id: number): Promise<TitleDescription> {
  const data = await read<Partial<TitleDescription>>(client, `posts/${id}/title-description-metas`);
  return { title: data?.title ?? "", description: data?.description ?? "" };
}

async function readTargetKeywords(client: WordPressClient, id: number): Promise<string[]> {
  const data = await read<unknown>(client, `posts/${id}/target-keywords`);
  if (!Array.isArray(data)) return [];
  return data
    .map((entry) => (typeof entry === "string" ? entry : (entry as { key?: unknown })?.key))
    .filter((keyword): keyword is string => typeof keyword === "string" && keyword.trim() !== "")
    .map((keyword) => keyword.trim());
}

/**
 * What SEOPress outputs for a published item (templates and global settings applied).
 * The route is public and returns null data for unpublished or password-protected items.
 */
async function readOutput(client: WordPressClient, id: number): Promise<Record<string, unknown> | null> {
  const response = await read<{ data?: Record<string, unknown> | null }>(client, `posts/${id}`);
  return response?.data ?? null;
}

// ---------------------------------------------------------------------------
// Per-item tools
// ---------------------------------------------------------------------------

export async function handleGetPostSEO(client: WordPressClient, params: Params): Promise<unknown> {
  const id = parseId(params);
  return withErrors(`Failed to get SEOPress data for item ${id}`, async () => {
    const titleDescription = await readTitleDescription(client, id);
    const [robots, social, redirect, keywords, output] = await Promise.allSettled([
      read<unknown>(client, `posts/${id}/meta-robot-settings`).then(toFieldMap),
      read<unknown>(client, `posts/${id}/social-settings`).then(toFieldMap),
      read<unknown>(client, `posts/${id}/redirection-settings`).then(toFieldMap),
      readTargetKeywords(client, id),
      readOutput(client, id),
    ]);
    const unavailable = (result: PromiseRejectedResult): string =>
      `- (unavailable: ${result.reason instanceof Error ? result.reason.message : String(result.reason)})`;

    const lines = [
      `**SEOPress data for item ${id}**`,
      "",
      "**Title and description** (empty uses the site's default template)",
      `- **Title:** ${display(titleDescription.title)}`,
      `- **Description:** ${display(titleDescription.description)}`,
      "",
      "**Robots**",
    ];
    if (robots.status === "fulfilled") {
      for (const [param, key] of Object.entries(ROBOTS_FLAGS)) {
        const entry = robots.value.get(key);
        if (!entry) continue;
        const forced = entry.can_modify === false ? " (set by SEOPress global settings, not editable here)" : "";
        lines.push(`- **${param}:** ${checkboxValue(entry.value) ? "yes" : "no"}${forced}`);
      }
      lines.push(`- **canonical:** ${display(normalize(robots.value.get("_seopress_robots_canonical")?.value))}`);
      lines.push(
        `- **primary_category:** ${display(normalize(robots.value.get("_seopress_robots_primary_cat")?.value))}`,
      );
    } else {
      lines.push(unavailable(robots));
    }

    lines.push("", "**Social**");
    if (social.status === "fulfilled") {
      for (const [param, key] of Object.entries(SOCIAL_TEXT_FIELDS)) {
        lines.push(`- **${param}:** ${display(normalize(social.value.get(key)?.value))}`);
      }
      for (const [param, prefix] of Object.entries(SOCIAL_IMAGE_FIELDS)) {
        const url = normalize(social.value.get(`${prefix}_img`)?.value);
        const mediaId = normalize(social.value.get(`${prefix}_img_attachment_id`)?.value);
        lines.push(`- **${param}:** ${mediaId || "(none)"}${url ? ` ${url}` : ""}`);
      }
    } else {
      lines.push(unavailable(social));
    }

    lines.push("", "**Redirect**");
    if (redirect.status === "fulfilled") {
      lines.push(
        `- **enabled:** ${checkboxValue(redirect.value.get("_seopress_redirections_enabled")?.value) ? "yes" : "no"}`,
        `- **url:** ${display(normalize(redirect.value.get("_seopress_redirections_value")?.value))}`,
        `- **type:** ${normalize(redirect.value.get("_seopress_redirections_type")?.value) || "301"}`,
        `- **logged_status:** ${normalize(redirect.value.get("_seopress_redirections_logged_status")?.value) || "both"}`,
      );
    } else {
      lines.push(unavailable(redirect));
    }

    lines.push("", "**Target keywords**");
    lines.push(
      keywords.status === "fulfilled"
        ? `- ${keywords.value.length > 0 ? keywords.value.join(", ") : "(none)"}`
        : unavailable(keywords),
    );

    lines.push("", "**Output** (what SEOPress renders; published items only)");
    if (output.status === "fulfilled" && output.value) {
      lines.push(
        `- **Title:** ${display(normalize(output.value.title))}`,
        `- **Description:** ${display(normalize(output.value.description))}`,
        `- **Canonical:** ${display(normalize(output.value.canonical))}`,
      );
    } else {
      lines.push(output.status === "fulfilled" ? "- (not published)" : unavailable(output));
    }
    return lines.join("\n");
  });
}

export async function handleUpdateTitleDescription(client: WordPressClient, params: Params): Promise<unknown> {
  const id = parseId(params);
  const { title, description } = params as { title?: string; description?: string };
  const sent: Stored = {
    ...(title !== undefined && { title }),
    ...(description !== undefined && { description }),
  };
  if (Object.keys(sent).length === 0) {
    throw new Error("Provide a title, a description, or both.");
  }
  const labels = { title: "title", description: "description" };

  return withErrors(`Failed to update SEOPress metadata for item ${id}`, async () => {
    const previous = await readTitleDescription(client, id);
    await client.put(seopressUrl(client, `posts/${id}/title-description-metas`), sent);
    const stored = await readTitleDescription(client, id);
    assertStored(id, sent, { ...stored }, { ...previous }, labels);

    let result = `✅ SEOPress metadata for item ${id} verified after saving.\n\n${changeLines(sent, { ...previous }, labels)}`;
    const output = await readOutput(client, id).catch(() => null);
    if (output) {
      result += `\n\n**Output:** title ${display(normalize(output.title))}, description ${display(normalize(output.description))}`;
    }
    return result;
  });
}

export async function handleUpdateRobots(client: WordPressClient, params: Params): Promise<unknown> {
  const id = parseId(params);
  const sent: Stored = {};
  for (const [param, key] of Object.entries(ROBOTS_FLAGS)) {
    if (typeof params[param] === "boolean") sent[key] = params[param] ? "yes" : "";
  }
  if (typeof params.canonical === "string") sent._seopress_robots_canonical = params.canonical.trim();
  if (typeof params.primary_category === "number") {
    sent._seopress_robots_primary_cat = params.primary_category > 0 ? String(params.primary_category) : "";
  }
  if (Object.keys(sent).length === 0) {
    throw new Error(
      `Provide at least one of: ${[...Object.keys(ROBOTS_FLAGS), "canonical", "primary_category"].join(", ")}.`,
    );
  }
  const labels = labelsFor({
    ...ROBOTS_FLAGS,
    canonical: "_seopress_robots_canonical",
    primary_category: "_seopress_robots_primary_cat",
  });
  const checkboxes = new Set<string>(Object.values(ROBOTS_FLAGS));
  const keys = Object.keys(sent);

  return withErrors(`Failed to update SEOPress robots settings for item ${id}`, async () => {
    const before = toFieldMap(await read<unknown>(client, `posts/${id}/meta-robot-settings`));
    const locked = keys.filter((key) => before.get(key)?.can_modify === false);
    if (locked.length > 0) {
      throw new Error(
        `${locked.map((key) => labels[key]).join(", ")} is set by SEOPress global settings for this item and ` +
          `cannot be changed per item. Change it with wp_seopress_update_settings (section "titles") instead.`,
      );
    }
    const previous = storedValues(before, keys, checkboxes);
    await client.put(seopressUrl(client, `posts/${id}/meta-robot-settings`), sent);
    const stored = storedValues(
      toFieldMap(await read<unknown>(client, `posts/${id}/meta-robot-settings`)),
      keys,
      checkboxes,
    );
    assertStored(id, sent, stored, previous, labels);
    return `✅ SEOPress robots settings for item ${id} verified after saving.\n\n${changeLines(sent, previous, labels)}`;
  });
}

export async function handleUpdateSocial(client: WordPressClient, params: Params): Promise<unknown> {
  const id = parseId(params);
  const sent: Stored = {};
  for (const [param, key] of Object.entries(SOCIAL_TEXT_FIELDS)) {
    if (typeof params[param] === "string") sent[key] = params[param] as string;
  }
  const labels = labelsFor(SOCIAL_TEXT_FIELDS);

  return withErrors(`Failed to update SEOPress social settings for item ${id}`, async () => {
    for (const [param, prefix] of Object.entries(SOCIAL_IMAGE_FIELDS)) {
      const mediaId = params[param];
      if (typeof mediaId !== "number") continue;
      labels[`${prefix}_img`] = `${param} (URL)`;
      labels[`${prefix}_img_attachment_id`] = param;
      if (mediaId <= 0) {
        Object.assign(sent, {
          [`${prefix}_img`]: "",
          [`${prefix}_img_attachment_id`]: "",
          [`${prefix}_img_width`]: "",
          [`${prefix}_img_height`]: "",
        });
        continue;
      }
      const media = await client.getMediaItem(mediaId);
      if (!media.mime_type?.startsWith("image/")) {
        throw new Error(`Media item ${mediaId} is not an image (${media.mime_type ?? "unknown type"}).`);
      }
      Object.assign(sent, {
        [`${prefix}_img`]: media.source_url,
        [`${prefix}_img_attachment_id`]: String(mediaId),
        [`${prefix}_img_width`]: String(media.media_details?.width ?? ""),
        [`${prefix}_img_height`]: String(media.media_details?.height ?? ""),
      });
    }
    if (Object.keys(sent).length === 0) {
      throw new Error(
        `Provide at least one of: ${[...Object.keys(SOCIAL_TEXT_FIELDS), ...Object.keys(SOCIAL_IMAGE_FIELDS)].join(", ")}.`,
      );
    }

    const keys = Object.keys(sent);
    const previous = storedValues(
      toFieldMap(await read<unknown>(client, `posts/${id}/social-settings`)),
      keys,
      new Set(),
    );
    await client.put(seopressUrl(client, `posts/${id}/social-settings`), sent);
    const stored = storedValues(
      toFieldMap(await read<unknown>(client, `posts/${id}/social-settings`)),
      keys,
      new Set(),
    );
    assertStored(id, sent, stored, previous, labels);
    const reported = Object.fromEntries(Object.entries(sent).filter(([key]) => key in labels));
    return `✅ SEOPress social settings for item ${id} verified after saving.\n\n${changeLines(reported, previous, labels)}`;
  });
}

export async function handleUpdateTargetKeywords(client: WordPressClient, params: Params): Promise<unknown> {
  const id = parseId(params);
  const keywords = (Array.isArray(params.keywords) ? params.keywords : [])
    .map((keyword) => String(keyword).trim())
    .filter((keyword) => keyword !== "");
  if (keywords.some((keyword) => keyword.includes(","))) {
    throw new Error("Keywords cannot contain commas; SEOPress stores them as a comma-separated list.");
  }

  return withErrors(`Failed to update SEOPress target keywords for item ${id}`, async () => {
    const previous = await readTargetKeywords(client, id);
    await client.put(seopressUrl(client, `posts/${id}/target-keywords`), {
      _seopress_analysis_target_kw: keywords.join(","),
    });
    const stored = await readTargetKeywords(client, id);
    if (stored.join(",") !== keywords.join(",")) {
      throw new Error(
        `SEOPress did not store the requested target keywords for item ${id}: sent "${keywords.join(", ")}", ` +
          `stored "${stored.join(", ")}", previously "${previous.join(", ")}".`,
      );
    }
    return (
      `✅ SEOPress target keywords for item ${id} verified after saving.\n\n` +
      `- **Keywords:** ${keywords.length > 0 ? keywords.join(", ") : "(none)"} (was ${previous.length > 0 ? previous.join(", ") : "(none)"})`
    );
  });
}

export async function handleUpdateRedirect(client: WordPressClient, params: Params): Promise<unknown> {
  const id = parseId(params);
  const sent: Stored = {};
  if (typeof params.enabled === "boolean") sent._seopress_redirections_enabled = params.enabled ? "yes" : "";
  if (typeof params.url === "string") sent._seopress_redirections_value = params.url.trim();
  if (typeof params.type === "string") sent._seopress_redirections_type = params.type;
  if (typeof params.logged_status === "string") sent._seopress_redirections_logged_status = params.logged_status;
  if (Object.keys(sent).length === 0) {
    throw new Error("Provide at least one of: enabled, url, type, logged_status.");
  }
  const labels = labelsFor({
    enabled: "_seopress_redirections_enabled",
    url: "_seopress_redirections_value",
    type: "_seopress_redirections_type",
    logged_status: "_seopress_redirections_logged_status",
  });
  const checkboxes = new Set(["_seopress_redirections_enabled"]);
  const keys = Object.keys(sent);

  return withErrors(`Failed to update SEOPress redirect for item ${id}`, async () => {
    const before = toFieldMap(await read<unknown>(client, `posts/${id}/redirection-settings`));
    const previous = storedValues(before, keys, checkboxes);
    const destination =
      sent._seopress_redirections_value ?? normalize(before.get("_seopress_redirections_value")?.value);
    if (sent._seopress_redirections_enabled === "yes" && destination === "") {
      throw new Error("Cannot enable a redirect without a destination url.");
    }

    await client.put(seopressUrl(client, `posts/${id}/redirection-settings`), sent);
    const after = toFieldMap(await read<unknown>(client, `posts/${id}/redirection-settings`));
    const stored = storedValues(after, keys, checkboxes);
    assertStored(id, sent, stored, previous, labels);

    let result = `✅ SEOPress redirect for item ${id} verified after saving.\n\n${changeLines(sent, previous, labels)}`;
    if (checkboxValue(after.get("_seopress_redirections_enabled")?.value)) {
      const test: Record<string, unknown> = await read<Record<string, unknown>>(
        client,
        `posts/${id}/redirection-test`,
      ).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
      result +=
        `\n\n**Redirect test:** ${normalize(test.source_url)} → ${normalize(test.destination_url) || destination}: ` +
        (test.error ? `⚠️ ${normalize(test.error)}` : `HTTP ${normalize(test.status_code ?? test.terminal)}`);
    }
    return result;
  });
}

// ---------------------------------------------------------------------------
// Site-wide tools
// ---------------------------------------------------------------------------

interface PostTypeInfo {
  slug?: string;
  rest_base?: string;
  rest_namespace?: string;
  viewable?: boolean;
}

interface ListedItem {
  id: number;
  title?: { raw?: string; rendered?: string };
  link?: string;
  meta?: Record<string, unknown>;
}

async function contentRestBases(client: WordPressClient, requested: string[] | undefined): Promise<string[]> {
  if (requested && requested.length > 0) return requested;
  const types = await client.get<Record<string, PostTypeInfo>>("types?context=edit");
  return Object.entries(types)
    .filter(([slug, type]) => {
      if (NON_CONTENT_POST_TYPES.has(slug) || !type.rest_base) return false;
      if (type.rest_namespace && type.rest_namespace !== "wp/v2") return false;
      return type.viewable !== false;
    })
    .map(([, type]) => type.rest_base as string);
}

export async function handleListIssues(client: WordPressClient, params: Params): Promise<unknown> {
  const issue = params.issue as "missing_title" | "missing_description" | "missing_title_or_description" | "noindex";
  const status = typeof params.status === "string" ? params.status : "publish";
  const maxItems = Math.min(Math.max(Number(params.max_items ?? 200), 1), 1000);

  return withErrors("Failed to list SEOPress issues", async () => {
    const bases = await contentRestBases(client, params.post_types as string[] | undefined);

    const matches = async (item: ListedItem): Promise<boolean> => {
      const meta = item.meta ?? {};
      if (issue === "noindex") {
        const value =
          "_seopress_robots_index" in meta
            ? meta._seopress_robots_index
            : toFieldMap(await read<unknown>(client, `posts/${item.id}/meta-robot-settings`)).get(
                "_seopress_robots_index",
              )?.value;
        return checkboxValue(value) === "yes";
      }
      const stored =
        "_seopress_titles_title" in meta
          ? { title: normalize(meta._seopress_titles_title), description: normalize(meta._seopress_titles_desc) }
          : await readTitleDescription(client, item.id);
      if (issue === "missing_title") return normalize(stored.title) === "";
      if (issue === "missing_description") return normalize(stored.description) === "";
      return normalize(stored.title) === "" || normalize(stored.description) === "";
    };

    const found: string[] = [];
    let scanned = 0;
    for (const base of bases) {
      for (let page = 1; found.length < maxItems; page++) {
        const response = await client.requestWithMetadata<ListedItem[]>(
          "GET",
          `${base}?status=${encodeURIComponent(status)}&per_page=100&page=${page}&context=edit&_fields=id,title,link,meta`,
        );
        const items = Array.isArray(response.data) ? response.data : [];
        for (const item of items) {
          scanned++;
          if (found.length < maxItems && (await matches(item))) {
            const title = item.title?.raw ?? item.title?.rendered ?? "";
            found.push(`- [${base}] ${item.id} ${display(title)} ${item.link ?? ""}`.trimEnd());
          }
        }
        const totalPages = Number(response.headers?.["x-wp-totalpages"] ?? 1);
        if (items.length === 0 || page >= totalPages) break;
      }
    }

    const note =
      issue === "noindex"
        ? "\n\nOnly items with an explicit per-item noindex are listed. Post types noindexed for the whole site are in the titles settings (wp_seopress_get_settings)."
        : "";
    return (
      `**SEOPress ${issue.replace(/_/g, " ")}: ${found.length}${found.length >= maxItems ? "+" : ""} of ${scanned} scanned ${status} items** ` +
      `(${bases.join(", ")})\n\n${found.join("\n") || "(none)"}${note}`
    );
  });
}

export async function handleGetSettings(client: WordPressClient, params: Params): Promise<unknown> {
  const section = params.section as string;
  if (!(READABLE_SETTINGS_SECTIONS as readonly string[]).includes(section)) {
    throw new Error(`Unknown or restricted settings section "${section}".`);
  }
  return withErrors(`Failed to get SEOPress ${section} settings`, async () => {
    const settings = await read<unknown>(client, `options/${section}-settings`);
    return `**SEOPress ${section} settings**\n\n\`\`\`json\n${JSON.stringify(settings, null, 2)}\n\`\`\``;
  });
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Deep-merges `changes` into `current`; a null value removes the key (unchecks a SEOPress checkbox). */
function mergeSettings(current: Record<string, unknown>, changes: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) {
      delete merged[key];
    } else if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = mergeSettings(merged[key] as Record<string, unknown>, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/** Leaf paths of `changes`, e.g. ["seopress_titles_single_titles", "page", "title"]. */
function changedPaths(changes: Record<string, unknown>, prefix: string[] = []): string[][] {
  return Object.entries(changes).flatMap(([key, value]) =>
    isPlainObject(value) && Object.keys(value).length > 0 ? changedPaths(value, [...prefix, key]) : [[...prefix, key]],
  );
}

const valueAt = (source: unknown, path: string[]): unknown =>
  path.reduce<unknown>((node, key) => (isPlainObject(node) ? node[key] : undefined), source);

/** SEOPress stores options as strings ("1" for a checked box); compare loosely. */
const settingValue = (value: unknown): string =>
  value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);

export async function handleUpdateSettings(client: WordPressClient, params: Params): Promise<unknown> {
  const section = params.section as string;
  const changes = params.changes;
  if (!(WRITABLE_SETTINGS_SECTIONS as readonly string[]).includes(section)) {
    throw new Error(`Settings section "${section}" cannot be written by this tool.`);
  }
  if (!isPlainObject(changes) || Object.keys(changes).length === 0) {
    throw new Error("Provide the settings to change as a non-empty object.");
  }
  if (section === "advanced" && params.confirm_advanced !== true) {
    throw new Error(
      "The advanced section controls SEOPress role restrictions, MCP exposure, and site-wide behavior. Set confirm_advanced to true to change it.",
    );
  }

  return withErrors(`Failed to update SEOPress ${section} settings`, async () => {
    const path = `options/${section}-settings`;
    const raw = await read<unknown>(client, path);
    const current = isPlainObject(raw) ? raw : {};
    // The route replaces the whole option with the request body, so send every
    // existing key; a partial body would erase the settings it leaves out.
    await client.post(seopressUrl(client, path), mergeSettings(current, changes));
    const stored = await read<unknown>(client, path);

    const lines: string[] = [];
    const mismatches: string[] = [];
    for (const leaf of changedPaths(changes)) {
      const sent = settingValue(valueAt(changes, leaf));
      const after = settingValue(valueAt(stored, leaf));
      const before = settingValue(valueAt(current, leaf));
      const name = leaf.join(".");
      if (after !== sent)
        mismatches.push(`- ${name}: sent ${display(sent)}, stored ${display(after)}, previously ${display(before)}`);
      lines.push(
        before === sent
          ? `- **${name}:** unchanged, already ${display(sent)}`
          : `- **${name}:** ${display(sent)} (was ${display(before)})`,
      );
    }
    if (mismatches.length > 0) {
      throw new Error(`SEOPress did not store the requested ${section} settings:\n${mismatches.join("\n")}`);
    }
    return `✅ SEOPress ${section} settings verified after saving.\n\n${lines.join("\n")}`;
  });
}

export async function handleTestSitemap(client: WordPressClient, _params: Params): Promise<unknown> {
  return withErrors("Failed to run the SEOPress sitemap test", async () => {
    const result = await client.post<unknown>(seopressUrl(client, "diagnostics/sitemap-test"));
    return `**SEOPress sitemap test**\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
  });
}
