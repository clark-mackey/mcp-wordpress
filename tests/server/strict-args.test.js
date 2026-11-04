import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { vi } from "vitest";
import { ToolRegistry } from "@/server/ToolRegistry.js";

// Through the real SDK: an argument a tool does not declare must fail the call, not vanish.
describe("unknown tool arguments through the MCP SDK", () => {
  let client;
  let handler;

  beforeEach(async () => {
    vi.stubEnv("MCP_WORDPRESS_DEFAULT_SITE", undefined);
    handler = vi.fn().mockResolvedValue("updated");
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const registry = new ToolRegistry(server, new Map([["default", {}]]));
    registry.registerTool({
      name: "wp_update_thing",
      description: "test",
      inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
      handler,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "c", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("rejects an undeclared argument and names the accepted ones", async () => {
    const result = await client.callTool({ name: "wp_update_thing", arguments: { id: 1, parent: 5 } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown argument(s): parent. wp_update_thing accepts: site, id.");
    expect(handler).not.toHaveBeenCalled();
  });

  it("still runs a call with only declared arguments", async () => {
    const result = await client.callTool({ name: "wp_update_thing", arguments: { id: 1 } });
    expect(result.isError).not.toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });
});
