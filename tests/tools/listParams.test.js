import * as Tools from "@/tools/index.js";

// Strict argument validation rejects anything a schema omits, so every argument a list
// handler forwards to WordPress must be declared.
const listTools = Object.values(Tools)
  .flatMap((ToolClass) => {
    try {
      return new ToolClass(new Map()).getTools();
    } catch {
      return [];
    }
  })
  .filter((tool) => tool.name.startsWith("wp_list_"));

describe("list tool parameters", () => {
  it.each([
    "wp_list_pages",
    "wp_list_posts",
    "wp_list_media",
    "wp_list_users",
    "wp_list_comments",
    "wp_list_categories",
    "wp_list_tags",
  ])("%s declares page and per_page", (name) => {
    const props = listTools.find((tool) => tool.name === name).inputSchema.properties;
    expect(props.page).toBeDefined();
    expect(props.per_page).toBeDefined();
  });

  it("wp_list_posts declares the sort and offset arguments its handler forwards", () => {
    const props = listTools.find((tool) => tool.name === "wp_list_posts").inputSchema.properties;
    expect(props.orderby.enum).toContain("title");
    expect(props.order.enum).toEqual(["asc", "desc"]);
    expect(props.offset.type).toBe("number");
  });

  it("wp_list_pages can sort by menu order", () => {
    const props = listTools.find((tool) => tool.name === "wp_list_pages").inputSchema.properties;
    expect(props.orderby.enum).toContain("menu_order");
  });
});
