/**
 * Contract between the hosted HTTP transport (src/server/http/app.ts) and hosted authentication
 * (src/server/http/auth/). See docs/HOSTED_DEPLOYMENT_SPEC.md.
 */
import type { Express, RequestHandler } from "express";

/** Which tools a principal may call. Admin tools are never registered in hosted mode regardless of the grant. */
export type ToolGrant =
  | { readonly all: true }
  | { readonly allow: readonly string[] }
  | { readonly deny: readonly string[] };

export interface Principal {
  readonly id: string;
  readonly tools: ToolGrant;
}

export interface HostedAuthOptions {
  /** https origin with no path; the OAuth issuer and the only allowed Host. */
  readonly publicBaseUrl: URL;
  /** Reads MCP_OAUTH_SIGNING_KEY, MCP_OAUTH_REDIRECT_ALLOWLIST, MCP_PRINCIPALS_JSON and MCP_PASSCODE_<PRINCIPAL>. */
  readonly env: NodeJS.ProcessEnv;
  /** Every tool name the server can register, used to reject unknown names in allow/deny lists. */
  readonly knownToolNames: readonly string[];
}

export interface HostedAuth {
  /** Mounts OAuth metadata, /register, /authorize, /authorize/passcode and /token at the app root. */
  install(app: Express): void;
  /**
   * Bearer check for /mcp. On success sets `req.auth` (SDK AuthInfo) and `res.locals.principal` (Principal), then
   * calls next(). Otherwise responds 401 with a WWW-Authenticate header pointing at the protected-resource metadata.
   */
  readonly requireAuth: RequestHandler;
  readonly principals: ReadonlyMap<string, Principal>;
}

/** Implemented by src/server/http/auth/index.ts. Throws an Error naming the offending variable on bad config. */
export type CreateHostedAuth = (options: HostedAuthOptions) => HostedAuth;

/** Never registered in hosted mode. */
export const HOSTED_ADMIN_TOOLS = [
  "wp_create_user",
  "wp_update_user",
  "wp_delete_user",
  "wp_get_application_passwords",
  "wp_create_application_password",
  "wp_delete_application_password",
  "wp_switch_auth_method",
  "wp_update_site_settings",
] as const;

/** True when a principal's grant allows the tool. Admin tools are excluded separately. */
export function grantAllows(grant: ToolGrant, toolName: string): boolean {
  if ("all" in grant) return true;
  if ("allow" in grant) return grant.allow.includes(toolName);
  return !grant.deny.includes(toolName);
}
