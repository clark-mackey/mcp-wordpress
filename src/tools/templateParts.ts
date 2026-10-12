import { WordPressClient } from "@/client/api.js";
import { WordPressAPIError } from "@/types/client.js";
import type { JSONSchemaProperty, MCPToolSchema } from "@/types/mcp.js";
import { isUnsafeWordPressContent } from "@/security/InputValidator.js";
import { freshGet } from "./localSnapshots.js";
import { parseId, toolParams } from "./params.js";
import {
  readTemplatePartSnapshot,
  resolveTemplatePartSnapshotPath,
  writeTemplatePartSnapshot,
} from "./templatePartSnapshots.js";
import { NO_TEMPLATE_PARTS_MESSAGE, themeRestError } from "./themeShared.js";

interface TemplatePart {
  id: string;
  slug: string;
  theme?: string;
  area?: string;
  status?: string;
  modified?: string;
  title?: { raw?: string; rendered?: string };
  content?: { raw?: string };
}

interface TemplatePartRevision {
  id: number;
  date?: string;
  modified?: string;
  author?: number;
  content?: { raw?: string };
}

const invalid = (message: string) => new WordPressAPIError(message, 400, "INVALID_PARAMETER");

/**
 * Template part IDs look like "twentytwentyfour//header" (theme, two slashes, slug). WordPress
 * routes on that literal "//", so each half is URL-encoded on its own and the slashes stay as they
 * are. Encoding the whole ID would turn them into %2F, which the route does not match. Theme folders
 * and slugs are plain [A-Za-z0-9_.-], so anything else (spaces, %, ?, #, extra slashes) is refused, not escaped.
 */
export function templatePartPath(id: string): string {
  const parts = id.split("//");
  const slug = parts[parts.length - 1] ?? "";
  const theme = parts.length === 2 ? parts[0] : undefined;
  // The theme half may carry one subdirectory ("parent/child"); the slug never has a slash.
  const segments = [...(theme?.split("/") ?? []), slug];
  const valid =
    parts.length <= 2 &&
    (theme === undefined || /^(?:[\w.-]+\/)?[\w.-]+$/.test(theme)) &&
    /^[\w.-]+$/.test(slug) &&
    segments.every((p) => p !== "." && p !== "..");
  if (!valid) {
    throw invalid(`"${id}" is not a template part ID. Use the ID from wp_list_template_parts, like theme//header.`);
  }
  const encode = (half: string) => half.split("/").map(encodeURIComponent).join("/");
  return parts.map(encode).join("//");
}

export const isTemplatePartId = (id: string): boolean => {
  try {
    templatePartPath(id);
    return true;
  } catch {
    return false;
  }
};

/**
 * Header and footer through template parts (block themes only). Classic themes have no template
 * parts, which shows up as a missing route or an empty list, and is reported in plain English.
 *
 * Undo has two layers. WordPress 6.4+ keeps revisions of template parts (GET
 * /wp/v2/template-parts/{id}/revisions), but only once the part is a database post: the FIRST edit of a
 * part that still comes from a theme file creates that post and leaves no revision of the original. So every
 * update also saves the current content to a local file first (templatePartSnapshots.ts), which
 * wp_restore_template_part_snapshot puts back. Revisions (wp_get_template_part_revisions,
 * wp_restore_template_part_revision) cover later edits on 6.4+.
 */
export class TemplatePartTools {
  public getTools(): Array<{
    name: string;
    description: string;
    inputSchema?: MCPToolSchema;
    handler: (client: WordPressClient, params: Record<string, unknown>) => Promise<unknown>;
  }> {
    const idProp: JSONSchemaProperty = {
      type: "string",
      description: 'The template part ID from wp_list_template_parts, like "twentytwentyfour//header".',
    };
    return [
      {
        name: "wp_list_template_parts",
        description:
          "Lists the block theme's template parts, such as the header and footer, with their IDs and areas. Block themes only; classic themes have none.",
        inputSchema: { type: "object", properties: {}, required: [] },
        handler: this.handleListTemplateParts.bind(this),
      },
      {
        name: "wp_get_template_part",
        description: "Retrieves a template part's block markup (raw content) for editing.",
        inputSchema: { type: "object", properties: { id: idProp }, required: ["id"] },
        handler: this.handleGetTemplatePart.bind(this),
      },
      {
        name: "wp_update_template_part",
        description:
          "Replaces a template part's content (for example the site header or footer) and applies it to the whole site immediately. " +
          "Send the complete block markup, starting from wp_get_template_part; blank content is refused. " +
          "A local copy of the current content is always saved first (undo with wp_restore_template_part_snapshot). " +
          "WordPress 6.4+ revisions only exist after a part's first edit, so do not rely on them for the first change.",
        inputSchema: {
          type: "object",
          properties: { id: idProp, content: { type: "string", description: "The full new block markup." } },
          required: ["id", "content"],
        },
        handler: this.handleUpdateTemplatePart.bind(this),
      },
      {
        name: "wp_restore_template_part_snapshot",
        description:
          "Puts a template part back to the content saved in a local snapshot (shown after every wp_update_template_part). " +
          "The current content is snapshotted first, so this can be undone too. Snapshots live in backups/template-parts/<site>/.",
        inputSchema: {
          type: "object",
          properties: {
            snapshot: { type: "string", description: "Snapshot file name from a previous template part update." },
          },
          required: ["snapshot"],
        },
        handler: this.handleRestoreTemplatePartSnapshot.bind(this),
      },
      {
        name: "wp_get_template_part_revisions",
        description: "Lists earlier saved versions of a template part (WordPress 6.4+), newest first.",
        inputSchema: { type: "object", properties: { id: idProp }, required: ["id"] },
        handler: this.handleGetTemplatePartRevisions.bind(this),
      },
      {
        name: "wp_restore_template_part_revision",
        description:
          "Puts a template part back to an earlier revision's content. The current version is kept as a new revision, so this can be undone too. " +
          "Get revision IDs from wp_get_template_part_revisions.",
        inputSchema: {
          type: "object",
          properties: { id: idProp, revision_id: { type: "number", description: "The revision ID to restore." } },
          required: ["id", "revision_id"],
        },
        handler: this.handleRestoreTemplatePartRevision.bind(this),
      },
    ];
  }

  public async handleListTemplateParts(client: WordPressClient, _params: Record<string, unknown>): Promise<unknown> {
    try {
      const parts = await freshGet<TemplatePart[]>(client, "template-parts");
      if (parts.length === 0) return NO_TEMPLATE_PARTS_MESSAGE;
      return (
        `Found ${parts.length} template parts:\n\n` +
        parts
          .map(
            (p) =>
              `- ID ${p.id}: **${p.title?.rendered || p.slug}** (slug ${p.slug}, area ${p.area ?? "uncategorized"})`,
          )
          .join("\n")
      );
    } catch (_error) {
      themeRestError("Failed to list template parts", _error, "template-parts");
    }
  }

  public async handleGetTemplatePart(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const { id } = toolParams<{ id: string }>(params);
    try {
      const part = await freshGet<TemplatePart>(client, `template-parts/${templatePartPath(id)}?context=edit`);
      if (part.content?.raw === undefined) {
        throw new WordPressAPIError(
          "WordPress did not return the raw content. The account needs edit_theme_options to read it for editing.",
          403,
          "INSUFFICIENT_PERMISSIONS",
        );
      }
      return (
        `**Template part ${part.id}** (area ${part.area ?? "uncategorized"}, modified ${part.modified ?? "unknown"})\n\n` +
        `**Content:**\n\n${part.content.raw || "(empty)"}`
      );
    } catch (_error) {
      themeRestError("Failed to get template part", _error, "template-parts");
    }
  }

  public async handleUpdateTemplatePart(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const { id, content } = toolParams<{ id: string; content: string }>(params);
    try {
      // Same check wp_update_page applies; repeated here so a direct handler call cannot skip it.
      if (isUnsafeWordPressContent(content)) {
        throw invalid(
          "Unsafe content (script tag, javascript: URL, or event handler). Do not remove existing scripts or embeds to get past this; ask the user to make the edit in WP admin.",
        );
      }
      if (!content.trim()) throw invalid("Refusing to blank a template part: the new content is empty.");
      const path = templatePartPath(id);
      // Save what is there now before touching it. A part still served from a theme file has no
      // revision to fall back on after this edit, and if the copy cannot be saved nothing is changed.
      const current = await freshGet<TemplatePart>(client, `template-parts/${path}?context=edit`);
      if (current.content?.raw === undefined) {
        throw new WordPressAPIError(
          "WordPress did not return the current raw content, so it cannot be saved before the edit. The account needs edit_theme_options.",
          403,
          "INSUFFICIENT_PERMISSIONS",
        );
      }
      const saved = await writeTemplatePartSnapshot(client, id, current.content.raw);
      const part = await client.post<TemplatePart>(`template-parts/${path}`, { content });
      return (
        `✅ Template part ${part.id} updated. It is live on the whole site now.\n` +
        `- Original content saved first: ${saved.file} (undo with wp_restore_template_part_snapshot)\n` +
        `- WordPress revisions (WordPress 6.4+) only exist after a part's first edit; the local copy is always saved.`
      );
    } catch (_error) {
      themeRestError("Failed to update template part", _error, "template-parts");
    }
  }

  public async handleRestoreTemplatePartSnapshot(
    client: WordPressClient,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const { snapshot } = toolParams<{ snapshot: string }>(params);
    try {
      const file = await resolveTemplatePartSnapshotPath(client, snapshot);
      const data = await readTemplatePartSnapshot(file, client, isTemplatePartId);
      if (!data.content.trim()) throw invalid("Refusing to blank a template part: the snapshot content is empty.");
      if (isUnsafeWordPressContent(data.content)) {
        throw invalid(
          "Snapshot contains unsafe content (script tag, javascript: URL, or event handler). Restore it from WP admin instead.",
        );
      }
      const path = templatePartPath(data.part_id);
      // Snapshot what is live now first, so the restore can itself be undone.
      const current = await freshGet<TemplatePart>(client, `template-parts/${path}?context=edit`);
      if (current.content?.raw === undefined) {
        throw new WordPressAPIError(
          "WordPress did not return the current raw content. The account needs edit_theme_options.",
          403,
          "INSUFFICIENT_PERMISSIONS",
        );
      }
      const before = await writeTemplatePartSnapshot(client, data.part_id, current.content.raw);
      await client.post<TemplatePart>(`template-parts/${path}`, { content: data.content });
      return `✅ Template part ${data.part_id} restored from ${snapshot}.\nThe version you replaced is saved as ${before.file}.`;
    } catch (_error) {
      themeRestError("Failed to restore template part snapshot", _error, "template-parts");
    }
  }

  public async handleGetTemplatePartRevisions(
    client: WordPressClient,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const { id } = toolParams<{ id: string }>(params);
    try {
      const revisions = await freshGet<TemplatePartRevision[]>(
        client,
        `template-parts/${templatePartPath(id)}/revisions?per_page=20&orderby=date&order=desc`,
      );
      if (revisions.length === 0) return `No saved revisions for ${id} yet.`;
      return (
        `Found ${revisions.length} revisions of ${id}:\n\n` +
        revisions
          .map(
            (r) => `- Revision ${r.id}: saved ${r.modified ?? r.date ?? "unknown"} (author ${r.author ?? "unknown"})`,
          )
          .join("\n")
      );
    } catch (_error) {
      themeRestError("Failed to get template part revisions", _error, "template-part-revisions");
    }
  }

  public async handleRestoreTemplatePartRevision(
    client: WordPressClient,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const { id } = toolParams<{ id: string }>(params);
    const revisionId = parseId({ id: (params as { revision_id?: unknown }).revision_id });
    try {
      const path = templatePartPath(id);
      const revision = await freshGet<TemplatePartRevision>(
        client,
        `template-parts/${path}/revisions/${revisionId}?context=edit`,
      );
      if (revision.content?.raw === undefined) {
        throw new WordPressAPIError(
          `Revision ${revisionId} came back without raw content. The account needs edit_theme_options to restore it.`,
          403,
          "INSUFFICIENT_PERMISSIONS",
        );
      }
      if (isUnsafeWordPressContent(revision.content.raw)) {
        throw invalid(
          "Revision contains unsafe content (script tag, javascript: URL, or event handler). Restore it from WP admin instead.",
        );
      }
      const part = await client.post<TemplatePart>(`template-parts/${path}`, { content: revision.content.raw });
      return (
        `✅ Template part ${part.id} restored to revision ${revisionId}.\n` +
        `The version you replaced is still in revision history, so this restore can be undone the same way.`
      );
    } catch (_error) {
      themeRestError("Failed to restore template part revision", _error, "template-part-revisions");
    }
  }
}

export default TemplatePartTools;
