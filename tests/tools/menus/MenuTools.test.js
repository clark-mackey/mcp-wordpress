import { vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MenuTools } from "@/tools/menus.js";
import { siteKey } from "@/tools/localSnapshots.js";
import { WordPressAPIError } from "@/types/client.js";

const menuItem = (id, title, over = {}) => ({
  id,
  title: { raw: title, rendered: title },
  url: `https://test-site.com/${id}`,
  parent: 0,
  menu_order: id,
  type: "custom",
  object: "custom",
  object_id: 0,
  menus: 5,
  ...over,
});

describe("MenuTools", () => {
  let tools;
  let client;
  let dir;
  const snapshots = () => readdirSync(join(dir, siteKey(client)));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "menu-tools-"));
    process.env.MCP_WP_MENU_BACKUP_DIR = dir;
    tools = new MenuTools();
    client = {
      getSiteUrl: () => "https://test-site.com",
      get: vi.fn(async (endpoint) => {
        if (endpoint.startsWith("menus?")) return [{ id: 5, name: "Main", slug: "main", locations: ["primary"] }];
        if (endpoint.startsWith("menus/5")) return { id: 5, name: "Main", locations: ["primary", "footer"] };
        if (endpoint.startsWith("menu-items?menus=5")) {
          return [menuItem(2, "Child", { parent: 1, menu_order: 2 }), menuItem(1, "Home")];
        }
        if (endpoint.startsWith("menu-items/")) return menuItem(1, "Home");
        throw new Error(`unexpected GET ${endpoint}`);
      }),
      post: vi.fn().mockResolvedValue({ id: 77 }),
      delete: vi.fn().mockResolvedValue({ deleted: true }),
    };
  });
  afterEach(() => {
    delete process.env.MCP_WP_MENU_BACKUP_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("exposes the six menu tools with required params", () => {
    const byName = Object.fromEntries(tools.getTools().map((t) => [t.name, t]));
    expect(Object.keys(byName)).toEqual([
      "wp_list_menus",
      "wp_get_menu",
      "wp_create_menu_item",
      "wp_update_menu_item",
      "wp_delete_menu_item",
      "wp_restore_menu_snapshot",
    ]);
    expect(byName.wp_create_menu_item.inputSchema.required).toEqual(["menu_id", "title"]);
    expect(byName.wp_delete_menu_item.inputSchema.required).toEqual(["id"]);
  });

  it("lists menus with locations", async () => {
    const result = await tools.handleListMenus(client, {});
    expect(client.get).toHaveBeenCalledWith("menus?context=edit&per_page=100");
    expect(result).toContain("ID 5: **Main**");
    expect(result).toContain("locations: primary");
  });

  it("shows a menu as a tree with parent, order and type", async () => {
    const result = await tools.handleGetMenu(client, { id: 5 });
    expect(client.get).toHaveBeenCalledWith(
      "menu-items?menus=5&per_page=100&page=1&status=publish,draft,pending,private&context=edit",
    );
    expect(result).toContain("Menu 5: Main");
    expect(result.indexOf("ID 1:")).toBeLessThan(result.indexOf("ID 2:"));
    expect(result).toMatch(/ {2}- ID 2: \*\*Child\*\*/);
    expect(result).toContain("custom link");
  });

  describe("create", () => {
    it("snapshots first, then posts a custom link", async () => {
      const result = await tools.handleCreateMenuItem(client, {
        menu_id: 5,
        title: "Blog",
        url: "https://test-site.com/blog",
        menu_order: 3,
      });

      expect(snapshots()).toHaveLength(1);
      expect(client.post).toHaveBeenCalledWith("menu-items", {
        title: "Blog",
        menus: 5,
        status: "publish",
        type: "custom",
        url: "https://test-site.com/blog",
        menu_order: 3,
      });
      expect(result).toContain("Menu item 77 added");
      expect(result).toContain(snapshots()[0]);
    });

    it("links to a page by object and object_id", async () => {
      await tools.handleCreateMenuItem(client, {
        menu_id: 5,
        title: "About",
        object: "page",
        object_id: 12,
        parent: 1,
      });
      expect(client.post.mock.calls[0][1]).toMatchObject({
        type: "post_type",
        object: "page",
        object_id: 12,
        parent: 1,
      });
      await tools.handleCreateMenuItem(client, { menu_id: 5, title: "News", object: "category", object_id: 3 });
      expect(client.post.mock.calls[1][1]).toMatchObject({ type: "taxonomy", object: "category" });
    });

    it("rejects a menu_id that is not a positive integer", async () => {
      await expect(
        tools.handleCreateMenuItem(client, { menu_id: "5", title: "x", url: "https://a.com" }),
      ).rejects.toThrow();
      await expect(
        tools.handleCreateMenuItem(client, { menu_id: -1, title: "x", url: "https://a.com" }),
      ).rejects.toThrow();
      expect(client.post).not.toHaveBeenCalled();
    });

    it("refuses without a target, and refuses unsafe links, writing nothing", async () => {
      await expect(tools.handleCreateMenuItem(client, { menu_id: 5, title: "x" })).rejects.toThrow(/either a url/);
      await expect(
        tools.handleCreateMenuItem(client, { menu_id: 5, title: "x", url: "javascript:alert(1)" }),
      ).rejects.toThrow(/Unsafe link/);
      expect(client.post).not.toHaveBeenCalled();
    });

    it("does not change the menu if the snapshot cannot be written", async () => {
      process.env.MCP_WP_MENU_BACKUP_DIR = join(dir, "file-not-dir");
      writeFileSync(join(dir, "file-not-dir"), "x");
      await expect(
        tools.handleCreateMenuItem(client, { menu_id: 5, title: "x", url: "https://a.com" }),
      ).rejects.toThrow();
      expect(client.post).not.toHaveBeenCalled();
    });
  });

  describe("update", () => {
    it("finds the item's menu, snapshots it, then posts only the given fields", async () => {
      const result = await tools.handleUpdateMenuItem(client, { id: 1, title: "Start", menu_order: 4 });
      expect(client.get).toHaveBeenCalledWith("menu-items/1?context=edit");
      expect(snapshots()[0]).toMatch(/^5-/);
      expect(client.post).toHaveBeenCalledWith("menu-items/1", { title: "Start", menu_order: 4 });
      expect(result).toContain("title, menu_order");
    });

    it("refuses an empty update and an item that is in no menu", async () => {
      await expect(tools.handleUpdateMenuItem(client, { id: 1 })).rejects.toThrow(/Nothing to change/);
      client.get.mockResolvedValueOnce(menuItem(1, "Home", { menus: 0 }));
      await expect(tools.handleUpdateMenuItem(client, { id: 1, title: "x" })).rejects.toThrow(/not in any menu/);
      expect(client.post).not.toHaveBeenCalled();
    });
  });

  describe("delete", () => {
    it("snapshots, then force-deletes", async () => {
      const result = await tools.handleDeleteMenuItem(client, { id: 1 });
      expect(snapshots()).toHaveLength(1);
      expect(client.delete).toHaveBeenCalledWith("menu-items/1?force=true");
      expect(result).toContain("Menu item 1 deleted from menu 5");
    });

    it("does not delete when the snapshot fails", async () => {
      client.get.mockImplementation(async (e) => {
        if (e.startsWith("menu-items/")) return menuItem(1, "Home");
        throw new WordPressAPIError("nope", 500);
      });
      await expect(tools.handleDeleteMenuItem(client, { id: 1 })).rejects.toThrow(/nope/);
      expect(client.delete).not.toHaveBeenCalled();
    });
  });

  describe("restore", () => {
    it("restores from a snapshot taken by an earlier change and reports what changed", async () => {
      await tools.handleDeleteMenuItem(client, { id: 1 });
      const file = snapshots()[0];
      // After the delete, the live menu has lost item 1.
      client.get.mockImplementation(async (endpoint) => {
        if (endpoint.startsWith("menus/5")) return { id: 5 };
        if (endpoint.startsWith("menu-items?menus=5")) return [menuItem(2, "Child", { parent: 1, menu_order: 2 })];
        throw new Error(endpoint);
      });
      client.post.mockClear();

      const result = await tools.handleRestoreMenuSnapshot(client, { snapshot: file });

      expect(result).toContain(`Menu 5 restored from ${file}`);
      expect(result).toContain('Recreated "Home"');
      expect(client.post.mock.calls[0][0]).toBe("menu-items");
      expect(snapshots()).toHaveLength(2); // the restore snapshotted the pre-restore state too
    });

    it("reports skipped deletes in plain words when a step failed", async () => {
      await tools.handleDeleteMenuItem(client, { id: 1 });
      const file = snapshots()[0];
      client.get.mockImplementation(async (endpoint) => {
        if (endpoint.startsWith("menus/5")) return { id: 5 };
        if (endpoint.startsWith("menu-items?menus=5")) return [menuItem(9, "Added", { menu_order: 9 })];
        throw new Error(endpoint);
      });
      client.post.mockRejectedValue(new Error("boom"));
      const result = await tools.handleRestoreMenuSnapshot(client, { snapshot: file });
      expect(result).toContain("partly restored");
      expect(result).toContain('Skipped deleting "Added" (item 9)');
      expect(result).toContain("because earlier steps failed");
      expect(client.delete).toHaveBeenCalledTimes(1); // only the original delete, none during restore
    });

    it("rejects path traversal before touching WordPress", async () => {
      const outsideDir = join(dir, "..", "x.json");
      await expect(tools.handleRestoreMenuSnapshot(client, { snapshot: "../x.json" })).rejects.toThrow(
        /Invalid snapshot/,
      );
      await expect(tools.handleRestoreMenuSnapshot(client, { snapshot: outsideDir })).rejects.toThrow(
        /Invalid snapshot/,
      );
      expect(client.get).not.toHaveBeenCalled();
      expect(client.post).not.toHaveBeenCalled();
    });

    it("rejects a snapshot file that is not valid", async () => {
      mkdirSync(join(dir, siteKey(client)), { recursive: true });
      writeFileSync(join(dir, siteKey(client), "5-bad.json"), "{}");
      await expect(tools.handleRestoreMenuSnapshot(client, { snapshot: "5-bad.json" })).rejects.toThrow(
        /does not look like/,
      );
    });
  });

  describe("plain-English errors", () => {
    it("explains a permission failure", async () => {
      client.get.mockRejectedValue(new WordPressAPIError("Sorry", 403, "rest_cannot_view"));
      await expect(tools.handleListMenus(client, {})).rejects.toThrow(
        /AI user lacks edit_theme_options; install mcp-wordpress-theme-access\.php and check its login name/,
      );
    });

    it("explains a missing route, but leaves a missing item's own message alone", async () => {
      client.get.mockRejectedValueOnce(new WordPressAPIError("No route", 404, "rest_no_route"));
      await expect(tools.handleListMenus(client, {})).rejects.toThrow(/needs WordPress 5\.9/);
      client.get.mockRejectedValueOnce(new WordPressAPIError("Invalid menu ID.", 404, "rest_menu_invalid_id"));
      await expect(tools.handleGetMenu(client, { id: 9 })).rejects.toThrow(/Invalid menu ID/);
    });
  });
});
