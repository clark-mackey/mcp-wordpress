import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WordPressClient } from "@/client/api.js";
import { AuthenticationError, WordPressAPIError } from "@/types/client.js";
import { getErrorMessage } from "@/utils/error.js";
import { EnhancedError, ErrorHandlers } from "@/utils/enhancedError.js";
import * as Tools from "@/tools/index.js";
import { z } from "zod";
import { ConfigurationValidator } from "@/config/ConfigurationSchema.js";
import type { MCPToolSchema, JSONSchemaProperty } from "@/types/mcp.js";
import { isUnsafePlainText, isUnsafeWordPressContent } from "@/security/InputValidator.js";
import { LOCAL_FILE_ACCESS_ERROR_CODES } from "@/utils/validation/security.js";

// Parameter names that carry WordPress post/page/comment body content — these legitimately
// contain rich HTML and Gutenberg block markup, so they're validated against the narrower
// isUnsafeWordPressContent check instead of the general isUnsafePlainText check applied to
// every other free-text string parameter (titles, slugs, search queries, URLs, etc.).
// wp_edit_content's old_string/new_string are body fragments too; the handler re-checks the full body.
const WORDPRESS_CONTENT_PARAM_NAMES = new Set(["content", "excerpt", "old_string", "new_string"]);

/**
 * Interface for tool definition
 */
export interface ToolExecutionHooks {
  start(): void;
  end(): void;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: Array<{
    name: string;
    type?: string;
    description?: string;
    required?: boolean;
    enum?: string[];
    items?: { type?: string };
    minimum?: number;
    maximum?: number;
  }>;
  inputSchema?: MCPToolSchema;
  handler: (client: WordPressClient, args: Record<string, unknown>) => Promise<unknown>;
}

/** Copy of a JSON Schema property with `additionalProperties: false` on every object that declares properties. */
function closeDeclaredObjects(prop: JSONSchemaProperty): JSONSchemaProperty {
  const copy: JSONSchemaProperty & { additionalProperties?: boolean } = { ...prop };
  if (prop.items) copy.items = closeDeclaredObjects(prop.items);
  if (prop.type === "object" && prop.properties) {
    copy.properties = Object.fromEntries(
      Object.entries(prop.properties).map(([key, nested]) => [key, closeDeclaredObjects(nested)]),
    );
    copy.additionalProperties = false;
  }
  return copy;
}

/**
 * Registry for managing MCP tools
 * Handles tool registration, parameter validation, and execution
 */
/**
 * What the registry needs from the performance subsystem to record tool invocations.
 * Structural on purpose: `MetricsCollector` satisfies it, and tests can pass a stub.
 */
export interface ToolExecutionTracker {
  startToolExecution(toolName: string, parameters: Record<string, unknown>, siteId?: string): string;
  endToolExecution(executionId: string, success: boolean, error?: Error, siteId?: string): void;
}

/**
 * Some handlers catch their own errors and return a descriptive object instead of throwing
 * (`wp_cache_info`, `wp_performance_benchmark` return `status: "unavailable"` / `success: false`).
 * For usage metrics those are failed calls, not successes.
 */
function isFailedToolResult(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const { success, status } = result as { success?: unknown; status?: unknown };
  return success === false || status === "unavailable";
}

/**
 * A failure reason for the recent-calls diagnostics when nothing was thrown. Deliberately a fixed code and
 * message: reasons derived from a call's arguments (a site name, a path) would leak them into the stats output.
 */
function codedFailure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export class ToolRegistry {
  // Exposed for tests that assert presence of these fields
  public server: McpServer;
  public wordpressClients: Map<string, WordPressClient>;
  private _cachedToolsListResponse: { tools: unknown[] } = { tools: [] };
  private definitions: ToolDefinition[] = [];
  private registrations: Array<(server: McpServer, execution?: ToolExecutionHooks) => void> = [];
  // Read at call time (not captured at registration) because PerformanceTools may be instantiated
  // after the tools that are registered before it.
  private toolExecutionTracker: ToolExecutionTracker | undefined;
  private readonly defaultSiteId: string | undefined;

  constructor(
    server: McpServer,
    wordpressClients: Map<string, WordPressClient>,
    private readonly toolFilter?: ((toolName: string) => boolean) | undefined,
  ) {
    this.server = server;
    this.wordpressClients = wordpressClients;
    this.defaultSiteId = ConfigurationValidator.validateDefaultSite(process.env.MCP_WORDPRESS_DEFAULT_SITE, [
      ...wordpressClients.keys(),
    ]);
  }

  /**
   * Register all available tools with the MCP server
   */
  public registerAllTools(definitions?: readonly ToolDefinition[]): void {
    if (definitions) {
      for (const tool of definitions) this.registerTool(tool);
      this.installCachedToolsListHandler();
      return;
    }
    // Register all tools from the tools directory
    Object.values(Tools).forEach((ToolClass) => {
      let toolInstance: { getTools(): unknown[] };

      // Cache and Performance tools need the clients map
      if (ToolClass.name === "CacheTools" || ToolClass.name === "PerformanceTools") {
        toolInstance = new ToolClass(this.wordpressClients);
        if (ToolClass.name === "PerformanceTools") {
          this.setMetricsCollector((toolInstance as InstanceType<typeof Tools.PerformanceTools>).getMetricsCollector());
        }
      } else {
        toolInstance = new (ToolClass as new () => { getTools(): unknown[] })();
      }

      const tools = toolInstance.getTools();

      tools.forEach((tool: unknown) => {
        this.registerTool(tool as ToolDefinition);
      });
    });

    // After all tools are registered, install a cached tools/list handler to avoid
    // repeated Zod→JSON-Schema conversion on every tools/list request.
    this.installCachedToolsListHandler();
  }

  /**
   * Report every tool invocation to `tracker` so wp_performance_stats can show tool usage.
   */
  public setMetricsCollector(tracker: ToolExecutionTracker | undefined): void {
    this.toolExecutionTracker = tracker;
  }

  /** Reuse tool objects and metrics while preparing a grant's schemas and list once. */
  public createFiltered(server: McpServer, filter: (name: string) => boolean): ToolRegistry {
    const registry = new ToolRegistry(server, this.wordpressClients, filter);
    registry.setMetricsCollector(this.toolExecutionTracker);
    registry.registerAllTools(this.definitions);
    return registry;
  }

  /** Attach prebuilt schemas, handlers and list data to a fresh request server. */
  public attachTo(server: McpServer, execution?: ToolExecutionHooks): void {
    for (const register of this.registrations) register(server, execution);
    this.installCachedToolsListHandler(server);
  }

  public getToolNames(): string[] {
    return this._cachedToolsListResponse.tools.map((tool) => (tool as { name: string }).name);
  }

  /** Bypass per-request SDK schema conversion, including for an empty grant. */
  private installCachedToolsListHandler(server = this.server): void {
    if (this.registrations.length === 0) server.server.registerCapabilities({ tools: { listChanged: true } });
    const cachedResponse = this._cachedToolsListResponse;
    // Replace the MCP SDK's tools/list handler (which re-converts Zod schemas on
    // every request) with one that returns the pre-built JSON Schema response.
    server.server.setRequestHandler(ListToolsRequestSchema, () => cachedResponse);
  }

  /**
   * Register a single tool with parameter validation and execution handling
   */
  private registerTool(tool: ToolDefinition): void {
    this.definitions.push(tool);
    if (this.toolFilter && !this.toolFilter(tool.name)) return;
    // Multiple sites require an explicit target unless a validated default is configured.
    const siteRequired = this.wordpressClients.size > 1 && this.defaultSiteId === undefined;
    const siteDescription = this.defaultSiteId
      ? `Site ID; defaults to "${this.defaultSiteId}" when omitted.`
      : "Site ID; required with multiple sites.";
    const siteSchema = siteRequired
      ? z.string().describe(siteDescription)
      : z.string().optional().describe(siteDescription);

    const baseSchema = { site: siteSchema };

    // Merge with tool-specific parameters
    const parameterSchema = this.buildParameterSchema(tool, baseSchema);

    // Strict: an argument the schema does not list is an error naming the accepted ones. A plain object
    // would drop it silently, so a call with an unsupported field (e.g. `parent` on a page) reported
    // success and changed nothing.
    const inputSchema = z.strictObject(parameterSchema as z.ZodRawShape, {
      error: (issue) =>
        issue.code === "unrecognized_keys"
          ? `Unknown argument(s): ${issue.keys.join(", ")}. ${tool.name} accepts: ${Object.keys(parameterSchema).join(", ")}.`
          : undefined,
    });

    const register = (server: McpServer, execution?: ToolExecutionHooks) =>
      server.registerTool(
        tool.name,
        { description: tool.description || `WordPress tool: ${tool.name}`, inputSchema },
        async (args: Record<string, unknown>) => {
          execution?.start();
          // Track from entry so every dispatched call is counted, including ones that fail before the handler
          // runs (unknown site, missing `site`). `succeeded` flips only when the handler returns a good result;
          // every other exit — early error returns and the catch below — is recorded as a failure.
          const tracker = this.toolExecutionTracker;
          const executionId = tracker?.startToolExecution(
            tool.name,
            args,
            typeof args.site === "string" ? args.site : undefined,
          );
          let succeeded = false;
          let failure: Error | undefined;
          // Declared outside the try so the catch can name the site that was actually resolved
          // (selectBestSite() may pick a configured ID other than "default" when `site` is omitted).
          let siteId = args.site ?? this.defaultSiteId;
          try {
            // If no site specified and multiple sites configured, require site parameter
            if (!siteId && this.wordpressClients.size > 1) {
              const availableSites = Array.from(this.wordpressClients.keys());
              failure = codedFailure("site_required", "site parameter required");
              const error = ErrorHandlers.siteParameterMissing(availableSites);
              return {
                content: [
                  {
                    type: "text" as const,
                    text: error.toString(),
                  },
                ],
                isError: true,
              };
            }

            // Auto-select the only site in single-site configurations.
            if (!siteId) {
              siteId = this.selectBestSite();
            }

            const client = this.wordpressClients.get(siteId as string);

            if (!client) {
              const availableSites = Array.from(this.wordpressClients.keys());
              failure = codedFailure("site_not_found", "site not found");
              const error = ErrorHandlers.siteNotFound(siteId as string, availableSites);
              return {
                content: [
                  {
                    type: "text" as const,
                    text: error.toString(),
                  },
                ],
                isError: true,
              };
            }

            // Call the tool handler with the client and parameters
            const result = await tool.handler(client, args);
            succeeded = !isFailedToolResult(result);
            if (!succeeded) {
              failure = codedFailure("tool_reported_failure", "tool reported a failure");
            }

            return {
              content: [
                {
                  type: "text" as const,
                  text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
                },
              ],
            };
          } catch (_error) {
            failure = _error instanceof Error ? _error : undefined;
            if (this.isAuthenticationError(_error)) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Authentication failed for site '${String(siteId || "default")}'. Please check your credentials. If they are right, the host may be stripping the login header: run npm run connect again, which detects this and names the fix.`,
                  },
                ],
                isError: true,
              };
            }

            if (this.isPermissionDeniedError(_error)) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: this.formatPermissionDenied(tool, String(siteId || "default"), _error),
                  },
                ],
                isError: true,
              };
            }

            // Handle enhanced errors with suggestions
            if (_error instanceof EnhancedError) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: _error.toString(),
                  },
                ],
                isError: true,
              };
            }

            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error: ${getErrorMessage(_error)}`,
                },
              ],
              isError: true,
            };
          } finally {
            execution?.end();
            if (tracker && executionId !== undefined) {
              tracker.endToolExecution(
                executionId,
                succeeded,
                failure,
                typeof siteId === "string" ? siteId : undefined,
              );
            }
          }
        },
      );

    this.registrations.push(register);
    register(this.server);

    // Accumulate into the tools/list cache (built in JSON Schema format so we can
    // avoid per-request Zod→JSON-Schema conversion once all tools are registered).
    this._cachedToolsListResponse.tools.push({
      name: tool.name,
      description: tool.description || `WordPress tool: ${tool.name}`,
      inputSchema: this.buildCachedInputSchema(tool),
    });
  }

  /**
   * Build a plain JSON Schema object for a tool's input, including the `site` parameter.
   * Used to pre-build the tools/list response so the SDK's per-request Zod conversion
   * is replaced by a single pre-computed snapshot.
   */
  private buildCachedInputSchema(tool: ToolDefinition): Record<string, unknown> {
    const siteRequired = this.wordpressClients.size > 1 && this.defaultSiteId === undefined;
    const siteDescription = this.defaultSiteId
      ? `Site ID; defaults to "${this.defaultSiteId}" when omitted.`
      : "Site ID; required with multiple sites.";

    const properties: Record<string, unknown> = {
      site: { type: "string", description: siteDescription },
    };
    // Match the live Zod schema in registerTool().
    const required: string[] = siteRequired ? ["site"] : [];

    if (tool.inputSchema) {
      for (const [key, prop] of Object.entries(tool.inputSchema.properties || {})) {
        properties[key] = closeDeclaredObjects(prop);
      }
      required.push(...(tool.inputSchema.required || []));
    } else if (tool.parameters) {
      for (const param of tool.parameters) {
        const propDef: Record<string, unknown> = { type: param.type || "string" };
        if (param.description) propDef.description = param.description;
        if (param.enum) propDef.enum = param.enum;
        if (param.items) propDef.items = param.items;
        properties[param.name] = propDef;
        if (param.required) required.push(param.name);
      }
    }

    // Matches the strict Zod object in registerTool(): unknown arguments are rejected.
    const schema: Record<string, unknown> = { type: "object", properties, additionalProperties: false };
    if (required.length > 0) schema.required = required;
    return schema;
  }

  /**
   * Build Zod parameter schema from tool definition
   */
  private buildParameterSchema(tool: ToolDefinition, baseSchema: Record<string, unknown>): Record<string, unknown> {
    // If tool has inputSchema (new format), convert it to Zod schema
    if (tool.inputSchema) {
      const schema = { ...baseSchema };
      const properties = tool.inputSchema.properties || {};
      const required = tool.inputSchema.required || [];

      for (const [propName, propDef] of Object.entries(properties)) {
        let zodType = this.getZodTypeForProperty(propDef, propName);

        if (propDef.description) {
          zodType = zodType.describe(propDef.description);
        }

        if (!required.includes(propName)) {
          zodType = zodType.optional();
        }

        schema[propName] = zodType;
      }

      return schema;
    }

    // Fall back to old parameters format
    return (
      tool.parameters?.reduce(
        (
          schema: Record<string, unknown>,
          param: { name: string; type?: string; required?: boolean; [key: string]: unknown },
        ) => {
          let zodType = this.getZodTypeForParameter(param);

          if (param.description) {
            zodType = zodType.describe(param.description as string);
          }

          if (!param.required) {
            zodType = zodType.optional();
          }

          schema[param.name] = zodType;
          return schema;
        },
        { ...baseSchema },
      ) || baseSchema
    );
  }

  /**
   * Get appropriate Zod type for inputSchema property definition. `propName` (when known) picks
   * the right security boundary for string properties — see WORDPRESS_CONTENT_PARAM_NAMES.
   */
  private getZodTypeForProperty(propDef: JSONSchemaProperty, propName?: string): z.ZodType {
    // Handle enum types
    if (propDef.enum && propDef.enum.length > 0) {
      const enumValues = propDef.enum as [string | number, ...(string | number)[]];
      return z.enum(enumValues as [string, ...string[]]);
    }

    // Handle array types — recurse so constraints/enums on the item schema
    // itself (not just its bare type) are preserved too.
    if (propDef.type === "array") {
      const itemSchema = propDef.items ? this.getZodTypeForProperty(propDef.items) : z.string();
      return z.array(itemSchema);
    }

    // Handle nested object types. JSONSchemaProperty has no per-nested-field
    // "required" list, so nested properties are treated as optional — that's
    // the most permissive interpretation the current schema shape supports.
    if (propDef.type === "object") {
      if (propDef.properties) {
        const shape: Record<string, z.ZodType> = {};
        for (const [key, nestedDef] of Object.entries(propDef.properties)) {
          let nestedType = this.getZodTypeForProperty(nestedDef, key).optional();
          if (nestedDef.description) {
            nestedType = nestedType.describe(nestedDef.description);
          }
          shape[key] = nestedType;
        }
        // Declared nested objects are strict too (e.g. wp_edit_content's edits[]); property-less
        // objects below stay open records for free-form data (REST queries, schema, settings).
        return z.strictObject(shape, {
          error: (issue) =>
            issue.code === "unrecognized_keys"
              ? `Unknown field(s): ${issue.keys.join(", ")}. Accepts: ${Object.keys(shape).join(", ")}.`
              : undefined,
        });
      }
      return z.record(z.string(), z.unknown());
    }

    // Handle primitive types, preserving numeric/string bounds and pattern.
    switch (propDef.type) {
      case "string": {
        let schema = z.string();
        if (propDef.minLength !== undefined) schema = schema.min(propDef.minLength);
        if (propDef.maxLength !== undefined) schema = schema.max(propDef.maxLength);
        if (propDef.pattern !== undefined) schema = schema.regex(new RegExp(propDef.pattern));

        // Route WordPress content fields (post/page/comment body text — legitimately rich
        // HTML/Gutenberg markup) through the narrower content-specific check; every other
        // free-text parameter (titles, slugs, search queries, URLs, ...) gets the stricter
        // general-purpose check. Both reject script tags, javascript: URLs, and real event
        // handler attributes; only the general check additionally rejects data: URLs.
        return propName !== undefined && WORDPRESS_CONTENT_PARAM_NAMES.has(propName)
          ? schema.refine(
              (val) => !isUnsafeWordPressContent(val),
              "Unsafe content: script tag, javascript: URL, or event handler attribute. Do not remove existing scripts or embeds to get past this; ask the user to make the edit in WP admin.",
            )
          : schema.refine(
              (val) => !isUnsafePlainText(val),
              "Unsafe content: script tag, javascript:/data: URL, or event handler attribute",
            );
      }
      case "number": {
        let schema = z.number();
        if (propDef.minimum !== undefined) schema = schema.min(propDef.minimum);
        if (propDef.maximum !== undefined) schema = schema.max(propDef.maximum);
        return schema;
      }
      case "boolean":
        return z.boolean();
      default:
        return z.string();
    }
  }

  /**
   * Get appropriate Zod type for parameter definition (old format)
   */
  private getZodTypeForParameter(param: {
    name?: string;
    type?: string;
    required?: boolean;
    [key: string]: unknown;
  }): z.ZodType {
    switch (param.type) {
      case "string": {
        const schema = z.string();
        return param.name !== undefined && WORDPRESS_CONTENT_PARAM_NAMES.has(param.name)
          ? schema.refine(
              (val) => !isUnsafeWordPressContent(val),
              "Unsafe content: script tag, javascript: URL, or event handler attribute. Do not remove existing scripts or embeds to get past this; ask the user to make the edit in WP admin.",
            )
          : schema.refine(
              (val) => !isUnsafePlainText(val),
              "Unsafe content: script tag, javascript:/data: URL, or event handler attribute",
            );
      }
      case "number":
        return z.number();
      case "boolean":
        return z.boolean();
      case "array":
        return z.array(z.string());
      case "object":
        return z.record(z.string(), z.unknown());
      default:
        return z.string();
    }
  }

  /**
   * Return the single configured site ID.
   * Only called after the multi-site guard (which requires an explicit `site` param),
   * so this path is only reached in single-site mode.
   */
  private selectBestSite(): string {
    const keys = Array.from(this.wordpressClients.keys());
    return keys[0] ?? "default";
  }

  /**
   * Check if error is authentication-related: the credentials were rejected (HTTP 401).
   *
   * Checks `statusCode` on the real `WordPressAPIError` hierarchy (`src/types/client.ts`),
   * not `error.response.status`/`error.code === "WORDPRESS_AUTH_ERROR"` — those never match
   * anything the client pipeline actually throws (it sets `statusCode` directly on the error,
   * with no `.response` wrapper, and uses `"authentication_failed"` as the code). Checking
   * `statusCode` rather than `instanceof AuthenticationError` also catches a bare 401 on a
   * non-media endpoint, which the client throws as a plain `WordPressAPIError`, not the
   * `AuthenticationError` subclass (that subtype is used for media-upload 401s and credential-handshake failures).
   *
   * A 403 is deliberately NOT an authentication error: WordPress answers 401 when it does not
   * know who you are and 403 when it does but you lack the capability (e.g. an editor calling
   * `wp_get_site_settings`, which needs `manage_options`). Reporting that as "check your
   * credentials" sends the user to fix the wrong thing — see `isPermissionDeniedError`.
   */
  private isAuthenticationError(error: unknown): boolean {
    if (error instanceof AuthenticationError) return true;
    if (!(error instanceof WordPressAPIError)) return false;
    // A host that strips the Authorization header makes WordPress answer as if nobody logged in;
    // some setups send that as 403 rest_not_logged_in. It is a login problem, not a role limit.
    return error.statusCode === 401 || (error.statusCode === 403 && error.code === "rest_not_logged_in");
  }

  /**
   * Check if error is a permission denial: the server accepted the credentials but refused the
   * action (HTTP 403, e.g. `rest_forbidden`), or a firewall/security plugin blocked the request
   * with a bare 403.
   *
   * A 403 whose code is in `LOCAL_FILE_ACCESS_ERROR_CODES` is NOT a WordPress denial:
   * `validateFilePath` (src/utils/validation/security.ts) raises `UPLOADS_DISABLED`,
   * `PATH_TRAVERSAL_ATTEMPT`, `SYMLINK_NOT_ALLOWED` and `NOT_A_REGULAR_FILE` itself — local
   * configuration/validation failures. Classifying them as authentication/permission problems made
   * `wp_upload_media` blame the credentials when the real cause was that MCP_UPLOAD_BASE_DIR was
   * not set. Any other 403 code (including a plugin's, whatever its casing) is a server refusal.
   */
  private isPermissionDeniedError(error: unknown): boolean {
    if (!(error instanceof WordPressAPIError) || error.statusCode !== 403) return false;
    return error.code === undefined || !LOCAL_FILE_ACCESS_ERROR_CODES.has(error.code);
  }

  /**
   * Build the permission-denied message, naming the role when the tool's own description
   * declares it ("Requires administrator role (manage_options capability).").
   */
  private formatPermissionDenied(tool: { name: string; description?: string }, site: string, error: unknown): string {
    const apiError = error as WordPressAPIError;
    const requirement = /Requires ([^.]*\brole\b[^.]*)\./i.exec(tool.description ?? "")?.[1];
    const code = apiError.code ? `, ${apiError.code}` : "";
    const header = `Permission denied for site '${site}' (HTTP 403${code}): ${getErrorMessage(error)}\n`;

    // A WordPress error code means WordPress itself refused the account. A bare 403 can just as well be a
    // firewall, hosting rule or security plugin in front of WordPress, so do not accuse the user's role.
    if (apiError.code) {
      return (
        header +
        `The server refused the request: this user is not allowed to run ${tool.name}` +
        (requirement ? ` — it requires ${requirement}.` : ".") +
        " Use an account with the required role, or check whether a security plugin or firewall is blocking the request."
      );
    }
    return (
      header +
      `The server refused the request without a WordPress error code, so a firewall, hosting rule or security ` +
      `plugin may be blocking ${tool.name}` +
      (requirement ? `; if not, the account's role may be the cause — it requires ${requirement}.` : ".")
    );
  }
}
