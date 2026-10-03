/**
 * SEOPress tools: per-item SEO fields, issue listing, global settings, and the sitemap
 * diagnostic, through SEOPress's own REST routes (namespace seopress/v1).
 */

import { WordPressClient } from "@/client/api.js";
import { seopressToolDefinitions } from "./SEOPressToolDefinitions.js";
import {
  handleGetPostSEO,
  handleGetSettings,
  handleListIssues,
  handleTestSitemap,
  handleUpdateRedirect,
  handleUpdateRobots,
  handleUpdateSettings,
  handleUpdateSocial,
  handleUpdateTargetKeywords,
  handleUpdateTitleDescription,
} from "./SEOPressHandlers.js";

type Handler = (client: WordPressClient, params: Record<string, unknown>) => Promise<unknown>;

const handlers: Record<string, Handler> = {
  wp_seopress_get_post_seo: handleGetPostSEO,
  wp_seopress_update_title_description: handleUpdateTitleDescription,
  wp_seopress_update_robots: handleUpdateRobots,
  wp_seopress_update_social: handleUpdateSocial,
  wp_seopress_update_target_keywords: handleUpdateTargetKeywords,
  wp_seopress_update_redirect: handleUpdateRedirect,
  wp_seopress_list_issues: handleListIssues,
  wp_seopress_get_settings: handleGetSettings,
  wp_seopress_update_settings: handleUpdateSettings,
  wp_seopress_test_sitemap: handleTestSitemap,
};

export class SEOPressTools {
  public getTools(): Array<{
    name: string;
    description: string;
    inputSchema?: unknown;
    handler: Handler;
  }> {
    return seopressToolDefinitions.map((tool) => {
      const handler = handlers[tool.name];
      if (!handler) throw new Error(`No handler for SEOPress tool ${tool.name}`);
      return { ...tool, handler };
    });
  }
}

export default SEOPressTools;
