import { describe, it, expect, afterEach } from "vitest";
import nock from "nock";
import { WordPressClient } from "@/client/api.js";
import { SiteTools } from "@/tools/site.js";

const baseUrl = "https://search.example.com";

afterEach(() => {
  nock.abortPendingRequests();
  nock.cleanAll();
});

describe("wp_search_site REST filters", () => {
  it.each([
    ["posts", "post"],
    ["pages", "page"],
    ["media", "attachment"],
    ["post", "post"],
    ["page", "page"],
    ["attachment", "attachment"],
  ])("maps %s to type=post and subtype=%s", async (type, subtype) => {
    const client = new WordPressClient({
      baseUrl,
      auth: { method: "app-password", username: "testuser", appPassword: "testpass123" },
    });
    const request = nock(baseUrl)
      .get("/wp-json/wp/v2/search")
      .query({ search: "about & contact", type: "post", subtype })
      .reply(200, []);

    const tool = new SiteTools().getTools().find((tool) => tool.name === "wp_search_site");
    expect(tool.inputSchema.properties.type.enum).toContain(type);
    await expect(tool.handler(client, { term: "about & contact", type })).resolves.toContain("No results");
    expect(request.isDone()).toBe(true);
  });

  it("leaves an unfiltered search unfiltered", async () => {
    const client = new WordPressClient({
      baseUrl,
      auth: { method: "app-password", username: "testuser", appPassword: "testpass123" },
    });
    const request = nock(baseUrl).get("/wp-json/wp/v2/search").query({ search: "about" }).reply(200, []);
    await new SiteTools().handleSearchSite(client, { term: "about" });
    expect(request.isDone()).toBe(true);
  });
});
