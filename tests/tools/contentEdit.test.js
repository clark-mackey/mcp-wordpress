import { vi } from "vitest";
import { ContentEditTools } from "@/tools/contentEdit.js";

describe("ContentEditTools", () => {
  let tools;
  let mockClient;
  const raw =
    "<!-- wp:paragraph --><p>Call us today.</p><!-- /wp:paragraph -->" +
    "<!-- wp:paragraph --><p>Book a consult. Call us today.</p><!-- /wp:paragraph -->";

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = {
      getSiteUrl: vi.fn().mockReturnValue("https://site.test"),
      requestWithMetadata: vi.fn().mockResolvedValue({ data: { id: 5, content: { raw, rendered: "" } }, headers: {} }),
      updatePage: vi
        .fn()
        .mockImplementation(async ({ id, content }) => ({ id, status: "publish", content: { raw: content } })),
      updatePost: vi
        .fn()
        .mockImplementation(async ({ id, content }) => ({ id, status: "draft", content: { raw: content } })),
    };
    tools = new ContentEditTools();
  });

  it("exposes wp_edit_content", () => {
    const [tool] = tools.getTools();
    expect(tool.name).toBe("wp_edit_content");
    expect(tool.inputSchema.required).toEqual(["id", "edits"]);
  });

  it("applies a unique replacement and sends only the edited body", async () => {
    const result = await tools.handleEditContent(mockClient, {
      id: 5,
      edits: [{ old_string: "Book a consult.", new_string: "Book a free consult." }],
    });

    expect(mockClient.requestWithMetadata).toHaveBeenCalledWith(
      "GET",
      "https://site.test/wp-json/wp/v2/pages/5?context=edit",
      null,
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    expect(mockClient.updatePage).toHaveBeenCalledWith({
      id: 5,
      content: raw.replace("Book a consult.", "Book a free consult."),
    });
    expect(result).toContain("Page 5 edited (1 edit");
    expect(result).toContain("Edit 1: 1 replacement");
    expect(result).not.toContain("Book a free consult");
  });

  it("refuses an ambiguous match without saving", async () => {
    await expect(
      tools.handleEditContent(mockClient, {
        id: 5,
        edits: [{ old_string: "Call us today.", new_string: "Call now." }],
      }),
    ).rejects.toThrow(/matches 2 times/);
    expect(mockClient.updatePage).not.toHaveBeenCalled();
  });

  it("replaces every match with replace_all", async () => {
    const result = await tools.handleEditContent(mockClient, {
      id: 5,
      edits: [{ old_string: "Call us today.", new_string: "Call now.", replace_all: true }],
    });
    expect(mockClient.updatePage.mock.calls[0][0].content).not.toContain("Call us today.");
    expect(result).toContain("2 replacements");
  });

  it("saves nothing when a later edit fails", async () => {
    await expect(
      tools.handleEditContent(mockClient, {
        id: 5,
        edits: [
          { old_string: "Book a consult.", new_string: "Book now." },
          { old_string: "not on the page", new_string: "x" },
        ],
      }),
    ).rejects.toThrow(/Edit 2: old_string not found/);
    expect(mockClient.updatePage).not.toHaveBeenCalled();
  });

  it("does not expand $ patterns in new_string", async () => {
    await tools.handleEditContent(mockClient, {
      id: 5,
      edits: [{ old_string: "Book a consult.", new_string: "Only $& $1 today." }],
    });
    expect(mockClient.updatePage.mock.calls[0][0].content).toContain("Only $& $1 today.");
  });

  it("refuses to save unsafe content", async () => {
    await expect(
      tools.handleEditContent(mockClient, {
        id: 5,
        edits: [{ old_string: "Book a consult.", new_string: "<script>alert(1)</script>" }],
      }),
    ).rejects.toThrow(/Unsafe content/);
    expect(mockClient.updatePage).not.toHaveBeenCalled();
  });

  it("edits posts through the post endpoints", async () => {
    await tools.handleEditContent(mockClient, {
      post_type: "post",
      id: 6,
      edits: [{ old_string: "Book a consult.", new_string: "Book." }],
    });
    expect(mockClient.requestWithMetadata.mock.calls[0][1]).toBe(
      "https://site.test/wp-json/wp/v2/posts/6?context=edit",
    );
    expect(mockClient.updatePost).toHaveBeenCalled();
    expect(mockClient.updatePage).not.toHaveBeenCalled();
  });

  it("warns when WordPress alters the content on save", async () => {
    mockClient.updatePage.mockResolvedValueOnce({ id: 5, status: "publish", content: { raw: "filtered" } });
    const result = await tools.handleEditContent(mockClient, {
      id: 5,
      edits: [{ old_string: "Book a consult.", new_string: "Book." }],
    });
    expect(result).toContain("WordPress changed the content while saving");
  });

  it("refuses when raw content is unavailable", async () => {
    mockClient.requestWithMetadata.mockResolvedValueOnce({
      data: { id: 5, content: { rendered: "<p>x</p>" } },
      headers: {},
    });
    await expect(
      tools.handleEditContent(mockClient, { id: 5, edits: [{ old_string: "x", new_string: "y" }] }),
    ).rejects.toThrow(/without raw content/);
  });

  it("rejects an empty edit list and empty old_string", async () => {
    await expect(tools.handleEditContent(mockClient, { id: 5, edits: [] })).rejects.toThrow(/at least one/);
    await expect(
      tools.handleEditContent(mockClient, { id: 5, edits: [{ old_string: "", new_string: "y" }] }),
    ).rejects.toThrow(/old_string \(non-empty\)/);
  });

  it("refuses to edit from a page-cached response", async () => {
    mockClient.requestWithMetadata.mockResolvedValueOnce({
      data: { id: 5, content: { raw, rendered: "" } },
      headers: { "x-litespeed-cache": "hit" },
    });
    await expect(
      tools.handleEditContent(mockClient, { id: 5, edits: [{ old_string: "Book a consult.", new_string: "Book." }] }),
    ).rejects.toThrow(/page cache answered/);
    expect(mockClient.updatePage).not.toHaveBeenCalled();
  });
});
