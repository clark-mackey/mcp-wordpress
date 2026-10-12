import { readFile } from "node:fs/promises";
import { WordPressClient } from "@/client/api.js";
import { WordPressAPIError } from "@/types/client.js";
import { getErrorMessage } from "@/utils/error.js";
import { assertSameSite, backupRoot, resolveSnapshotFile, writeSnapshotFile } from "./localSnapshots.js";

/**
 * Local copy of a template part's content before every edit, in
 * `<repo root>/backups/template-parts/<host>-<hash of site URL>/<id>-<timestamp>.json`.
 *
 * Why this exists next to WordPress revisions: a template part that still comes from a theme file
 * has no database post yet, so its FIRST edit creates the post with the new content and core keeps
 * no revision of the original. Revisions only cover later edits. The local copy is always saved,
 * so the original header/footer can always be put back.
 */

export interface TemplatePartSnapshot {
  version: 1;
  site_url: string;
  taken_at: string;
  part_id: string;
  content: string;
}

export const templatePartBackupRoot = (): string => backupRoot("template-parts", "MCP_WP_TEMPLATE_PART_BACKUP_DIR");

/** `theme//header` becomes `theme__header` (ids are already limited to [\w.-] and slashes). */
const safeName = (partId: string): string => partId.replace(/\//g, "_");

export async function writeTemplatePartSnapshot(
  client: WordPressClient,
  partId: string,
  content: string,
): Promise<{ file: string; path: string }> {
  const takenAt = new Date().toISOString();
  const snapshot: TemplatePartSnapshot = {
    version: 1,
    site_url: client.getSiteUrl(),
    taken_at: takenAt,
    part_id: partId,
    content,
  };
  return writeSnapshotFile(client, templatePartBackupRoot(), safeName(partId), takenAt, snapshot);
}

export const resolveTemplatePartSnapshotPath = (client: WordPressClient, input: string): Promise<string> =>
  resolveSnapshotFile(client, templatePartBackupRoot(), input, "template-parts");

/** Reads and checks a snapshot. `isValidId` is the caller's template part ID check. */
export async function readTemplatePartSnapshot(
  path: string,
  client: WordPressClient,
  isValidId: (id: string) => boolean,
): Promise<TemplatePartSnapshot> {
  let data: TemplatePartSnapshot;
  try {
    data = JSON.parse(await readFile(path, "utf8")) as TemplatePartSnapshot;
  } catch (error) {
    throw new WordPressAPIError(
      `Snapshot file is not readable JSON: ${getErrorMessage(error)}`,
      400,
      "INVALID_PARAMETER",
    );
  }
  const valid =
    data?.version === 1 &&
    typeof data.site_url === "string" &&
    typeof data.part_id === "string" &&
    isValidId(data.part_id) &&
    typeof data.content === "string";
  if (!valid)
    throw new WordPressAPIError("Snapshot file does not look like a template part snapshot.", 400, "INVALID_PARAMETER");
  assertSameSite(data.site_url, client);
  return data;
}
