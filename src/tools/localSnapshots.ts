import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WordPressClient } from "@/client/api.js";
import { WordPressAPIError } from "@/types/client.js";

/**
 * Shared plumbing for the local undo files (menus, widgets, template parts): where they live,
 * how one is written (0600, never overwritten) and how a name or path is resolved safely.
 * Each caller stores `site_url` in the file and checks it with assertSameSite on restore.
 */

const invalid = (message: string) => new WordPressAPIError(message, 400, "INVALID_PARAMETER");

/** `<repo root>/backups/<kind>`, or the env override (mainly for tests). dist/tools and src/tools both sit two levels below the root. */
export function backupRoot(kind: string, envVar: string): string {
  return process.env[envVar] || join(dirname(fileURLToPath(import.meta.url)), "..", "..", "backups", kind);
}

/** Folder name per site: host plus a short hash of the full URL, so two sites on one host (or http/https, paths) never share one. */
export function siteKey(client: WordPressClient): string {
  const url = client.getSiteUrl();
  const host = new URL(url).host.toLowerCase().replace(/[^a-z0-9.-]/g, "_");
  return `${host}-${createHash("sha256").update(url).digest("hex").slice(0, 8)}`;
}

/** Writes `<root>/<site-key>/<prefix>-<timestamp>.json` with owner-only permissions; never overwrites. */
export async function writeSnapshotFile(
  client: WordPressClient,
  root: string,
  prefix: string,
  takenAt: string,
  data: unknown,
): Promise<{ file: string; path: string }> {
  const dir = join(root, siteKey(client));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Colons are not allowed in Windows filenames, so the timestamp uses dashes.
  const stamp = takenAt.replace(/:/g, "-");
  for (let attempt = 0; attempt < 10; attempt++) {
    const file = `${prefix}-${stamp}${attempt ? `-${attempt}` : ""}.json`;
    const path = join(dir, file);
    try {
      // "wx": never overwrite an existing snapshot.
      await writeFile(path, JSON.stringify(data, null, 2), { mode: 0o600, flag: "wx" });
      return { file, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not pick a free snapshot file name.");
}

/** Accepts a file name (this site's folder) or a path inside the root; refuses traversal, symlinks out, other sites. */
export async function resolveSnapshotFile(
  client: WordPressClient,
  root: string,
  input: string,
  folder: string,
): Promise<string> {
  const refuse = (why: string) => invalid(`Invalid snapshot: ${why}`);
  const raw = input.trim();
  if (!raw || raw.includes("\0")) throw refuse("give a snapshot file name.");
  if (raw.split(/[\\/]/).includes("..")) throw refuse("paths with '..' are not allowed.");
  if (!raw.toLowerCase().endsWith(".json")) throw refuse("snapshot files end in .json.");

  const key = siteKey(client);
  const bare = !/[\\/]/.test(raw);
  const candidate = bare ? join(root, key, raw) : isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  let realRoot: string;
  let real: string;
  try {
    realRoot = await realpath(root);
    real = await realpath(candidate);
  } catch {
    throw refuse(`no snapshot file found at ${candidate}.`);
  }
  if (!real.startsWith(realRoot + sep)) throw refuse(`the file must be inside the backups/${folder} folder.`);
  if (dirname(real) !== join(realRoot, key)) throw refuse("that snapshot belongs to a different site.");
  return real;
}

/** The file's recorded site URL must be exactly this client's, even when it sits in the right folder. */
export function assertSameSite(recorded: unknown, client: WordPressClient): void {
  if (recorded !== client.getSiteUrl()) {
    throw invalid(`This snapshot was taken on ${String(recorded)}, not ${client.getSiteUrl()}. Nothing was changed.`);
  }
}

/**
 * GET that never comes from the read cache. CachedWordPressClient caches GETs for minutes and has no
 * invalidation rules for menus, widgets, sidebars or template parts, so a read that feeds a write or a
 * snapshot through client.get() could return data from before the last edit. requestWithMetadata()
 * bypasses that cache (it calls the base client directly), so every theme read goes through here.
 */
export async function freshGet<T>(client: WordPressClient, endpoint: string): Promise<T> {
  return (await client.requestWithMetadata<T>("GET", endpoint)).data;
}
