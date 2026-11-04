import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { createHostedApp } from "@/server/http/app.js";
import { HOSTED_ADMIN_TOOLS } from "@/server/http/contract.js";
import { ToolRegistry } from "@/server/ToolRegistry.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const ACCEPT = "application/json, text/event-stream";

function fakeAuth(principals) {
  const principalMap = new Map(principals.map((principal) => [principal.id, principal]));
  return {
    principals: principalMap,
    install(app) {
      app.get("/fake-auth", (_req, res) => res.json({ installed: true }));
    },
    requireAuth(req, res, next) {
      const id = req.get("authorization")?.replace(/^Bearer\s+/i, "");
      const principal = principalMap.get(id);
      if (!principal) return res.sendStatus(401);
      req.auth = { token: "test-token", clientId: "test-client", scopes: [] };
      res.locals.principal = principal;
      next();
    },
  };
}

function startApp(principals, wordpressClients = new Map()) {
  return createHostedApp({
    publicBaseUrl: new URL("https://mcp.example.test"),
    auth: fakeAuth(principals),
    wordpressClients,
  });
}

async function request(app, path, { method = "GET", token, body, host = "mcp.example.test", onResponse } = {}) {
  const headers = { accept: ACCEPT, host };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const bodyText = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  if (bodyText) headers["content-length"] = String(Buffer.byteLength(bodyText));
  const socket = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  socket.remoteAddress = "127.0.0.1";
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = path;
  req.headers = headers;
  req.rawHeaders = Object.entries(headers).flatMap(([name, value]) => [name, value]);
  req.httpVersion = "1.1";
  req.complete = true;
  if (bodyText) req.push(bodyText);
  req.push(null);
  const response = new ServerResponse(req);
  response.assignSocket(socket);
  const chunks = [];
  const originalWrite = response.write.bind(response);
  const originalEnd = response.end.bind(response);
  response.write = (chunk, ...args) => {
    if (chunk !== undefined) chunks.push(Buffer.from(chunk));
    return originalWrite(chunk, ...args);
  };
  response.end = (chunk, ...args) => {
    if (chunk !== undefined) chunks.push(Buffer.from(chunk));
    return originalEnd(chunk, ...args);
  };
  const completed = new Promise((resolve) => {
    response.once("finish", resolve);
    response.once("close", resolve);
  });
  onResponse?.(response);
  app(req, response);
  await completed;
  const text = Buffer.concat(chunks).toString("utf8");
  const responseHeaders = response.getHeaders();
  if (String(responseHeaders["content-type"] ?? "").includes("text/event-stream")) {
    const data = text
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice(6);
    return { response, payload: data ? JSON.parse(data) : undefined, text };
  }
  let payload;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = text;
  }
  return { response, payload, text };
}

function rpc(method, params = {}, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

describe("hosted HTTP app", () => {
  let app;

  it("serves health and exposes grant-filtered tools without hosted admin tools", async () => {
    app = startApp(
      [
        { id: "all", tools: { all: true } },
        { id: "limited", tools: { allow: ["wp_list_posts"] } },
        { id: "empty", tools: { allow: [] } },
        { id: "denied", tools: { deny: ["wp_list_posts"] } },
      ],
      new Map([
        ["site-a", {}],
        ["site-b", {}],
      ]),
    );

    const health = await request(app, "/healthz");
    expect(health.response.statusCode).toBe(200);
    expect(health.payload).toEqual({
      ok: true,
      version: JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version,
      sites: 2,
    });

    const all = await request(app, "/mcp", { method: "POST", token: "all", body: rpc("tools/list") });
    const limited = await request(app, "/mcp", { method: "POST", token: "limited", body: rpc("tools/list") });
    const empty = await request(app, "/mcp", { method: "POST", token: "empty", body: rpc("tools/list") });
    const denied = await request(app, "/mcp", { method: "POST", token: "denied", body: rpc("tools/list") });
    for (const result of [all, limited, empty, denied]) expect(result.response.statusCode).toBe(200);
    const allTools = all.payload.result.tools;
    const allNames = allTools.map(({ name }) => name);
    expect(allNames).toContain("wp_list_posts");
    for (const name of HOSTED_ADMIN_TOOLS) expect(allNames).not.toContain(name);
    expect(limited.payload.result.tools.map(({ name }) => name)).toEqual(["wp_list_posts"]);
    expect(empty.payload.result.tools).toEqual([]);
    expect(denied.payload.result.tools.map(({ name }) => name)).toEqual(
      allNames.filter((name) => name !== "wp_list_posts"),
    );
    const fullRegistry = new ToolRegistry(new McpServer({ name: "test", version: "0" }), new Map());
    fullRegistry.registerAllTools();
    expect(allNames).toHaveLength(fullRegistry.getToolNames().length - HOSTED_ADMIN_TOOLS.length);
  });

  it("rejects a call hidden by the principal's grant", async () => {
    app = startApp([{ id: "limited", tools: { allow: ["wp_get_post"] } }]);
    const result = await request(app, "/mcp", {
      method: "POST",
      token: "limited",
      body: rpc("tools/call", { name: "wp_list_posts", arguments: {} }),
    });
    expect(result.payload, result.text).toBeDefined();
    expect(result.payload.result?.isError).toBe(true);
    expect(result.payload.result.content.length).toBeGreaterThan(0);
  });

  it("rejects bad Host headers on MCP and installed auth routes", async () => {
    app = startApp([{ id: "all", tools: { all: true } }]);
    for (const [path, method, body] of [
      ["/mcp", "POST", rpc("tools/list")],
      ["/fake-auth", "GET"],
    ]) {
      const result = await request(app, path, { method, body, token: "all", host: "attacker.example" });
      expect(result.response.statusCode).toBe(403);
    }
  });

  it("answers /healthz for the platform's own probe Host", async () => {
    app = startApp([{ id: "all", tools: { all: true } }]);
    const result = await request(app, "/healthz", { host: "healthcheck.railway.app" });
    expect(result.response.statusCode).toBe(200);
  });

  it("returns 405 for GET/DELETE and 413 for an oversized JSON body", async () => {
    app = startApp([{ id: "all", tools: { all: true } }]);
    expect((await request(app, "/mcp")).response.statusCode).toBe(405);
    expect((await request(app, "/mcp", { method: "DELETE" })).response.statusCode).toBe(405);
    const response = await request(app, "/mcp", {
      method: "POST",
      token: "all",
      body: { data: "x".repeat(1_100_000) },
    });
    expect(response.response.statusCode).toBe(413);
    expect(response.payload).toEqual({ error: "Request body exceeds 1 MB" });
    const malformed = await request(app, "/mcp", { method: "POST", token: "all", body: "{" });
    expect(malformed.response.statusCode).toBe(400);
    expect(malformed.payload).toEqual({ error: "Request failed" });
  });

  it("limits each principal to four concurrent calls and releases slots on completion", async () => {
    let resolvePosts;
    const posts = new Promise((resolve) => {
      resolvePosts = resolve;
    });
    const client = { getPosts: vi.fn(() => posts), getSiteUrl: () => "https://wp.example.test" };
    app = startApp(
      [
        { id: "busy", tools: { allow: ["wp_list_posts"] } },
        { id: "other", tools: { allow: ["wp_list_posts"] } },
      ],
      new Map([["site", client]]),
    );
    const call = (token, id) =>
      request(app, "/mcp", {
        method: "POST",
        token,
        body: rpc("tools/call", { name: "wp_list_posts", arguments: {} }, id),
      });
    const active = [call("busy", 1), call("busy", 2), call("busy", 3), call("busy", 4)];
    await vi.waitFor(() => expect(client.getPosts).toHaveBeenCalledTimes(4));
    const limited = await call("busy", 5);
    expect(limited.response.statusCode).toBe(429);
    const independent = call("other", 6);
    await vi.waitFor(() => expect(client.getPosts).toHaveBeenCalledTimes(5));
    resolvePosts([]);
    const activeResults = await Promise.all([...active, independent]);
    expect(activeResults.every((result) => result.response.statusCode === 200)).toBe(true);
    const afterRelease = await call("busy", 7);
    expect(afterRelease.response.statusCode).toBe(200);
  });
  it("holds a disconnected call's slot until the underlying tool completes", async () => {
    let resolvePosts;
    const posts = new Promise((resolve) => {
      resolvePosts = resolve;
    });
    const client = { getPosts: vi.fn(() => posts), getSiteUrl: () => "https://wp.example.test" };
    app = startApp([{ id: "busy", tools: { allow: ["wp_list_posts"] } }], new Map([["site", client]]));
    const responses = [];
    const call = (id) =>
      request(app, "/mcp", {
        method: "POST",
        token: "busy",
        body: rpc("tools/call", { name: "wp_list_posts", arguments: {} }, id),
        onResponse: (response) => responses.push(response),
      });
    const active = [call(1), call(2), call(3), call(4)];
    await vi.waitFor(() => expect(client.getPosts).toHaveBeenCalledTimes(4));
    responses[0].destroy();
    expect((await call(5)).response.statusCode).toBe(429);
    resolvePosts([]);
    await Promise.all(active);
    await vi.waitFor(() => expect(client.getPosts).toHaveBeenCalledTimes(4));
    expect((await call(6)).response.statusCode).toBe(200);
  });
  it("prepares one registry per distinct grant and authenticates every POST", async () => {
    const prepare = vi.spyOn(ToolRegistry.prototype, "createFiltered");
    try {
      app = startApp([
        { id: "first", tools: { allow: ["wp_get_post", "wp_list_posts"] } },
        { id: "second", tools: { allow: ["wp_list_posts", "wp_get_post", "wp_get_post"] } },
      ]);
      expect(prepare).toHaveBeenCalledTimes(1);
      for (const token of ["first", "second", "first"]) {
        const result = await request(app, "/mcp", { method: "POST", token, body: rpc("tools/list") });
        expect(result.payload.result.tools).toHaveLength(2);
      }
      expect(prepare).toHaveBeenCalledTimes(1);
      expect((await request(app, "/mcp", { method: "POST", body: rpc("tools/list") })).response.statusCode).toBe(401);
    } finally {
      prepare.mockRestore();
    }
  });
});
