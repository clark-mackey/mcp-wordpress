import express from "express";
import { randomUUID } from "node:crypto";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import type { WordPressClient } from "../../client/api.js";
import { WordPressAPIError } from "../../types/client.js";
import { ToolRegistry } from "../ToolRegistry.js";
import type { ToolExecutionHooks } from "../ToolRegistry.js";
import { LoggerFactory } from "../../utils/logger.js";
import { getVersion } from "../../utils/version.js";
import { grantAllows, HOSTED_ADMIN_TOOLS } from "./contract.js";
import type { HostedAuth, Principal, ToolGrant } from "./contract.js";
import { parseClient, usagePayload } from "./usage/payload.js";
import type { UsageEvent, UsageRecorder } from "./usage/types.js";

export interface HostedAppOptions {
  publicBaseUrl: URL;
  auth: HostedAuth;
  wordpressClients: Map<string, WordPressClient>;
  toolRegistry?: ToolRegistry | undefined;
  usage?: UsageRecorder | undefined;
  usageReviewer?: string | null | undefined;
  usageRetentionDays?: number | undefined;
}

interface UsageExecutionHookOptions {
  principalId: string;
  client: ReturnType<typeof parseClient>;
  bootId: string;
  version: string;
  isConfiguredSite(siteId: string): boolean;
  isReleased(): boolean;
  markStarted(): void;
  release(): void;
  enqueue(event: UsageEvent): void;
}

export function createUsageExecutionHooks(options: UsageExecutionHookOptions): ToolExecutionHooks {
  let startedAt: Date | undefined;
  return {
    start: ({ toolName, args }) => {
      startedAt = new Date();
      if (options.isReleased()) {
        const endedAt = new Date();
        options.enqueue({
          attemptId: randomUUID(),
          eventType: "tool_call",
          startedAt,
          endedAt,
          bootId: options.bootId,
          principalId: options.principalId,
          clientName: options.client.name,
          clientVersion: options.client.version,
          toolName,
          siteId: typeof args.site === "string" && options.isConfiguredSite(args.site) ? args.site : null,
          outcome: "cancelled",
          errorClass: "REQUEST_CLOSED",
          durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
          resultBytes: 0,
          returnedCount: null,
          serverVersion: options.version,
          payload: usagePayload(toolName, args),
        });
        throw new WordPressAPIError("Request closed before tool execution", undefined, "REQUEST_CLOSED");
      }
      options.markStarted();
    },
    end: (event) => {
      options.release();
      const endedAt = new Date();
      options.enqueue({
        attemptId: randomUUID(),
        eventType: "tool_call",
        startedAt: startedAt ?? new Date(endedAt.getTime() - event.durationMs),
        endedAt,
        bootId: options.bootId,
        principalId: options.principalId,
        clientName: options.client.name,
        clientVersion: options.client.version,
        toolName: event.toolName,
        siteId: event.siteId !== null && options.isConfiguredSite(event.siteId) ? event.siteId : null,
        outcome: event.outcome,
        errorClass: event.errorClass,
        durationMs: event.durationMs,
        resultBytes: event.resultBytes,
        returnedCount: event.returnedCount,
        serverVersion: options.version,
        payload: usagePayload(event.toolName, event.args),
      });
    },
  };
}

function grantKey(grant: ToolGrant): string {
  if ("all" in grant) return "all";
  if ("allow" in grant) return JSON.stringify(["allow", [...new Set(grant.allow)].sort()]);
  return JSON.stringify(["deny", [...new Set(grant.deny)].sort()]);
}

export function createHostedApp({
  publicBaseUrl,
  auth,
  wordpressClients,
  toolRegistry,
  usage,
  usageReviewer,
  usageRetentionDays = 90,
}: HostedAppOptions): express.Express {
  const app = express();
  const bootId = randomUUID();
  const version = getVersion();
  const safeEnqueue = (event: UsageEvent) => {
    try {
      usage?.enqueue(event);
    } catch {
      // Usage recording is deliberately isolated from the request path.
    }
  };
  app.set("trust proxy", 1);
  // Before the Host check: Railway's healthcheck probes with its own Host. The response holds no secrets.
  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      version,
      sites: wordpressClients.size,
      usage: usage ? { enabled: true, ...usage.counters() } : { enabled: false },
    });
  });
  app.use(hostHeaderValidation([publicBaseUrl.hostname]));
  app.use(express.json({ limit: "1mb" }));
  const registries = new Map<string, ToolRegistry>();
  const inFlight = new Map<string, number>();
  const adminTools = new Set<string>(HOSTED_ADMIN_TOOLS);
  const newServer = () => new McpServer({ name: "mcp-wordpress", version });
  const catalog = toolRegistry ?? new ToolRegistry(newServer(), wordpressClients);
  if (!toolRegistry) catalog.registerAllTools();
  const catalogToolNames = new Set(catalog.getToolNames());
  const registryFor = (principal: Principal) => {
    const key = grantKey(principal.tools);
    let registry = registries.get(key);
    if (!registry) {
      registry = catalog.createFiltered(
        newServer(),
        (name) => !adminTools.has(name) && grantAllows(principal.tools, name),
      );
      registries.set(key, registry);
    }
    return registry;
  };
  for (const principal of auth.principals.values()) registryFor(principal);

  auth.install(app);
  app.get(
    "/admin/usage/report",
    (_req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      next();
    },
    auth.requireAuth,
    async (req, res) => {
      if (!usageReviewer || !usage) {
        res.sendStatus(404);
        return;
      }
      const principal = res.locals.principal as Principal;
      if (principal.id !== usageReviewer) {
        res.sendStatus(403);
        return;
      }
      const keys = Object.keys(req.query);
      if (keys.some((key) => key !== "since" && key !== "until")) {
        res.status(400).json({ error: "Invalid report parameters." });
        return;
      }
      const parseTimestamp = (name: "since" | "until"): Date | undefined => {
        const value = req.query[name];
        if (value === undefined) return undefined;
        if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return new Date(NaN);
        return new Date(value);
      };
      const now = new Date();
      let since = parseTimestamp("since") ?? new Date(now.getTime() - 30 * 86400_000);
      const until = parseTimestamp("until") ?? now;
      const retentionCutoff = new Date(now.getTime() - usageRetentionDays * 86400_000);
      if (
        Number.isNaN(since.getTime()) ||
        Number.isNaN(until.getTime()) ||
        since >= until ||
        until.getTime() - since.getTime() > 92 * 86400_000
      ) {
        res.status(400).json({ error: "Invalid report parameters." });
        return;
      }
      if (since < retentionCutoff) since = retentionCutoff;
      try {
        res.json(await usage.report({ since, until }));
      } catch {
        res.status(503).json({ error: "Usage report is temporarily unavailable." });
      }
    },
  );
  app
    .route("/mcp")
    .get((_req, res) => {
      res.sendStatus(405);
    })
    .delete((_req, res) => {
      res.sendStatus(405);
    });
  app.post("/mcp", auth.requireAuth, async (req, res, next) => {
    const principal = res.locals.principal as Principal;
    const client = usage ? parseClient(req.get("user-agent")) : { name: null, version: null };
    // A batch would hide its tools/call messages from the per-principal limit below.
    if (Array.isArray(req.body)) {
      res.status(400).json({ error: "Batch requests are not supported." });
      return;
    }
    const isToolCall = req.body?.method === "tools/call";
    const requestStartedAt = new Date();
    const count = inFlight.get(principal.id) ?? 0;
    if (isToolCall && count >= 4) {
      const now = new Date();
      safeEnqueue({
        attemptId: randomUUID(),
        eventType: "rejection",
        startedAt: now,
        endedAt: now,
        bootId,
        principalId: principal.id,
        clientName: client.name,
        clientVersion: client.version,
        toolName: null,
        siteId: null,
        outcome: "concurrency_limited",
        errorClass: null,
        durationMs: 0,
        resultBytes: 0,
        returnedCount: null,
        serverVersion: version,
        payload: {},
      });
      res.status(429).json({ error: "At most 4 tool calls may be in flight per principal." });
      return;
    }
    if (isToolCall) inFlight.set(principal.id, count + 1);
    let started = false;
    let released = false;
    let cancelled = false;
    const release = () => {
      if (!isToolCall || released) return;
      released = true;
      const remaining = (inFlight.get(principal.id) ?? 1) - 1;
      if (remaining === 0) inFlight.delete(principal.id);
      else inFlight.set(principal.id, remaining);
    };
    const server = newServer();
    // Omitting sessionIdGenerator leaves it undefined (stateless mode).
    const transport = new StreamableHTTPServerTransport({});
    res.on("close", () => {
      if (!started) {
        cancelled = !res.writableEnded;
        release();
      }
      void server.close().catch(next);
      void transport.close().catch(next);
    });
    try {
      const execution: ToolExecutionHooks = usage
        ? createUsageExecutionHooks({
            principalId: principal.id,
            client,
            bootId,
            version,
            isConfiguredSite: (siteId) => wordpressClients.has(siteId),
            isReleased: () => released,
            markStarted: () => {
              started = true;
            },
            release,
            enqueue: safeEnqueue,
          })
        : {
            start: () => {
              if (released)
                throw new WordPressAPIError("Request closed before tool execution", undefined, "REQUEST_CLOSED");
              started = true;
            },
            end: release,
          };
      const registry = registryFor(principal);
      registry.attachTo(server, execution);
      // SDK transport declarations differ on optional callbacks under exactOptionalPropertyTypes.
      await server.connect(transport as Transport);
      await transport.handleRequest(req, res, req.body);
      if (usage && isToolCall && !started && !cancelled) {
        release();
        const endedAt = new Date();
        const requestedName = typeof req.body?.params?.name === "string" ? req.body.params.name : null;
        const toolName = requestedName !== null && catalogToolNames.has(requestedName) ? requestedName : null;
        // Arguments the SDK rejected were never validated: keep only a configured site, never their keys or values.
        const site: unknown = req.body?.params?.arguments?.site;
        safeEnqueue({
          attemptId: randomUUID(),
          eventType: "tool_call",
          startedAt: requestStartedAt,
          endedAt,
          bootId,
          principalId: principal.id,
          clientName: client.name,
          clientVersion: client.version,
          toolName,
          siteId: typeof site === "string" && wordpressClients.has(site) ? site : null,
          outcome: "not_dispatched",
          errorClass:
            res.statusCode >= 400
              ? "transport_rejected"
              : requestedName !== null && registry.getToolNames().includes(requestedName)
                ? "invalid_arguments"
                : "unknown_tool",
          durationMs: Math.max(0, endedAt.getTime() - requestStartedAt.getTime()),
          resultBytes: 0,
          returnedCount: null,
          serverVersion: version,
          payload: {},
        });
      }
    } catch (error) {
      if (!started) release();
      next(error);
    }
  });
  const handleError: express.ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const status = typeof error?.status === "number" && error.status >= 400 && error.status < 600 ? error.status : 500;
    if (status >= 500) LoggerFactory.server().error("Hosted HTTP request failed", { error });
    res.status(status).json({ error: status === 413 ? "Request body exceeds 1 MB" : "Request failed" });
  };
  app.use(handleError);
  return app;
}
