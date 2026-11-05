export type UsageEventType = "tool_call" | "rejection";

export interface UsagePayload {
  ids?: Record<string, number | number[]>;
  search_text?: Record<string, string | string[]>;
  search_text_truncated?: true;
}

export interface UsageEvent {
  attemptId: string;
  eventType: UsageEventType;
  startedAt: Date;
  endedAt: Date;
  bootId: string;
  principalId: string;
  clientName: string | null;
  clientVersion: string | null;
  toolName: string | null;
  siteId: string | null;
  outcome: string;
  errorClass: string | null;
  durationMs: number;
  resultBytes: number;
  returnedCount: number | null;
  serverVersion: string;
  payload: UsagePayload;
}

export interface UsageCounters {
  enqueued: number;
  committed: number;
  dropped_queue_full: number;
  init_failures: number;
  pool_errors: number;
  failed_batches: number;
  failed_events: number;
  retention_runs: number;
  retention_failures: number;
  last_commit_at: string | null;
}

export interface UsageReportWindow {
  since: Date;
  until: Date;
}

export interface UsageRecorder {
  enqueue(event: UsageEvent): void;
  counters(): UsageCounters;
  report(window: UsageReportWindow): Promise<Record<string, unknown>>;
  shutdown(timeoutMs?: number): Promise<void>;
}
