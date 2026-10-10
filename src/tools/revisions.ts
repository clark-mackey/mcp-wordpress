import { WordPressClient } from "@/client/api.js";
import { WordPressAPIError } from "@/types/client.js";
import type { MCPToolSchema } from "@/types/mcp.js";
import type { UpdatePageRequest } from "@/types/wordpress.js";
import { preserveToolError } from "@/utils/error.js";
import { isUnsafeWordPressContent } from "@/security/InputValidator.js";
import { toolParams } from "./params.js";

/**
 * Provides revision restore for pages and posts.
 * Listing revisions lives with the page and post tools (wp_get_page_revisions, wp_get_post_revisions).
 */
export class RevisionTools {
  public getTools(): Array<{
    name: string;
    description: string;
    inputSchema?: MCPToolSchema;
    handler: (client: WordPressClient, params: Record<string, unknown>) => Promise<unknown>;
  }> {
    return [
      {
        name: "wp_restore_revision",
        description:
          "Restores a page or post to an earlier revision by copying that revision's title, content and excerpt back onto it. " +
          "The page keeps its current status, so a published page goes live with the restored content immediately. " +
          "WordPress records the restore as a new revision, so it can itself be undone. " +
          "Get revision IDs from wp_get_page_revisions or wp_get_post_revisions.",
        inputSchema: {
          type: "object",
          properties: {
            post_type: {
              type: "string",
              description: "Whether the revision belongs to a page or a post. Defaults to page.",
              enum: ["page", "post"],
            },
            parent_id: {
              type: "number",
              description: "The ID of the page or post to restore.",
            },
            revision_id: {
              type: "number",
              description: "The ID of the revision to restore.",
            },
          },
          required: ["parent_id", "revision_id"],
        },
        handler: this.handleRestoreRevision.bind(this),
      },
    ];
  }

  public async handleRestoreRevision(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const {
      post_type = "page",
      parent_id,
      revision_id,
    } = toolParams<{ post_type?: "page" | "post"; parent_id: number; revision_id: number }>(params);
    const label = post_type === "page" ? "Page" : "Post";
    try {
      // WordPress returns 404 (rest_revision_parent_id_mismatch) if the revision doesn't belong to parent_id.
      const revision =
        post_type === "page"
          ? await client.getPageRevision(parent_id, revision_id)
          : await client.getPostRevision(parent_id, revision_id);

      if (revision.content?.raw === undefined) {
        throw new WordPressAPIError(
          `Revision ${revision_id} came back without raw content. The account needs edit permission on this ${post_type} to restore it.`,
          403,
          "INSUFFICIENT_PERMISSIONS",
        );
      }

      // Same check wp_update_page / wp_update_post apply to incoming content.
      if (isUnsafeWordPressContent(revision.content.raw)) {
        throw new WordPressAPIError(
          "Revision contains unsafe content (script tag, javascript: URL, or event handler). Restore it from WP admin instead.",
          400,
          "INVALID_PARAMETER",
        );
      }

      // Only send fields the revision actually carries: pages without excerpt support return no excerpt.
      const update: UpdatePageRequest = { id: parent_id, content: revision.content.raw };
      if (revision.title?.raw !== undefined) update.title = revision.title.raw;
      if (revision.excerpt?.raw !== undefined) update.excerpt = revision.excerpt.raw;

      const updated = post_type === "page" ? await client.updatePage(update) : await client.updatePost(update);

      return (
        `✅ ${label} ${updated.id} restored to revision ${revision_id} (saved ${new Date(revision.modified).toLocaleString()}).\n` +
        `- Status unchanged: ${updated.status}\n` +
        `- Link: ${updated.link}\n` +
        `The version you replaced is still in revision history, so this restore can be undone the same way.`
      );
    } catch (_error) {
      preserveToolError(`Failed to restore ${post_type} revision`, _error);
    }
  }
}

export default RevisionTools;
