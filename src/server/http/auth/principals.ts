import { createHmac, timingSafeEqual } from "node:crypto";
import { HOSTED_ADMIN_TOOLS, type HostedAuthOptions, type Principal, type ToolGrant } from "../contract.js";

export interface AuthConfiguration {
  key: Buffer;
  principals: ReadonlyMap<string, Principal>;
  versions: ReadonlyMap<string, string>;
  matchPasscode(value: string): string | undefined;
  redirectAllowed(uri: string): boolean;
}

function fail(variable: string, detail: string): never {
  throw new Error(`${variable}: ${detail}`);
}

export function redirectAllowlist(raw: string | undefined): (uri: string) => boolean {
  const entries =
    raw === undefined
      ? [
          "https://claude.ai/api/mcp/auth_callback",
          "https://claude.com/api/mcp/auth_callback",
          "http://localhost:*",
          "http://127.0.0.1:*",
        ]
      : raw.split(",").map((entry) => entry.trim());
  const loopbacks = ["http://localhost:*", "http://127.0.0.1:*"];
  for (const entry of entries) {
    if (loopbacks.includes(entry)) continue;
    try {
      const uri = new URL(entry);
      if (
        uri.protocol !== "https:" ||
        uri.username ||
        uri.password ||
        entry.includes("?") ||
        entry.includes("#") ||
        entry.includes("*") ||
        uri.hostname.includes("*") ||
        entry.includes("\\")
      )
        throw new Error();
    } catch {
      // Never reflect credentials from malformed configuration values.
      fail("MCP_OAUTH_REDIRECT_ALLOWLIST", `invalid entry at position ${entries.indexOf(entry) + 1}`);
    }
  }
  return (value) => {
    try {
      const uri = new URL(value);
      if (
        uri.username ||
        uri.password ||
        value.includes("?") ||
        value.includes("#") ||
        value.includes("*") ||
        value.includes("\\")
      )
        return false;
      if (uri.protocol === "https:") return entries.includes(value);
      return (
        /^http:\/\/(localhost|127\.0\.0\.1)(?::[0-9]+)?(?:\/|$)/i.test(value) &&
        uri.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(uri.hostname) &&
        entries.includes(`http://${uri.hostname}:*`)
      );
    } catch {
      return false;
    }
  };
}

export function parseConfiguration(options: HostedAuthOptions): AuthConfiguration {
  const { env, publicBaseUrl, knownToolNames } = options;
  if (
    !publicBaseUrl ||
    publicBaseUrl.protocol !== "https:" ||
    publicBaseUrl.pathname !== "/" ||
    publicBaseUrl.search ||
    publicBaseUrl.hash ||
    publicBaseUrl.username ||
    publicBaseUrl.password
  )
    fail("PUBLIC_BASE_URL", "must be an https origin");
  const signingKey = env.MCP_OAUTH_SIGNING_KEY;
  if (!signingKey || !/^[A-Za-z0-9+/]+={0,2}$/.test(signingKey) || Buffer.from(signingKey, "base64").length < 32)
    fail("MCP_OAUTH_SIGNING_KEY", "must encode at least 32 bytes as base64");
  const key = Buffer.from(signingKey, "base64");
  const digest = (value: string): Buffer => createHmac("sha256", key).update(value).digest();
  const principals = new Map<string, Principal>();
  const hashes = new Map<string, Buffer>();
  const versions = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.MCP_PRINCIPALS_JSON ?? "");
  } catch {
    fail("MCP_PRINCIPALS_JSON", "invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Object.keys(parsed).length)
    fail("MCP_PRINCIPALS_JSON", "must be a nonempty object");
  for (const [id, grant] of Object.entries(parsed)) {
    if (!/^[a-z][a-z0-9_]{1,31}$/.test(id)) fail("MCP_PRINCIPALS_JSON", "invalid principal id");
    if (!grant || typeof grant !== "object" || Array.isArray(grant) || Object.keys(grant).length !== 1)
      fail("MCP_PRINCIPALS_JSON", "exactly one grant required");
    const [field] = Object.keys(grant);
    const value: unknown = (grant as Record<string, unknown>)[field];
    let tools: ToolGrant;
    if (field === "tools" && value === "all") tools = { all: true };
    else if (
      (field === "allow" || field === "deny") &&
      Array.isArray(value) &&
      value.every((name) => typeof name === "string")
    ) {
      for (const name of value) {
        if (!knownToolNames.includes(name)) fail("MCP_PRINCIPALS_JSON", "unknown tool name");
        if ((HOSTED_ADMIN_TOOLS as readonly string[]).includes(name)) fail("MCP_PRINCIPALS_JSON", "admin tool name");
      }
      tools = field === "allow" ? { allow: Object.freeze([...value]) } : { deny: Object.freeze([...value]) };
    } else fail("MCP_PRINCIPALS_JSON", "invalid grant or unknown key");
    const variable = `MCP_PASSCODE_${id.toUpperCase()}`;
    const passcode = env[variable];
    if (!passcode || passcode.length < 43) fail(variable, "must contain at least 43 characters");
    if (passcode === signingKey) fail(variable, "must differ from MCP_OAUTH_SIGNING_KEY");
    const hash = digest(passcode);
    for (const other of hashes.values()) if (timingSafeEqual(hash, other)) fail(variable, "duplicate passcode");
    hashes.set(id, hash);
    versions.set(id, hash.toString("hex").slice(0, 16));
    principals.set(id, Object.freeze({ id, tools: Object.freeze(tools) }));
  }
  for (const variable of Object.keys(env)) {
    if (
      variable.startsWith("MCP_PASSCODE_") &&
      ![...principals.keys()].some((id) => variable === `MCP_PASSCODE_${id.toUpperCase()}`)
    )
      fail(variable, "no matching principal");
  }
  return {
    key,
    principals,
    versions,
    redirectAllowed: redirectAllowlist(env.MCP_OAUTH_REDIRECT_ALLOWLIST),
    matchPasscode(value) {
      const candidate = digest(value);
      let match: string | undefined;
      for (const [id, hash] of hashes) if (timingSafeEqual(candidate, hash)) match = id;
      return match;
    },
  };
}
