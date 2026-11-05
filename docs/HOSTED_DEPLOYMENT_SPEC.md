# Spec: Hosted WordPress MCP on Railway

Status: draft for review. Written 2026-11-04 against fork `main` at `dc029a9`.

## Context

A team that edits many client WordPress sites through this MCP server today runs one local copy per person. Two things
are wrong with that:

- **Updates don't reach people.** Each person installs and pins their own copy, so fixes and new tools (partial reads,
  `wp_edit_content`, `wp_rest_get`, strict arguments, default site) reach them only when they reinstall.
- **Every install holds every site's password.** Each local install carries the full multi-site config, so offboarding
  one person means rotating every site's application password.

Hosting one copy on Railway fixes both: one deploy updates everyone, and the passwords live only on the server. People
connect from Claude.ai, Claude desktop, Claude Code, Codex, or any other MCP client the operator adds to the redirect
allowlist, with no local install.

## Current State (verified 2026-11-04)

| Item             | Today                                                                                                                 | Evidence                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Transport        | stdio only                                                                                                            | `src/index.ts:94` creates `StdioServerTransport`; no HTTP server anywhere in `src/`        |
| Site config      | file only: `MCP_WORDPRESS_CONFIG`, `~/.config/mcp-wordpress/config.json`, `~/mcp-wordpress.config.json`, install dir  | `src/config/ServerConfiguration.ts:186-220`                                                |
| WordPress logins | typically one application-password login per site, shared by the team                                                 | multi-site config shape                                                                    |
| Uploads          | `wp_upload_media` reads `file_path` from local disk under `MCP_UPLOAD_BASE_DIR`                                       | `src/tools/media.ts:113,234-239`                                                           |
| Tools            | 90, all exposed to every user                                                                                         | `tools/list` smoke test, 2026-11-04                                                        |
| Who-did-what     | none: every edit is the one shared WordPress user                                                                     | above                                                                                      |
| Install          | `npm i -g mcp-wordpress` per person, with a local multi-site config file                                              | `README.md`                                                                                |
| Container        | `Dockerfile` exists: node 22 alpine, non-root, `CMD node dist/index.js`                                               | `Dockerfile:1-103`                                                                         |
| SDK              | `@modelcontextprotocol/sdk` 1.32.1 ships `StreamableHTTPServerTransport` and `mcpAuthRouter` (OAuth 2.1 + DCR + PKCE) | `node_modules/@modelcontextprotocol/sdk/dist/esm/server/{streamableHttp,auth/router}.d.ts` |

## Decisions (2026-11-04)

1. **Login: passcode pairing.** Each person gets a personal passcode. Connecting from Claude.ai opens a page that asks
   for it once; the server then issues OAuth tokens. Codex and Claude Code can send the passcode directly as a bearer
   token.
2. **Uploads: from a public URL.** `wp_upload_media` gains `source_url`; the server downloads and uploads it. Local-file
   uploads stay available only in the local (stdio) install.
3. **Tools: admin tools off for everyone, the rest per person.** The 8 admin tools listed under "Authorization" are
   never registered in hosted mode. Each person has an allow or deny list for the remaining 82.
4. **Who edited: server log only.** Keep the one shared WordPress login. The server logs each tool call with the person,
   tool, site and result.

Design choices made in this spec (change them in review if wrong):

5. **No database.** OAuth client registrations, access tokens and refresh tokens are signed tokens (HS256, `jose`), each
   with its own type and audience, so a redeploy logs nobody out and there is nothing to store. Only one-time
   authorization codes live in memory (10-minute life). Revocation is per person (rotate their passcode or remove them),
   not per token, which fits a small team.
6. **Stateless HTTP.** Each MCP request gets a fresh `McpServer` and transport for the signed-in person. Tool objects,
   their schemas and the `tools/list` response are built once per process and once per distinct tool set, then reused,
   so a request does not rebuild 90 schemas. `WordPressClient` instances (one per site) are shared, so the cache is
   shared. No session affinity; restarts drop nothing.
7. **Its own Railway service.** This server holds write access to client sites, so it runs alone, not inside another
   service, so a bug elsewhere can't expose it. Own domain.
8. **One replica.** `wp_edit_content` reads, edits and writes back the whole body. In hosted mode a per-page lock
   (site + post type + id) stops two hosted edits to the same page from overwriting each other within one call. The lock
   is in-process, so `numReplicas` stays 1 and deploy overlap is 0. It does not protect against edits from WP admin,
   from a local install, or a model that reads in one call and writes the whole body in a later one.
9. **Stdio stays the default.** `MCP_TRANSPORT=http` turns on hosted mode. Local installs and plugin bundles keep
   working unchanged and are the fallback if the hosted server is down.

## Proposed Change

```
Claude.ai / desktop ──OAuth──┐
Claude Code / Codex ─bearer──┤   Railway service "wordpress-mcp" (1 replica)
                             ▼
              ┌──────────────────────────────────────────────┐
              │ express                                      │
              │  /.well-known/* /register /authorize /token  │  mcpAuthRouter + PasscodeOAuthProvider
              │  POST /authorize/passcode                    │  passcode form submit
              │  /mcp  (requireBearerAuth)                   │  → principal
              │        └─ per request: McpServer             │
              │              + ToolRegistry(allowed tools)   │
              │              + audit wrapper                 │
              │  /healthz                                    │
              └──────────────────┬───────────────────────────┘
                                 │ shared WordPressClient per site (cache shared)
                                 ▼
                       client WordPress sites (REST, app password)
```

### Configuration (hosted mode only)

| Env var                          | Required       | Meaning                                                                                                                                                                                                                                                     |
| -------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_TRANSPORT`                  | yes            | `http` turns on hosted mode. Unset or `stdio` keeps today's behavior.                                                                                                                                                                                       |
| `PORT`                           | yes            | Railway sets it.                                                                                                                                                                                                                                            |
| `PUBLIC_BASE_URL`                | yes            | e.g. `https://wordpress-mcp.up.railway.app`. Used for OAuth metadata and the allowed `Host`. Startup fails without it.                                                                                                                                      |
| `MCP_WORDPRESS_CONFIG_JSON`      | yes            | The multi-site config JSON (same shape as `mcp-wordpress.config.json`). New source, checked before the file sources; never written to disk.                                                                                                                 |
| `MCP_OAUTH_SIGNING_KEY`          | yes            | ≥32 random bytes, base64. Rotating it signs everyone out. Startup fails if shorter.                                                                                                                                                                         |
| `MCP_OAUTH_REDIRECT_ALLOWLIST`   | no             | The complete list of apps allowed to sign in, as redirect URIs, comma-separated. Unset means the defaults listed under Authentication. When set, it replaces the defaults, so keep the Claude entries in it. Entry rules under "Adding or removing an app". |
| `MCP_PRINCIPALS_JSON`            | yes            | Who can sign in and which tools they get. Shape below.                                                                                                                                                                                                      |
| `MCP_PASSCODE_<PRINCIPAL>`       | one per person | That person's passcode, made by `npm run passcode` (32 random bytes, base64url, 43 characters). `<PRINCIPAL>` is the upper-cased id. A principal without one cannot sign in.                                                                                |
| `MCP_WORDPRESS_ALLOW_MULTI_SITE` | yes            | `true`, as today.                                                                                                                                                                                                                                           |
| `MCP_WORDPRESS_DEFAULT_SITE`     | no             | Unset in hosted mode (each person picks the site).                                                                                                                                                                                                          |

`MCP_PRINCIPALS_JSON`:

```json
{
  "admin": { "tools": "all" },
  "editor": { "deny": ["wp_delete_page", "wp_delete_post", "wp_delete_media"] },
  "reviewer": { "allow": ["wp_get_page", "wp_list_pages", "wp_edit_content", "wp_search_site"] }
}
```

Exactly one of `tools: "all"`, `allow`, or `deny` per person. Ids match `^[a-z][a-z0-9_]{1,31}$`.

Startup fails, naming the problem, on any of: unknown key; unknown tool name; admin tool name; a principal with no
passcode; an `MCP_PASSCODE_*` with no principal; two principals with the same passcode (otherwise sign-ins would be
credited to the wrong person and could get the wrong tools); a passcode shorter than 43 characters or equal to the
signing key; `PUBLIC_BASE_URL` that is not `https://` or has a path.

### Authentication

`src/server/http/PasscodeOAuthProvider.ts` implements the SDK's `OAuthServerProvider`.

Signed values (all HS256 with `MCP_OAUTH_SIGNING_KEY`, verified with `algorithms: ["HS256"]`, `iss` =
`PUBLIC_BASE_URL`). Each verifier rejects any other `typ`:

| Value                 | `typ`     | `aud`                 | Claims                                                       | Life    |
| --------------------- | --------- | --------------------- | ------------------------------------------------------------ | ------- |
| `client_id`           | `client`  | `register`            | `redirect_uris`, `client_name`                               | none    |
| Authorize transaction | `authz`   | `authorize`           | `cid`, `redirect_uri`, `state`, `code_challenge`, `resource` | 10 min  |
| Access token          | `access`  | `PUBLIC_BASE_URL/mcp` | `sub` (principal), `cid`, `pv`                               | 1 hour  |
| Refresh token         | `refresh` | `token`               | `sub`, `cid`, `pv`                                           | 30 days |

`pv` is the first 16 hex characters of `HMAC-SHA256(signing key, passcode)`: it changes when the passcode changes and
reveals nothing about the passcode.

| Piece                      | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client registration (DCR)  | Public clients only: `token_endpoint_auth_method: "none"`, PKCE required, no client secret is ever issued. Every redirect URI must be on the allowlist, else `invalid_redirect_uri`. Default allowlist (used when `MCP_OAUTH_REDIRECT_ALLOWLIST` is unset): `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`, `http://localhost:*` and `http://127.0.0.1:*` (Claude desktop, Claude Code, Codex, and other local agents).                                                                                                              |
| `/authorize`               | Verifies the client, that `redirect_uri` is one it registered, and that it is still on the current allowlist (so removing an app takes effect for clients registered before the change), then renders the passcode form. The form shows the redirect host in large text ("You are signing in to: claude.ai") and carries only the signed authorize transaction, so the submit can't be tampered with. Headers: `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`. |
| `POST /authorize/passcode` | Verifies the transaction token, recomputes HMACs and compares with `crypto.timingSafeEqual` against every principal. On match: random 32-byte code stored in memory with principal, client, redirect URI, PKCE challenge and 10-minute expiry; HTTP 302 to the redirect URI with `code` and `state`. On miss: re-render with a generic error, HTTP 401.                                                                                                                                                                                                                     |
| `/token` (code)            | Code is single-use (deleted on first lookup, even if the exchange then fails) and must match the client and redirect URI. Issues an access and refresh token.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `/token` (refresh)         | Checks `typ`, signature, expiry, that `cid` is the calling client, that `pv` matches the person's current passcode, that the person still exists, and that the client's registered redirect URI is still on the current allowlist; issues a new pair.                                                                                                                                                                                                                                                                                                                       |
| Bearer check on `/mcp`     | Accepts an access token (`typ: access`, current `pv`) or a raw passcode (for Codex and Claude Code). The passcode path returns `AuthInfo` with `expiresAt` = now + 60 s, because the SDK's `requireBearerAuth` rejects any token without one (`bearerAuth.js:46`). Anything else → 401 with `WWW-Authenticate` pointing at the protected-resource metadata, so Claude.ai starts OAuth.                                                                                                                                                                                      |
| Guessing limits            | 10 failed passcode or bearer checks per IP per 15 minutes across `/authorize/passcode`, `/token` and `/mcp` (`express-rate-limit`), then 429. Each failure is logged.                                                                                                                                                                                                                                                                                                                                                                                                       |
| Revocation                 | Change or remove a person's passcode (or entry) and redeploy: their `pv` no longer matches, so every token they hold fails at once.                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Use `mcpAuthRouter`, `requireBearerAuth` and the SDK's PKCE and metadata handlers; write only the provider, the passcode
route and the principal lookup. Check in Chrome that the 302 to the Claude.ai callback after the form post is followed
(no `form-action` directive is set, because Chrome applies it to that redirect).

#### Adding or removing an app

The allowlist is editable without a code change: the operator edits `MCP_OAUTH_REDIRECT_ALLOWLIST` in Railway, Railway
redeploys (about a minute), and nobody is signed out because tokens are signed, not stored. Removing an entry blocks new
sign-ins and token refreshes from that app at once; an access token it already holds keeps working until it expires.

Entry forms, checked at startup (a bad entry stops the deploy with the entry named in the error):

- `https://host/path`: exact match on the whole URI. No wildcards in the host or path, no query, no fragment.
- `http://localhost:*` or `http://127.0.0.1:*`: any port and path on the loopback address, for apps that run on the
  person's machine. `http` is allowed only for these two hosts.
- Anything else (`http` on another host, a custom scheme such as `myapp://`, `*` in a host) is refused. A custom scheme
  can be claimed by any app on the machine, so it needs its own decision before it is accepted.

Finding the URI for a new app: a DCR or `/authorize` call refused with `invalid_redirect_uri` writes one log line with
`event: "redirect_refused"` and the full redirect URI (redirect URIs are not secret). The operator tries to connect the
new app once, reads that line in Railway logs, checks the host belongs to the app's vendor, and adds it.

Apps that can send a custom `Authorization` header (most agent harnesses can) can skip OAuth: they send the person's
passcode as a bearer, exactly like Codex, and the allowlist does not apply to them. Hosted apps that only support the
OAuth connector flow need their callback URI on the list. Apps that register through a Client ID Metadata Document
instead of DCR are out of scope; supporting them is a follow-up.

### Authorization

Never registered in hosted mode (8 tools): `wp_create_user`, `wp_update_user`, `wp_delete_user`,
`wp_get_application_passwords`, `wp_create_application_password`, `wp_delete_application_password`,
`wp_switch_auth_method`, `wp_update_site_settings`.

`ToolRegistry` gains an optional filter `(toolName) => boolean`, applied in `registerTool` **before** both the SDK
registration and the push into the cached `tools/list` response (`src/server/ToolRegistry.ts:308-318`); the cache
replaces the SDK's own list handler (`:144-151`), so filtering later would leave denied tools listed. Hosted mode passes
a filter built from the principal's entry; stdio passes none (all tools, no change). A filtered-out tool is not in
`tools/list`, and calling it returns the SDK's unknown-tool error. Both are tested through the HTTP stack.

### Uploads

`wp_upload_media` takes exactly one of `file_path` or `source_url` (both or neither → error naming the two).

`source_url` rules (in `src/utils/safeFetch.ts`):

- `https:` on port 443 only; no user name or password in the URL; system proxy settings ignored.
- Resolve every A and AAAA record; refuse unless **all** of them are public unicast. Use a parsed-address check that
  allows only public ranges, so these are refused: `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`,
  `192.0.0/24`, `192.168/16`, `198.18/15`, `224/4`, `240/4`, `::/128`, `::1`, `fc00::/7` (includes Railway's
  `*.railway.internal`), `fe80::/10`, `ff00::/8`, IPv4-mapped `::ffff:0:0/96` (checked as the IPv4 inside), NAT64
  `64:ff9b::/96`, 6to4 `2002::/16`.
- Connect to the checked address through an undici `Agent` whose `lookup` returns it, so the TLS name check still uses
  the hostname and a DNS change between check and connect can't get around it.
- At most 3 redirects, each checked the same way.
- `Accept-Encoding: identity`; 25 MB cap on the bytes received, enforced while streaming; one 30-second `AbortSignal`
  for the whole fetch.
- Allowed types: JPEG, PNG, GIF, WebP, PDF, MP4, WebM. Never SVG. The type is decided by the existing magic-byte check
  (`src/client/operations/media.ts:83`, `validateMagicBytes`), not the response header. The filename comes from the URL
  path, sanitized, unless `title` is given.
- The tool's error says which rule refused the URL, never the resolved address.

In hosted mode, `file_path` is refused with "Local files can't be uploaded through the hosted server; pass `source_url`,
or use the local install." `MCP_UPLOAD_BASE_DIR` is ignored there.

### Edit lock

In hosted mode, `wp_edit_content`, `wp_update_page` and `wp_update_post` take an in-process lock keyed
`<site id>:<page|post>:<id>` (the key uses the singular type whichever tool takes it) for the read-modify-write,
released in `finally`. A second call on the same key waits (max 30 seconds, then errors "another edit to this page is in
progress"). This only covers two hosted calls racing; see decision 8.

### Usage log

One JSON line per tool call to stdout (Railway keeps it with the service logs):

```json
{
  "evt": "tool_call",
  "ts": "2026-11-04T18:02:11.512Z",
  "principal": "editor",
  "tool": "wp_edit_content",
  "site": "site1",
  "target": "page:123",
  "ok": true,
  "ms": 842,
  "error_code": null
}
```

- `site` is logged only if it is a configured site id, else `"unknown"`; `target` only from a numeric `id`.
- `ok` is false when the tool threw **or** returned an error result (`isError` / `isFailedToolResult`,
  `src/server/ToolRegistry.ts:72-76`).
- `error_code` is one of `null`, `validation`, `not_found`, `permission`, `wordpress_error`, `timeout`, `locked`,
  `upload_refused`, `internal`.
- Sign-in lines: `evt: "auth"`, `principal` or `null`, `ok`, `ip`, `route`.
- Never logged anywhere in the process (usage log, the existing logger, express errors): argument values other than the
  above, content bodies, `source_url`, tokens, passcodes, WordPress response bodies. The express error handler returns a
  generic 500 and logs only the error class and code.
- In stdio mode none of this is written.

Ceiling: Railway keeps logs 7 days on Hobby and 30 on Pro. If a longer history is needed, add a Postgres sink as its own
change.

### Railway

- New service `wordpress-mcp` in your Railway project, built from this repo's `Dockerfile`, command `node dist/index.js`
  with `MCP_TRANSPORT=http`.
- `railway.toml`: `numReplicas = 1`, healthcheck `/healthz`, restart on failure.
- `/healthz` returns 200 with `{"ok":true,"version":"<package version>","sites":<count>}` once the server is listening.
  It does not call WordPress, so one slow client site can't fail the deploy.
- The MCP endpoint is `PUBLIC_BASE_URL/mcp`. `StreamableHTTPServerTransport` runs with `sessionIdGenerator: undefined`
  and DNS-rebinding protection on, allowed host = `PUBLIC_BASE_URL`'s host.
- `app.set("trust proxy", 1)` so rate limiting sees client IPs behind Railway's edge.
- Host check app-wide (every route, not only `/mcp`) with the SDK's `hostHeaderValidation` middleware.
- `GET` and `DELETE /mcp` return 405 (stateless mode has no streams or sessions). The per-request server and transport
  are closed when the response closes.
- Request body limit 1 MB; at most 4 tool calls in flight per person (the 5th gets 429).
- Skip the per-site connection test at startup in hosted mode, so one down client site can't block a deploy.
- On `SIGTERM`, stop accepting requests and let in-flight calls finish (max 25 seconds) before exit.
- Railway project access: only the operator can see this service's variables (they hold every site's application
  password and the signing key).

### Rollout

1. Deploy with only the operator in `MCP_PRINCIPALS_JSON`. Pair Claude.ai, Claude desktop and Codex; run the acceptance
   checks.
2. Add the rest of the team with their passcodes, each handed out privately (one secret per person).
3. Replace the team's local-install instructions with "add the connector" steps for Claude.ai / desktop and Codex. Keep
   the local install documented for two weeks as a fallback.
4. **After everyone is on the hosted server, rotate every site's application password** and put the new ones only in the
   hosted service's variables. Until then, the old passwords still exist on local installs, so the security benefit
   hasn't landed. Rotate one site first and confirm hosted edits still work before doing the rest. Then delete the old
   shared config wherever the team kept it.

## Acceptance Criteria

1. With `MCP_TRANSPORT` unset, the stdio server behaves as on `dc029a9`: same tool set, existing test suite passes
   unchanged.
2. Hosted startup fails with a message naming the variable for each case listed under Configuration (missing or short
   signing key, missing `PUBLIC_BASE_URL` or one with `http://` or a path, bad principals JSON, unknown or admin tool,
   principal without passcode, orphan passcode, duplicate passcode).
3. A Claude.ai custom connector pairs with `PUBLIC_BASE_URL/mcp` using a passcode in Chrome, and `wp_list_pages` on one
   site returns pages.
4. Codex with the passcode as bearer lists tools and calls `wp_get_page`.
5. A wrong passcode returns 401 and a generic error; the 11th failed attempt from one IP within 15 minutes, on any mix
   of `/authorize/passcode`, `/token` and `/mcp`, returns 429.
6. An authorization code works once; a second exchange returns `invalid_grant`. A code exchanged by a different client
   or with a different redirect URI returns `invalid_grant`.
7. DCR with a redirect URI not on the allowlist returns `invalid_redirect_uri` and logs `redirect_refused` with that
   URI. Adding the URI to `MCP_OAUTH_REDIRECT_ALLOWLIST` and redeploying lets the same DCR call succeed; removing it
   again makes `/authorize` refuse a client that registered while it was allowed.
8. A refresh token sent as a bearer to `/mcp`, an access token sent to `/token` as a refresh token, a client id sent as
   either, a token with `alg: none`, and a token with one changed byte each return 401 / `invalid_grant`. A refresh
   token used by a client other than its `cid` returns `invalid_grant`.
9. After a redeploy (a second app instance with the same env), an existing access token and refresh token keep working.
10. After a person's passcode changes, their old access and refresh tokens return 401 / `invalid_grant`.
11. For a principal with `deny: ["wp_delete_page"]`, `tools/list` equals the full tool set minus the 8 admin tools minus
    `wp_delete_page`, and `tools/call wp_delete_page` errors; for `tools: "all"` it equals the full set minus the 8
    admin tools. Counts are computed from the registry, not hard-coded.
12. `wp_upload_media` with `source_url` refuses, before any bytes reach WordPress: `http://`, port 8443, a URL with user
    info, `127.0.0.1`, `169.254.169.254`, `[::ffff:10.0.0.1]`, a host resolving to `10.0.0.5`, a host with one public
    and one private record, a redirect to any of those, a 26 MB body, and an SVG served as `image/png`. A public 200 KB
    JPEG uploads. (Tests inject the resolver.)
13. Two concurrent `wp_edit_content` calls on the same page with different `old_string`s both land (the second sees the
    first's result); on different pages they run in parallel. (Tests use a WordPress mock with injected latency that
    keeps the body between calls.)
14. Each tool call writes exactly one `tool_call` line with the fields above. A test captures all stdout and stderr
    across success, tool error, thrown error, express error and failed sign-in, and finds no content body, `source_url`,
    token or passcode.
15. A request with a `Host` other than `PUBLIC_BASE_URL`'s host is rejected on `/mcp`, `/authorize` and `/token`.
16. The passcode page is served with `frame-ancestors 'none'`, `Referrer-Policy: no-referrer` and
    `Cache-Control: no-store`.
17. The 5th concurrent tool call from one person returns 429; `GET /mcp` returns 405.
18. Each test in the Testing Plan states its card:
    `protects=<observable it protects>; fails_when=<wrong result it rejects>; no_claim=<what green does not prove>`.
19. No degradation of existing functionality: the stdio full suite, lint and typecheck pass.

## Testing Plan

| Layer       | What                                                                                                                                                                                                                                             | Count    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| Unit        | Principal config parsing (all/allow/deny, unknown key, unknown tool, admin tool, bad id)                                                                                                                                                         | +6       |
| Unit        | Signed values: round-trip per type, wrong `typ`/`aud`, expiry, `pv` mismatch, wrong `cid`, `alg: none`, tampered                                                                                                                                 | +9       |
| Unit        | Redirect allowlist: exact https match, loopback any port, defaults when unset, env replaces defaults, refused forms (http non-loopback, custom scheme, host wildcard, query, fragment); duplicate and orphan passcodes; `PUBLIC_BASE_URL` checks | +8       |
| Unit        | `source_url` guard with injected resolver: scheme, port, user info, each blocked range (v4, v6, mapped, NAT64, 6to4), mixed records, redirect re-check, size cap, magic bytes                                                                    | +12      |
| Unit        | Edit lock: same key serializes, different keys parallel, 30-second timeout                                                                                                                                                                       | +3       |
| Unit        | Log line shape and redaction                                                                                                                                                                                                                     | +2       |
| Integration | express app in-process: DCR → authorize form → passcode → token → `/mcp` `tools/list` → refresh                                                                                                                                                  | +1       |
| Integration | Passcode as bearer; wrong passcode 401; shared rate limit 429; code reuse and wrong client `invalid_grant`; bad Host on 3 routes; page headers; 405; concurrency 429                                                                             | +8       |
| Integration | Second app instance accepts first instance's tokens; passcode change revokes                                                                                                                                                                     | +2       |
| Integration | Full-process log capture across 5 paths                                                                                                                                                                                                          | +1       |
| Integration | Tool filtering visible in `tools/list`; filtered tool call errors                                                                                                                                                                                | +2       |
| Integration | Startup validation errors (criterion 2)                                                                                                                                                                                                          | +4       |
| Manual      | Claude.ai connector pairing, Codex bearer, redeploy keeps session (criteria 3, 4, 7)                                                                                                                                                             | 3 checks |

Integration tests use a mocked WordPress (existing client mocks), not live sites.

## Rules for the implementing agent

1. Acceptance criteria are the `protects / fails_when / no_claim` profile of each test: the observable it protects, the
   wrong result it rejects, and what green does not prove. Never "make the tests pass".
2. Real code and real tests land in the same change; a placeholder, a stub assertion or a test deferred to a follow-up
   is not done.
3. Any change to a test, validator, CI step, timeout, tolerance, threshold, snapshot or suppression pragma is reported
   on its own line in your summary with its justification, before any other result.
4. A reported command names the command and its observed result (exit status, counts, the failing line); a command you
   did not run is not reported, and stderr is never silenced in a command you cite.
5. Your report is a claim until the parent re-executes it: say what you verified, what you reused, and what you could
   not check.

## Work Breakdown

| #   | Piece                                                                                                   | Depends on | Effort |
| --- | ------------------------------------------------------------------------------------------------------- | ---------- | ------ |
| 1   | `MCP_WORDPRESS_CONFIG_JSON` source; `ToolRegistry` tool filter                                          | —          | 0.5 d  |
| 2   | HTTP mode: express app, per-request server from memoized tools, `/healthz`, Host check, limits, SIGTERM | 1          | 1 d    |
| 3   | `PasscodeOAuthProvider`, passcode page, principals config and validation, bearer check, guessing limits | 2          | 2 d    |
| 4   | Usage log wrapper                                                                                       | 2          | 0.25 d |
| 5   | `source_url` uploads with address guard                                                                 | —          | 1 d    |
| 6   | Edit lock                                                                                               | —          | 0.25 d |
| 7   | `railway.toml`, Railway service, domain, env vars; pair the operator                                    | 3, 4       | 0.5 d  |
| 8   | Team connect instructions, passcodes to the team                                                        | 7          | 0.5 d  |
| 9   | Rotate every site's application password, delete old shared config                                      | 8          | 0.5 d  |

Total about 6.5 days. 5 and 6 can run alongside 1-3. Ship 1-6 as one fork PR (or 1-4 then 5-6), 7-9 are operations.

```
#1 ──> #2 ──┬─> #3 ──┐
            └─> #4 ──┴─> #7 ──> #8 ──> #9
#5, #6 (independent, before #7)
```

Order matters at the end: rotating passwords (#9) before people move (#8) locks them out; skipping #9 leaves the old
passwords on every local install.

## Rollback

- Code: hosted mode is behind `MCP_TRANSPORT=http`; stdio users are unaffected. Revert the PR if needed.
- Service: if the hosted server misbehaves, people point their clients back at a local install (npm package or a plugin
  bundle). Keep that path documented until two weeks after cutover.
- Before #9, rollback is free. After #9, a rollback means handing the team the new passwords again.

## Files Reference

| File                                                                                | Change                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts:53-104`                                                               | Choose stdio or HTTP from `MCP_TRANSPORT`; HTTP builds clients once and starts express                                                                                                        |
| `src/server/http/app.ts` (new)                                                      | express app: auth router, passcode route, `/mcp`, `/healthz`, Host check                                                                                                                      |
| `src/server/http/PasscodeOAuthProvider.ts` (new)                                    | OAuth provider with signed clients and tokens, in-memory codes                                                                                                                                |
| `src/server/http/principals.ts` (new)                                               | Parse and validate `MCP_PRINCIPALS_JSON` and `MCP_PASSCODE_*`                                                                                                                                 |
| `src/server/http/usageLog.ts` (new)                                                 | `tool_call` / `auth` JSON lines                                                                                                                                                               |
| `src/server/ToolRegistry.ts:96-107`                                                 | Optional tool filter; hook for the usage-log wrapper                                                                                                                                          |
| `src/config/ServerConfiguration.ts:186-220`                                         | `MCP_WORDPRESS_CONFIG_JSON` as first source                                                                                                                                                   |
| `src/tools/media.ts:113,234-239`                                                    | `source_url` and hosted-mode refusal of `file_path`                                                                                                                                           |
| `src/utils/safeFetch.ts` (new)                                                      | Address-checked fetch with redirect and size limits                                                                                                                                           |
| `src/tools/contentEdit.ts`, `src/tools/pages.ts`, `src/tools/posts/PostHandlers.ts` | Edit lock in hosted mode                                                                                                                                                                      |
| `package.json`                                                                      | `express`, `jose` and `undici` as direct dependencies (the first two are already installed via the SDK); a small IP-range library (e.g. `ipaddr.js`) for the address check; `passcode` script |
| `railway.toml` (new)                                                                | One replica, healthcheck, start command                                                                                                                                                       |
| `docs/HOSTED_DEPLOYMENT.md` (new)                                                   | How to run hosted mode and add or remove a person                                                                                                                                             |
| `tests/server/http/*.test.js` (new)                                                 | Tests above                                                                                                                                                                                   |

## Out of Scope

- A WordPress login per person (decided against for now; the usage log covers who-did-what).
- Per-person site lists. Everyone signed in can reach every configured site, as with a local install.
- A database or long-term usage history.
- More than one replica.
- Google or other single sign-on.
- Changing plugin bundles that ship this server (they stay stdio).
- Sharing sign-in with any other service.
- Protecting against a model that reads a page in one call and writes the whole body in a later one, or against WP-admin
  edits (no WordPress REST support for conditional writes).
- Separate per-person tokens for Codex and Claude Code distinct from the pairing passcode.
