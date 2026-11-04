import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "@/server/ToolRegistry.js";

const clients = new Map([
  ["site1", { id: "site1" }],
  ["site2", { id: "site2" }],
]);

afterEach(() => vi.unstubAllEnvs());

describe("default site routing", () => {
  it.each([
    [undefined, "site2"],
    ["site1", "site1"],
  ])("routes site=%s to %s", async (site, expected) => {
    vi.stubEnv("MCP_WORDPRESS_DEFAULT_SITE", "site2");
    let registered;
    const server = {
      registerTool: vi.fn((_name, { inputSchema }, handler) => {
        registered = { schema: inputSchema.shape, handler };
      }),
    };
    const handler = vi.fn().mockResolvedValue("ok");
    const tool = { name: "wp_test_default", inputSchema: { type: "object", properties: {} }, handler };
    const registry = new ToolRegistry(server, clients);
    registry.registerTool(tool);

    const input = site === undefined ? {} : { site };
    const parsed = z.object(registered.schema).parse(input);
    const result = await registered.handler(parsed);
    expect(result.isError).not.toBe(true);
    expect(handler).toHaveBeenCalledWith(clients.get(expected), parsed);
    const cached = registry.buildCachedInputSchema(tool);
    expect(cached.required ?? []).not.toContain("site");
    expect(cached.properties.site.description).toBe('Site ID; defaults to "site2" when omitted.');
    expect(registered.schema.site.description).toBe(cached.properties.site.description);
  });

  it("rejects an explicit unknown site instead of using the default", async () => {
    vi.stubEnv("MCP_WORDPRESS_DEFAULT_SITE", "site2");
    let call;
    const server = {
      registerTool: vi.fn((_name, _config, handler) => {
        call = handler;
      }),
    };
    const handler = vi.fn();
    const registry = new ToolRegistry(server, clients);
    registry.registerTool({ name: "wp_test_default", handler });
    expect((await call({ site: "missing" })).isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it("requires site when no default is set", () => {
    vi.stubEnv("MCP_WORDPRESS_DEFAULT_SITE", undefined);
    let schema;
    const server = {
      registerTool: vi.fn((_name, { inputSchema }) => {
        schema = inputSchema.shape;
      }),
    };
    const registry = new ToolRegistry(server, clients);
    const tool = { name: "wp_test_default", handler: vi.fn() };
    registry.registerTool(tool);
    expect(z.object(schema).safeParse({}).success).toBe(false);
    expect(registry.buildCachedInputSchema(tool).required).toContain("site");
  });

  it("fails immediately for a default that is not configured", () => {
    vi.stubEnv("MCP_WORDPRESS_DEFAULT_SITE", "missing");
    expect(() => new ToolRegistry({}, clients)).toThrow(/MCP_WORDPRESS_DEFAULT_SITE.*missing.*site1, site2/);
  });
});

describe("ConfigurationValidator.validateDefaultSite", () => {
  it("treats a blank value as no default", async () => {
    const { ConfigurationValidator } = await import("@/config/ConfigurationSchema.js");
    expect(ConfigurationValidator.validateDefaultSite("  ", ["a", "b"])).toBeUndefined();
    expect(() => ConfigurationValidator.validateDefaultSite("c", ["a", "b"])).toThrow(/Configured site IDs: a, b/);
  });
});
