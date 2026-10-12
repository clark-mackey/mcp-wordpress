import { vi } from "vitest";
import { TemplatePartTools, templatePartPath } from "@/tools/templateParts.js";
import { WordPressAPIError } from "@/types/client.js";

const BLOCKS = "<!-- wp:site-title /-->";

describe("TemplatePartTools", () => {
  let tools;
  let client;

  beforeEach(() => {
    tools = new TemplatePartTools();
    client = { get: vi.fn(), post: vi.fn() };
  });

  it("exposes five tools", () => {
    expect(tools.getTools().map((t) => t.name)).toEqual([
      "wp_list_template_parts",
      "wp_get_template_part",
      "wp_update_template_part",
      "wp_get_template_part_revisions",
      "wp_restore_template_part_revision",
    ]);
  });

  describe("templatePartPath", () => {
    it("keeps the literal // between theme and slug (never %2F)", () => {
      expect(templatePartPath("twentytwentyfour//header")).toBe("twentytwentyfour//header");
      expect(templatePartPath("my-child_theme.2//footer-new")).toBe("my-child_theme.2//footer-new");
      expect(templatePartPath("theme//header")).not.toContain("%2F");
    });
    it("accepts a bare slug", () => {
      expect(templatePartPath("footer")).toBe("footer");
    });
    it.each([
      "../header",
      "a//..",
      "a//b//c",
      "a/b",
      "a//b?x=1",
      "",
      "a b#c",
      "//header",
      "my theme//header",
      "t%2Fx//header",
    ])("rejects %s", (bad) => {
      expect(() => templatePartPath(bad)).toThrow(/not a template part ID/);
    });
  });

  it("lists parts with id, slug and area", async () => {
    client.get.mockResolvedValue([
      { id: "theme//header", slug: "header", area: "header", title: { rendered: "Header" } },
      { id: "theme//footer", slug: "footer", area: "footer", title: { rendered: "Footer" } },
    ]);
    const result = await tools.handleListTemplateParts(client, {});
    expect(client.get).toHaveBeenCalledWith("template-parts");
    expect(result).toContain("ID theme//header: **Header** (slug header, area header)");
    expect(result).toContain("Found 2 template parts");
  });

  it("says plainly when the list is empty (classic theme)", async () => {
    client.get.mockResolvedValue([]);
    expect(await tools.handleListTemplateParts(client, {})).toContain("classic theme");
  });

  it("explains a missing route as a classic theme, and a 403 as missing theme access", async () => {
    client.get.mockRejectedValueOnce(new WordPressAPIError("No route", 404, "rest_no_route"));
    await expect(tools.handleListTemplateParts(client, {})).rejects.toThrow(
      "this site's theme has no template parts (classic theme) — its header/footer live in PHP files or a page builder and cannot be edited through the REST API",
    );
    client.get.mockRejectedValueOnce(new WordPressAPIError("Sorry", 403, "rest_cannot_view"));
    await expect(tools.handleListTemplateParts(client, {})).rejects.toThrow(
      "the AI user lacks edit_theme_options; install wordpress/mu-plugins/mcp-wordpress-theme-access.php (see docs)",
    );
  });

  it("leaves other 404s (unknown id) with WordPress's own message", async () => {
    client.get.mockRejectedValue(new WordPressAPIError("Template not found.", 404, "rest_template_not_found"));
    await expect(tools.handleGetTemplatePart(client, { id: "theme//nope" })).rejects.toThrow(/Template not found/);
  });

  it("gets raw content with context=edit and an unencoded // in the path", async () => {
    client.get.mockResolvedValue({ id: "theme//header", area: "header", content: { raw: BLOCKS } });
    const result = await tools.handleGetTemplatePart(client, { id: "theme//header" });
    expect(client.get).toHaveBeenCalledWith("template-parts/theme//header?context=edit");
    expect(result).toContain(BLOCKS);
  });

  it("refuses when raw content is not returned", async () => {
    client.get.mockResolvedValue({ id: "theme//header", content: { rendered: "<p/>" } });
    await expect(tools.handleGetTemplatePart(client, { id: "theme//header" })).rejects.toThrow(/edit_theme_options/);
  });

  describe("update", () => {
    it("posts the new content to the id's route, // intact", async () => {
      client.post.mockResolvedValue({ id: "theme//header" });
      const result = await tools.handleUpdateTemplatePart(client, { id: "theme//header", content: BLOCKS });
      expect(client.post).toHaveBeenCalledWith("template-parts/theme//header", { content: BLOCKS });
      expect(result).toContain("updated");
      expect(result).toContain("wp_restore_template_part_revision");
    });

    it("refuses unsafe content without calling WordPress", async () => {
      await expect(
        tools.handleUpdateTemplatePart(client, { id: "theme//header", content: "<script>alert(1)</script>" }),
      ).rejects.toThrow(/Unsafe content/);
      await expect(
        tools.handleUpdateTemplatePart(client, { id: "theme//header", content: '<a onclick="x()">hi</a>' }),
      ).rejects.toThrow(/Unsafe content/);
      expect(client.post).not.toHaveBeenCalled();
    });

    it("allows ordinary block markup", async () => {
      client.post.mockResolvedValue({ id: "theme//footer" });
      await expect(
        tools.handleUpdateTemplatePart(client, {
          id: "theme//footer",
          content: `<!-- wp:group --><div>${BLOCKS}</div><!-- /wp:group -->`,
        }),
      ).resolves.toContain("updated");
    });
  });

  describe("revisions", () => {
    it("lists revisions", async () => {
      client.get.mockResolvedValue([{ id: 31, modified: "2026-10-11T10:00:00", author: 2 }]);
      const result = await tools.handleGetTemplatePartRevisions(client, { id: "theme//header" });
      expect(client.get).toHaveBeenCalledWith(
        "template-parts/theme//header/revisions?per_page=20&orderby=date&order=desc",
      );
      expect(result).toContain("Revision 31");
    });

    it("explains a WordPress without template part revisions", async () => {
      client.get.mockRejectedValue(new WordPressAPIError("No route", 404, "rest_no_route"));
      await expect(tools.handleGetTemplatePartRevisions(client, { id: "theme//header" })).rejects.toThrow(/6\.4/);
    });

    it("restores a revision's raw content onto the part", async () => {
      client.get.mockResolvedValue({ id: 31, content: { raw: BLOCKS } });
      client.post.mockResolvedValue({ id: "theme//header" });
      const result = await tools.handleRestoreTemplatePartRevision(client, { id: "theme//header", revision_id: 31 });
      expect(client.get).toHaveBeenCalledWith("template-parts/theme//header/revisions/31?context=edit");
      expect(client.post).toHaveBeenCalledWith("template-parts/theme//header", { content: BLOCKS });
      expect(result).toContain("restored to revision 31");
    });

    it("refuses a revision without raw or with unsafe content", async () => {
      client.get.mockResolvedValueOnce({ id: 31, content: {} });
      await expect(
        tools.handleRestoreTemplatePartRevision(client, { id: "theme//header", revision_id: 31 }),
      ).rejects.toThrow(/without raw content/);
      client.get.mockResolvedValueOnce({ id: 31, content: { raw: "<script>x</script>" } });
      await expect(
        tools.handleRestoreTemplatePartRevision(client, { id: "theme//header", revision_id: 31 }),
      ).rejects.toThrow(/unsafe content/);
      expect(client.post).not.toHaveBeenCalled();
    });

    it("rejects a bad revision id", async () => {
      await expect(
        tools.handleRestoreTemplatePartRevision(client, { id: "theme//header", revision_id: "x" }),
      ).rejects.toThrow();
    });
  });
});
