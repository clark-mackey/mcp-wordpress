# Hosted usage

## Purpose

Optional, failure-isolated PostgreSQL usage events and aggregate reporting for hosted HTTP mode.

## Ownership

Owns environment validation, the argument allowlist, client identification, event types, the bounded writer, schema,
retention, and fixed report queries.

## Local Contracts

- Never place raw headers, result bodies, error messages, credentials, paths, URLs, or non-allowlisted arguments in an
  event. Extend `payload.ts` only for fields that are demonstrably search terms or non-negative identifiers.
- Search text is allowlisted by tool and argument: list tools use `search`, `wp_search_site` uses `term`,
  `wp_seo_track_serp` uses `keywords`, and `wp_seo_keyword_research` uses `seedKeyword`. Metadata-writing tools do not
  contribute search text.
- Store a site ID only after matching it against the configured client map. SDK-rejected calls use `not_dispatched`;
  preserve a tool name only when it is in the catalog.
- Enqueueing must remain synchronous, bounded, and unable to throw into a request. Database startup and batch failures
  must not stop the HTTP server or create retry storms. Keep `init_failures`, `pool_errors`, `failed_batches`, and
  `failed_events` semantically distinct and visible in health/report writer counters.
- Keep report SQL fixed and parameterized. Report access control and `Cache-Control` headers belong to `../app.ts`.
- Search-capable handlers publish an explicit returned count through `server/toolResult.ts`; their client-visible text
  remains unchanged. Report dimensions are capped independently at 100 rows.
- Do not import this subsystem from the stdio startup path unless hosted mode is selected.

## Work Guidance

Inject `UsagePool` in tests; do not require a listening socket or real PostgreSQL.

## Verification

`npm run build && npx vitest run tests/server/http/usage.test.js tests/server/http/app.test.js`

## Child DOX Index

None.
