import { vi } from "vitest";
import { RestReadTools } from "@/tools/restRead.js";

describe("RestReadTools", () => {
  let tools;
  let mockClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = {
      getSiteUrl: vi.fn().mockReturnValue("https://site.test"),
      request: vi.fn().mockResolvedValue([{ id: 7, title: { rendered: "Header" } }]),
    };
    tools = new RestReadTools();
  });

  it("GETs a /wp/v2 route with _fields and query", async () => {
    const result = await tools.handleRestGet(mockClient, {
      route: "/wp-json/wp/v2/template-parts/",
      fields: ["id", "title"],
      query: { search: "header", per_page: 5 },
    });

    expect(mockClient.request).toHaveBeenCalledWith(
      "GET",
      "https://site.test/wp-json/wp/v2/template-parts?search=header&per_page=5&_fields=id%2Ctitle",
    );
    expect(result).toBe('[{"id":7,"title":{"rendered":"Header"}}]');
  });

  it("truncates long responses", async () => {
    mockClient.request.mockResolvedValueOnce({ content: "x".repeat(100) });
    const result = await tools.handleRestGet(mockClient, { route: "blocks/3", max_chars: 20 });
    expect(result).toMatch(/^\{"content":"x{8}\n\n\[truncated: first 20 of \d+ chars/);
  });

  it.each(["users/me", "settings", "application-passwords", "Plugins", "comments"])(
    "refuses the denied route %s",
    async (route) => {
      await expect(tools.handleRestGet(mockClient, { route })).rejects.toThrow(/does not read/);
      expect(mockClient.request).not.toHaveBeenCalled();
    },
  );

  it.each(["../wp/v2/users", "types?x=1", "https://evil.test/x"])(
    "refuses a malformed or foreign route %s",
    async (route) => {
      await expect(tools.handleRestGet(mockClient, { route })).rejects.toThrow();
      expect(mockClient.request).not.toHaveBeenCalledWith("GET", expect.stringContaining("evil"));
    },
  );

  it.each([{ _method: "DELETE", force: true }, { rest_route: "/wp/v2/users/me" }, { _embed: 1 }, { _fields: "id" }])(
    "refuses override query %o",
    async (query) => {
      await expect(tools.handleRestGet(mockClient, { route: "posts/42", query })).rejects.toThrow(/not allowed/);
      expect(mockClient.request).not.toHaveBeenCalled();
    },
  );

  it("refuses non-scalar query values", async () => {
    await expect(tools.handleRestGet(mockClient, { route: "types", query: { a: { b: 1 } } })).rejects.toThrow(
      /query.a/,
    );
  });
});
