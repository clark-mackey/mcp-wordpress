import { describe, it, expect, vi, afterEach } from "vitest";
import express from "express";
import { URL } from "node:url";
import { createHash, createHmac } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { execFileSync } from "node:child_process";
import { SignJWT, decodeJwt, decodeProtectedHeader } from "jose";
import { createHostedAuth } from "@/server/http/auth/index.js";
import { parseConfiguration, redirectAllowlist } from "@/server/http/auth/principals.js";
import { SignedValues } from "@/server/http/auth/values.js";
import { PasscodeOAuthProvider } from "@/server/http/auth/provider.js";
import { HOSTED_ADMIN_TOOLS } from "@/server/http/contract.js";

const issuer = "https://example.com";
const passcode = "a".repeat(43);
const key = Buffer.alloc(32, 7);
const options = (env = {}) => ({
  publicBaseUrl: new URL(issuer),
  knownToolNames: ["wp_get_page", "wp_delete_page", ...HOSTED_ADMIN_TOOLS],
  env: {
    MCP_OAUTH_SIGNING_KEY: key.toString("base64"),
    MCP_PRINCIPALS_JSON: JSON.stringify({ alice: { tools: "all" } }),
    MCP_PASSCODE_ALICE: passcode,
    ...env,
  },
});
const card = (protects, fails, no = "live connector compatibility") =>
  `protects=${protects}; fails_when=${fails}; no_claim=${no}`;
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function appFor(env) {
  const app = express();
  const auth = createHostedAuth(options(env));
  auth.install(app);
  app.get("/mcp", auth.requireAuth, (req, res) =>
    res.json({ id: res.locals.principal.id, expiresAt: req.auth.expiresAt }),
  );
  // Run the actual Express/SDK stack without opening a listening socket.
  const request = (path, init = {}) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      const socket = new Duplex({
        read() {},
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
      });
      socket.remoteAddress = "127.0.0.1";
      const req = new IncomingMessage(socket);
      req.method = init.method ?? "GET";
      req.url = path;
      req.headers = Object.fromEntries(
        Object.entries(init.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
      );
      req.httpVersion = "1.1";
      req.httpVersionMajor = 1;
      req.httpVersionMinor = 1;
      if (init.body !== undefined) {
        const body = init.body.toString();
        if (init.body instanceof URLSearchParams) req.headers["content-type"] = "application/x-www-form-urlencoded";
        req.headers["content-length"] = String(Buffer.byteLength(body));
        req.push(body);
      }
      req.push(null);
      req.complete = true;
      const res = new ServerResponse(req);
      res.assignSocket(socket);
      res.once("error", reject);
      res.once("finish", () => {
        const wire = Buffer.concat(chunks).toString();
        const body = wire.slice(wire.indexOf("\r\n\r\n") + 4);
        resolve({
          status: res.statusCode,
          headers: { get: (name) => res.getHeader(name) ?? null },
          text: async () => body,
          json: async () => JSON.parse(body),
        });
        socket.destroy();
      });
      app.handle(req, res);
    });
  const post = (path, data) => request(path, { method: "POST", body: new URLSearchParams(data) });
  const register = async (redirect = "http://localhost:1234/callback", extra = {}) => {
    const response = await request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: "none", ...extra }),
    });
    return { response, client: await response.json() };
  };
  const bearer = (value) => request("/mcp", { headers: { Authorization: `Bearer ${value}` } });
  return { request, post, register, bearer };
}

async function authorization(app, client, redirect = "http://localhost:1234/callback") {
  const verifier = "v".repeat(43);
  const response = await app.request(
    `/authorize?${new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: "code", code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"), state: "test-state", resource: `${issuer}/mcp` })}`,
  );
  expect(response.status).toBe(200);
  const html = await response.text();
  const transaction = html.match(/name="transaction" value="([^"]+)"/)[1];
  return { response, html, transaction, verifier, redirect };
}

async function issue(app, client) {
  const form = await authorization(app, client);
  const signedIn = await app.post("/authorize/passcode", { transaction: form.transaction, passcode });
  expect(signedIn.status).toBe(302);
  const location = new URL(signedIn.headers.get("location"));
  expect(location.searchParams.get("state")).toBe("test-state");
  const exchange = {
    grant_type: "authorization_code",
    client_id: client.client_id,
    code: location.searchParams.get("code"),
    redirect_uri: form.redirect,
    code_verifier: form.verifier,
  };
  const response = await app.post("/token", exchange);
  expect(response.status).toBe(200);
  return { tokens: await response.json(), exchange };
}

describe("hosted principal configuration", () => {
  it(card("all/allow/deny grants and passcode HMAC", "grant or pv differs"), () => {
    const config = parseConfiguration(
      options({
        MCP_PRINCIPALS_JSON: JSON.stringify({
          alice: { tools: "all" },
          editor: { allow: ["wp_get_page"] },
          reviewer: { deny: ["wp_delete_page"] },
        }),
        MCP_PASSCODE_EDITOR: "b".repeat(43),
        MCP_PASSCODE_REVIEWER: "c".repeat(43),
      }),
    );
    expect([...config.principals.values()].map((p) => p.tools)).toEqual([
      { all: true },
      { allow: ["wp_get_page"] },
      { deny: ["wp_delete_page"] },
    ]);
    expect(config.matchPasscode(passcode)).toBe("alice");
    expect(config.matchPasscode("bad")).toBeUndefined();
    expect(config.versions.get("alice")).toBe(createHmac("sha256", key).update(passcode).digest("hex").slice(0, 16));
  });
  it.each([
    [undefined],
    ["{"],
    ["[]"],
    ["null"],
    ["{}"],
    [JSON.stringify({ a: { tools: "all" } })],
    [JSON.stringify({ Alice: { tools: "all" } })],
    [JSON.stringify({ ["a".repeat(33)]: { tools: "all" } })],
    [JSON.stringify({ "al-ice": { tools: "all" } })],
    [JSON.stringify({ alice: { unknown: [] } })],
    [JSON.stringify({ alice: { tools: "some" } })],
    [JSON.stringify({ alice: { tools: "all", allow: [] } })],
    [JSON.stringify({ alice: null })],
    [JSON.stringify({ alice: [] })],
    [JSON.stringify({ alice: { allow: "wp_get_page" } })],
    [JSON.stringify({ alice: { allow: [1] } })],
    [JSON.stringify({ alice: { allow: ["wp_missing"] } })],
    [JSON.stringify({ alice: { deny: ["wp_missing"] } })],
    ...HOSTED_ADMIN_TOOLS.flatMap((tool) => [
      [JSON.stringify({ alice: { allow: [tool] } })],
      [JSON.stringify({ alice: { deny: [tool] } })],
    ]),
  ])(card("invalid principal JSON is rejected", "startup accepts %s", "other configuration validators"), (json) => {
    expect(() => createHostedAuth(options({ MCP_PRINCIPALS_JSON: json }))).toThrow(/MCP_PRINCIPALS_JSON/);
  });
  it.each([
    [{ MCP_PASSCODE_ALICE: undefined }, "MCP_PASSCODE_ALICE"],
    [{ MCP_PASSCODE_ALICE: "short" }, "MCP_PASSCODE_ALICE"],
    [{ MCP_PASSCODE_ALICE: key.toString("base64") }, "MCP_PASSCODE_ALICE"],
    [{ MCP_PASSCODE_EDITOR: "b".repeat(43) }, "MCP_PASSCODE_EDITOR"],
    [{ MCP_PASSCODE_alice: passcode }, "MCP_PASSCODE_alice"],
    [
      {
        MCP_PRINCIPALS_JSON: JSON.stringify({ alice: { tools: "all" }, editor: { tools: "all" } }),
        MCP_PASSCODE_EDITOR: passcode,
      },
      "MCP_PASSCODE_EDITOR",
    ],
    [{ MCP_OAUTH_SIGNING_KEY: undefined }, "MCP_OAUTH_SIGNING_KEY"],
    [{ MCP_OAUTH_SIGNING_KEY: Buffer.alloc(31).toString("base64") }, "MCP_OAUTH_SIGNING_KEY"],
    [{ MCP_OAUTH_SIGNING_KEY: "!".repeat(50) }, "MCP_OAUTH_SIGNING_KEY"],
  ])(card("credential configuration fails safely", "accepts invalid variable", "OAuth runtime"), (env, variable) => {
    let error;
    try {
      createHostedAuth(options(env));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(variable);
    expect(error.message).not.toContain(passcode);
    expect(error.message).not.toContain(key.toString("base64"));
  });
  it.each([
    "http://example.com",
    "https://example.com/path",
    "https://example.com/?q=x",
    "https://example.com/#x",
    "https://user@example.com",
  ])(card("issuer is an https origin", "accepts %s"), (url) => {
    expect(() => createHostedAuth({ ...options(), publicBaseUrl: new URL(url) })).toThrow(/PUBLIC_BASE_URL/);
  });
});

describe("hosted auth edge cases", () => {
  it(
    card(
      "passcode generator entropy and encoding",
      "output is not 43 base64url characters",
      "statistical entropy audit",
    ),
    () => {
      const generated = execFileSync(
        process.execPath,
        [new URL("../../../scripts/passcode.js", import.meta.url).pathname],
        { encoding: "utf8" },
      ).trim();
      expect(/^[A-Za-z0-9_-]{43}$/.test(generated)).toBe(true);
      expect(Buffer.from(generated, "base64url").length).toBe(32);
    },
  );
  it(card("missing issuer names its variable", "undefined origin crashes without context"), () => {
    expect(() => createHostedAuth({ ...options(), publicBaseUrl: undefined })).toThrow(/PUBLIC_BASE_URL/);
  });
  it(
    card("access client binding and principal existence", "unknown client or removed principal accepted"),
    async () => {
      const config = parseConfiguration(options());
      const provider = new PasscodeOAuthProvider(config, issuer);
      const client = await provider.clientsStore.registerClient({
        redirect_uris: ["http://localhost:1234/callback"],
        token_endpoint_auth_method: "none",
      });
      const claims = { sub: "alice", cid: client.client_id, pv: config.versions.get("alice") };
      const good = await provider.values.sign("access", claims);
      expect((await provider.verifyAccessToken(good)).extra.principal).toBe("alice");
      for (const patch of [{ cid: "unknown-client" }, { sub: "editor" }, { pv: "wrong-version" }]) {
        await expect(
          provider.verifyAccessToken(await provider.values.sign("access", { ...claims, ...patch })),
        ).rejects.toThrow();
      }
      const removedOptions = options({
        MCP_PRINCIPALS_JSON: JSON.stringify({ editor: { tools: "all" } }),
        MCP_PASSCODE_EDITOR: "b".repeat(43),
      });
      delete removedOptions.env.MCP_PASSCODE_ALICE;
      const removed = new PasscodeOAuthProvider(parseConfiguration(removedOptions), issuer);
      await expect(removed.verifyAccessToken(good)).rejects.toThrow();
    },
  );
});

describe("redirect allowlist", () => {
  it(card("default callbacks and loopback paths", "default match is widened or lost"), () => {
    const allowed = redirectAllowlist(undefined);
    for (const value of [
      "https://claude.ai/api/mcp/auth_callback",
      "https://claude.com/api/mcp/auth_callback",
      "http://localhost:54321/a",
      "http://127.0.0.1:123/b",
    ])
      expect(allowed(value)).toBe(true);
    for (const value of [
      "https://claude.ai/other",
      "http://example.com/x",
      "myapp://callback",
      "http://localhost:12/x?q=1",
      "http://127.0.0.1:12/x#fragment",
      "http://user@localhost:123/a",
      "http://[::1]:123/a",
      "https://*.example.com/x",
      "garbage",
    ])
      expect(allowed(value)).toBe(false);
  });
  it(card("env replaces defaults and exact https strings", "old defaults or normalized URI pass"), () => {
    const allowed = redirectAllowlist(" https://example.com/callback , http://localhost:* ");
    expect(allowed("https://example.com/callback")).toBe(true);
    for (const value of [
      "https://example.com/callback/",
      "https://example.com:443/callback",
      "https://claude.ai/api/mcp/auth_callback",
      "http://127.0.0.1:123/a",
    ])
      expect(allowed(value)).toBe(false);
  });
  it.each([
    "",
    "http://example.com/x",
    "myapp://x",
    "https://*.example.com/x",
    "https://%2a.example.com/x",
    "https://example.com/*",
    "https://example.com/x?q=1",
    "https://example.com/x#f",
    "https://example.com/x?",
    "https://example.com/x#",
    "https://user@example.com/x",
    "http://localhost:123/a",
    "http://[::1]:*",
    "https://example.com/x,",
    "garbage",
  ])(card("invalid redirect config fails startup", "accepts %s"), (value) => {
    expect(() => createHostedAuth(options({ MCP_OAUTH_REDIRECT_ALLOWLIST: value }))).toThrow(
      /MCP_OAUTH_REDIRECT_ALLOWLIST/,
    );
  });
});

describe("signed values", () => {
  const values = new SignedValues(key, issuer);
  const audiences = { client: "register", authz: "authorize", access: `${issuer}/mcp`, refresh: "token" };
  it.each(Object.keys(audiences))(
    card("signed %s type round trip", "header audience or life differs"),
    async (type) => {
      const token = await values.sign(type, { cid: "test-client", sub: "alice", pv: "version" });
      expect(decodeProtectedHeader(token)).toEqual({ alg: "HS256", typ: type });
      const claims = await values.verify(type, token);
      expect(claims).toMatchObject({ cid: "test-client", sub: "alice", aud: audiences[type], iss: issuer });
      if (type === "client") expect(claims.exp).toBeUndefined();
      else expect(claims.exp - claims.iat).toBe({ authz: 600, access: 3600, refresh: 2592000 }[type]);
      for (const other of Object.keys(audiences).filter((other) => other !== type))
        await expect(values.verify(other, token)).rejects.toThrow();
    },
  );
  it.each(["wrong typ", "wrong aud", "wrong issuer", "expired", "no expiry", "none", "tamper"])(
    card("token validation", "%s accepted", "key custody"),
    async (variant) => {
      let token = await new SignJWT({ sub: "alice" })
        .setProtectedHeader({ alg: "HS256", typ: variant === "wrong typ" ? "refresh" : "access" })
        .setIssuer(variant === "wrong issuer" ? "https://other.example.com" : issuer)
        .setAudience(variant === "wrong aud" ? "token" : `${issuer}/mcp`)
        .setIssuedAt()
        .setExpirationTime(variant === "expired" ? "-1s" : "1h")
        .sign(key);
      if (variant === "no expiry")
        token = await new SignJWT({})
          .setProtectedHeader({ alg: "HS256", typ: "access" })
          .setIssuer(issuer)
          .setAudience(`${issuer}/mcp`)
          .setIssuedAt()
          .sign(key);
      if (variant === "none")
        token = `${Buffer.from(JSON.stringify({ alg: "none", typ: "access" })).toString("base64url")}.${Buffer.from(JSON.stringify(decodeJwt(token))).toString("base64url")}.`;
      if (variant === "tamper") {
        const parts = token.split(".");
        parts[2] = (parts[2][0] === "a" ? "b" : "a") + parts[2].slice(1);
        token = parts.join(".");
      }
      await expect(values.verify("access", token)).rejects.toThrow("Invalid credential");
    },
  );
});

describe("SDK OAuth integration", () => {
  it(card("DCR authorize PKCE token refresh and bearer", "flow fails or form metadata is unsafe"), async () => {
    const app = await appFor();
    const metadata = await app.request("/.well-known/oauth-protected-resource/mcp");
    expect(await metadata.json()).toMatchObject({ resource: `${issuer}/mcp` });
    const { response, client } = await app.register();
    expect(response.status).toBe(201);
    expect(client.client_secret).toBeUndefined();
    expect(client.token_endpoint_auth_method).toBe("none");
    const form = await authorization(app, client);
    expect(form.response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    );
    expect(form.response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(form.response.headers.get("cache-control")).toBe("no-store");
    expect(form.html).toContain("You are signing in to: localhost:1234");
    expect(form.html.match(/type="hidden"/g)).toHaveLength(1);
    expect(form.html).not.toContain(passcode);
    const { tokens } = await issue(app, client);
    expect(await (await app.bearer(tokens.access_token)).json()).toMatchObject({ id: "alice" });
    const refreshed = await app.post("/token", {
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: tokens.refresh_token,
    });
    expect(refreshed.status).toBe(200);
    expect((await app.bearer((await refreshed.json()).access_token)).status).toBe(200);
  });
  it(card("raw bearer and 401 metadata", "passcode rejected or bad bearer accepted"), async () => {
    const app = await appFor();
    const response = await app.bearer(passcode);
    expect(response.status).toBe(200);
    expect((await response.json()).expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 55);
    for (const value of ["wrong-passcode", ""]) {
      const denied = await app.bearer(value);
      expect(denied.status).toBe(401);
      expect(denied.headers.get("www-authenticate")).toContain(`${issuer}/.well-known/oauth-protected-resource/mcp`);
    }
  });
  it(card("one shared failed guessing budget", "11th attempt across routes is not 429"), async () => {
    const app = await appFor();
    const { client } = await app.register();
    const { transaction } = await authorization(app, client);
    for (let i = 0; i < 10; i++) {
      const response =
        i % 3 === 0
          ? await app.bearer("wrong")
          : i % 3 === 1
            ? await app.post("/authorize/passcode", { transaction, passcode: "wrong" })
            : await app.post("/token", {
                grant_type: "refresh_token",
                client_id: client.client_id,
                refresh_token: "wrong",
              });
      expect(response.status).toBe(i % 3 === 2 ? 400 : 401);
    }
    expect((await app.bearer(passcode)).status).toBe(429);
    expect((await app.post("/authorize/passcode", { transaction, passcode })).status).toBe(429);
    expect((await app.post("/token", {})).status).toBe(429);
  });
  it(card("successes do not use failure budget", "successful bearer exhausts limiter"), async () => {
    const app = await appFor();
    for (let i = 0; i < 12; i++) expect((await app.bearer(passcode)).status).toBe(200);
    expect((await app.bearer("wrong")).status).toBe(401);
  });
  it(card("code reuse client redirect and PKCE binding", "consumed or mismatched code exchanges"), async () => {
    const app = await appFor();
    const { client } = await app.register();
    const other = (await app.register()).client;
    const { exchange } = await issue(app, client);
    expect(await (await app.post("/token", exchange)).json()).toMatchObject({ error: "invalid_grant" });
    for (const changed of [
      { client_id: other.client_id },
      { redirect_uri: "http://localhost:1234/other" },
      { code_verifier: "wrong" },
    ]) {
      const form = await authorization(app, client);
      const signedIn = await app.post("/authorize/passcode", { transaction: form.transaction, passcode });
      const code = new URL(signedIn.headers.get("location")).searchParams.get("code");
      expect(await (await app.post("/token", { ...exchange, code, ...changed })).json()).toMatchObject({
        error: "invalid_grant",
      });
      expect(await (await app.post("/token", { ...exchange, code })).json()).toMatchObject({ error: "invalid_grant" });
    }
  });
  it(card("type separation and refresh client binding", "other token kind or client works"), async () => {
    const app = await appFor();
    const { client } = await app.register();
    const other = (await app.register()).client;
    const { tokens } = await issue(app, client);
    for (const value of [tokens.refresh_token, client.client_id]) expect((await app.bearer(value)).status).toBe(401);
    for (const [refresh_token, client_id] of [
      [tokens.access_token, client.client_id],
      [client.client_id, client.client_id],
      [tokens.refresh_token, other.client_id],
    ])
      expect(
        await (await app.post("/token", { grant_type: "refresh_token", refresh_token, client_id })).json(),
      ).toMatchObject({ error: "invalid_grant" });
  });
  it(card("redeploy continuity and passcode revocation", "restart revokes or rotated secret stays valid"), async () => {
    const first = await appFor();
    const { client } = await first.register();
    const { tokens } = await issue(first, client);
    const second = await appFor();
    expect((await second.bearer(tokens.access_token)).status).toBe(200);
    expect(
      (
        await second.post("/token", {
          grant_type: "refresh_token",
          client_id: client.client_id,
          refresh_token: tokens.refresh_token,
        })
      ).status,
    ).toBe(200);
    const rotated = await appFor({ MCP_PASSCODE_ALICE: "b".repeat(43) });
    expect((await rotated.bearer(tokens.access_token)).status).toBe(401);
    expect((await rotated.bearer(passcode)).status).toBe(401);
    expect(
      await (
        await rotated.post("/token", {
          grant_type: "refresh_token",
          client_id: client.client_id,
          refresh_token: tokens.refresh_token,
        })
      ).json(),
    ).toMatchObject({ error: "invalid_grant" });
  });
  it(card("app removal blocks authorize and refresh", "removed redirect remains usable"), async () => {
    const first = await appFor();
    const { client } = await first.register();
    const { tokens } = await issue(first, client);
    const second = await appFor({ MCP_OAUTH_REDIRECT_ALLOWLIST: "https://example.com/callback" });
    expect((await second.bearer(tokens.access_token)).status).toBe(200);
    const response = await second.request(
      `/authorize?${new URLSearchParams({ client_id: client.client_id, redirect_uri: "http://localhost:1234/callback" })}`,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_redirect_uri" });
    expect((await second.request(`/authorize?${new URLSearchParams({ client_id: client.client_id })}`)).status).toBe(
      400,
    );
    expect(
      await (
        await second.post("/token", {
          grant_type: "refresh_token",
          client_id: client.client_id,
          refresh_token: tokens.refresh_token,
        })
      ).json(),
    ).toMatchObject({ error: "invalid_grant" });
  });
  it(
    card("public clients redirect refusals and safe audit lines", "confidential client allowed or failure log leaks"),
    async () => {
      const logs = [];
      vi.spyOn(process.stderr, "write").mockImplementation((value) => {
        logs.push(String(value));
        return true;
      });
      const app = await appFor();
      expect(
        (await app.register(undefined, { token_endpoint_auth_method: "client_secret_post" })).response.status,
      ).toBe(400);
      const refused = await app.register("https://example.com/refused");
      expect(await Promise.resolve(refused.client)).toMatchObject({ error: "invalid_redirect_uri" });
      const event = logs.map((line) => JSON.parse(line)).find((entry) => entry.event === "redirect_refused");
      expect(event).toEqual({ event: "redirect_refused", uri: "https://example.com/refused" });
      const { client } = await app.register();
      const { tokens } = await issue(app, client);
      const form = await authorization(app, client);
      const denied = await app.post("/authorize/passcode", {
        transaction: form.transaction,
        passcode: "wrong-sensitive-passcode",
      });
      expect(denied.status).toBe(401);
      expect(await denied.text()).not.toContain("wrong-sensitive-passcode");
      await app.bearer(tokens.access_token);
      await app.post("/token", {
        grant_type: "refresh_token",
        client_id: client.client_id,
        refresh_token: tokens.refresh_token,
      });
      await app.bearer("wrong-sensitive-bearer");
      expect(logs.join("")).not.toContain(tokens.access_token);
      expect(logs.join("")).not.toContain(tokens.refresh_token);
      expect(logs.join("")).not.toContain(form.transaction);
      expect(logs.join("")).not.toContain("wrong-sensitive-passcode");
      expect(logs.some((line) => JSON.parse(line).event === "auth_failure")).toBe(true);
      expect(logs.join("")).not.toMatch(/wrong-sensitive-bearer/);
      expect(logs.join("")).not.toContain(passcode);
      expect(logs.join("")).not.toContain(key.toString("base64"));
    },
  );
  it(card("DCR refused URI errors and audit events", "malformed or unsafe URI bypasses policy"), async () => {
    const lines = [];
    vi.spyOn(process.stderr, "write").mockImplementation((value) => {
      lines.push(String(value));
      return true;
    });
    const app = await appFor();
    for (const uri of [
      "garbage",
      "http://example.com/callback",
      "myapp://callback",
      "https://*.example.com/callback",
      "http://localhost:123/callback?x=1",
      "http://localhost:123/callback#x",
    ]) {
      const before = lines.length;
      const { response, client } = await app.register(uri);
      expect(response.status).toBe(400);
      expect(client.error).toBe("invalid_redirect_uri");
      expect(
        lines
          .slice(before)
          .map((line) => JSON.parse(line))
          .filter((event) => event.event === "redirect_refused"),
      ).toHaveLength(1);
    }
  });
  it(card("refused redirect log omits credentials", "userinfo or query secrets reach the log"), async () => {
    const lines = [];
    vi.spyOn(process.stderr, "write").mockImplementation((value) => {
      lines.push(String(value));
      return true;
    });
    const app = await appFor();
    await app.register("https://user:pw-secret@example.com/cb?token=query-secret#frag-secret");
    await app.register("not a uri with raw-secret");
    const events = lines.map((line) => JSON.parse(line)).filter((event) => event.event === "redirect_refused");
    expect(events).toEqual([
      { event: "redirect_refused", uri: "https://example.com/cb" },
      { event: "redirect_refused", uri: "[invalid URI]" },
    ]);
    expect(lines.join("")).not.toMatch(/pw-secret|query-secret|frag-secret|raw-secret/);
  });
  it(card("pending authorization codes are capped per principal", "unexchanged codes grow without bound"), async () => {
    const app = await appFor();
    const { client } = await app.register();
    const form = await authorization(app, client);
    for (let i = 0; i < 16; i++)
      expect((await app.post("/authorize/passcode", { transaction: form.transaction, passcode })).status).toBe(302);
    expect((await app.post("/authorize/passcode", { transaction: form.transaction, passcode })).status).toBe(401);
  });
  it(card("signed transaction integrity and expiry", "tampered or expired form authenticates"), async () => {
    const app = await appFor();
    const { client } = await app.register();
    const form = await authorization(app, client);
    expect((await app.post("/authorize/passcode", { transaction: `${form.transaction}x`, passcode })).status).toBe(401);
    const provider = new PasscodeOAuthProvider(parseConfiguration(options()), issuer);
    const transaction = await new SignJWT({
      cid: client.client_id,
      redirect_uri: "http://localhost:1234/callback",
      code_challenge: "test",
    })
      .setProtectedHeader({ alg: "HS256", typ: "authz" })
      .setIssuer(issuer)
      .setAudience("authorize")
      .setIssuedAt()
      .setExpirationTime("-1s")
      .sign(key);
    await expect(provider.transaction(transaction)).rejects.toThrow();
  });
});
