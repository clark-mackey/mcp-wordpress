import { vi } from "vitest";
import { contentView } from "@/tools/format.js";
import { PageTools } from "@/tools/pages.js";
import { PostTools } from "@/tools/posts/index.js";

describe("contentView", () => {
  const body = `${"a".repeat(500)}NEEDLE${"b".repeat(500)}NEEDLE`;

  it("returns the whole body without options", () => {
    expect(contentView("short", {})).toBe("short");
  });

  it("returns each find match with context and its offset", () => {
    const result = contentView(body, { find: "NEEDLE" });
    expect(result).toContain("2 match(es)");
    expect(result).toContain("[match 1 at char 500]");
    expect(result).toContain("[match 2 at char 1006]");
    expect(result.length).toBeLessThan(body.length);
  });

  it("says when find has no match", () => {
    expect(contentView(body, { find: "missing" })).toBe(`"missing" not found in the content (${body.length} chars).`);
  });

  it("caps find output at max_chars", () => {
    const result = contentView(body, { find: "NEEDLE", max_chars: 50 });
    expect(result).toMatch(/\[truncated at 50 chars/);
    expect(result.length).toBeLessThan(120);
  });

  it("truncates to max_chars", () => {
    expect(contentView(body, { max_chars: 10 })).toMatch(/^a{10}\n\n\[truncated: first 10 of 1012 chars/);
  });
});

describe("content view on get tools", () => {
  const raw = `<!-- wp:paragraph --><p>${"x".repeat(1000)} Hours: 9-5</p><!-- /wp:paragraph -->`;
  const item = {
    id: 1,
    title: { rendered: "T" },
    content: { raw, rendered: "" },
    excerpt: { rendered: "" },
    date: "2024-01-01T00:00:00",
    modified: "2024-01-01T00:00:00",
    status: "publish",
    link: "https://site.test/t",
  };
  let mockClient;

  beforeEach(() => {
    mockClient = {
      getPage: vi.fn().mockResolvedValue(item),
      getPost: vi.fn().mockResolvedValue(item),
      getSiteUrl: vi.fn().mockReturnValue("https://site.test"),
    };
  });

  it("wp_get_page find implies include_content and returns only the match", async () => {
    const result = await new PageTools().handleGetPage(mockClient, { id: 1, find: "Hours:" });
    expect(mockClient.getPage).toHaveBeenCalledWith(1, "edit");
    expect(result).toContain("1 match(es)");
    expect(result).not.toContain("x".repeat(500));
  });

  it("wp_get_post honors include_content=false", async () => {
    const result = await new PostTools().handleGetPost(mockClient, { id: 1, include_content: false });
    expect(mockClient.getPost).toHaveBeenCalledWith(1, "view");
    expect(result).not.toContain("## Content");
  });

  it("wp_get_post passes max_chars through", async () => {
    const result = await new PostTools().handleGetPost(mockClient, { id: 1, max_chars: 30 });
    expect(result).toContain("[truncated: first 30 of");
  });
});
