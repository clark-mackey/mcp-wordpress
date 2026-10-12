import { WordPressClient } from "@/client/api.js";
import { WordPressAPIError } from "@/types/client.js";
import type { MCPToolSchema } from "@/types/mcp.js";
import { isUnsafePlainText, isUnsafeWordPressContent } from "@/security/InputValidator.js";
import { freshGet } from "./localSnapshots.js";
import { toolParams } from "./params.js";
import { themeRestError } from "./themeShared.js";
import {
  WidgetRecord,
  assertWidgetId,
  enc,
  fetchWidgets,
  readWidgetSnapshot,
  resolveWidgetSnapshotPath,
  restoreWidgetSnapshot,
  writeWidgetSnapshot,
} from "./widgetSnapshots.js";

interface Sidebar {
  id: string;
  name?: string;
  description?: string;
  status?: string;
  widgets?: string[];
}

const invalid = (message: string) => new WordPressAPIError(message, 400, "INVALID_PARAMETER");
const unsafeContent = () =>
  invalid(
    "Unsafe content (script tag, javascript: URL, or event handler). Do not remove existing scripts or embeds to get past this; ask the user to make the edit in WP admin.",
  );

/** Core widget types whose settings WordPress exposes as editable raw instances. */
const RAW_TYPES = new Set(["block", "text", "custom_html"]);

/** What a widget says, in words: block and core Text/Custom HTML show their content; anything else is named by type only. */
function describeWidget(w: WidgetRecord): string {
  const raw = w.instance?.raw;
  const head = `- ${w.id} (${w.id_base ?? "unknown type"})`;
  if (!raw) return `${head}: legacy widget, settings not readable over REST (id_base ${w.id_base ?? "unknown"})`;
  const parts: string[] = [];
  for (const key of ["title", "content", "text"]) {
    if (typeof raw[key] === "string" && raw[key]) parts.push(`${key}: ${raw[key]}`);
  }
  return parts.length ? `${head}:\n${parts.map((p) => `  ${p}`).join("\n")}` : `${head}: (empty)`;
}

/**
 * Footer and sidebar widgets through the core REST API (WordPress 5.8+). Many classic themes keep
 * their footer in widget areas, so this is how Claude edits "the footer" there. Needs the same
 * edit_theme_options grant as menus. Undo is a local snapshot of the whole area before every
 * change (widgetSnapshots.ts) and wp_restore_widget_snapshot.
 */
export class WidgetTools {
  public getTools(): Array<{
    name: string;
    description: string;
    inputSchema?: MCPToolSchema;
    handler: (client: WordPressClient, params: Record<string, unknown>) => Promise<unknown>;
  }> {
    return [
      {
        name: "wp_list_widget_areas",
        description:
          "Lists the theme's widget areas (sidebars, footer columns) with their widgets. Areas with 'footer' in their ID or name are marked as likely footers.",
        inputSchema: { type: "object", properties: {}, required: [] },
        handler: this.handleListWidgetAreas.bind(this),
      },
      {
        name: "wp_get_widget_area",
        description:
          "Shows one widget area and the content of each widget in it. Block widgets and core Text / Custom HTML widgets are readable; other plugin widgets are shown by type only.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "The widget area ID from wp_list_widget_areas, like sidebar-1." },
          },
          required: ["id"],
        },
        handler: this.handleGetWidgetArea.bind(this),
      },
      {
        name: "wp_update_widget",
        description:
          "Changes a widget's content. Block widgets: send content (block markup). Core Custom HTML: content and optional title. Core Text: text and optional title. " +
          "Other widget types cannot be edited over REST. Saves a snapshot of the whole area first; undo with wp_restore_widget_snapshot.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "The widget ID from wp_get_widget_area, like block-3 or text-2." },
            content: { type: "string", description: "New content, for block and Custom HTML widgets." },
            text: { type: "string", description: "New text, for core Text widgets." },
            title: { type: "string", description: "New title, for Text and Custom HTML widgets." },
          },
          required: ["id"],
        },
        handler: this.handleUpdateWidget.bind(this),
      },
      {
        name: "wp_create_widget",
        description:
          "Adds a block widget (with block markup or plain HTML content) to a widget area. Block widgets only. Saves a snapshot of the area first; undo with wp_restore_widget_snapshot.",
        inputSchema: {
          type: "object",
          properties: {
            sidebar: { type: "string", description: "The widget area ID from wp_list_widget_areas." },
            content: { type: "string", description: "The widget's block markup." },
          },
          required: ["sidebar", "content"],
        },
        handler: this.handleCreateWidget.bind(this),
      },
      {
        name: "wp_delete_widget",
        description:
          "Takes a widget out of its widget area by moving it to Inactive Widgets (its settings are kept and it can be put back in WP admin). Saves a snapshot of the area first; undo with wp_restore_widget_snapshot.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string", description: "The widget ID from wp_get_widget_area." } },
          required: ["id"],
        },
        handler: this.handleDeleteWidget.bind(this),
      },
      {
        name: "wp_restore_widget_snapshot",
        description:
          "Puts a widget area back the way a saved snapshot had it: restores widget settings and area, recreates deleted block widgets, " +
          "and MOVES widgets that were added after the snapshot to Inactive Widgets (only when every earlier step worked; nothing is permanently deleted). The current state is snapshotted first. " +
          "Snapshot names are shown after every widget change; they live in backups/widgets/<site>/. Widget order is not restored.",
        inputSchema: {
          type: "object",
          properties: {
            snapshot: { type: "string", description: "Snapshot file name from a previous widget change." },
          },
          required: ["snapshot"],
        },
        handler: this.handleRestoreWidgetSnapshot.bind(this),
      },
    ];
  }

  public async handleListWidgetAreas(client: WordPressClient, _params: Record<string, unknown>): Promise<unknown> {
    try {
      const sidebars = await freshGet<Sidebar[]>(client, "sidebars?context=edit&per_page=100");
      if (sidebars.length === 0) return "No widget areas found: this theme has no widget areas.";
      return (
        `Found ${sidebars.length} widget areas:\n\n` +
        sidebars
          .map((s) => {
            const footer = /footer/i.test(`${s.id} ${s.name ?? ""}`) ? " [likely footer]" : "";
            return `- ${s.id}: **${s.name ?? s.id}**${footer} (${s.status ?? "active"}) — widgets: ${s.widgets?.join(", ") || "none"}${s.description ? `\n  ${s.description}` : ""}`;
          })
          .join("\n")
      );
    } catch (_error) {
      themeRestError("Failed to list widget areas", _error, "widgets");
    }
  }

  public async handleGetWidgetArea(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    try {
      const id = assertWidgetId(toolParams<{ id: string }>(params).id, "widget area");
      const sidebar = await freshGet<Sidebar>(client, `sidebars/${enc(id)}?context=edit`);
      const widgets = await fetchWidgets(client, id);
      return `**Widget area ${sidebar.id}: ${sidebar.name ?? sidebar.id}**\n\n${widgets.length ? widgets.map(describeWidget).join("\n") : "(no widgets)"}`;
    } catch (_error) {
      themeRestError("Failed to get widget area", _error, "widgets");
    }
  }

  public async handleCreateWidget(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const { sidebar, content } = toolParams<{ sidebar: string; content: string }>(params);
    try {
      assertWidgetId(sidebar, "widget area");
      if (typeof content !== "string") throw invalid("content must be text (block markup).");
      if (!content.trim()) throw invalid("Refusing to create an empty widget: content is blank.");
      if (isUnsafeWordPressContent(content)) throw unsafeContent();
      const snapshot = await writeWidgetSnapshot(client, sidebar);
      const created = await client.post<WidgetRecord>("widgets", {
        id_base: "block",
        sidebar,
        instance: { raw: { content } },
      });
      return `✅ Block widget ${created.id} added to ${sidebar}.\n- Snapshot saved first: ${snapshot.file} (undo with wp_restore_widget_snapshot)`;
    } catch (_error) {
      themeRestError("Failed to create widget", _error, "widgets");
    }
  }

  public async handleUpdateWidget(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const { id, content, text, title } = toolParams<{ id: string; content?: string; text?: string; title?: string }>(
      params,
    );
    let type = "unknown";
    try {
      assertWidgetId(id);
      for (const [name, value] of Object.entries({ content, text, title })) {
        if (value !== undefined && typeof value !== "string") throw invalid(`${name} must be text.`);
      }
      for (const html of [content, text])
        if (html !== undefined && isUnsafeWordPressContent(html)) throw unsafeContent();
      if (title !== undefined && isUnsafePlainText(title)) throw unsafeContent();

      const widget = await freshGet<WidgetRecord>(client, `widgets/${enc(id)}?context=edit`);
      type = widget.id_base ?? "unknown";
      if (!RAW_TYPES.has(type) || !widget.instance?.raw) {
        throw invalid(
          `Widget ${id} is a "${type}" widget. WordPress only lets block, Text and Custom HTML widgets be edited over REST; change this one in WP admin (Appearance > Widgets).`,
        );
      }
      const wanted: Record<string, string | undefined> =
        type === "block" ? { content } : type === "custom_html" ? { content, title } : { text, title };
      const changes = Object.fromEntries(Object.entries(wanted).filter(([, v]) => v !== undefined));
      const misplaced = Object.entries({ content, text, title }).filter(([k, v]) => v !== undefined && !(k in wanted));
      if (misplaced.length || !Object.keys(changes).length) {
        throw invalid(
          type === "block"
            ? "A block widget only takes content."
            : type === "custom_html"
              ? "A Custom HTML widget takes content and title."
              : "A Text widget takes text and title.",
        );
      }
      if (!widget.sidebar) throw invalid(`Widget ${id} is not in a widget area, so nothing was changed.`);
      const snapshot = await writeWidgetSnapshot(client, widget.sidebar);
      await client.post(`widgets/${enc(id)}`, { instance: { raw: { ...widget.instance.raw, ...changes } } });
      return `✅ Widget ${id} updated (${Object.keys(changes).join(", ")}).\n- Snapshot saved first: ${snapshot.file} (undo with wp_restore_widget_snapshot)`;
    } catch (_error) {
      if (_error instanceof WordPressAPIError && _error.statusCode === 400 && _error.code !== "INVALID_PARAMETER") {
        throw new WordPressAPIError(
          `Failed to update widget: WordPress would not accept this change to the "${type}" widget (${_error.message}). Change it in WP admin instead.`,
          400,
          _error.code,
        );
      }
      themeRestError("Failed to update widget", _error, "widgets");
    }
  }

  public async handleDeleteWidget(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const { id } = toolParams<{ id: string }>(params);
    try {
      assertWidgetId(id);
      const widget = await freshGet<WidgetRecord>(client, `widgets/${enc(id)}?context=edit`);
      if (!widget.sidebar) throw invalid(`Widget ${id} is not in a widget area, so nothing was changed.`);
      const snapshot = await writeWidgetSnapshot(client, widget.sidebar);
      // No force: core then moves the widget to wp_inactive_widgets with its settings intact.
      await client.delete(`widgets/${enc(id)}`);
      return `✅ Widget ${id} moved from ${widget.sidebar} to Inactive Widgets (settings kept; reactivate it in WP admin > Appearance > Widgets).\n- Snapshot saved first: ${snapshot.file} (undo with wp_restore_widget_snapshot)`;
    } catch (_error) {
      themeRestError("Failed to delete widget", _error, "widgets");
    }
  }

  public async handleRestoreWidgetSnapshot(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const { snapshot } = toolParams<{ snapshot: string }>(params);
    try {
      const path = await resolveWidgetSnapshotPath(client, snapshot);
      const data = await readWidgetSnapshot(path, client);
      const report = await restoreWidgetSnapshot(client, data);
      const lines = [
        report.failed.length
          ? `⚠️ Widget area ${data.sidebar_id} partly restored from ${snapshot} (${report.failed.length} problem(s)).`
          : `✅ Widget area ${data.sidebar_id} restored from ${snapshot}.`,
        report.changes.length
          ? report.changes.map((c) => `- ${c}`).join("\n")
          : report.failed.length
            ? "- No changes were made."
            : "- Nothing needed changing; the area already matched.",
      ];
      if (report.failed.length) lines.push("Problems:", ...report.failed.map((f) => `- ${f}`));
      if (report.deletionSkipped)
        lines.push("Widgets added after the snapshot were NOT moved to Inactive Widgets, because a step above failed.");
      lines.push(`The area as it was before this restore is saved as ${report.backup}.`);
      return lines.join("\n");
    } catch (_error) {
      themeRestError("Failed to restore widget snapshot", _error, "widgets");
    }
  }
}

export default WidgetTools;
