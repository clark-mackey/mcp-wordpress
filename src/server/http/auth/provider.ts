import { randomBytes } from "node:crypto";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTokenError,
  OAuthError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { redirectUriMatches } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import type { JWTPayload } from "jose";
import { SignedValues } from "./values.js";
import type { AuthConfiguration } from "./principals.js";

class InvalidRedirectUriError extends OAuthError {
  static override errorCode = "invalid_redirect_uri";
}

interface Code {
  principal: string;
  cid: string;
  redirect: string;
  challenge: string;
  expires: number;
}

export function audit(event: string, fields: Record<string, string> = {}): void {
  process.stderr.write(`${JSON.stringify({ event, ...fields })}\n`);
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

export function passcodePage(res: Response, transaction: string, redirect: string, failed = false): void {
  res
    .set({
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    })
    .type("html").send(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Sign in</title>
<style>body{font:18px system-ui;max-width:36rem;margin:4rem auto;padding:1rem}h1{font-size:2rem}</style>
<h1>You are signing in to: ${escapeHtml(new URL(redirect).host)}</h1>
${failed ? "<p>Sign-in failed. Try again.</p>" : ""}
<form method="post" action="/authorize/passcode"><input type="hidden" name="transaction" value="${escapeHtml(transaction)}">
<label>Passcode <input name="passcode" type="password" autocomplete="current-password" required></label>
<button type="submit">Sign in</button></form></html>`);
}

export class PasscodeOAuthProvider implements OAuthServerProvider {
  readonly values: SignedValues;
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly codes = new Map<string, Code>();
  // The SDK looks up PKCE before exchanging. Keep that consumed code only on this request's client object.
  private readonly pending = new WeakMap<OAuthClientInformationFull, { value: string; code: Code }>();

  constructor(
    readonly config: AuthConfiguration,
    readonly issuer: string,
  ) {
    this.values = new SignedValues(config.key, issuer);
    this.clientsStore = {
      getClient: async (id) => {
        try {
          const claims = await this.values.verify("client", id);
          if (!Array.isArray(claims.redirect_uris) || !claims.redirect_uris.every((uri) => typeof uri === "string"))
            return undefined;
          return {
            client_id: id,
            redirect_uris: claims.redirect_uris,
            token_endpoint_auth_method: "none",
            ...(typeof claims.client_name === "string" && { client_name: claims.client_name }),
          };
        } catch {
          return undefined;
        }
      },
      registerClient: async (client) => {
        if (client.token_endpoint_auth_method !== "none")
          throw new InvalidClientMetadataError("Public clients required");
        client.redirect_uris.forEach((uri) => this.checkRedirect(uri));
        const metadata = {
          redirect_uris: client.redirect_uris,
          ...(client.client_name !== undefined && { client_name: client.client_name }),
        };
        return {
          ...metadata,
          client_id: await this.values.sign("client", { ...metadata, jti: randomBytes(16).toString("hex") }),
          token_endpoint_auth_method: "none",
        };
      },
    };
  }

  checkRedirect(uri: string): void {
    if (!this.config.redirectAllowed(uri)) {
      audit("redirect_refused", { uri });
      throw new InvalidRedirectUriError("Redirect URI refused");
    }
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.checkRedirect(params.redirectUri);
    if (!client.redirect_uris.some((uri) => redirectUriMatches(params.redirectUri, uri)))
      throw new InvalidGrantError("Invalid redirect");
    if (params.resource && params.resource.href !== `${this.issuer}/mcp`)
      throw new InvalidGrantError("Invalid resource");
    const transaction = await this.values.sign("authz", {
      cid: client.client_id,
      redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge,
      ...(params.state !== undefined && { state: params.state }),
      ...(params.resource && { resource: params.resource.href }),
    });
    passcodePage(res, transaction, params.redirectUri);
  }

  async transaction(token: string): Promise<JWTPayload> {
    const claims = await this.values.verify("authz", token);
    if (
      typeof claims.cid !== "string" ||
      typeof claims.redirect_uri !== "string" ||
      typeof claims.code_challenge !== "string"
    )
      throw new InvalidGrantError("Invalid transaction");
    const client = await this.clientsStore.getClient(claims.cid);
    if (!client || !client.redirect_uris.some((uri) => redirectUriMatches(claims.redirect_uri as string, uri)))
      throw new InvalidGrantError("Invalid transaction");
    this.checkRedirect(claims.redirect_uri);
    return claims;
  }

  complete(claims: JWTPayload, principal: string): string {
    const now = Date.now();
    for (const [key, code] of this.codes) if (code.expires <= now) this.codes.delete(key);
    const value = randomBytes(32).toString("base64url");
    this.codes.set(value, {
      principal,
      cid: claims.cid as string,
      redirect: claims.redirect_uri as string,
      challenge: claims.code_challenge as string,
      expires: now + 600_000,
    });
    const redirect = new URL(claims.redirect_uri as string);
    redirect.searchParams.set("code", value);
    if (typeof claims.state === "string") redirect.searchParams.set("state", claims.state);
    return redirect.href;
  }

  private consume(client: OAuthClientInformationFull, value: string): Code {
    const code = this.codes.get(value);
    this.codes.delete(value);
    if (!code || code.expires <= Date.now() || code.cid !== client.client_id)
      throw new InvalidGrantError("Invalid authorization code");
    return code;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, value: string): Promise<string> {
    const code = this.consume(client, value);
    this.pending.set(client, { value, code });
    return code.challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    value: string,
    _verifier?: string,
    redirect?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const pending = this.pending.get(client);
    this.pending.delete(client);
    const code = pending?.value === value ? pending.code : this.consume(client, value);
    if (
      code.expires <= Date.now() ||
      code.redirect !== redirect ||
      (resource && resource.href !== `${this.issuer}/mcp`)
    )
      throw new InvalidGrantError("Invalid authorization code");
    return this.tokens(code.principal, client.client_id);
  }

  private async tokens(id: string, cid: string): Promise<OAuthTokens> {
    const pv = this.config.versions.get(id);
    if (!pv) throw new InvalidGrantError("Invalid principal");
    const claims = { sub: id, cid, pv };
    return {
      access_token: await this.values.sign("access", claims),
      refresh_token: await this.values.sign("refresh", claims),
      token_type: "Bearer",
      expires_in: 3600,
    };
  }

  private principal(claims: JWTPayload): string {
    if (
      typeof claims.sub !== "string" ||
      !this.config.principals.has(claims.sub) ||
      claims.pv !== this.config.versions.get(claims.sub) ||
      typeof claims.cid !== "string"
    )
      throw new InvalidGrantError("Invalid principal");
    return claims.sub;
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    value: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const claims = await this.values.verify("refresh", value);
    const id = this.principal(claims);
    if (claims.cid !== client.client_id || (resource && resource.href !== `${this.issuer}/mcp`))
      throw new InvalidGrantError("Invalid refresh token");
    for (const uri of client.redirect_uris) {
      try {
        this.checkRedirect(uri);
      } catch {
        throw new InvalidGrantError("Redirect URI refused");
      }
    }
    return this.tokens(id, client.client_id);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const raw = this.config.matchPasscode(token);
    if (raw)
      return {
        token,
        clientId: raw,
        scopes: [],
        expiresAt: Math.floor(Date.now() / 1000) + 60,
        resource: new URL(`${this.issuer}/mcp`),
        extra: { principal: raw },
      };
    try {
      const claims = await this.values.verify("access", token);
      const id = this.principal(claims);
      if (!(await this.clientsStore.getClient(claims.cid as string))) throw new InvalidTokenError("Invalid credential");
      return {
        token,
        clientId: claims.cid as string,
        scopes: [],
        expiresAt: claims.exp!,
        resource: new URL(`${this.issuer}/mcp`),
        extra: { principal: id },
      };
    } catch {
      throw new InvalidTokenError("Invalid credential");
    }
  }
}
