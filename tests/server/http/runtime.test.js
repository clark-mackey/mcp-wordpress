import { URL } from "node:url";
import { EventEmitter } from "node:events";
import { vi, describe, it, expect, afterEach } from "vitest";
import { getTransport, getHostedConfiguration, drainHostedServer, loadHostedAuth } from "@/server/http/runtime.js";
import { createHostedApp } from "@/server/http/app.js";
import { ServerConfiguration } from "@/config/ServerConfiguration.js";
import { ConnectionTester } from "@/server/ConnectionTester.js";
import { MCPWordPressServer } from "@/index.js";

vi.mock("@/server/http/runtime.js", async (original) => ({ ...(await original()), loadHostedAuth: vi.fn() }));
vi.mock("@/server/http/app.js", () => ({ createHostedApp: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("hosted runtime configuration", () => {
  it("defaults to stdio and accepts explicit modes", () => {
    expect(getTransport({})).toBe("stdio");
    expect(getTransport({ MCP_TRANSPORT: "stdio" })).toBe("stdio");
    expect(getTransport({ MCP_TRANSPORT: "http" })).toBe("http");
    expect(() => getTransport({ MCP_TRANSPORT: "other" })).toThrow("MCP_TRANSPORT");
  });

  it.each([
    undefined,
    "",
    "not a URL",
    "http://example.com",
    "https://example.com/path",
    "https://example.com/?x=1",
    "https://example.com/#x",
    "https://user:pass@example.com",
  ])("rejects PUBLIC_BASE_URL=%s", (PUBLIC_BASE_URL) => {
    expect(() => getHostedConfiguration({ PUBLIC_BASE_URL })).toThrow("PUBLIC_BASE_URL");
  });

  it("accepts an https origin and defaults PORT to 3000", () => {
    expect(getHostedConfiguration({ PUBLIC_BASE_URL: "https://example.com" })).toEqual({
      publicBaseUrl: new URL("https://example.com"),
      port: 3000,
    });
    expect(getHostedConfiguration({ PUBLIC_BASE_URL: "https://example.com/", PORT: "8080" }).port).toBe(8080);
    expect(() => getHostedConfiguration({ PUBLIC_BASE_URL: "https://example.com", PORT: "NaN" })).toThrow("PORT");
  });

  it("drains pending requests and forces connections closed after 25 seconds", async () => {
    vi.useFakeTimers();
    let finish;
    const listener = {
      close: vi.fn((callback) => {
        finish = callback;
      }),
      closeAllConnections: vi.fn(),
    };
    const draining = drainHostedServer(listener);
    expect(listener.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(24999);
    expect(listener.closeAllConnections).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await draining;
    expect(listener.closeAllConnections).toHaveBeenCalledOnce();
    finish();
  });

  it("finishes shutdown as soon as all requests finish", async () => {
    vi.useFakeTimers();
    const listener = { close: vi.fn((callback) => callback()), closeAllConnections: vi.fn() };
    await drainHostedServer(listener);
    await vi.advanceTimersByTimeAsync(25000);
    expect(listener.closeAllConnections).not.toHaveBeenCalled();
  });
});

describe("transport selection in the entrypoint", () => {
  function configure() {
    vi.spyOn(ServerConfiguration.getInstance(), "loadClientConfigurations").mockResolvedValue({
      clients: new Map([["site1", {}]]),
      configs: [],
    });
    return vi.spyOn(ConnectionTester, "testClientConnections").mockResolvedValue(undefined);
  }

  it("keeps connection testing, stdio connection and stdin resume by default", async () => {
    vi.stubEnv("MCP_TRANSPORT", undefined);
    vi.stubEnv("DXT", undefined);
    const testConnections = configure();
    const server = new MCPWordPressServer();
    const connect = vi.spyOn(server, "connectWithTimeout").mockResolvedValue(undefined);
    const resume = vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
    await server.run();
    expect(testConnections).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ start: expect.any(Function) }), 30000);
    expect(resume).toHaveBeenCalledOnce();
    expect(loadHostedAuth).not.toHaveBeenCalled();
    await server.shutdown();
  });

  it("builds shared clients once, loads auth, and skips WordPress probes in HTTP mode", async () => {
    vi.stubEnv("MCP_TRANSPORT", "http");
    vi.stubEnv("PUBLIC_BASE_URL", "https://example.com");
    vi.stubEnv("PORT", "3000");
    const testConnections = configure();
    const listener = new EventEmitter();
    listener.close = vi.fn((callback) => callback());
    listener.closeAllConnections = vi.fn();
    const listen = vi.fn((_port, callback) => {
      Promise.resolve().then(callback);
      return listener;
    });
    createHostedApp.mockReturnValue({ listen });
    const auth = { install: vi.fn(), requireAuth: vi.fn(), principals: new Map() };
    loadHostedAuth.mockResolvedValue(auth);
    const server = new MCPWordPressServer();
    await server.run();
    expect(testConnections).not.toHaveBeenCalled();
    expect(ServerConfiguration.getInstance().loadClientConfigurations).toHaveBeenCalledOnce();
    expect(loadHostedAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        publicBaseUrl: new URL("https://example.com"),
        knownToolNames: expect.arrayContaining(["wp_create_user", "wp_list_posts"]),
      }),
    );
    expect(createHostedApp).toHaveBeenCalledWith(expect.objectContaining({ auth, wordpressClients: expect.any(Map) }));
    expect(listen).toHaveBeenCalledWith(3000, expect.any(Function));
    await server.shutdown();
    expect(listener.close).toHaveBeenCalledOnce();
  });
});
