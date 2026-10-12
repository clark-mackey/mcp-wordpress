import { WordPressClient } from "@/client/api.js";
import { WordPressAPIError } from "@/types/client.js";
import type { MCPToolSchema } from "@/types/mcp.js";
import { isUnsafePlainText } from "@/security/InputValidator.js";
import {
  MenuItemRecord,
  fetchMenuItems,
  readMenuSnapshot,
  resolveSnapshotPath,
  restoreMenuSnapshot,
  writeMenuSnapshot,
} from "./menuSnapshots.js";
import { parseId, toolParams } from "./params.js";
import { themeRestError } from "./themeShared.js";

interface MenuRecord {
  id: number;
  name: string;
  slug?: string;
  description?: string;
  locations?: string[];
}

interface MenuItemInput {
  title?: string;
  url?: string;
  type?: string;
  object?: string;
  object_id?: number;
  menu_id?: number;
  parent?: number;
  menu_order?: number;
}

const invalid = (message: string) => new WordPressAPIError(message, 400, "INVALID_PARAMETER");

/** Same string check the MCP boundary applies, repeated here because restore and direct handler calls skip that boundary. */
function assertSafeUrl(url: string | undefined): void {
  if (url !== undefined && isUnsafePlainText(url)) {
    throw invalid("Unsafe link (script, javascript: or data: URL). Menu links must be normal web addresses.");
  }
}

function itemLine(item: MenuItemRecord, depth: number): string {
  const kind =
    item.type === "custom" ? "custom link" : `${item.type ?? "item"}/${item.object ?? "?"} #${item.object_id ?? "?"}`;
  return (
    `${"  ".repeat(depth)}- ID ${item.id}: **${item.title.raw ?? item.title.rendered}** → ${item.url || "(no url)"}\n` +
    `${"  ".repeat(depth)}  parent ${item.parent}, order ${item.menu_order}, ${kind}`
  );
}

/** Items ordered so each parent is followed by its children, with their depth. */
function orderTree(items: MenuItemRecord[]): Array<{ item: MenuItemRecord; depth: number }> {
  const ids = new Set(items.map((i) => i.id));
  const byOrder = [...items].sort((a, b) => a.menu_order - b.menu_order);
  const out: Array<{ item: MenuItemRecord; depth: number }> = [];
  const seen = new Set<number>();
  const walk = (parent: number, depth: number) => {
    for (const item of byOrder) {
      if (item.parent !== parent || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push({ item, depth });
      walk(item.id, depth + 1);
    }
  };
  walk(0, 0);
  // Items whose parent is missing from the list still get shown.
  for (const item of byOrder) {
    if (!seen.has(item.id) && !ids.has(item.parent)) walk(item.parent, 0);
  }
  return out;
}

/**
 * Menus through the core REST API (WordPress 5.9+). Works on any theme. The AI user needs
 * edit_theme_options, which Editors do not have by default (see wordpress/mu-plugins/mcp-wordpress-theme-access.php).
 *
 * WordPress keeps no revisions of menus, so every change snapshots the whole menu to disk first
 * (menuSnapshots.ts) and wp_restore_menu_snapshot undoes it.
 */
export class MenuTools {
  public getTools(): Array<{
    name: string;
    description: string;
    inputSchema?: MCPToolSchema;
    handler: (client: WordPressClient, params: Record<string, unknown>) => Promise<unknown>;
  }> {
    const itemFields: MCPToolSchema["properties"] = {
      url: { type: "string", description: "Link address, for a custom link." },
      object: {
        type: "string",
        description: "What the item links to, for a page or category: page, post, category, post_tag and so on.",
      },
      object_id: { type: "number", description: "The ID of the page, post or category the item links to." },
      parent: { type: "number", description: "ID of the parent menu item (for a dropdown). 0 means top level." },
      menu_order: { type: "number", description: "Position in the menu, starting at 1." },
    };
    return [
      {
        name: "wp_list_menus",
        description:
          "Lists the site's navigation menus with their IDs and the theme locations (header, footer) they are assigned to.",
        inputSchema: { type: "object", properties: {}, required: [] },
        handler: this.handleListMenus.bind(this),
      },
      {
        name: "wp_get_menu",
        description: "Retrieves one menu and all of its items (ID, title, link, parent, order, type) as a tree.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "number", description: "The menu ID from wp_list_menus." } },
          required: ["id"],
        },
        handler: this.handleGetMenu.bind(this),
      },
      {
        name: "wp_create_menu_item",
        description:
          "Adds an item to a menu. Give either a url (custom link) or object + object_id (link to a page, post or category). " +
          "Saves a snapshot of the menu first; undo with wp_restore_menu_snapshot.",
        inputSchema: {
          type: "object",
          properties: {
            menu_id: { type: "number", description: "The menu to add to." },
            title: { type: "string", description: "The text shown in the menu." },
            ...itemFields,
          },
          required: ["menu_id", "title"],
        },
        handler: this.handleCreateMenuItem.bind(this),
      },
      {
        name: "wp_update_menu_item",
        description:
          "Changes a menu item's title, link, parent or position. Saves a snapshot of the menu first; undo with wp_restore_menu_snapshot.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "The menu item ID from wp_get_menu." },
            title: { type: "string", description: "New text shown in the menu." },
            ...itemFields,
          },
          required: ["id"],
        },
        handler: this.handleUpdateMenuItem.bind(this),
      },
      {
        name: "wp_delete_menu_item",
        description:
          "Permanently deletes a menu item (WordPress has no trash for menu items). Saves a snapshot of the menu first; undo with wp_restore_menu_snapshot.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "number", description: "The menu item ID from wp_get_menu." } },
          required: ["id"],
        },
        handler: this.handleDeleteMenuItem.bind(this),
      },
      {
        name: "wp_restore_menu_snapshot",
        description:
          "Puts a menu back the way a saved snapshot had it: restores titles, links, parents and order, recreates deleted items, and deletes items added since. " +
          "The menu's current state is snapshotted first. Snapshot file names are shown after every menu change; they live in backups/menus/<site>/.",
        inputSchema: {
          type: "object",
          properties: {
            snapshot: {
              type: "string",
              description:
                "Snapshot file name (for example 7-2026-10-11T12-00-00.000Z.json) from a previous menu change.",
            },
          },
          required: ["snapshot"],
        },
        handler: this.handleRestoreMenuSnapshot.bind(this),
      },
    ];
  }

  public async handleListMenus(client: WordPressClient, _params: Record<string, unknown>): Promise<unknown> {
    try {
      const menus = await client.get<MenuRecord[]>("menus?context=edit&per_page=100");
      if (menus.length === 0) return "No menus found.";
      return (
        `Found ${menus.length} menus:\n\n` +
        menus
          .map(
            (m) =>
              `- ID ${m.id}: **${m.name}** (${m.slug ?? "no slug"}) — locations: ${m.locations?.join(", ") || "none"}`,
          )
          .join("\n")
      );
    } catch (_error) {
      themeRestError("Failed to list menus", _error, "menus");
    }
  }

  public async handleGetMenu(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const id = parseId(params);
    try {
      const menu = await client.get<MenuRecord>(`menus/${id}?context=edit`);
      const items = await fetchMenuItems(client, id);
      const body = items.length
        ? orderTree(items)
            .map(({ item, depth }) => itemLine(item, depth))
            .join("\n")
        : "(no items)";
      return `**Menu ${menu.id}: ${menu.name}** — locations: ${menu.locations?.join(", ") || "none"}\n\n${body}`;
    } catch (_error) {
      themeRestError("Failed to get menu", _error, "menus");
    }
  }

  public async handleCreateMenuItem(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const { menu_id, title, url, type, object, object_id, parent, menu_order } = toolParams<
      MenuItemInput & { menu_id: number; title: string }
    >(params);
    try {
      assertSafeUrl(url);
      if (!url && !(object && object_id)) {
        throw invalid("Give either a url (custom link) or object and object_id (link to a page, post or category).");
      }
      const snapshot = await writeMenuSnapshot(client, menu_id);
      const body: Record<string, unknown> = { title, menus: menu_id, status: "publish" };
      if (url) {
        body.type = "custom";
        body.url = url;
      } else {
        body.type = type ?? (object === "category" || object === "post_tag" ? "taxonomy" : "post_type");
        body.object = object;
        body.object_id = object_id;
      }
      if (parent !== undefined) body.parent = parent;
      if (menu_order !== undefined) body.menu_order = menu_order;
      const created = await client.post<MenuItemRecord>("menu-items", body);
      return `✅ Menu item ${created.id} added to menu ${menu_id}.\n- Title: ${title}\n- Snapshot saved first: ${snapshot.file} (undo with wp_restore_menu_snapshot)`;
    } catch (_error) {
      themeRestError("Failed to create menu item", _error, "menus");
    }
  }

  public async handleUpdateMenuItem(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const { id, title, url, object, object_id, parent, menu_order } = toolParams<MenuItemInput & { id: number }>(
      params,
    );
    try {
      assertSafeUrl(url);
      const body: Record<string, unknown> = {};
      for (const [key, value] of Object.entries({ title, url, object, object_id, parent, menu_order })) {
        if (value !== undefined) body[key] = value;
      }
      if (!Object.keys(body).length)
        throw invalid("Nothing to change: give at least one of title, url, object, object_id, parent, menu_order.");
      const menuId = await this.menuIdOf(client, id);
      const snapshot = await writeMenuSnapshot(client, menuId);
      await client.post(`menu-items/${id}`, body);
      return `✅ Menu item ${id} updated (${Object.keys(body).join(", ")}).\n- Snapshot saved first: ${snapshot.file} (undo with wp_restore_menu_snapshot)`;
    } catch (_error) {
      themeRestError("Failed to update menu item", _error, "menus");
    }
  }

  public async handleDeleteMenuItem(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const id = parseId(params);
    try {
      const menuId = await this.menuIdOf(client, id);
      const snapshot = await writeMenuSnapshot(client, menuId);
      // Menu items have no trash, so WordPress only accepts a forced delete.
      await client.delete(`menu-items/${id}?force=true`);
      return `✅ Menu item ${id} deleted from menu ${menuId}.\n- Snapshot saved first: ${snapshot.file} (undo with wp_restore_menu_snapshot)`;
    } catch (_error) {
      themeRestError("Failed to delete menu item", _error, "menus");
    }
  }

  public async handleRestoreMenuSnapshot(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const { snapshot } = toolParams<{ snapshot: string }>(params);
    try {
      const path = await resolveSnapshotPath(client, snapshot);
      const data = await readMenuSnapshot(path);
      const report = await restoreMenuSnapshot(client, data);
      const lines = [
        report.failed.length
          ? `⚠️ Menu ${data.menu_id} partly restored from ${snapshot} (${report.failed.length} problem(s)).`
          : `✅ Menu ${data.menu_id} restored from ${snapshot}.`,
        report.changes.length
          ? report.changes.map((c) => `- ${c}`).join("\n")
          : "- Nothing needed changing; the menu already matched.",
      ];
      if (report.failed.length) lines.push("Problems:", ...report.failed.map((f) => `- ${f}`));
      lines.push(`The menu as it was before this restore is saved as ${report.backup}.`);
      return lines.join("\n");
    } catch (_error) {
      themeRestError("Failed to restore menu snapshot", _error, "menus");
    }
  }

  /** The menu an item belongs to, read from the item itself (WordPress returns it as a number). */
  private async menuIdOf(client: WordPressClient, itemId: number): Promise<number> {
    const item = await client.get<{ menus?: number | number[] }>(`menu-items/${itemId}?context=edit`);
    const menuId = Array.isArray(item.menus) ? item.menus[0] : item.menus;
    if (!menuId)
      throw invalid(`Menu item ${itemId} is not in any menu, so there is nothing to snapshot. Nothing was changed.`);
    return menuId;
  }
}

export default MenuTools;
