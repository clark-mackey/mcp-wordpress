import { Pool } from "pg";
import { LoggerFactory } from "../../../utils/logger.js";
import type { UsageConfiguration } from "./config.js";
import type { UsageCounters, UsageEvent, UsageRecorder, UsageReportWindow } from "./types.js";

export interface QueryResultLike {
  rows: Array<Record<string, unknown>>;
  rowCount?: number | null;
}

export interface UsagePool {
  query(text: string, values?: readonly unknown[]): Promise<QueryResultLike>;
  end(): Promise<void>;
}

const SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS mcp_wordpress_usage;
CREATE TABLE IF NOT EXISTS mcp_wordpress_usage.usage_events (
  attempt_id UUID PRIMARY KEY, event_type TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL, boot_id UUID NOT NULL, principal_id TEXT NOT NULL,
  client_name TEXT, client_version TEXT, tool_name TEXT, site_id TEXT, outcome TEXT NOT NULL,
  error_class TEXT, duration_ms INTEGER NOT NULL, result_bytes INTEGER NOT NULL,
  returned_count INTEGER, server_version TEXT NOT NULL, payload JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_events_started_attempt_idx
  ON mcp_wordpress_usage.usage_events (started_at, attempt_id);
CREATE INDEX IF NOT EXISTS usage_events_tool_started_idx
  ON mcp_wordpress_usage.usage_events (tool_name, started_at);`;

const INSERT_COLUMNS = 17;

export class PostgresUsageStore implements UsageRecorder {
  private readonly queue: UsageEvent[] = [];
  private readonly pool: UsagePool;
  private readonly logger = LoggerFactory.server();
  private initialized = false;
  private stopping = false;
  private flushing = false;
  private retryMs = 1000;
  private loggedUnavailable = false;
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private retentionTimer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly stats: UsageCounters = {
    enqueued: 0,
    committed: 0,
    dropped_queue_full: 0,
    init_failures: 0,
    pool_errors: 0,
    failed_batches: 0,
    failed_events: 0,
    retention_runs: 0,
    retention_failures: 0,
    last_commit_at: null,
  };

  constructor(
    private readonly config: UsageConfiguration,
    pool?: UsagePool,
  ) {
    if (pool) {
      this.pool = pool;
    } else {
      const concretePool = new Pool({
        connectionString: config.databaseUrl,
        max: 2,
        connectionTimeoutMillis: 5000,
        statement_timeout: 5000,
      });
      concretePool.on("error", () => {
        this.stats.pool_errors += 1;
        this.logger.warn("Usage database pool error");
      });
      this.pool = concretePool;
    }
    this.flushTimer = setInterval(() => void this.flush(), 1000);
    this.flushTimer.unref();
    void this.initialize();
  }

  enqueue(event: UsageEvent): void {
    try {
      if (this.queue.length >= 256) {
        this.stats.dropped_queue_full += 1;
        return;
      }
      this.queue.push(event);
      this.stats.enqueued += 1;
    } catch {
      this.stats.dropped_queue_full += 1;
    }
  }

  counters(): UsageCounters {
    return { ...this.stats };
  }

  private async initialize(): Promise<void> {
    if (this.stopping || this.initialized) return;
    try {
      await this.pool.query(SCHEMA_SQL);
      this.initialized = true;
      this.retryMs = 1000;
      await this.runRetention();
      this.retentionTimer = setInterval(() => void this.runRetention(), 60 * 60 * 1000);
      this.retentionTimer.unref();
      void this.flush();
    } catch {
      this.stats.init_failures += 1;
      if (!this.loggedUnavailable) {
        this.loggedUnavailable = true;
        this.logger.warn("Usage database unavailable; recording will retry");
      }
      if (!this.stopping) {
        this.retryTimer = setTimeout(() => void this.initialize(), this.retryMs);
        this.retryTimer.unref();
        this.retryMs = Math.min(this.retryMs * 2, 60_000);
      }
    }
  }

  private async runRetention(): Promise<void> {
    if (!this.initialized) return;
    try {
      await this.pool.query(
        "DELETE FROM mcp_wordpress_usage.usage_events WHERE started_at < NOW() - ($1 * INTERVAL '1 day')",
        [this.config.retentionDays],
      );
      this.stats.retention_runs += 1;
    } catch {
      this.stats.retention_failures += 1;
    }
  }

  async flush(): Promise<void> {
    if (!this.initialized || this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue.splice(0, 50);
    try {
      const values: unknown[] = [];
      const tuples = batch.map((event, row) => {
        values.push(
          event.attemptId,
          event.eventType,
          event.startedAt,
          event.endedAt,
          event.bootId,
          event.principalId,
          event.clientName,
          event.clientVersion,
          event.toolName,
          event.siteId,
          event.outcome,
          event.errorClass,
          event.durationMs,
          event.resultBytes,
          event.returnedCount,
          event.serverVersion,
          event.payload,
        );
        const offset = row * INSERT_COLUMNS;
        return `(${Array.from({ length: INSERT_COLUMNS }, (_, column) => `$${offset + column + 1}`).join(",")})`;
      });
      const sql = `INSERT INTO mcp_wordpress_usage.usage_events
        (attempt_id,event_type,started_at,ended_at,boot_id,principal_id,client_name,client_version,
         tool_name,site_id,outcome,error_class,duration_ms,result_bytes,returned_count,server_version,payload)
        VALUES ${tuples.join(",")} ON CONFLICT (attempt_id) DO NOTHING`;
      const result = await this.pool.query(sql, values);
      this.stats.committed += result.rowCount ?? batch.length;
      this.stats.last_commit_at = new Date().toISOString();
    } catch {
      this.stats.failed_batches += 1;
      this.stats.failed_events += batch.length;
    } finally {
      this.flushing = false;
    }
  }

  async report(window: UsageReportWindow): Promise<Record<string, unknown>> {
    const range = [window.since, window.until];
    const base = " FROM mcp_wordpress_usage.usage_events WHERE started_at >= $1 AND started_at < $2";
    const [total, dimensions, zeroSearches, toolStats, errors, searches] = await Promise.all([
      this.pool.query(`SELECT COUNT(*)::int AS total${base}`, range),
      this.pool.query(
        `SELECT dimension, key, count FROM (
          SELECT dimension, key, count,
            ROW_NUMBER() OVER (PARTITION BY dimension ORDER BY count DESC, key) AS row_number
          FROM (
            SELECT 'event_type' AS dimension, COALESCE(event_type, '(none)') AS key, COUNT(*)::int AS count${base} GROUP BY 2
            UNION ALL SELECT 'outcome' AS dimension, COALESCE(outcome, '(none)') AS key, COUNT(*)::int AS count${base} GROUP BY 2
            UNION ALL SELECT 'tool' AS dimension, COALESCE(tool_name, '(none)') AS key, COUNT(*)::int AS count${base} GROUP BY 2
            UNION ALL SELECT 'site' AS dimension, COALESCE(site_id, '(none)') AS key, COUNT(*)::int AS count${base} GROUP BY 2
            UNION ALL SELECT 'principal' AS dimension, COALESCE(principal_id, '(none)') AS key, COUNT(*)::int AS count${base} GROUP BY 2
            UNION ALL SELECT 'client_name' AS dimension, COALESCE(client_name, '(none)') AS key, COUNT(*)::int AS count${base} GROUP BY 2
            UNION ALL SELECT 'day' AS dimension, TO_CHAR(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS key, COUNT(*)::int AS count${base} GROUP BY 2
          ) AS counts
        ) AS ranked WHERE row_number <= 100 ORDER BY dimension, count DESC, key`,
        range,
      ),
      this.pool.query(
        `SELECT search_item.value #>> '{}' AS search_text, COALESCE(tool_name, '(none)') AS tool,
          COUNT(*)::int AS count
         FROM mcp_wordpress_usage.usage_events
         CROSS JOIN LATERAL jsonb_each(COALESCE(payload->'search_text', '{}'::jsonb)) AS entry
         CROSS JOIN LATERAL jsonb_array_elements(CASE jsonb_typeof(entry.value)
           WHEN 'array' THEN entry.value ELSE jsonb_build_array(entry.value) END) AS search_item(value)
         WHERE started_at >= $1 AND started_at < $2 AND returned_count = 0
         GROUP BY 1, 2 ORDER BY count DESC, search_text, tool LIMIT 50`,
        range,
      ),
      this.pool.query(
        `SELECT COALESCE(tool_name, '(none)') AS tool, COUNT(*)::int AS calls,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms)::float8 AS latency_p50,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)::float8 AS latency_p95,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY result_bytes)::float8 AS result_bytes_p50,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY result_bytes)::float8 AS result_bytes_p95,
          SUM(result_bytes)::bigint AS result_bytes_sum${base} GROUP BY 1 ORDER BY calls DESC, tool LIMIT 100`,
        range,
      ),
      this.pool.query(
        `SELECT COALESCE(tool_name, '(none)') AS tool, error_class, COUNT(*)::int AS count${base}
          AND error_class IS NOT NULL GROUP BY 1, 2 ORDER BY count DESC, tool, error_class LIMIT 50`,
        range,
      ),
      this.pool.query(
        `SELECT search_item.value #>> '{}' AS search_text, COALESCE(tool_name, '(none)') AS tool,
          COUNT(*)::int AS count, COUNT(*) FILTER (WHERE returned_count = 0)::int AS zero_count
         FROM mcp_wordpress_usage.usage_events
         CROSS JOIN LATERAL jsonb_each(COALESCE(payload->'search_text', '{}'::jsonb)) AS entry
         CROSS JOIN LATERAL jsonb_array_elements(CASE jsonb_typeof(entry.value)
           WHEN 'array' THEN entry.value ELSE jsonb_build_array(entry.value) END) AS search_item(value)
         WHERE started_at >= $1 AND started_at < $2
         GROUP BY 1, 2 ORDER BY count DESC, search_text, tool LIMIT 50`,
        range,
      ),
    ]);
    const counts: Record<string, Record<string, number>> = {};
    for (const row of dimensions.rows) {
      const dimension = String(row.dimension);
      const map = (counts[dimension] ??= {});
      if (Object.keys(map).length < 100) map[String(row.key)] = Number(row.count);
    }
    const report: Record<string, unknown> = {
      window: { since: window.since.toISOString(), until: window.until.toISOString() },
      total_events: Number(total.rows[0]?.total ?? 0),
      counts,
      per_tool: toolStats.rows,
      error_classes: errors.rows,
      top_zero_result_searches: zeroSearches.rows,
      top_searches: searches.rows,
      writer: this.counters(),
    };
    for (const [dimension, values] of Object.entries(counts)) report[`by_${dimension}`] = values;
    return report;
  }

  async shutdown(timeoutMs = 5000): Promise<void> {
    this.stopping = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (!this.initialized && this.queue.length > 0) {
      this.stats.failed_events += this.queue.length;
      this.queue.length = 0;
    }
    await Promise.race([
      (async () => {
        while (this.initialized && (this.queue.length > 0 || this.flushing)) {
          await this.flush();
          if (this.flushing) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await this.pool.end().catch(() => undefined);
      })(),
      new Promise<void>((resolve) => {
        const deadline = setTimeout(resolve, timeoutMs);
        deadline.unref();
      }),
    ]);
  }
}
