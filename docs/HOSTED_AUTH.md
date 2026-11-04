# Hosted authentication

`createHostedAuth` in `src/server/http/auth/index.ts` implements the shared HTTP authentication contract. The HTTP
transport supplies an HTTPS origin and known tool names, calls `install(app)`, and mounts `requireAuth` on `/mcp`. Stdio
authentication is unchanged. See [the deployment spec](HOSTED_DEPLOYMENT_SPEC.md) for the transport design.

## Configuration

- `MCP_OAUTH_SIGNING_KEY`: base64 encoding of at least 32 random bytes. Keep it stable across redeploys. Rotating it
  invalidates every signed client registration and token.
- `MCP_PRINCIPALS_JSON`: a nonempty object keyed by IDs matching `^[a-z][a-z0-9_]{1,31}$`. Each value is exactly one of
  `{ "tools": "all" }`, `{ "allow": ["wp_get_page"] }`, or `{ "deny": ["wp_delete_page"] }`. Unknown keys, unknown tools
  and admin tool names fail startup. The transport excludes admin tools for everyone.
- `MCP_PASSCODE_<ID>`: one unique passcode per principal, with the ID upper-cased. Run `npm run passcode` to generate 32
  random bytes as 43 base64url characters, then deliver it privately. Passcodes shorter than 43 characters, equal to the
  signing key, duplicated, orphaned or missing fail startup. No credentials are written to disk by this module.
- `MCP_OAUTH_REDIRECT_ALLOWLIST`: optional comma-separated complete replacement of the defaults. Defaults are
  `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`, `http://localhost:*`, and
  `http://127.0.0.1:*`.

The supplied public base URL must be an HTTPS origin with no path, credentials, query or fragment.

## Sign in and revoke

OAuth apps dynamically register as public clients (`token_endpoint_auth_method: "none"`) and use S256 PKCE. The passcode
form shows the destination host. Access tokens last one hour; refresh tokens last 30 days. Authorization transactions
and single-use codes last 10 minutes. Client registrations and signed tokens survive a restart with the same key and
configuration. Authorization codes are kept only in memory, so an in-flight exchange must restart after a process
restart.

CLI agents may send the person's raw passcode as `Authorization: Bearer <passcode>`. All failed sign-in checks share 10
failures per IP per 15 minutes; further checks return 429. Failures produce credential-free JSON audit lines.

Change a person's passcode or remove the principal and its passcode, then redeploy to revoke their access and refresh
tokens. Changing the tool grant is applied by the transport when it next resolves the current principal.

## Add or remove an app

Try its connection once and inspect the `redirect_refused` JSON event for the requested URI. Verify the vendor's host,
then add the URI to `MCP_OAUTH_REDIRECT_ALLOWLIST` and redeploy. Keep every existing desired entry, including the
default callbacks, because this setting replaces defaults.

HTTPS URIs match the entire string exactly. Queries, fragments, credentials and wildcards are refused. The only HTTP
entries are `http://localhost:*` and `http://127.0.0.1:*`, each permitting any port and path for that host. Custom
schemes and host wildcards are refused. Malformed entries stop startup with the variable and entry position identified.

Remove an entry and redeploy to block authorization and refresh for that app, including clients registered before
removal. Existing access tokens remain valid until expiry. Apps using raw passcodes do not use the redirect allowlist.
