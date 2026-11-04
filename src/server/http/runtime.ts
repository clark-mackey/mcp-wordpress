import type { Server } from "node:http";
import type { CreateHostedAuth, HostedAuthOptions, HostedAuth } from "./contract.js";

export function getTransport(env: NodeJS.ProcessEnv = process.env): "stdio" | "http" {
  const transport = env.MCP_TRANSPORT ?? "stdio";
  if (transport !== "stdio" && transport !== "http") throw new Error("MCP_TRANSPORT must be stdio or http");
  return transport;
}

export function getHostedConfiguration(env: NodeJS.ProcessEnv = process.env): { publicBaseUrl: URL; port: number } {
  let publicBaseUrl: URL;
  try {
    publicBaseUrl = new URL(env.PUBLIC_BASE_URL ?? "");
  } catch {
    throw new Error("PUBLIC_BASE_URL must be an https origin with no path");
  }
  if (
    publicBaseUrl.protocol !== "https:" ||
    publicBaseUrl.pathname !== "/" ||
    publicBaseUrl.search ||
    publicBaseUrl.hash ||
    publicBaseUrl.username ||
    publicBaseUrl.password
  )
    throw new Error("PUBLIC_BASE_URL must be an https origin with no path, query, credentials or fragment");
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535");
  return { publicBaseUrl, port };
}

export async function loadHostedAuth(options: HostedAuthOptions): Promise<HostedAuth> {
  // The auth package is delivered independently; stdio must not load or require it.
  const authModulePath = "./auth/index.js";
  const { createHostedAuth } = (await import(authModulePath)) as { createHostedAuth: CreateHostedAuth };
  return createHostedAuth(options);
}

export async function drainHostedServer(server: Server, timeoutMs = 25000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      resolve();
    }, timeoutMs);
    server.close((error) => {
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve();
    });
  });
}
