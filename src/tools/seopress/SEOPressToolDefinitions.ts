/**
 * SEOPress tool definitions (schemas only; handlers live in SEOPressHandlers.ts).
 */

import type { MCPTool } from "@/types/mcp.js";
import { READABLE_SETTINGS_SECTIONS, WRITABLE_SETTINGS_SECTIONS } from "./SEOPressHandlers.js";

const ITEM_ID = {
  type: "number",
  description: "The ID of the post, page, or custom post type item.",
} as const;

const VERIFIED =
  "Reads the stored values back and fails if SEOPress did not store what was sent, listing the previous values so the change can be undone.";

export const getPostSEOTool: MCPTool = {
  name: "wp_seopress_get_post_seo",
  description:
    "Gets every SEOPress field of a post, page, or custom post type item: SEO title and meta description, robots " +
    "(noindex, nofollow, canonical, primary category), social (Open Graph and X), redirect, and target keywords, " +
    "plus what SEOPress outputs for it when published. Robots fields set by SEOPress global settings are marked.",
  inputSchema: {
    type: "object",
    properties: { id: ITEM_ID },
    required: ["id"],
  },
};

export const updateTitleDescriptionTool: MCPTool = {
  name: "wp_seopress_update_title_description",
  description:
    "Sets the SEOPress SEO title and/or meta description of a post, page, or custom post type item. An empty string " +
    "clears the field so SEOPress uses the site's default template. Template variables such as %%sitetitle%% are " +
    `stored as written. ${VERIFIED} Also reports the title and description SEOPress outputs when published.`,
  inputSchema: {
    type: "object",
    properties: {
      id: ITEM_ID,
      title: { type: "string", description: "The SEO title. Omit to leave it unchanged." },
      description: { type: "string", description: "The meta description. Omit to leave it unchanged." },
    },
    required: ["id"],
  },
};

export const updateRobotsTool: MCPTool = {
  name: "wp_seopress_update_robots",
  description:
    "Sets SEOPress robots settings of a post, page, or custom post type item. Omitted fields are unchanged. Fails " +
    `without saving if a requested field is set by SEOPress global settings for this item. ${VERIFIED}`,
  inputSchema: {
    type: "object",
    properties: {
      id: ITEM_ID,
      noindex: { type: "boolean", description: "true hides the item from search results (noindex)." },
      nofollow: { type: "boolean", description: "true tells search engines not to follow its links (nofollow)." },
      noimageindex: { type: "boolean", description: "true stops search engines indexing its images." },
      nosnippet: { type: "boolean", description: "true stops search engines showing a snippet." },
      canonical: {
        type: "string",
        description: "Canonical URL. An empty string removes the custom canonical (the item's own URL is used).",
      },
      primary_category: {
        type: "number",
        description: "Term ID of the primary category (used in breadcrumbs and permalinks). 0 clears it.",
      },
      freeze_modified_date: {
        type: "boolean",
        description: "true keeps the item's modified date from changing on save.",
      },
    },
    required: ["id"],
  },
};

export const updateSocialTool: MCPTool = {
  name: "wp_seopress_update_social",
  description:
    "Sets SEOPress Open Graph (Facebook, LinkedIn) and X (Twitter) title, description, and image of a post, page, or " +
    "custom post type item. Empty strings clear a field so SEOPress falls back to the SEO title, description, or " +
    `default image. Images are given as media library IDs; 0 clears the image. ${VERIFIED}`,
  inputSchema: {
    type: "object",
    properties: {
      id: ITEM_ID,
      facebook_title: { type: "string", description: "Open Graph title." },
      facebook_description: { type: "string", description: "Open Graph description." },
      facebook_image_id: { type: "number", description: "Media library ID of the Open Graph image. 0 clears it." },
      x_title: { type: "string", description: "X (Twitter) card title." },
      x_description: { type: "string", description: "X (Twitter) card description." },
      x_image_id: { type: "number", description: "Media library ID of the X (Twitter) card image. 0 clears it." },
    },
    required: ["id"],
  },
};

export const updateTargetKeywordsTool: MCPTool = {
  name: "wp_seopress_update_target_keywords",
  description:
    "Replaces the SEOPress target keywords (used by its content analysis) of a post, page, or custom post type item. " +
    `An empty list clears them. ${VERIFIED}`,
  inputSchema: {
    type: "object",
    properties: {
      id: ITEM_ID,
      keywords: {
        type: "array",
        items: { type: "string" },
        description: "Target keywords in priority order, without commas.",
      },
    },
    required: ["id", "keywords"],
  },
};

export const updateRedirectTool: MCPTool = {
  name: "wp_seopress_update_redirect",
  description:
    "Sets the SEOPress redirect of a post, page, or custom post type item. When enabled on a published item, " +
    "visitors to it are redirected immediately. Omitted fields are unchanged. After saving an enabled redirect, " +
    `tests the destination and reports its HTTP status. ${VERIFIED} For site-wide redirect lists use the ` +
    "Redirection plugin tools instead.",
  inputSchema: {
    type: "object",
    properties: {
      id: ITEM_ID,
      enabled: { type: "boolean", description: "true turns the redirect on; false turns it off." },
      url: { type: "string", description: "Destination URL, absolute or relative to the site." },
      type: { type: "string", enum: ["301", "302", "307"], description: "Redirect status code." },
      logged_status: {
        type: "string",
        enum: ["both", "only_logged_in", "only_not_logged_in"],
        description: "Which visitors are redirected.",
      },
    },
    required: ["id"],
  },
};

export const listIssuesTool: MCPTool = {
  name: "wp_seopress_list_issues",
  description:
    "Lists posts, pages, and custom post type items with a SEOPress issue: no SEO title, no meta description, " +
    "either missing, or an explicit noindex. Scans every public content type unless post_types is given.",
  inputSchema: {
    type: "object",
    properties: {
      issue: {
        type: "string",
        enum: ["missing_title", "missing_description", "missing_title_or_description", "noindex"],
        description: "The issue to look for.",
      },
      post_types: {
        type: "array",
        items: { type: "string" },
        description: 'REST bases to scan, e.g. ["posts", "pages"]. Default: every public content type.',
      },
      status: {
        type: "string",
        enum: ["publish", "draft", "pending", "private", "future"],
        description: "Post status to scan. Default: publish.",
      },
      max_items: { type: "number", description: "Maximum items to list (1-1000). Default: 200." },
    },
    required: ["issue"],
  },
};

export const getSettingsTool: MCPTool = {
  name: "wp_seopress_get_settings",
  description:
    "Gets a section of SEOPress global settings as JSON: titles (title/description templates and per-post-type " +
    "noindex), social (knowledge graph and default social images), sitemaps, advanced, bot, or woocommerce. " +
    "Settings holding credentials (indexing, license, analytics, Pro) are not available.",
  inputSchema: {
    type: "object",
    properties: {
      section: { type: "string", enum: [...READABLE_SETTINGS_SECTIONS], description: "Settings section." },
    },
    required: ["section"],
  },
};

export const updateSettingsTool: MCPTool = {
  name: "wp_seopress_update_settings",
  description:
    "Changes SEOPress global settings in one section (titles, social, sitemaps, or advanced). Read the section with " +
    "wp_seopress_get_settings first and pass only the keys to change: nested objects are merged, other values " +
    "replaced, and null removes a key (unchecks a SEOPress checkbox). Every other setting is kept. Checkboxes are " +
    `stored as "1". The advanced section also needs confirm_advanced: true. ${VERIFIED}`,
  inputSchema: {
    type: "object",
    properties: {
      section: { type: "string", enum: [...WRITABLE_SETTINGS_SECTIONS], description: "Settings section." },
      changes: {
        type: "object",
        description: 'Keys to change, e.g. {"seopress_titles_sep": "|"} or {"seopress_xml_sitemap_img_enable": null}.',
      },
      confirm_advanced: {
        type: "boolean",
        description: "Required (true) to change the advanced section, which includes SEOPress role restrictions.",
      },
    },
    required: ["section", "changes"],
  },
};

export const testSitemapTool: MCPTool = {
  name: "wp_seopress_test_sitemap",
  description:
    "Runs the SEOPress XML sitemap diagnostic (sitemap reachable, valid, and listed in robots.txt) and returns its " +
    "report. Use after changing sitemap settings or publishing many items.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

export const seopressToolDefinitions = [
  getPostSEOTool,
  updateTitleDescriptionTool,
  updateRobotsTool,
  updateSocialTool,
  updateTargetKeywordsTool,
  updateRedirectTool,
  listIssuesTool,
  getSettingsTool,
  updateSettingsTool,
  testSitemapTool,
];
