import type { Principal } from "../contract.js";

export interface UsageConfiguration {
  databaseUrl: string;
  retentionDays: number;
  reviewer: string | null;
}

export function getUsageConfiguration(
  principals: ReadonlyMap<string, Principal>,
  env: NodeJS.ProcessEnv = process.env,
): UsageConfiguration | undefined {
  const rawRetention = env.MCP_USAGE_RETENTION_DAYS ?? "90";
  const retentionDays = Number(rawRetention);
  if (!/^\d+$/.test(rawRetention) || !Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650)
    throw new Error("MCP_USAGE_RETENTION_DAYS must be an integer from 1 to 3650");
  const reviewer = env.MCP_USAGE_REVIEWER ?? null;
  if (reviewer !== null && !principals.has(reviewer))
    throw new Error("MCP_USAGE_REVIEWER must name a configured principal");
  const databaseUrl = env.MCP_USAGE_DATABASE_URL;
  if (!databaseUrl) return undefined;
  return { databaseUrl, retentionDays, reviewer };
}
