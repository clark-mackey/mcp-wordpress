import { vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { siteKey } from "@/tools/localSnapshots.js";
import { TemplatePartTools, templatePartPath } from "@/tools/templateParts.js";
import { WordPressAPIError } from "@/types/client.js";

const BLOCKS = "<!-- wp:site-title /-->";

describe("TemplatePartTools", () => {
  let tools;
  let client;

  let dir;
  const saved = () => readdirSync(join(dir, siteKey(client)));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tp-snap-"));
    process.env.MCP_WP_TEMPLATE_PART_BACKUP_DIR = dir;
    tools = new TemplatePartTools();
    client = { getSiteUrl: () => "https://test-site.com", get: vi.fn(), post: vi.fn() };
  });
  afterEach(() => {
    delete process.env.MCP_WP_TEMPLATE_PART_BACKUP_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("exposes six tools", () => {
    expect(tools.getTools().map((t) => t.name)).toEqual([
      "wp_list_template_parts",
      "wp_get_template_part",
      "wp_update_template_part",
      "wp_restore_template_part_snapshot",
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
    it("allows one theme subdirectory level and encodes each segment", () => {
      expect(templatePartPath("parent/child//header")).toBe("parent/child//header");
      expect(templatePartPath("a.b-c/d_e//foot-er")).toBe("a.b-c/d_e//foot-er");
    });
    it.each(["a/b/c//header", "parent/../x//header", "./x//header", "a//b/c", "parent//"])(
      "rejects deeper or odd paths: %s",
      (bad) => {
        expect(() => templatePartPath(bad)).toThrow(/not a template part ID/);
      },
    );
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
      "the AI user lacks edit_theme_options; install mcp-wordpress-theme-access.php and check its login name matches this user",
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
    const ORIGINAL = "<!-- wp:site-logo /-->";
    beforeEach(() => {
      client.get.mockResolvedValue({ id: "theme//header", content: { raw: ORIGINAL } });
      client.post.mockResolvedValue({ id: "theme//header" });
    });

    it("saves the current content locally first, then posts the new content to the id's route", async () => {
      const result = await tools.handleUpdateTemplatePart(client, { id: "theme//header", content: BLOCKS });
      expect(client.get).toHaveBeenCalledWith("template-parts/theme//header?context=edit");
      expect(client.post).toHaveBeenCalledWith("template-parts/theme//header", { content: BLOCKS });
      expect(client.get.mock.invocationCallOrder[0]).toBeLessThan(client.post.mock.invocationCallOrder[0]);

      expect(saved()).toHaveLength(1);
      expect(saved()[0]).toMatch(/^theme__header-.*\.json$/);
      const path = join(dir, siteKey(client), saved()[0]);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
        version: 1,
        site_url: "https://test-site.com",
        part_id: "theme//header",
        content: ORIGINAL,
      });
      expect(result).toContain(saved()[0]);
      expect(result).toContain("wp_restore_template_part_snapshot");
      expect(result).toContain("only exist after a part's first edit");
    });

    it("refuses blank content and writes nothing", async () => {
      for (const content of ["", "   \n\t"]) {
        await expect(tools.handleUpdateTemplatePart(client, { id: "theme//header", content })).rejects.toThrow(
          /Refusing to blank a template part/,
        );
      }
      expect(client.post).not.toHaveBeenCalled();
      expect(client.get).not.toHaveBeenCalled();
    });

    it("fails closed: no POST when the original cannot be read or saved", async () => {
      client.get.mockResolvedValueOnce({ id: "theme//header", content: {} });
      await expect(tools.handleUpdateTemplatePart(client, { id: "theme//header", content: BLOCKS })).rejects.toThrow(
        /cannot be saved before the edit/,
      );
      client.get.mockRejectedValueOnce(new WordPressAPIError("boom", 500));
      await expect(tools.handleUpdateTemplatePart(client, { id: "theme//header", content: BLOCKS })).rejects.toThrow(
        /boom/,
      );
      process.env.MCP_WP_TEMPLATE_PART_BACKUP_DIR = join(dir, "afile");
      writeFileSync(join(dir, "afile"), "x");
      await expect(tools.handleUpdateTemplatePart(client, { id: "theme//header", content: BLOCKS })).rejects.toThrow();
      expect(client.post).not.toHaveBeenCalled();
    });

    it("refuses unsafe content without calling WordPress", async () => {
      await expect(
        tools.handleUpdateTemplatePart(client, { id: "theme//header", content: "<script>alert(1)</script>" }),
      ).rejects.toThrow(/Unsafe content/);
      await expect(
        tools.handleUpdateTemplatePart(client, { id: "theme//header", content: '<a onclick="x()">hi</a>' }),
      ).rejects.toThrow(/Unsafe content/);
      expect(client.post).not.toHaveBeenCalled();
      expect(client.get).not.toHaveBeenCalled();
    });

    it("allows ordinary block markup", async () => {
      await expect(
        tools.handleUpdateTemplatePart(client, {
          id: "theme//footer",
          content: `<!-- wp:group --><div>${BLOCKS}</div><!-- /wp:group -->`,
        }),
      ).resolves.toContain("updated");
    });
  });

  describe("restore snapshot", () => {
    const ORIGINAL = "<!-- wp:site-logo /-->";
    let file;
    beforeEach(async () => {
      client.get.mockResolvedValue({ id: "theme//header", content: { raw: ORIGINAL } });
      client.post.mockResolvedValue({ id: "theme//header" });
      await tools.handleUpdateTemplatePart(client, { id: "theme//header", content: BLOCKS });
      file = saved()[0];
      client.get.mockReset().mockResolvedValue({ id: "theme//header", content: { raw: BLOCKS } });
      client.post.mockClear();
    });

    it("snapshots the live content first, then posts the saved original", async () => {
      const result = await tools.handleRestoreTemplatePartSnapshot(client, { snapshot: file });
      expect(client.post).toHaveBeenCalledTimes(1);
      expect(client.post).toHaveBeenCalledWith("template-parts/theme//header", { content: ORIGINAL });
      expect(saved()).toHaveLength(2);
      const newest = saved().find((f) => f !== file);
      expect(JSON.parse(readFileSync(join(dir, siteKey(client), newest), "utf8")).content).toBe(BLOCKS);
      expect(result).toContain(`restored from ${file}`);
      expect(result).toContain(newest);
    });

    it("rejects path traversal, other sites, and a mismatched recorded site_url", async () => {
      await expect(tools.handleRestoreTemplatePartSnapshot(client, { snapshot: "../x.json" })).rejects.toThrow(
        /Invalid snapshot/,
      );
      const other = { ...client, getSiteUrl: () => "https://test-site.com/blog" };
      await expect(tools.handleRestoreTemplatePartSnapshot(other, { snapshot: file })).rejects.toThrow(
        /no snapshot file found/,
      );

      const path = join(dir, siteKey(client), file);
      const forged = { ...JSON.parse(readFileSync(path, "utf8")), site_url: "https://elsewhere.com" };
      writeFileSync(path, JSON.stringify(forged));
      await expect(tools.handleRestoreTemplatePartSnapshot(client, { snapshot: file })).rejects.toThrow(
        /not https:\/\/test-site\.com/,
      );
      expect(client.post).not.toHaveBeenCalled();
    });

    it("refuses unsafe, blank, or malformed snapshot content", async () => {
      const path = join(dir, siteKey(client), file);
      const base = JSON.parse(readFileSync(path, "utf8"));
      for (const [patch, error] of [
        [{ content: "<script>x()</script>" }, /unsafe content/],
        [{ content: "  " }, /Refusing to blank/],
        [{ part_id: "../evil" }, /does not look like a template part snapshot/],
        [{ content: 5 }, /does not look like/],
      ]) {
        writeFileSync(path, JSON.stringify({ ...base, ...patch }));
        await expect(tools.handleRestoreTemplatePartSnapshot(client, { snapshot: file })).rejects.toThrow(error);
      }
      expect(client.post).not.toHaveBeenCalled();
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
