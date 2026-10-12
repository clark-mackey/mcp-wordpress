import { WordPressAPIError } from "@/types/client.js";
import { preserveToolError } from "@/utils/error.js";

export type ThemeRoute = "menus" | "template-parts" | "template-part-revisions";

const CLASSIC_THEME =
  "this site's theme has no template parts (classic theme) — its header/footer live in PHP files or a page builder and cannot be edited through the REST API";
const NEEDS_THEME_ACCESS =
  "the AI user lacks edit_theme_options; install wordpress/mu-plugins/mcp-wordpress-theme-access.php (see docs)";

/**
 * Rewrites the two failures people hit on the theme routes into plain English, keeping the
 * original status and code so callers and tests can still tell them apart. Everything else
 * goes through preserveToolError unchanged.
 */
export function themeRestError(prefix: string, error: unknown, route: ThemeRoute): never {
  if (error instanceof WordPressAPIError) {
    // Only rest_no_route means "the route is not there". A 404 for one missing menu item or
    // template part carries a different code and keeps WordPress's own message.
    if (error.statusCode === 404 && error.code === "rest_no_route") {
      const why =
        route === "template-parts"
          ? CLASSIC_THEME
          : route === "template-part-revisions"
            ? "this WordPress version does not keep template part revisions (needs WordPress 6.4 or newer)"
            : "this WordPress version has no menu endpoints (needs WordPress 5.9 or newer)";
      throw new WordPressAPIError(`${prefix}: ${why}`, 404, error.code);
    }
    if (error.statusCode === 403 && error.code?.startsWith("rest_cannot_")) {
      throw new WordPressAPIError(`${prefix}: ${NEEDS_THEME_ACCESS}`, 403, error.code);
    }
  }
  preserveToolError(prefix, error);
}

/** The text a block-theme-less site gets back when the template part list is empty. */
export const NO_TEMPLATE_PARTS_MESSAGE = `No template parts found: ${CLASSIC_THEME}.`;
