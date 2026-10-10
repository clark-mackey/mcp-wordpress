/**
 * Redirection plugin tool definitions (schemas only; handlers live in RedirectionHandlers.ts).
 */

import type { MCPTool } from "@/types/mcp.js";
import { REDIRECT_CODES } from "./RedirectionHandlers.js";

const REDIRECT_ID = { type: "number", description: "The Redirection redirect ID." } as const;

const CODE = {
  type: "number",
  description: `HTTP status, one of ${REDIRECT_CODES.join(", ")}: 301 (permanent, the default for moved pages), 302 or 307 (temporary), 308 (permanent).`,
} as const;

const VERIFIED =
  "Reads the redirect back and fails if Redirection did not store what was sent, reporting the stored values.";

export const listRedirectsTool: MCPTool = {
  name: "wp_redirection_list_redirects",
  description:
    "Lists redirects managed by the Redirection plugin, newest first, with ID, source, status code, target, " +
    "enabled state, group, and hit count. Filters match part of the source or target.",
  inputSchema: {
    type: "object",
    properties: {
      source: { type: "string", description: "Only redirects whose source contains this text." },
      target: { type: "string", description: "Only redirects whose target contains this text." },
      status: { type: "string", enum: ["enabled", "disabled"], description: "Only enabled or disabled redirects." },
      group_id: { type: "number", description: "Only redirects in this Redirection group." },
      page: { type: "number", description: "Page number, from 1 (default 1)." },
      per_page: { type: "number", description: "Redirects per page, 5 to 200 (default 50)." },
    },
  },
};

export const listGroupsTool: MCPTool = {
  name: "wp_redirection_list_groups",
  description:
    "Lists Redirection groups with their IDs, module, enabled state, and redirect counts. Only groups in the " +
    "WordPress module redirect without exporting server rules.",
  inputSchema: { type: "object", properties: {} },
};

export const createRedirectTool: MCPTool = {
  name: "wp_redirection_create_redirect",
  description:
    "Creates a Redirection redirect from a path on this site to a target URL. Fails without saving when another " +
    "redirect already handles the source (Redirection ignores case and a trailing slash by default) or when the " +
    `redirect would loop, and warns when the target is itself redirected. ${VERIFIED} Check the live response ` +
    "afterwards with wp_redirection_check_redirect.",
  inputSchema: {
    type: "object",
    properties: {
      source: {
        type: "string",
        description:
          'The old path on this site, starting with "/", such as /old-page/. A regular expression when regex is true.',
      },
      target: { type: "string", description: 'Where to send visitors: a path starting with "/" or a full URL.' },
      code: CODE,
      group_id: {
        type: "number",
        description: "Redirection group ID. Default: the first enabled group in the WordPress module.",
      },
      title: { type: "string", description: "Optional note shown in the Redirection list." },
      regex: { type: "boolean", description: "Treat source as a regular expression (default false)." },
    },
    required: ["source", "target"],
  },
};

export const updateRedirectTool: MCPTool = {
  name: "wp_redirection_update_redirect",
  description:
    "Changes the source, target, status code, title, or group of a plain URL redirect. Omitted fields are " +
    "unchanged. Refuses redirects using other match conditions or actions, which belong in wp-admin, and applies " +
    `the same duplicate and loop checks as creating. ${VERIFIED} Reports the previous values.`,
  inputSchema: {
    type: "object",
    properties: {
      id: REDIRECT_ID,
      source: { type: "string", description: 'New source path, starting with "/".' },
      target: { type: "string", description: 'New target: a path starting with "/" or a full URL.' },
      code: CODE,
      title: { type: "string", description: "New title; an empty string clears it." },
      group_id: { type: "number", description: "Move the redirect to this Redirection group." },
    },
    required: ["id"],
  },
};

export const setEnabledTool: MCPTool = {
  name: "wp_redirection_set_enabled",
  description:
    "Enables or disables a Redirection redirect. Disabling is how these tools remove a redirect; nothing is " +
    `deleted. ${VERIFIED}`,
  inputSchema: {
    type: "object",
    properties: {
      id: REDIRECT_ID,
      enabled: { type: "boolean", description: "true to enable the redirect, false to disable it." },
    },
    required: ["id", "enabled"],
  },
};

export const checkRedirectTool: MCPTool = {
  name: "wp_redirection_check_redirect",
  description:
    "Requests a path on this site as an anonymous visitor, without following redirects, and reports the HTTP " +
    "status, the redirect target, what sent it, and whether a page cache answered. With expected_code or " +
    "expected_target it fails when the live response differs.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: 'The path to request, starting with "/", such as /old-page/.' },
      expected_code: { type: "number", description: "The HTTP status the response must have, such as 301." },
      expected_target: {
        type: "string",
        description: 'The URL the response must redirect to: a path starting with "/" or a full URL.',
      },
    },
    required: ["path"],
  },
};

export const redirectionToolDefinitions: MCPTool[] = [
  listRedirectsTool,
  listGroupsTool,
  createRedirectTool,
  updateRedirectTool,
  setEnabledTool,
  checkRedirectTool,
];
