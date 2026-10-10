/**
 * Shared helpers for tools that call a plugin's own REST namespace (seopress/v1,
 * redirection/v1) rather than core /wp/v2.
 */

import { WordPressClient } from "@/client/api.js";

/** Absolute URL of a plugin REST route; relative endpoints are prefixed with /wp-json/wp/v2. */
export const pluginRestUrl = (client: WordPressClient, namespace: string, path: string): string =>
  `${client.getSiteUrl()}/wp-json/${namespace}/${path}`;

/** Request headers asking caches between the client and WordPress for a fresh response. */
export const NO_CACHE = { headers: { "Cache-Control": "no-cache", Pragma: "no-cache" } };

const PAGE_CACHE_HEADERS = ["x-litespeed-cache", "x-cache", "x-proxy-cache", "cf-cache-status"];

/** The page-cache header reporting a hit, if any, as `name: value`. */
export function pageCacheHit(headers: Record<string, string> | undefined): string | undefined {
  const hit = PAGE_CACHE_HEADERS.find((name) => /^hit/i.test(headers?.[name] ?? ""));
  return hit ? `${hit}: ${headers?.[hit]}` : undefined;
}

/**
 * Some page caches (LiteSpeed Cache) store plugin REST responses to Application Password
 * requests as if anonymous. A cached response shows stale values, so it is an error, never data.
 */
export function assertNotPageCached(headers: Record<string, string> | undefined, path: string): void {
  const hit = pageCacheHit(headers);
  if (hit) {
    throw new Error(
      `The site's page cache answered the request for ${path} (${hit}), so ` +
        "the values WordPress stored cannot be read or verified (a write already sent may have been saved). " +
        "Purge the page cache and " +
        "exclude logged-in REST API responses from it: a cached response to an authenticated request is also " +
        "served to anonymous visitors.",
    );
  }
}

/** GET without the client cache, so a read-back after a write shows what WordPress stored. */
export async function readFresh<T>(client: WordPressClient, url: string, label: string): Promise<T> {
  const response = await client.requestWithMetadata<T>("GET", url, null, NO_CACHE);
  assertNotPageCached(response.headers, label);
  return response.data;
}
