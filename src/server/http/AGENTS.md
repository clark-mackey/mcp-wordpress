# Hosted HTTP transport

## Purpose

Optional stateless HTTP service selected with `MCP_TRANSPORT=http`; stdio remains the default.

## Ownership

Owns `app.ts`, `runtime.ts`, and the transport/auth interface `contract.ts`. Authentication implementation belongs to
`auth/` and must satisfy `HostedAuth`.

## Local Contracts

- Build tool definitions once with shared WordPress clients, prepare filtered registries once per distinct grant, and
  attach their schemas, callbacks, and cached lists to fresh request servers. Exclude `HOSTED_ADMIN_TOOLS` before
  registration and cached list insertion; use `grantAllows` for principal grants.
- Validate Host before every route, including auth and health. Trust one proxy and limit JSON to 1 MB.
- Authenticate POST `/mcp`; GET and DELETE return 405. Close each MCP server/transport when its response closes.
- Hold at most four tool calls per principal. A disconnect does not free a running tool's slot until it finishes.
- Send generic JSON error responses without exception details; log internal failures.
- `/healthz` returns package version and configured site count without WordPress requests.
- Validate `PUBLIC_BASE_URL` and `PORT` before startup; load auth only in HTTP mode. SIGTERM drains HTTP connections for
  at most 25 seconds.

## Work Guidance

Keep `contract.ts` stable across transport and auth changes. Tests inject fake `HostedAuth`; do not require live sites.

## Verification

`npm run build && npx vitest run tests/server/http`

## Child DOX Index

None.
