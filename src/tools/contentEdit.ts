import { WordPressClient } from "@/client/api.js";
import { WordPressAPIError } from "@/types/client.js";
import type { MCPToolSchema } from "@/types/mcp.js";
import type { WordPressPost } from "@/types/wordpress.js";
import { preserveToolError } from "@/utils/error.js";
import { isUnsafeWordPressContent } from "@/security/InputValidator.js";
import { toolParams } from "./params.js";
import { pluginRestUrl, readFresh } from "./pluginRest.js";

interface ContentEdit {
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
}

const countOccurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

/**
 * Exact-text edits to a page or post body, so changing a sentence does not mean sending the whole page back.
 */
export class ContentEditTools {
  public getTools(): Array<{
    name: string;
    description: string;
    inputSchema?: MCPToolSchema;
    handler: (client: WordPressClient, params: Record<string, unknown>) => Promise<unknown>;
  }> {
    return [
      {
        name: "wp_edit_content",
        description:
          "Changes part of a page or post body by exact text replacement, without sending the whole body. " +
          "Each old_string must match the raw content (Gutenberg block markup included) exactly once, unless replace_all is set; " +
          "find it with wp_get_page / wp_get_post `find`. All edits apply in order and are saved together as one revision, " +
          "or none are saved if any fails. Changes post_content only: page-builder layouts such as Elementor's are not touched.",
        inputSchema: {
          type: "object",
          properties: {
            post_type: {
              type: "string",
              description: "Whether the ID is a page or a post. Defaults to page.",
              enum: ["page", "post"],
            },
            id: {
              type: "number",
              description: "The ID of the page or post to edit.",
            },
            edits: {
              type: "array",
              description: "Replacements to apply in order.",
              items: {
                type: "object",
                properties: {
                  old_string: { type: "string", description: "Exact text to replace." },
                  new_string: { type: "string", description: "Replacement text (may be empty to delete)." },
                  replace_all: { type: "boolean", description: "Replace every match instead of requiring one." },
                },
              },
            },
          },
          required: ["id", "edits"],
        },
        handler: this.handleEditContent.bind(this),
      },
    ];
  }

  public async handleEditContent(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const {
      post_type = "page",
      id,
      edits,
    } = toolParams<{ post_type?: "page" | "post"; id: number; edits: ContentEdit[] }>(params);
    const label = post_type === "page" ? "Page" : "Post";
    try {
      if (!Array.isArray(edits) || edits.length === 0) {
        throw new WordPressAPIError("edits must list at least one replacement.", 400, "INVALID_PARAMETER");
      }

      // Bypass the client cache: the whole body is written back, so a stale cached copy would undo newer edits.
      const collection = post_type === "page" ? "pages" : "posts";
      const item = await readFresh<WordPressPost>(
        client,
        pluginRestUrl(client, "wp/v2", `${collection}/${id}?context=edit`),
        `${collection}/${id}`,
      );
      if (item.content?.raw === undefined) {
        throw new WordPressAPIError(
          `${label} ${id} came back without raw content. The account needs edit permission on it.`,
          403,
          "INSUFFICIENT_PERMISSIONS",
        );
      }

      // Validate and apply every edit before writing anything, so a bad edit saves nothing.
      let content = item.content.raw;
      const applied: string[] = [];
      edits.forEach((edit, n) => {
        const { old_string, new_string, replace_all = false } = edit;
        const where = `Edit ${n + 1}`;
        if (typeof old_string !== "string" || old_string === "" || typeof new_string !== "string") {
          throw new WordPressAPIError(
            `${where}: old_string (non-empty) and new_string are required.`,
            400,
            "INVALID_PARAMETER",
          );
        }
        if (old_string === new_string) {
          throw new WordPressAPIError(`${where}: old_string and new_string are identical.`, 400, "INVALID_PARAMETER");
        }
        const matches = countOccurrences(content, old_string);
        if (matches === 0) {
          throw new WordPressAPIError(
            `${where}: old_string not found in the ${post_type}'s raw content` +
              (n > 0 ? " (after the earlier edits were applied)" : "") +
              `. Copy it exactly from wp_get_${post_type} with \`find\`; block markup and entities must match.`,
            400,
            "INVALID_PARAMETER",
          );
        }
        if (matches > 1 && !replace_all) {
          throw new WordPressAPIError(
            `${where}: old_string matches ${matches} times. Include more surrounding text to pick one, or set replace_all.`,
            400,
            "INVALID_PARAMETER",
          );
        }
        content = replace_all
          ? content.split(old_string).join(new_string)
          : content.replace(old_string, () => new_string);
        applied.push(`- ${where}: ${matches} replacement${matches === 1 ? "" : "s"}`);
      });

      // Same check wp_update_page / wp_update_post apply, on the full body that will be saved.
      if (isUnsafeWordPressContent(content)) {
        throw new WordPressAPIError(
          "Unsafe content (script tag, javascript: URL, or event handler). Do not remove existing scripts or embeds to get past this; ask the user to make the edit in WP admin.",
          400,
          "INVALID_PARAMETER",
        );
      }

      const updated =
        post_type === "page" ? await client.updatePage({ id, content }) : await client.updatePost({ id, content });

      // WordPress may filter the body on save (kses for accounts without unfiltered_html).
      const altered =
        updated.content?.raw !== undefined && updated.content.raw !== content
          ? "\n⚠️ WordPress changed the content while saving (likely HTML filtering); check the result with `find`."
          : "";
      return (
        `✅ ${label} ${updated.id} edited (${edits.length} edit${edits.length === 1 ? "" : "s"}, status ${updated.status}).\n` +
        `${applied.join("\n")}${altered}\n` +
        `Undo with wp_restore_revision.`
      );
    } catch (_error) {
      preserveToolError(`Failed to edit ${post_type} content`, _error);
    }
  }
}

export default ContentEditTools;
