import { vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WidgetTools } from "@/tools/widgets.js";
import {
  siteKey,
  writeWidgetSnapshot,
  resolveWidgetSnapshotPath,
  readWidgetSnapshot,
} from "@/tools/widgetSnapshots.js";
import { WordPressAPIError } from "@/types/client.js";

const block = (n, content, over = {}) => ({
  id: `block-${n}`,
  id_base: "block",
  sidebar: "footer-1",
  instance: { raw: { content } },
  ...over,
});
const text = (n, over = {}) => ({
  id: `text-${n}`,
  id_base: "text",
  sidebar: "footer-1",
  instance: { raw: { title: "Hours", text: "9-5", filter: false } },
  ...over,
});
const legacy = (n) => ({ id: `search-${n}`, id_base: "search", sidebar: "footer-1", instance: {} });

function makeClient(widgets, siteUrl = "https://test-site.com") {
  const store = { widgets };
  const client = {
    getSiteUrl: () => siteUrl,
    store,
    get: vi.fn(async (endpoint) => {
      if (endpoint.startsWith("sidebars?")) {
        return [
          { id: "footer-1", name: "Footer Column 1", status: "active", widgets: store.widgets.map((w) => w.id) },
          { id: "sidebar-1", name: "Blog Sidebar", status: "active", widgets: [] },
        ];
      }
      if (endpoint.startsWith("sidebars/footer-1")) return { id: "footer-1", name: "Footer Column 1" };
      if (endpoint.startsWith("widgets?sidebar=footer-1")) return store.widgets;
      const m = endpoint.match(/^widgets\/([^?]+)\?context=edit$/);
      if (m) {
        const w = store.widgets.find((x) => x.id === m[1]);
        if (w) return w;
        throw new WordPressAPIError("Widget not found", 404, "rest_invalid_widget");
      }
      throw new Error(`unexpected GET ${endpoint}`);
    }),
    post: vi.fn().mockResolvedValue({ id: "block-99" }),
    delete: vi.fn().mockResolvedValue({ deleted: true }),
  };
  return client;
}

describe("WidgetTools", () => {
  let tools;
  let dir;
  let client;
  const files = (c = client) => readdirSync(join(dir, siteKey(c)));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "widget-tools-"));
    process.env.MCP_WP_WIDGET_BACKUP_DIR = dir;
    tools = new WidgetTools();
    client = makeClient([block(3, "<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->"), text(2), legacy(1)]);
  });
  afterEach(() => {
    delete process.env.MCP_WP_WIDGET_BACKUP_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("exposes six tools", () => {
    expect(tools.getTools().map((t) => t.name)).toEqual([
      "wp_list_widget_areas",
      "wp_get_widget_area",
      "wp_update_widget",
      "wp_create_widget",
      "wp_delete_widget",
      "wp_restore_widget_snapshot",
    ]);
  });

  it("lists areas and marks footers as hints", async () => {
    const result = await tools.handleListWidgetAreas(client, {});
    expect(result).toContain("footer-1: **Footer Column 1** [likely footer]");
    expect(result).toContain("block-3, text-2, search-1");
    expect(result).not.toMatch(/sidebar-1: \*\*Blog Sidebar\*\* \[likely/);
  });

  it("says plainly when the theme has no widget areas, and explains missing routes and 403s", async () => {
    client.get.mockResolvedValueOnce([]);
    expect(await tools.handleListWidgetAreas(client, {})).toContain("this theme has no widget areas");
    client.get.mockRejectedValueOnce(new WordPressAPIError("x", 404, "rest_no_route"));
    await expect(tools.handleListWidgetAreas(client, {})).rejects.toThrow(
      "this site's WordPress is older than 5.8 or widgets are disabled",
    );
    client.get.mockRejectedValueOnce(new WordPressAPIError("x", 403, "rest_cannot_view"));
    await expect(tools.handleListWidgetAreas(client, {})).rejects.toThrow(
      "lacks edit_theme_options; install mcp-wordpress-theme-access.php and check its login name matches this user",
    );
  });

  it("shows readable content for block/text widgets and type only for legacy ones", async () => {
    const result = await tools.handleGetWidgetArea(client, { id: "footer-1" });
    expect(client.get).toHaveBeenCalledWith("widgets?sidebar=footer-1&per_page=100&context=edit");
    expect(result).toContain("content: <!-- wp:paragraph --><p>Hi</p>");
    expect(result).toContain("title: Hours");
    expect(result).toContain("text: 9-5");
    expect(result).toContain("legacy widget, settings not readable over REST (id_base search)");
  });

  describe("id validation", () => {
    it.each(["../x", "a/b", "a b", "a?x=1", "", "block-3/"])("rejects %s", async (bad) => {
      await expect(tools.handleGetWidgetArea(client, { id: bad })).rejects.toThrow(/not a valid widget area ID/);
      await expect(tools.handleDeleteWidget(client, { id: bad })).rejects.toThrow(/not a valid widget ID/);
      await expect(tools.handleCreateWidget(client, { sidebar: bad, content: "x" })).rejects.toThrow(/not a valid/);
    });
    it("accepts ids with dash, underscore and digits", async () => {
      await expect(tools.handleGetWidgetArea(client, { id: "footer-1" })).resolves.toContain("footer-1");
      await tools.handleUpdateWidget(client, { id: "block-3", content: "<p>x</p>" });
      expect(client.post.mock.calls[0][0]).toBe("widgets/block-3");
    });
  });

  describe("update", () => {
    it("snapshots the whole area, then updates a block widget", async () => {
      const result = await tools.handleUpdateWidget(client, { id: "block-3", content: "<p>New</p>" });
      expect(files()).toHaveLength(1);
      expect(client.post).toHaveBeenCalledWith("widgets/block-3", { instance: { raw: { content: "<p>New</p>" } } });
      expect(result).toContain(files()[0]);
    });

    it("updates Text and Custom HTML widgets, merging with the existing settings", async () => {
      await tools.handleUpdateWidget(client, { id: "text-2", text: "10-6" });
      expect(client.post).toHaveBeenCalledWith("widgets/text-2", {
        instance: { raw: { title: "Hours", text: "10-6", filter: false } },
      });
      client.store.widgets.push({
        id: "custom_html-4",
        id_base: "custom_html",
        sidebar: "footer-1",
        instance: { raw: { title: "", content: "<b>a</b>" } },
      });
      await tools.handleUpdateWidget(client, { id: "custom_html-4", content: "<b>b</b>", title: "T" });
      expect(client.post.mock.calls[1][1]).toEqual({ instance: { raw: { title: "T", content: "<b>b</b>" } } });
    });

    it("refuses a legacy widget by naming its type, without writing anything", async () => {
      await expect(tools.handleUpdateWidget(client, { id: "search-1", content: "x" })).rejects.toThrow(
        /"search" widget/,
      );
      expect(client.post).not.toHaveBeenCalled();
      expect(client.store.widgets).toHaveLength(3);
      expect(() => files()).toThrow();
    });

    it("refuses wrong fields for the type, unsafe content, and empty updates", async () => {
      await expect(tools.handleUpdateWidget(client, { id: "text-2", content: "x" })).rejects.toThrow(
        /Text widget takes text and title/,
      );
      await expect(tools.handleUpdateWidget(client, { id: "block-3", text: "x" })).rejects.toThrow(
        /only takes content/,
      );
      await expect(tools.handleUpdateWidget(client, { id: "block-3" })).rejects.toThrow(/only takes content/);
      await expect(
        tools.handleUpdateWidget(client, { id: "block-3", content: "<script>x()</script>" }),
      ).rejects.toThrow(/Unsafe content/);
      await expect(tools.handleUpdateWidget(client, { id: "text-2", text: '<a onclick="x()">' })).rejects.toThrow(
        /Unsafe content/,
      );
      expect(client.post).not.toHaveBeenCalled();
    });

    it("turns a WordPress 400 into a plain message naming the widget type", async () => {
      client.post.mockRejectedValueOnce(
        new WordPressAPIError("Invalid parameter(s): instance", 400, "rest_invalid_param"),
      );
      await expect(tools.handleUpdateWidget(client, { id: "block-3", content: "<p>x</p>" })).rejects.toThrow(
        /"block" widget/,
      );
    });

    it("does not write when the snapshot cannot be saved", async () => {
      process.env.MCP_WP_WIDGET_BACKUP_DIR = join(dir, "file");
      writeFileSync(join(dir, "file"), "x");
      await expect(tools.handleUpdateWidget(client, { id: "block-3", content: "<p>x</p>" })).rejects.toThrow();
      expect(client.post).not.toHaveBeenCalled();
    });
  });

  it("creates a block widget after snapshotting", async () => {
    const result = await tools.handleCreateWidget(client, { sidebar: "footer-1", content: "<p>Hi</p>" });
    expect(files()).toHaveLength(1);
    expect(client.post).toHaveBeenCalledWith("widgets", {
      id_base: "block",
      sidebar: "footer-1",
      instance: { raw: { content: "<p>Hi</p>" } },
    });
    expect(result).toContain("block-99");
    await expect(
      tools.handleCreateWidget(client, { sidebar: "footer-1", content: "<script>x()</script>" }),
    ).rejects.toThrow(/Unsafe/);
  });

  it("deletes with force after snapshotting, and does not delete when the snapshot fails", async () => {
    await tools.handleDeleteWidget(client, { id: "block-3" });
    expect(files()).toHaveLength(1);
    expect(client.delete).toHaveBeenCalledWith("widgets/block-3?force=true");

    client.delete.mockClear();
    client.get.mockImplementation(async (e) => {
      if (e.startsWith("widgets/")) return block(3, "x");
      throw new WordPressAPIError("nope", 500);
    });
    await expect(tools.handleDeleteWidget(client, { id: "block-3" })).rejects.toThrow(/nope/);
    expect(client.delete).not.toHaveBeenCalled();
  });

  describe("snapshots", () => {
    it("write 0600 files under <host>-<hash> and bind to the full site URL", async () => {
      const { path, file } = await writeWidgetSnapshot(client, "footer-1");
      expect(file).toMatch(/^footer-1-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.json$/);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(path).toContain(`test-site.com-`);
      const saved = JSON.parse(readFileSync(path, "utf8"));
      expect(saved).toMatchObject({ site_url: "https://test-site.com", sidebar_id: "footer-1" });
      expect(saved.widgets).toHaveLength(3);
      expect(siteKey(makeClient([], "https://test-site.com/blog"))).not.toBe(siteKey(client));
      expect(siteKey(makeClient([], "http://test-site.com"))).not.toBe(siteKey(client));
    });

    it("throws instead of saving a truncated snapshot when a full page comes back", async () => {
      const many = makeClient(Array.from({ length: 100 }, (_, i) => block(i + 1, "x")));
      await expect(writeWidgetSnapshot(many, "footer-1")).rejects.toThrow(/more than a snapshot can safely hold/);
      expect(() => files(many)).toThrow();
    });

    it("never overwrites an existing file", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-11T12:00:00.000Z"));
      try {
        const a = await writeWidgetSnapshot(client, "footer-1");
        const b = await writeWidgetSnapshot(client, "footer-1");
        expect(a.file).not.toBe(b.file);
      } finally {
        vi.useRealTimers();
      }
    });

    it.each(["../x.json", "a/../../b.json", "..\\x.json", "x.txt", ""])(
      "rejects traversal or bad name %s",
      async (bad) => {
        await expect(resolveWidgetSnapshotPath(client, bad)).rejects.toThrow(/Invalid snapshot/);
      },
    );

    it("rejects outside paths, symlinks out, and another site's folder", async () => {
      const { file, path } = await writeWidgetSnapshot(client, "footer-1");
      await expect(resolveWidgetSnapshotPath(client, file)).resolves.toBeTruthy();
      await expect(resolveWidgetSnapshotPath(client, join(dir, siteKey(client), file))).resolves.toBeTruthy();
      await expect(resolveWidgetSnapshotPath(client, "/etc/passwd.json")).rejects.toThrow(/Invalid snapshot/);

      const outside = join(tmpdir(), `outside-${Date.now()}.json`);
      writeFileSync(outside, "{}");
      symlinkSync(outside, join(dir, siteKey(client), "evil.json"));
      try {
        await expect(resolveWidgetSnapshotPath(client, "evil.json")).rejects.toThrow(
          /inside the backups\/widgets folder/,
        );
      } finally {
        rmSync(outside, { force: true });
      }

      const other = makeClient([], "https://other.com");
      await expect(resolveWidgetSnapshotPath(other, path)).rejects.toThrow(/different site/);
    });

    it("refuses a snapshot whose recorded site URL is not the client's, even from the right folder", async () => {
      const { path } = await writeWidgetSnapshot(client, "footer-1");
      const forged = JSON.parse(readFileSync(path, "utf8"));
      forged.site_url = "https://test-site.com/other-install";
      writeFileSync(path, JSON.stringify(forged));
      await expect(readWidgetSnapshot(path, client)).rejects.toThrow(/not https:\/\/test-site\.com/);
      writeFileSync(
        path,
        JSON.stringify({ version: 1, site_url: "https://test-site.com", sidebar_id: "../x", widgets: [] }),
      );
      await expect(readWidgetSnapshot(path, client)).rejects.toThrow(/does not look like/);
      writeFileSync(path, "nope");
      await expect(readWidgetSnapshot(path, client)).rejects.toThrow(/not readable JSON/);
    });
  });

  describe("restore", () => {
    const snap = async (c) => (await writeWidgetSnapshot(c, "footer-1")).file;

    it("reapplies settings, recreates a deleted block widget, removes added widgets, and snapshots first", async () => {
      const file = await snap(client);
      // After: block-3 deleted, text-2 edited, search-1 untouched, block-8 added.
      client.store.widgets = [
        text(2, { instance: { raw: { title: "Hours", text: "CHANGED", filter: false } } }),
        legacy(1),
        block(8, "<p>new</p>"),
      ];
      client.post.mockClear();

      const result = await tools.handleRestoreWidgetSnapshot(client, { snapshot: file });

      expect(result).toContain("restored from");
      expect(client.post).toHaveBeenCalledWith(
        "widgets",
        expect.objectContaining({ id_base: "block", sidebar: "footer-1" }),
      );
      expect(client.post).toHaveBeenCalledWith("widgets/text-2", {
        instance: { raw: { title: "Hours", text: "9-5", filter: false } },
      });
      expect(client.delete).toHaveBeenCalledWith("widgets/block-8?force=true");
      expect(result).toContain("Recreated widget block-3");
      expect(result).toContain("Deleted widget block-8");
      expect(files().length).toBe(2);
    });

    it("moves a widget back into the area instead of duplicating it", async () => {
      const file = await snap(client);
      client.store.widgets = client.store.widgets.map((w) => (w.id === "block-3" ? { ...w, sidebar: "sidebar-1" } : w));
      // Not listed under footer-1 any more, but still fetchable by ID.
      const inFooter = client.store.widgets.filter((w) => w.sidebar === "footer-1");
      client.get.mockImplementation(async (e) => {
        if (e.startsWith("sidebars/")) return { id: "footer-1" };
        if (e.startsWith("widgets?sidebar=footer-1")) return inFooter;
        if (e === "widgets/block-3?context=edit") return client.store.widgets.find((w) => w.id === "block-3");
        throw new WordPressAPIError("nf", 404, "rest_invalid_widget");
      });
      client.post.mockClear();
      await tools.handleRestoreWidgetSnapshot(client, { snapshot: file });
      expect(client.post).toHaveBeenCalledTimes(1);
      expect(client.post).toHaveBeenCalledWith("widgets/block-3", { sidebar: "footer-1" });
    });

    it("skips every delete when an earlier step failed, and says so", async () => {
      const file = await snap(client);
      client.store.widgets = [legacy(1), block(8, "<p>new</p>")]; // block-3 and text-2 gone
      client.post.mockClear();
      const result = await tools.handleRestoreWidgetSnapshot(client, { snapshot: file });
      // text-2 is a legacy-style type that cannot be recreated: that is a failure.
      expect(result).toContain("partly restored");
      expect(result).toContain("only block widgets can be created again");
      expect(client.delete).not.toHaveBeenCalled();
      expect(result).toContain("were NOT removed");
    });

    it("also skips deletes when an update call fails", async () => {
      const file = await snap(client);
      client.store.widgets = [block(3, "<p>changed</p>"), text(2), legacy(1), block(8, "x")];
      client.post.mockRejectedValue(new Error("boom"));
      const result = await tools.handleRestoreWidgetSnapshot(client, { snapshot: file });
      expect(result).toContain("boom");
      expect(client.delete).not.toHaveBeenCalled();
    });

    it("refuses a snapshot from a different site URL before touching WordPress", async () => {
      const file = await snap(client);
      const sibling = makeClient([], "https://test-site.com/blog");
      await expect(tools.handleRestoreWidgetSnapshot(sibling, { snapshot: file })).rejects.toThrow(
        /Invalid snapshot|different site/,
      );
      expect(sibling.post).not.toHaveBeenCalled();
      expect(sibling.delete).not.toHaveBeenCalled();
    });

    it("rejects path traversal", async () => {
      await expect(tools.handleRestoreWidgetSnapshot(client, { snapshot: "../x.json" })).rejects.toThrow(
        /Invalid snapshot/,
      );
      expect(client.get).not.toHaveBeenCalled();
    });

    it("reports nothing to do when the area already matches", async () => {
      const file = await snap(client);
      client.post.mockClear();
      const result = await tools.handleRestoreWidgetSnapshot(client, { snapshot: file });
      expect(result).toContain("Nothing needed changing");
      expect(client.post).not.toHaveBeenCalled();
    });
  });
});
