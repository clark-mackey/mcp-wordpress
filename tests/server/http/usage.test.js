import { getUsageConfiguration } from "@/server/http/usage/config.js";
import { parseClient, SEARCH_ARGUMENTS_BY_TOOL, usagePayload } from "@/server/http/usage/payload.js";
import { PostgresUsageStore } from "@/server/http/usage/store.js";
import { captureReturnedCount, countedText, failedText } from "@/server/toolResult.js";

const principals = new Map([["alice", { id: "alice", tools: { all: true } }]]);

describe("hosted usage", () => {
  it("captures a reported failure and a count without changing the text", async () => {
    const failed = await captureReturnedCount(async () => failedText("Failed to delete post with ID 7."));
    expect(failed).toEqual({ result: "Failed to delete post with ID 7.", returnedCount: null, failed: true });
    const counted = await captureReturnedCount(async () => countedText("No posts found.", 0));
    expect(counted).toEqual({ result: "No posts found.", returnedCount: 0, failed: false });
    expect(failedText("outside a capture")).toBe("outside a capture");
  });

  it("validates retention and reviewer without constructing a disabled store", () => {
    expect(getUsageConfiguration(principals, {})).toBeUndefined();
    expect(() => getUsageConfiguration(principals, { MCP_USAGE_RETENTION_DAYS: "0" })).toThrow(
      "MCP_USAGE_RETENTION_DAYS",
    );
    expect(() => getUsageConfiguration(principals, { MCP_USAGE_RETENTION_DAYS: "2.5" })).toThrow(
      "MCP_USAGE_RETENTION_DAYS",
    );
    expect(() => getUsageConfiguration(principals, { MCP_USAGE_REVIEWER: "missing" })).toThrow("MCP_USAGE_REVIEWER");
    expect(
      getUsageConfiguration(principals, {
        MCP_USAGE_DATABASE_URL: "postgres://example.test/db",
        MCP_USAGE_REVIEWER: "alice",
      }),
    ).toEqual({ databaseUrl: "postgres://example.test/db", retentionDays: 90, reviewer: "alice" });
  });

  it("uses an explicit payload allowlist and maps user agents", () => {
    expect(SEARCH_ARGUMENTS_BY_TOOL).toEqual({
      wp_list_posts: ["search"],
      wp_list_pages: ["search"],
      wp_list_media: ["search"],
      wp_list_users: ["search"],
      wp_list_categories: ["search"],
      wp_list_tags: ["search"],
      wp_search_site: ["term"],
      wp_seo_track_serp: ["keywords"],
      wp_seo_keyword_research: ["seedKeyword"],
    });
    expect(
      usagePayload("wp_list_posts", {
        id: 1,
        post_id: [2, -1, 3.5, 4],
        search: " hello ",
        keywords: [" one ", "two"],
        content: "secret",
        title: "secret",
        slug: "secret",
        password: "secret",
        file_path: "/secret",
      }),
    ).toEqual({ ids: { id: 1, post_id: [2, 4] }, search_text: { search: "hello" } });
    expect(usagePayload("wp_seo_track_serp", { keywords: [" one ", "two"] })).toEqual({
      search_text: { keywords: ["one", "two"] },
    });
    expect(usagePayload("wp_seopress_update_target_keywords", { keywords: ["private metadata"] })).toEqual({});
    expect(parseClient(undefined)).toEqual({ name: null, version: null });
    expect(parseClient("codex-mcp-client/2.3.4")).toEqual({ name: "codex", version: "2.3.4" });
    expect(parseClient(`garbage/${"x".repeat(10000)}`)).toEqual({ name: "other", version: null });
  });

  it("handles errors emitted by its concrete pool without throwing", async () => {
    const store = new PostgresUsageStore({
      databaseUrl: "postgres://%",
      retentionDays: 90,
      reviewer: null,
    });
    expect(() => store.pool.emit("error", new Error("x"))).not.toThrow();
    expect(store.counters().pool_errors).toBe(1);
    await store.shutdown(1);
  });

  it("separates initialization failures and counts queued events discarded before initialization", async () => {
    const pool = {
      query: vi.fn().mockRejectedValue(new Error("down")),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const store = new PostgresUsageStore(
      { databaseUrl: "postgres://example.test/db", retentionDays: 90, reviewer: null },
      pool,
    );
    store.enqueue({ attemptId: "discarded" });
    await vi.waitFor(() => expect(store.counters().init_failures).toBe(1));
    await store.shutdown(1);
    expect(store.counters()).toMatchObject({ failed_batches: 0, failed_events: 1 });
  });

  it("caps report dimensions independently and uses explicit SQL aliases", async () => {
    const sql = [];
    const pool = {
      query: vi.fn(async (statement) => {
        sql.push(statement);
        if (statement.includes("COUNT(*)::int AS total")) return { rows: [{ total: 0 }] };
        return { rows: [] };
      }),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const store = new PostgresUsageStore(
      { databaseUrl: "postgres://example.test/db", retentionDays: 90, reviewer: null },
      pool,
    );
    await vi.waitFor(() => expect(store.counters().retention_runs).toBe(1));
    const report = await store.report({
      since: new Date("2026-01-01T00:00:00Z"),
      until: new Date("2026-02-01T00:00:00Z"),
    });
    expect(report.writer).toMatchObject({ init_failures: 0, pool_errors: 0 });
    const dimensions = sql.find((statement) => statement.includes("ROW_NUMBER()"));
    expect(dimensions).toContain("ROW_NUMBER() OVER (PARTITION BY dimension");
    expect(dimensions).toContain("WHERE row_number <= 100");
    expect(dimensions).not.toContain("LIMIT 700");
    for (const statement of sql.filter((statement) => statement.startsWith("SELECT"))) {
      expect(statement).not.toMatch(/\)\s+(counts|ranked)\b/);
      expect(statement).not.toMatch(
        /\b(COALESCE\([^\n]+\)|COUNT\([^\n]+\)|PERCENTILE_CONT\([^\n]+\))\s+(key|count|tool|calls|latency_p\d+|result_bytes_p\d+|result_bytes_sum)\b/,
      );
    }
    await store.shutdown(1);
  });

  it("bounds the queue, swallows pool failures, and parameterizes inserts", async () => {
    let initialized = false;
    const calls = [];
    const pool = {
      query: vi.fn(async (sql, values) => {
        calls.push({ sql, values });
        if (!initialized) {
          initialized = true;
          return { rows: [] };
        }
        if (sql.startsWith("DELETE")) return { rows: [] };
        throw new Error("down");
      }),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const store = new PostgresUsageStore(
      { databaseUrl: "postgres://example.test/db", retentionDays: 90, reviewer: null },
      pool,
    );
    const event = {
      attemptId: "00000000-0000-4000-8000-000000000000",
      eventType: "tool_call",
      startedAt: new Date(),
      endedAt: new Date(),
      bootId: "00000000-0000-4000-8000-000000000001",
      principalId: "alice",
      clientName: null,
      clientVersion: null,
      toolName: "wp_list_posts",
      siteId: "site1",
      outcome: "success",
      errorClass: null,
      durationMs: 1,
      resultBytes: 2,
      returnedCount: 0,
      serverVersion: "0",
      payload: { search_text: { search: "needle" } },
    };
    for (let index = 0; index < 257; index += 1) expect(() => store.enqueue({ ...event })).not.toThrow();
    await vi.waitFor(() => expect(store.counters().retention_runs).toBe(1));
    await store.flush();
    expect(store.counters()).toMatchObject({ enqueued: 256, dropped_queue_full: 1 });
    expect(store.counters().failed_batches).toBeGreaterThanOrEqual(1);
    expect(store.counters().failed_events).toBeGreaterThanOrEqual(50);
    const insert = calls.find(({ sql }) => sql.startsWith("INSERT"));
    expect(insert.sql).not.toContain("needle");
    expect(insert.sql).not.toContain("alice");
    expect(insert.sql).toContain("$1");
    expect(JSON.stringify(insert.values)).toContain("needle");
    await store.shutdown(1);
  });
});
