/**
 * Redirection plugin tools: list, create, update, enable/disable, and check redirects through the
 * plugin's own REST routes (namespace redirection/v1).
 */

import { WordPressClient } from "@/client/api.js";
import { redirectionToolDefinitions } from "./RedirectionToolDefinitions.js";
import {
  handleCheckRedirect,
  handleCreateRedirect,
  handleListGroups,
  handleListRedirects,
  handleSetEnabled,
  handleUpdateRedirect,
} from "./RedirectionHandlers.js";

type Handler = (client: WordPressClient, params: Record<string, unknown>) => Promise<unknown>;

const handlers: Record<string, Handler> = {
  wp_redirection_list_redirects: handleListRedirects,
  wp_redirection_list_groups: handleListGroups,
  wp_redirection_create_redirect: handleCreateRedirect,
  wp_redirection_update_redirect: handleUpdateRedirect,
  wp_redirection_set_enabled: handleSetEnabled,
  wp_redirection_check_redirect: handleCheckRedirect,
};

export class RedirectionTools {
  public getTools(): Array<{
    name: string;
    description: string;
    inputSchema?: unknown;
    handler: Handler;
  }> {
    return redirectionToolDefinitions.map((tool) => {
      const handler = handlers[tool.name];
      if (!handler) throw new Error(`No handler for Redirection tool ${tool.name}`);
      return { ...tool, handler };
    });
  }
}

export default RedirectionTools;
