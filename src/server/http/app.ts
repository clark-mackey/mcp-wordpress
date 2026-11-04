import express from "express";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import type { WordPressClient } from "../../client/api.js";
import { WordPressAPIError } from "../../types/client.js";
import { ToolRegistry } from "../ToolRegistry.js";
import { LoggerFactory } from "../../utils/logger.js";
import { getVersion } from "../../utils/version.js";
import { grantAllows, HOSTED_ADMIN_TOOLS } from "./contract.js";
import type { HostedAuth, Principal, ToolGrant } from "./contract.js";

export interface HostedAppOptions {
  publicBaseUrl: URL;
  auth: HostedAuth;
  wordpressClients: Map<string, WordPressClient>;
  toolRegistry?: ToolRegistry | undefined;
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
}: HostedAppOptions): express.Express {
  const app = express();
  app.set("trust proxy", 1);
  // Before the Host check: Railway's healthcheck probes with its own Host. The response holds no secrets.
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, version: getVersion(), sites: wordpressClients.size });
  });
  app.use(hostHeaderValidation([publicBaseUrl.hostname]));
  app.use(express.json({ limit: "1mb" }));
  const registries = new Map<string, ToolRegistry>();
  const inFlight = new Map<string, number>();
  const adminTools = new Set<string>(HOSTED_ADMIN_TOOLS);
  const newServer = () => new McpServer({ name: "mcp-wordpress", version: getVersion() });
  const catalog = toolRegistry ?? new ToolRegistry(newServer(), wordpressClients);
  if (!toolRegistry) catalog.registerAllTools();
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
    // A batch would hide its tools/call messages from the per-principal limit below.
    if (Array.isArray(req.body)) {
      res.status(400).json({ error: "Batch requests are not supported." });
      return;
    }
    const isToolCall = req.body?.method === "tools/call";
    const count = inFlight.get(principal.id) ?? 0;
    if (isToolCall && count >= 4) {
      res.status(429).json({ error: "At most 4 tool calls may be in flight per principal." });
      return;
    }
    if (isToolCall) inFlight.set(principal.id, count + 1);
    let started = false;
    let released = false;
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
      if (!started) release();
      void server.close().catch(next);
      void transport.close().catch(next);
    });
    try {
      registryFor(principal).attachTo(server, {
        start: () => {
          if (released)
            throw new WordPressAPIError("Request closed before tool execution", undefined, "REQUEST_CLOSED");
          started = true;
        },
        end: release,
      });
      // SDK transport declarations differ on optional callbacks under exactOptionalPropertyTypes.
      await server.connect(transport as Transport);
      await transport.handleRequest(req, res, req.body);
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
