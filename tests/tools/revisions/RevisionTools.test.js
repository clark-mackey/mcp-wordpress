import { vi } from "vitest";
import { RevisionTools } from "@/tools/revisions.js";

describe("RevisionTools", () => {
  let revisionTools;
  let mockClient;

  const pageRevision = {
    id: 20,
    parent: 2,
    author: 1,
    date: "2024-01-15T14:30:00",
    modified: "2024-01-15T14:30:00",
    title: { rendered: "Old Title", raw: "Old Title" },
    content: { rendered: "<p>Old</p>", raw: "<!-- wp:paragraph --><p>Old</p><!-- /wp:paragraph -->" },
    excerpt: { rendered: "<p>Old excerpt</p>", raw: "Old excerpt" },
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockClient = {
      getPageRevision: vi.fn(),
      getPostRevision: vi.fn(),
      updatePage: vi.fn().mockResolvedValue({ id: 2, status: "publish", link: "https://test-site.com/page" }),
      updatePost: vi.fn().mockResolvedValue({ id: 3, status: "draft", link: "https://test-site.com/post" }),
    };

    revisionTools = new RevisionTools();
  });

  it("exposes wp_restore_revision", () => {
    const tools = revisionTools.getTools();

    expect(tools.map((t) => t.name)).toEqual(["wp_restore_revision"]);
    expect(tools[0].inputSchema.required).toEqual(["parent_id", "revision_id"]);
  });

  it("restores a page from the revision's raw title, content and excerpt", async () => {
    mockClient.getPageRevision.mockResolvedValueOnce(pageRevision);

    const result = await revisionTools.handleRestoreRevision(mockClient, { parent_id: 2, revision_id: 20 });

    expect(mockClient.getPageRevision).toHaveBeenCalledWith(2, 20);
    expect(mockClient.updatePage).toHaveBeenCalledWith({
      id: 2,
      title: "Old Title",
      content: "<!-- wp:paragraph --><p>Old</p><!-- /wp:paragraph -->",
      excerpt: "Old excerpt",
    });
    expect(mockClient.updatePost).not.toHaveBeenCalled();
    expect(result).toContain("Page 2 restored to revision 20");
    expect(result).toContain("Status unchanged: publish");
  });

  it("restores a post through the post endpoints", async () => {
    mockClient.getPostRevision.mockResolvedValueOnce({ ...pageRevision, id: 30, parent: 3 });

    const result = await revisionTools.handleRestoreRevision(mockClient, {
      post_type: "post",
      parent_id: 3,
      revision_id: 30,
    });

    expect(mockClient.getPostRevision).toHaveBeenCalledWith(3, 30);
    expect(mockClient.updatePost).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }));
    expect(mockClient.updatePage).not.toHaveBeenCalled();
    expect(result).toContain("Post 3 restored to revision 30");
  });

  it("omits fields the revision does not carry", async () => {
    const { excerpt: _excerpt, ...noExcerpt } = pageRevision;
    mockClient.getPageRevision.mockResolvedValueOnce(noExcerpt);

    await revisionTools.handleRestoreRevision(mockClient, { parent_id: 2, revision_id: 20 });

    expect(mockClient.updatePage.mock.calls[0][0]).not.toHaveProperty("excerpt");
  });

  it("refuses when the revision has no raw content", async () => {
    mockClient.getPageRevision.mockResolvedValueOnce({ ...pageRevision, content: { rendered: "<p>Old</p>" } });

    await expect(revisionTools.handleRestoreRevision(mockClient, { parent_id: 2, revision_id: 20 })).rejects.toThrow(
      "edit permission",
    );
    expect(mockClient.updatePage).not.toHaveBeenCalled();
  });

  it("refuses to restore unsafe content", async () => {
    mockClient.getPageRevision.mockResolvedValueOnce({
      ...pageRevision,
      content: { rendered: "", raw: "<script>alert(1)</script>" },
    });

    await expect(revisionTools.handleRestoreRevision(mockClient, { parent_id: 2, revision_id: 20 })).rejects.toThrow(
      "unsafe content",
    );
    expect(mockClient.updatePage).not.toHaveBeenCalled();
  });

  it("surfaces API errors such as a revision from a different page", async () => {
    mockClient.getPageRevision.mockRejectedValueOnce(new Error("The revision parent ID does not match"));

    await expect(revisionTools.handleRestoreRevision(mockClient, { parent_id: 2, revision_id: 99 })).rejects.toThrow(
      "Failed to restore page revision",
    );
    expect(mockClient.updatePage).not.toHaveBeenCalled();
  });
});
