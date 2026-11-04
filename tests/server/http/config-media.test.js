import { vi } from "vitest";

const mockReadFile = vi.fn();
const mockAccess = vi.fn();
const mockDotenvConfig = vi.fn();

vi.mock("dotenv", () => ({ default: { config: mockDotenvConfig } }));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, promises: { ...actual.promises, access: mockAccess, readFile: mockReadFile } };
});

const { ServerConfiguration } = await import("@/config/ServerConfiguration.js");
const { MediaTools } = await import("@/tools/media.js");

const validConfig = JSON.stringify({
  sites: [
    {
      id: "site1",
      name: "Site One",
      config: {
        WORDPRESS_SITE_URL: "https://example.com",
        WORDPRESS_USERNAME: "admin",
        WORDPRESS_APP_PASSWORD: "abcd1234efgh5678",
      },
    },
  ],
});

describe("hosted configuration and media restrictions", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDotenvConfig.mockReturnValue({});
    process.env.MCP_TRANSPORT = "http";
    process.env.MCP_WORDPRESS_CONFIG_JSON = validConfig;
    process.env.MCP_WORDPRESS_ALLOW_MULTI_SITE = "true";
    delete process.env.MCP_WORDPRESS_CONFIG;
  });

  afterAll(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it("loads the in-memory multi-site JSON before any file lookup", async () => {
    process.env.MCP_WORDPRESS_CONFIG = "/not-used/config.json";
    const result = await ServerConfiguration.getInstance().loadClientConfigurations();
    expect([...result.clients.keys()]).toEqual(["site1"]);
    expect(ServerConfiguration.getInstance().getLoadInfo()).toMatchObject({ source: "env", siteIds: ["site1"] });
    expect(mockAccess).not.toHaveBeenCalled();
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("fails on invalid present JSON without falling back to disk", async () => {
    process.env.MCP_WORDPRESS_CONFIG_JSON = "{";
    await expect(ServerConfiguration.getInstance().loadClientConfigurations()).rejects.toThrow(
      "Failed to load multi-site configuration",
    );
    expect(mockAccess).not.toHaveBeenCalled();
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("refuses hosted local uploads before validating or opening the file", async () => {
    const client = { uploadMedia: vi.fn() };
    await expect(new MediaTools().handleUploadMedia(client, { file_path: "/does/not/exist.jpg" })).rejects.toThrow(
      "file_path uploads are disabled in hosted HTTP mode",
    );
    expect(client.uploadMedia).not.toHaveBeenCalled();
  });
});
