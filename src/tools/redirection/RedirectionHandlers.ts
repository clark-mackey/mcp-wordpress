/**
 * Redirection plugin tool handlers (namespace redirection/v1).
 *
 * Redirection's create and update routes rebuild the whole redirect from the request and
 * sanitize it (absolute sources made relative or turned into server matches, percent-encoding
 * decoded, titles stripped), and the create route answers with a list page rather than the
 * new redirect. Every write therefore reads the redirect back without the client GET cache and
 * fails when it differs from the request, reporting the previous values.
 *
 * Only plain URL redirects (match "URL only", action "Redirect to URL") are created or edited
 * here; other kinds are listed but left to wp-admin. Only the redirect and group routes are
 * called: the log, 404, settings, plugin, import, and export routes hold visitor IPs and the
 * log feed token. Redirects are disabled, never deleted.
 */

import { WordPressClient } from "@/client/api.js";
import { WordPressAPIError } from "@/types/client.js";
import { preserveToolError } from "@/utils/error.js";
import { getUserAgent } from "@/utils/version.js";
import { parseId } from "../params.js";
import { pageCacheHit, pluginRestUrl, readFresh } from "../pluginRest.js";

type Params = Record<string, unknown>;

export const REDIRECT_CODES = [301, 302, 307, 308] as const;

/** Redirection's group modules: only WordPress groups redirect without exporting server rules. */
const WORDPRESS_MODULE = 1;

/** A redirect as Redirection's REST API returns it (Red_Item::to_json). */
interface Redirect {
  id: number;
  url: string;
  match_type: string;
  action_type: string;
  action_code: number;
  action_data: { url?: string } | null;
  match_data?: unknown;
  title: string | null;
  hits: number;
  regex: boolean;
  group_id: number;
  position: number;
  last_access: string;
  enabled: boolean;
}

interface Group {
  id: number;
  name: string;
  redirects: number;
  module_id: number;
  moduleName: string;
  enabled: boolean;
}

interface Page<T> {
  items: T[];
  total: number;
}

/** The fields these tools write and verify. */
interface Wanted {
  url: string;
  target: string;
  code: number;
  group_id: number;
  title: string;
  regex: boolean;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const MAX_PER_PAGE = 200;

function redirectionUrl(client: WordPressClient, path: string, query?: Record<string, string | number>): string {
  const url = pluginRestUrl(client, "redirection/v1", path);
  if (!query) return url;
  const search = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
  return `${url}?${search}`;
}

const read = <T>(client: WordPressClient, path: string, query?: Record<string, string | number>): Promise<T> =>
  readFresh<T>(client, redirectionUrl(client, path, query), path);

function asPage<T>(response: unknown): Page<T> {
  const page = response as Partial<Page<T>> | null;
  if (!page || !Array.isArray(page.items)) {
    throw new Error("Unexpected response from the Redirection REST API (no items list).");
  }
  return { items: page.items, total: Number(page.total ?? page.items.length) };
}

/** Filters are Redirection's `filterBy[...]`; `page` is 0-based. */
async function listRedirects(
  client: WordPressClient,
  filters: Record<string, string | number>,
  page = 0,
  perPage = MAX_PER_PAGE,
): Promise<Page<Redirect>> {
  const query: Record<string, string | number> = { page, per_page: perPage };
  for (const [key, value] of Object.entries(filters)) query[`filterBy[${key}]`] = value;
  return asPage<Redirect>(await read<unknown>(client, "redirect", query));
}

/** Every item of a list route, following pages. */
async function allPages<T>(list: (page: number) => Promise<Page<T>>): Promise<T[]> {
  const items: T[] = [];
  for (let page = 0; ; page++) {
    const result = await list(page);
    items.push(...result.items);
    if (result.items.length < MAX_PER_PAGE || items.length >= result.total) return items;
  }
}

/** Every redirect matching the filters. */
const allRedirects = (client: WordPressClient, filters: Record<string, string | number>): Promise<Redirect[]> =>
  allPages((page) => listRedirects(client, filters, page));

async function getRedirect(client: WordPressClient, id: number): Promise<Redirect> {
  const match = (await listRedirects(client, { id }, 0, 5)).items.find((item) => Number(item.id) === id);
  if (!match) throw new Error(`Redirect ${id} was not found.`);
  return match;
}

const listGroups = (client: WordPressClient): Promise<Group[]> =>
  allPages(async (page) => asPage<Group>(await read<unknown>(client, "group", { page, per_page: MAX_PER_PAGE })));

/** Redirection stores sources percent-decoded (rawurldecode). */
function decoded(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

/**
 * Redirection matches sources case-insensitively and ignoring a trailing slash by default,
 * and stores them percent-decoded, so sources that differ only there are the same redirect.
 */
const sourceKey = (url: string): string => {
  const lower = decoded(url).trim().toLowerCase();
  return lower.length > 1 ? lower.replace(/\/+$/, "") : lower;
};

/**
 * Text for Redirection's source search (SQL LIKE on the stored, decoded source), which must also find
 * the source with a trailing slash.
 */
const searchText = (url: string): string => {
  const text = decoded(url);
  return text.length > 1 ? text.replace(/\/+$/, "") : text;
};

const isPlainUrlRedirect = (item: Redirect): boolean => item.match_type === "url" && item.action_type === "url";

const targetOf = (item: Redirect): string => item.action_data?.url ?? "";

const summary = (item: Redirect): string => {
  const kind = isPlainUrlRedirect(item) ? "" : ` [match: ${item.match_type}, action: ${item.action_type}]`;
  const target = isPlainUrlRedirect(item) ? ` → ${targetOf(item) || "(no target)"}` : "";
  return (
    `#${item.id} ${item.url}${item.regex ? " (regex)" : ""} ${item.action_code}${target}${kind} — ` +
    `${item.enabled ? "enabled" : "disabled"}, group ${item.group_id}, ${item.hits} hits` +
    (item.title ? `, "${item.title}"` : "")
  );
};

function requireString(params: Params, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${key} is required.`);
  return value.trim();
}

function parseSource(value: string, regex: boolean): string {
  // Redirection turns any source containing "http:" or "https:" into a server-match redirect.
  if (regex && (value.includes("http:") || value.includes("https:"))) {
    throw new Error(
      `A regex source must not contain an absolute URL (got "${value}"): Redirection turns it into a ` +
        "server-match redirect, which these tools do not manage.",
    );
  }
  if (regex) return value;
  if (!value.startsWith("/") || value.startsWith("//")) {
    throw new Error(
      `source must be a path on this site starting with "/", such as /old-page/ (got "${value}"). ` +
        "Redirection turns absolute URLs on other domains into server-match redirects, which these tools do not manage.",
    );
  }
  return value;
}

function parseTarget(value: string): string {
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return value;
  } catch {
    // Reported below.
  }
  throw new Error(`target must be a path starting with "/" or an http(s) URL (got "${value}").`);
}

function parseCode(params: Params, fallback: number): number {
  if (params.code === undefined) return fallback;
  const code = Number(params.code);
  if (!(REDIRECT_CODES as readonly number[]).includes(code)) {
    throw new Error(`code must be one of ${REDIRECT_CODES.join(", ")} (got ${String(params.code)}).`);
  }
  return code;
}

/** The site path a target points to, or undefined when it leaves the site. */
function sitePath(client: WordPressClient, target: string): string | undefined {
  const site = new URL(client.getSiteUrl());
  const url = new URL(target, site);
  return url.host === site.host ? url.pathname : undefined;
}

async function resolveGroup(client: WordPressClient, requested: unknown): Promise<Group> {
  const groups = await listGroups(client);
  if (requested !== undefined) {
    const id = Number(requested);
    const group = groups.find((item) => Number(item.id) === id);
    if (!group) throw new Error(`Redirection group ${String(requested)} does not exist. List groups first.`);
    return group;
  }
  const group = groups
    .filter((item) => Number(item.module_id) === WORDPRESS_MODULE && item.enabled)
    .sort((a, b) => a.id - b.id)[0];
  if (!group) throw new Error("This site has no enabled WordPress Redirection group. Pass group_id.");
  return group;
}

/**
 * Refuses a source another redirect already handles, and a target that redirects back to the
 * source. Returns a warning when the target is itself redirected (a chain).
 */
async function checkConflicts(client: WordPressClient, wanted: Wanted, selfId?: number): Promise<string | undefined> {
  if (!wanted.regex) {
    const others = await allRedirects(client, { url: searchText(wanted.url) });
    const duplicate = others.find(
      (item) => item.id !== selfId && !item.regex && sourceKey(item.url) === sourceKey(wanted.url),
    );
    if (duplicate) {
      throw new Error(
        `Redirect ${duplicate.id} already handles this source: ${summary(duplicate)}. ` +
          "Update that redirect instead of adding another.",
      );
    }
  }

  const path = sitePath(client, wanted.target);
  if (path === undefined) return undefined;
  if (!wanted.regex && sourceKey(path) === sourceKey(wanted.url)) {
    throw new Error(`The target ${wanted.target} is the source itself; the redirect would loop.`);
  }
  const next = (await allRedirects(client, { url: searchText(path) })).find(
    (item) => item.id !== selfId && item.enabled && !item.regex && sourceKey(item.url) === sourceKey(path),
  );
  if (!next) return undefined;
  const nextPath = sitePath(client, targetOf(next));
  if (!wanted.regex && nextPath !== undefined && sourceKey(nextPath) === sourceKey(wanted.url)) {
    throw new Error(`Redirect ${next.id} sends ${path} back to ${wanted.url}; the redirects would loop.`);
  }
  return `⚠️ The target is itself redirected (${summary(next)}). Point this redirect at the final URL to avoid a chain.`;
}

/** Fields the read-back differs in from what was requested. */
function mismatches(item: Redirect, wanted: Wanted): string[] {
  const checks: Array<[string, unknown, unknown]> = [
    ["source", item.url === decoded(wanted.url) ? wanted.url : item.url, wanted.url],
    ["target", targetOf(item), wanted.target],
    ["code", Number(item.action_code), wanted.code],
    ["group", Number(item.group_id), wanted.group_id],
    ["title", item.title ?? "", wanted.title],
    ["regex", Boolean(item.regex), wanted.regex],
    ["match", item.match_type, "url"],
    ["action", item.action_type, "url"],
  ];
  return checks
    .filter(([, stored, sent]) => stored !== sent)
    .map(([label, stored, sent]) => `- ${label}: sent ${JSON.stringify(sent)}, stored ${JSON.stringify(stored)}`);
}

/** Redirection rebuilds the whole redirect on save, so every field is sent. */
const payload = (wanted: Wanted, current?: Redirect): Record<string, unknown> => ({
  url: wanted.url,
  match_type: "url",
  action_type: "url",
  action_code: wanted.code,
  action_data: { url: wanted.target },
  group_id: wanted.group_id,
  title: wanted.title,
  regex: wanted.regex ? 1 : 0,
  ...(current ? { match_data: current.match_data, position: current.position } : {}),
});

function throwRedirectionError(prefix: string, error: unknown): never {
  if (error instanceof WordPressAPIError && error.statusCode === 404) {
    throw new Error(`${prefix}: the Redirection REST route was not found. Is the Redirection plugin active?`);
  }
  if (error instanceof WordPressAPIError && (error.statusCode === 401 || error.statusCode === 403)) {
    throw new Error(
      `${prefix}: not permitted (${error.message}). Redirection's API needs the capability set by its ` +
        "redirection_role filter (manage_options by default), and a site access policy may block this route.",
    );
  }
  preserveToolError(prefix, error);
}

async function withErrors<T>(prefix: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throwRedirectionError(prefix, error);
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export async function handleListRedirects(client: WordPressClient, params: Params): Promise<unknown> {
  const filters: Record<string, string | number> = {};
  if (typeof params.source === "string" && params.source.trim()) filters.url = params.source.trim();
  if (typeof params.target === "string" && params.target.trim()) filters.target = params.target.trim();
  if (params.status === "enabled" || params.status === "disabled") filters.status = params.status;
  if (params.group_id !== undefined) filters.group = Number(params.group_id);
  const perPage = Math.min(MAX_PER_PAGE, Math.max(5, Math.trunc(Number(params.per_page ?? 50)) || 50));
  const page = Math.max(1, Math.trunc(Number(params.page ?? 1)) || 1);

  return withErrors("Failed to list Redirection redirects", async () => {
    const result = await listRedirects(client, filters, page - 1, perPage);
    if (result.items.length === 0) {
      return result.total > 0 ? `No redirects on page ${page} (${result.total} in total).` : "No redirects found.";
    }
    const first = (page - 1) * perPage + 1;
    return [
      `**Redirects ${first}–${first + result.items.length - 1} of ${result.total}**`,
      "",
      ...result.items.map((item) => `- ${summary(item)}`),
    ].join("\n");
  });
}

export async function handleListGroups(client: WordPressClient, _params: Params): Promise<unknown> {
  return withErrors("Failed to list Redirection groups", async () => {
    const groups = await listGroups(client);
    if (groups.length === 0) return "No Redirection groups found.";
    return [
      "**Redirection groups**",
      "",
      ...groups.map(
        (group) =>
          `- #${group.id} ${group.name} — ${group.moduleName || `module ${group.module_id}`}, ` +
          `${group.enabled ? "enabled" : "disabled"}, ${group.redirects} redirects`,
      ),
    ].join("\n");
  });
}

export async function handleCreateRedirect(client: WordPressClient, params: Params): Promise<unknown> {
  const regex = params.regex === true;
  const url = parseSource(requireString(params, "source"), regex);
  const target = parseTarget(requireString(params, "target"));
  const code = parseCode(params, 301);
  const title = typeof params.title === "string" ? params.title.trim() : "";

  return withErrors(`Failed to create the redirect from ${url}`, async () => {
    const group = await resolveGroup(client, params.group_id);
    const wanted: Wanted = { url, target, code, group_id: Number(group.id), title, regex };
    const warning = await checkConflicts(client, wanted);
    const newestBefore = Number((await listRedirects(client, {}, 0, 5)).items[0]?.id ?? 0);

    const response = asPage<Redirect>(await client.post<unknown>(redirectionUrl(client, "redirect"), payload(wanted)));
    const created = response.items.filter((item) => Number(item.id) > newestBefore);
    if (created.length !== 1) {
      throw new Error(
        `Redirection answered without ${created.length === 0 ? "a new redirect" : "a single new redirect"}. ` +
          "Check the redirects list before retrying, so the redirect is not added twice.",
      );
    }
    const stored = await getRedirect(client, Number(created[0]!.id));
    const problems = mismatches(stored, wanted);
    if (!stored.enabled) problems.push("- enabled: sent true, stored false");
    if (problems.length > 0) {
      throw new Error(
        `Redirect ${stored.id} was created but not stored as requested:\n${problems.join("\n")}\n` +
          "Correct it with wp_redirection_update_redirect or disable it with wp_redirection_set_enabled.",
      );
    }
    return [
      `✅ Redirect ${stored.id} created and verified: ${summary(stored)}`,
      `Group: ${group.name}${Number(group.module_id) === WORDPRESS_MODULE ? "" : ` (${group.moduleName}: takes effect only after its server rules are exported)`}`,
      ...(warning ? ["", warning] : []),
    ].join("\n");
  });
}

export async function handleUpdateRedirect(client: WordPressClient, params: Params): Promise<unknown> {
  const id = parseId(params);
  if (["source", "target", "code", "title", "group_id"].every((key) => params[key] === undefined)) {
    throw new Error("Provide at least one of: source, target, code, title, group_id.");
  }

  return withErrors(`Failed to update redirect ${id}`, async () => {
    const current = await getRedirect(client, id);
    if (!isPlainUrlRedirect(current)) {
      throw new Error(
        `Redirect ${id} is not a plain URL redirect (match: ${current.match_type}, action: ${current.action_type}); ` +
          "edit it in wp-admin under Tools > Redirection.",
      );
    }
    const regex = Boolean(current.regex);
    const wanted: Wanted = {
      url: params.source === undefined ? current.url : parseSource(requireString(params, "source"), regex),
      target: params.target === undefined ? targetOf(current) : parseTarget(requireString(params, "target")),
      code: parseCode(params, Number(current.action_code)),
      group_id:
        params.group_id === undefined
          ? Number(current.group_id)
          : Number((await resolveGroup(client, params.group_id)).id),
      title: typeof params.title === "string" ? params.title.trim() : (current.title ?? ""),
      regex,
    };
    const warning =
      wanted.url !== current.url || wanted.target !== targetOf(current)
        ? await checkConflicts(client, wanted, id)
        : undefined;

    await client.post<unknown>(redirectionUrl(client, `redirect/${id}`), payload(wanted, current));
    const stored = await getRedirect(client, id);
    const problems = mismatches(stored, wanted);
    if (problems.length > 0) {
      throw new Error(
        `Redirect ${id} was not stored as requested:\n${problems.join("\n")}\nPreviously: ${summary(current)}`,
      );
    }
    return [
      `✅ Redirect ${id} updated and verified: ${summary(stored)}`,
      `Previously: ${summary(current)}`,
      ...(warning ? ["", warning] : []),
    ].join("\n");
  });
}

export async function handleSetEnabled(client: WordPressClient, params: Params): Promise<unknown> {
  const id = parseId(params);
  if (typeof params.enabled !== "boolean") throw new Error("enabled must be true or false.");
  const enabled = params.enabled;

  return withErrors(`Failed to ${enabled ? "enable" : "disable"} redirect ${id}`, async () => {
    const current = await getRedirect(client, id);
    if (current.enabled === enabled)
      return `Redirect ${id} is already ${enabled ? "enabled" : "disabled"}: ${summary(current)}`;
    await client.post<unknown>(redirectionUrl(client, `bulk/redirect/${enabled ? "enable" : "disable"}`), {
      items: [id],
    });
    const stored = await getRedirect(client, id);
    if (stored.enabled !== enabled) {
      throw new Error(`Redirection did not ${enabled ? "enable" : "disable"} redirect ${id}: ${summary(stored)}`);
    }
    return `✅ Redirect ${id} ${enabled ? "enabled" : "disabled"} and verified: ${summary(stored)}`;
  });
}

/**
 * Requests a path on the site anonymously, without following redirects, and reports what a
 * visitor gets. No credentials are sent: this is the public response.
 */
export async function handleCheckRedirect(client: WordPressClient, params: Params): Promise<unknown> {
  const path = requireString(params, "path");
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error(`path must start with "/", such as /old-page/ (got "${path}").`);
  }
  const site = new URL(client.getSiteUrl());
  const url = new URL(path, site);
  // The URL parser reads a backslash as "/" and drops tabs and newlines, so such paths can leave the site.
  if (url.origin !== site.origin) {
    throw new Error(`path must stay on this site (got "${path}", which resolves to ${url.origin}).`);
  }
  const expectedCode = params.expected_code === undefined ? undefined : Number(params.expected_code);
  if (expectedCode !== undefined && !Number.isInteger(expectedCode)) {
    throw new Error(`expected_code must be an HTTP status such as 301 (got ${String(params.expected_code)}).`);
  }
  const expectedTarget =
    typeof params.expected_target === "string" && params.expected_target.trim()
      ? new URL(params.expected_target.trim(), site).href
      : undefined;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": getUserAgent(), "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw new Error(`Failed to request ${url.href}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  await response.body?.cancel();
  let location: string | undefined;
  if (headers.location) {
    try {
      location = new URL(headers.location, url).href;
    } catch {
      location = headers.location;
    }
  }

  const lines = [
    `**${url.href}** → HTTP ${response.status}${location ? ` to ${location}` : ""}`,
    ...(headers["x-redirect-by"] ? [`- Redirected by: ${headers["x-redirect-by"]}`] : []),
  ];
  const cached = pageCacheHit(headers);
  if (cached) lines.push(`- Served from the page cache (${cached}); purge it if this response is out of date.`);

  const failures: string[] = [];
  if (expectedCode !== undefined && response.status !== expectedCode) {
    failures.push(`expected HTTP ${expectedCode}, got ${response.status}`);
  }
  if (expectedTarget !== undefined && location !== expectedTarget) {
    failures.push(`expected a redirect to ${expectedTarget}, got ${location ?? "no redirect"}`);
  }
  if (failures.length > 0) throw new Error(`Redirect check failed: ${failures.join("; ")}.\n${lines.join("\n")}`);
  return (
    (expectedCode !== undefined || expectedTarget !== undefined ? "✅ Redirect check passed.\n" : "") + lines.join("\n")
  );
}
