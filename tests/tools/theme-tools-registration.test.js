import { vi } from "vitest";
import { ToolRegistry } from "@/server/ToolRegistry.js";

const THEME_TOOLS = [
  "wp_list_menus",
  "wp_get_menu",
  "wp_create_menu_item",
  "wp_update_menu_item",
  "wp_delete_menu_item",
  "wp_restore_menu_snapshot",
  "wp_list_template_parts",
  "wp_get_template_part",
  "wp_update_template_part",
  "wp_get_template_part_revisions",
  "wp_restore_template_part_revision",
  "wp_list_widget_areas",
  "wp_get_widget_area",
  "wp_update_widget",
  "wp_create_widget",
  "wp_delete_widget",
  "wp_restore_widget_snapshot",
];

describe("theme tool registration", () => {
  it("registers every tool through the registry, 105 in total", () => {
    const tools = new Map();
    const server = {
      tool: vi.fn((name, _description, schema) => tools.set(name, schema)),
      server: { setRequestHandler: vi.fn() },
    };
    new ToolRegistry(server, new Map([["site1", {}]])).registerAllTools();

    expect(tools.size).toBe(105);
    for (const name of THEME_TOOLS) expect(tools.has(name), name).toBe(true);
  });

  it("validates arguments centrally: ids must be real, unsafe links are rejected", () => {
    const tools = new Map();
    const server = {
      tool: vi.fn((name, _description, schema) => tools.set(name, schema)),
      server: { setRequestHandler: vi.fn() },
    };
    new ToolRegistry(server, new Map([["site1", {}]])).registerAllTools();

    const create = tools.get("wp_create_menu_item");
    expect(create.menu_id.safeParse(5).success).toBe(true);
    expect(create.menu_id.safeParse("5").success).toBe(false);
    expect(create.url.safeParse("javascript:alert(1)").success).toBe(false);
    expect(create.url.safeParse("https://example.com/a").success).toBe(true);

    const update = tools.get("wp_update_template_part");
    expect(update.content.safeParse("<!-- wp:site-title /-->").success).toBe(true);
    expect(update.content.safeParse("<script>x()</script>").success).toBe(false);
  });
});
