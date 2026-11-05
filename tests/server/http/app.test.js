import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { createHostedApp, createUsageExecutionHooks } from "@/server/http/app.js";
import { HOSTED_ADMIN_TOOLS } from "@/server/http/contract.js";
import { ToolRegistry } from "@/server/ToolRegistry.js";
import { countedText } from "@/server/toolResult.js";
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

function startApp(principals, wordpressClients = new Map(), options = {}) {
  return createHostedApp({
    publicBaseUrl: new URL("https://mcp.example.test"),
    auth: fakeAuth(principals),
    wordpressClients,
    ...options,
  });
}

async function request(
  app,
  path,
  { method = "GET", token, body, host = "mcp.example.test", userAgent, onResponse } = {},
) {
  const headers = { accept: ACCEPT, host };
  if (token) headers.authorization = `Bearer ${token}`;
  if (userAgent !== undefined) headers["user-agent"] = userAgent;
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
      usage: { enabled: false },
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

  it("rejects JSON-RPC batches so batched calls cannot skip the concurrency limit", async () => {
    app = startApp([{ id: "all", tools: { all: true } }]);
    const call = rpc("tools/call", { name: "wp_list_posts", arguments: {} });
    const result = await request(app, "/mcp", { method: "POST", token: "all", body: [call, { ...call, id: 2 }] });
    expect(result.response.statusCode).toBe(400);
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
    const usage = { enqueue: vi.fn(), counters: () => ({}), report: vi.fn(), shutdown: vi.fn() };
    app = startApp(
      [
        { id: "busy", tools: { allow: ["wp_list_posts"] } },
        { id: "other", tools: { allow: ["wp_list_posts"] } },
      ],
      new Map([["site", client]]),
      { usage },
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
    expect(usage.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "rejection",
        principalId: "busy",
        toolName: null,
        outcome: "concurrency_limited",
      }),
    );
    const independent = call("other", 6);
    await vi.waitFor(() => expect(client.getPosts).toHaveBeenCalledTimes(5));
    resolvePosts([]);
    const activeResults = await Promise.all([...active, independent]);
    expect(activeResults.every((result) => result.response.statusCode === 200)).toBe(true);
    const afterRelease = await call("busy", 7);
    expect(afterRelease.response.statusCode).toBe(200);
  });

  it("records a request closed before tool execution as cancelled", () => {
    const events = [];
    const hooks = createUsageExecutionHooks({
      principalId: "alice",
      client: { name: null, version: null },
      bootId: "00000000-0000-4000-8000-000000000000",
      version: "0",
      isConfiguredSite: (siteId) => siteId === "site1",
      isReleased: () => true,
      markStarted: vi.fn(),
      release: vi.fn(),
      enqueue: (event) => events.push(event),
    });
    expect(() => hooks.start({ toolName: "wp_list_posts", args: { site: "site1" } })).toThrow("Request closed");
    expect(events[0]).toMatchObject({ outcome: "cancelled", errorClass: "REQUEST_CLOSED", resultBytes: 0 });
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

  it("records tool outcomes, allowlisted arguments, and recognized clients", async () => {
    const events = [];
    const usage = { enqueue: (event) => events.push(event), counters: () => ({}), report: vi.fn(), shutdown: vi.fn() };
    const client = {
      getPosts: vi.fn().mockResolvedValue([]),
      getSiteUrl: () => "https://example.test",
    };
    app = startApp([{ id: "alice", tools: { allow: ["wp_list_posts"] } }], new Map([["site1", client]]), {
      usage,
    });
    const result = await request(app, "/mcp", {
      method: "POST",
      token: "alice",
      userAgent: "claude-code/1.2.3 extra",
      body: rpc("tools/call", {
        name: "wp_list_posts",
        arguments: {
          search: `${"x".repeat(260)} `,
        },
      }),
    });
    expect(result.response.statusCode).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "tool_call",
      principalId: "alice",
      clientName: "claude_code",
      clientVersion: "1.2.3",
      toolName: "wp_list_posts",
      siteId: "site1",
      outcome: "success",
      errorClass: null,
      returnedCount: 0,
    });
    expect(events[0].resultBytes).toBeGreaterThan(0);
    expect(events[0].payload).toEqual({
      search_text: { search: "x".repeat(256) },
      search_text_truncated: true,
    });
  });

  it("records site, tool-reported, and thrown failures without raw arguments", async () => {
    const events = [];
    const usage = { enqueue: (event) => events.push(event), counters: () => ({}), report: vi.fn(), shutdown: vi.fn() };
    const failingRegistry = new ToolRegistry(new McpServer({ name: "test", version: "0" }), new Map([["site1", {}]]));
    failingRegistry.registerAllTools([
      {
        name: "wp_test_failure",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number" },
            content: { type: "string" },
            title: { type: "string" },
            slug: { type: "string" },
            password: { type: "string" },
            file_path: { type: "string" },
          },
        },
        handler: async () => ({ success: false }),
      },
      {
        name: "wp_test_error",
        inputSchema: { type: "object", properties: {} },
        handler: async () => {
          throw new TypeError("not recorded");
        },
      },
      {
        name: "wp_test_array",
        inputSchema: { type: "object", properties: {} },
        handler: async () => [{ id: 1 }, { id: 2 }],
      },
    ]);
    app = startApp([{ id: "alice", tools: { all: true } }], new Map([["site1", {}]]), {
      usage,
      toolRegistry: failingRegistry,
    });
    await request(app, "/mcp", {
      method: "POST",
      token: "alice",
      body: rpc("tools/call", {
        name: "wp_test_failure",
        arguments: { id: 4, content: "x", title: "x", slug: "x", password: "x", file_path: "/x" },
      }),
    });
    await request(app, "/mcp", {
      method: "POST",
      token: "alice",
      body: rpc("tools/call", { name: "wp_test_error", arguments: {} }, 2),
    });
    await request(app, "/mcp", {
      method: "POST",
      token: "alice",
      body: rpc("tools/call", { name: "wp_test_array", arguments: {} }, 3),
    });
    expect(events.map(({ outcome }) => outcome)).toEqual(["tool_failure", "error", "success"]);
    expect(events[0].errorClass).toBe("tool_reported_failure");
    expect(events[0].payload).toEqual({ ids: { id: 4 } });
    expect(events[1].errorClass).toBe("TypeError");
    expect(events[2]).toMatchObject({ returnedCount: 2, errorClass: null });

    const missing = startApp(
      [{ id: "alice", tools: { allow: ["wp_list_posts"] } }],
      new Map([
        ["site1", {}],
        ["site2", {}],
      ]),
      { usage },
    );
    await request(missing, "/mcp", {
      method: "POST",
      token: "alice",
      body: rpc("tools/call", { name: "wp_list_posts", arguments: { site: "missing" } }, 4),
    });
    expect(events.at(-1)).toMatchObject({ outcome: "site_not_found", errorClass: "site_not_found", siteId: null });
  });

  it("does not record caller-supplied site strings on dispatched or cancelled calls", async () => {
    const events = [];
    const usage = { enqueue: (event) => events.push(event), counters: () => ({}), report: vi.fn(), shutdown: vi.fn() };
    app = startApp(
      [{ id: "alice", tools: { allow: ["wp_list_posts"] } }],
      new Map([["site1", { getPosts: vi.fn().mockResolvedValue([]), getSiteUrl: () => "https://example.test" }]]),
      { usage },
    );
    await request(app, "/mcp", {
      method: "POST",
      token: "alice",
      body: rpc("tools/call", { name: "wp_list_posts", arguments: { site: "https://not-a-site.example/" } }),
    });
    expect(events.at(-1).siteId).toBeNull();

    const hooks = createUsageExecutionHooks({
      principalId: "alice",
      client: { name: null, version: null },
      bootId: "00000000-0000-4000-8000-000000000000",
      version: "0",
      isConfiguredSite: () => false,
      isReleased: () => true,
      markStarted: vi.fn(),
      release: vi.fn(),
      enqueue: (event) => events.push(event),
    });
    expect(() => hooks.start({ toolName: "wp_list_posts", args: { site: "x".repeat(1_000_000) } })).toThrow();
    expect(events.at(-1).siteId).toBeNull();
  });

  it("records SDK-rejected tool calls exactly once without preserving unknown names", async () => {
    const events = [];
    const usage = { enqueue: (event) => events.push(event), counters: () => ({}), report: vi.fn(), shutdown: vi.fn() };
    app = startApp(
      [{ id: "limited", tools: { allow: ["wp_list_posts"] } }],
      new Map([["site1", { getPosts: vi.fn().mockResolvedValue([]), getSiteUrl: () => "https://example.test" }]]),
      { usage },
    );
    for (const [name, args] of [
      ["wp_list_posts", { unsupported: true, "pasted text here_id": 7, site: "https://not-configured.test" }],
      ["does_not_exist", {}],
      ["wp_get_post", { id: 1 }],
    ]) {
      await request(app, "/mcp", {
        method: "POST",
        token: "limited",
        body: rpc("tools/call", { name, arguments: args }),
      });
    }
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      outcome: "not_dispatched",
      toolName: "wp_list_posts",
      errorClass: "invalid_arguments",
      siteId: null,
      payload: {},
    });
    expect(events[1]).toMatchObject({ outcome: "not_dispatched", toolName: null, errorClass: "unknown_tool" });
    expect(events[2]).toMatchObject({ outcome: "not_dispatched", toolName: "wp_get_post", errorClass: "unknown_tool" });
  });

  it("unwraps counted text without changing the client response", async () => {
    const events = [];
    const usage = { enqueue: (event) => events.push(event), counters: () => ({}), report: vi.fn(), shutdown: vi.fn() };
    const registry = new ToolRegistry(new McpServer({ name: "test", version: "0" }), new Map([["site1", {}]]));
    registry.registerAllTools([
      {
        name: "wp_test_counted",
        inputSchema: { type: "object", properties: {} },
        handler: async () => countedText("byte-identical", 7),
      },
    ]);
    app = startApp([{ id: "alice", tools: { all: true } }], new Map([["site1", {}]]), {
      usage,
      toolRegistry: registry,
    });
    const result = await request(app, "/mcp", {
      method: "POST",
      token: "alice",
      body: rpc("tools/call", { name: "wp_test_counted", arguments: {} }),
    });
    expect(result.payload.result.content[0].text).toBe("byte-identical");
    expect(events[0].returnedCount).toBe(7);
  });

  it("gates usage reports and always disables caching", async () => {
    const usage = {
      enqueue: vi.fn(),
      counters: () => ({ enqueued: 2, init_failures: 3, pool_errors: 4 }),
      report: vi.fn().mockResolvedValue({ total_events: 2 }),
      shutdown: vi.fn(),
    };
    app = startApp(
      [
        { id: "alice", tools: { all: true } },
        { id: "reviewer", tools: { all: true } },
      ],
      new Map(),
      { usage, usageReviewer: "reviewer" },
    );
    const health = await request(app, "/healthz");
    expect(health.payload.usage).toMatchObject({ enabled: true, init_failures: 3, pool_errors: 4 });
    for (const [token, status] of [
      [undefined, 401],
      ["alice", 403],
    ]) {
      const result = await request(app, "/admin/usage/report", { token });
      expect(result.response.statusCode).toBe(status);
      expect(result.response.getHeader("cache-control")).toBe("no-store");
    }
    const bad = await request(app, "/admin/usage/report?since=2026-01-01", { token: "reviewer" });
    expect(bad.response.statusCode).toBe(400);
    expect(bad.response.getHeader("cache-control")).toBe("no-store");
    const good = await request(app, "/admin/usage/report", { token: "reviewer" });
    expect(good.response.statusCode).toBe(200);
    expect(good.payload).toEqual({ total_events: 2 });
    expect(good.response.getHeader("cache-control")).toBe("no-store");
    usage.report.mockRejectedValueOnce(new Error("down"));
    const down = await request(app, "/admin/usage/report", { token: "reviewer" });
    expect(down.response.statusCode).toBe(503);
    expect(down.response.getHeader("cache-control")).toBe("no-store");
  });
});
