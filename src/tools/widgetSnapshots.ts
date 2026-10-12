import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WordPressClient } from "@/client/api.js";
import { WordPressAPIError } from "@/types/client.js";
import { getErrorMessage } from "@/utils/error.js";

/**
 * Local undo for widget areas (footer and sidebar widgets). WordPress keeps no revisions of
 * widgets, so before every widget create, update or delete the whole area (sidebar + all its
 * widgets, context=edit) is written to `<repo root>/backups/widgets/<site-key>/<sidebarId>-<timestamp>.json`.
 * If the snapshot cannot be written the change is not made. Each file records the full site URL
 * and a restore refuses a file whose URL is not the client's, so a snapshot never crosses sites.
 */

export interface WidgetRecord {
  id: string;
  id_base?: string;
  sidebar?: string;
  instance?: { raw?: Record<string, unknown> };
}

export interface WidgetSnapshot {
  version: 1;
  site_url: string;
  taken_at: string;
  sidebar_id: string;
  sidebar: Record<string, unknown>;
  widgets: WidgetRecord[];
}

const ID_PATTERN = /^[\w-]+$/;

export function assertWidgetId(id: unknown, what = "widget"): string {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new WordPressAPIError(
      `"${String(id)}" is not a valid ${what} ID. Use an ID from wp_list_widget_areas or wp_get_widget_area (letters, digits, - and _ only).`,
      400,
      "INVALID_PARAMETER",
    );
  }
  return id;
}

export const enc = (id: string): string => encodeURIComponent(id);

/** Repo-root backups folder (dist/tools and src/tools both sit two levels below the root). MCP_WP_WIDGET_BACKUP_DIR overrides it, mainly for tests. */
export function widgetBackupRoot(): string {
  return (
    process.env.MCP_WP_WIDGET_BACKUP_DIR ||
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "backups", "widgets")
  );
}

/** Folder name per site: host plus a short hash of the full URL, so two sites on one host (or http/https, paths) never share one. */
export function siteKey(client: WordPressClient): string {
  const url = client.getSiteUrl();
  const host = new URL(url).host.toLowerCase().replace(/[^a-z0-9.-]/g, "_");
  return `${host}-${createHash("sha256").update(url).digest("hex").slice(0, 8)}`;
}

export async function fetchWidgets(client: WordPressClient, sidebarId: string): Promise<WidgetRecord[]> {
  return client.get<WidgetRecord[]>(`widgets?sidebar=${enc(sidebarId)}&per_page=100&context=edit`);
}

export async function writeWidgetSnapshot(
  client: WordPressClient,
  sidebarId: string,
): Promise<{ file: string; path: string }> {
  const sidebar = await client.get<Record<string, unknown>>(`sidebars/${enc(sidebarId)}?context=edit`);
  const widgets = await fetchWidgets(client, sidebarId);
  const takenAt = new Date().toISOString();
  const snapshot: WidgetSnapshot = {
    version: 1,
    site_url: client.getSiteUrl(),
    taken_at: takenAt,
    sidebar_id: sidebarId,
    sidebar,
    widgets,
  };
  const dir = join(widgetBackupRoot(), siteKey(client));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stamp = takenAt.replace(/:/g, "-");
  for (let attempt = 0; attempt < 10; attempt++) {
    const file = `${sidebarId}-${stamp}${attempt ? `-${attempt}` : ""}.json`;
    const path = join(dir, file);
    try {
      // "wx": never overwrite an existing snapshot.
      await writeFile(path, JSON.stringify(snapshot, null, 2), { mode: 0o600, flag: "wx" });
      return { file, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not pick a free snapshot file name.");
}

/** Accepts a file name (this site's folder) or a path inside backups/widgets; refuses traversal, symlinks out, other sites. */
export async function resolveWidgetSnapshotPath(client: WordPressClient, input: string): Promise<string> {
  const refuse = (why: string) => new WordPressAPIError(`Invalid snapshot: ${why}`, 400, "INVALID_PARAMETER");
  const raw = input.trim();
  if (!raw || raw.includes("\0")) throw refuse("give a snapshot file name.");
  if (raw.split(/[\\/]/).includes("..")) throw refuse("paths with '..' are not allowed.");
  if (!raw.toLowerCase().endsWith(".json")) throw refuse("snapshot files end in .json.");

  const root = widgetBackupRoot();
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
  if (!real.startsWith(realRoot + sep)) throw refuse("the file must be inside the backups/widgets folder.");
  if (dirname(real) !== join(realRoot, key)) throw refuse("that snapshot belongs to a different site.");
  return real;
}

export async function readWidgetSnapshot(path: string, client: WordPressClient): Promise<WidgetSnapshot> {
  let data: WidgetSnapshot;
  try {
    data = JSON.parse(await readFile(path, "utf8")) as WidgetSnapshot;
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
    typeof data.sidebar_id === "string" &&
    ID_PATTERN.test(data.sidebar_id) &&
    Array.isArray(data.widgets) &&
    data.widgets.every((w) => typeof w?.id === "string" && ID_PATTERN.test(w.id));
  if (!valid)
    throw new WordPressAPIError("Snapshot file does not look like a widget snapshot.", 400, "INVALID_PARAMETER");
  if (data.site_url !== client.getSiteUrl()) {
    throw new WordPressAPIError(
      `This snapshot was taken on ${data.site_url}, not ${client.getSiteUrl()}. Nothing was changed.`,
      400,
      "INVALID_PARAMETER",
    );
  }
  return data;
}

export interface WidgetRestoreReport {
  backup: string;
  changes: string[];
  failed: string[];
  deletionSkipped: boolean;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const label = (w: WidgetRecord) => `widget ${w.id}`;

/**
 * Puts a widget area back: widgets still on the site get their settings (instance.raw, where
 * WordPress exposes it) and sidebar back, deleted block widgets are created again (new IDs),
 * and widgets added since are removed, but ONLY if every earlier step succeeded; a failed step
 * means the picture is incomplete, so nothing is deleted. Order within the area is not restored.
 * The current state is snapshotted first, so a restore can itself be undone.
 */
export async function restoreWidgetSnapshot(
  client: WordPressClient,
  snapshot: WidgetSnapshot,
): Promise<WidgetRestoreReport> {
  const sidebarId = snapshot.sidebar_id;
  const backup = (await writeWidgetSnapshot(client, sidebarId)).file;
  const current = await fetchWidgets(client, sidebarId);
  const currentById = new Map(current.map((w) => [w.id, w]));
  const wantedIds = new Set(snapshot.widgets.map((w) => w.id));
  const changes: string[] = [];
  const failed: string[] = [];
  const attempt = async (what: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      failed.push(`${what}: ${getErrorMessage(error)}`);
    }
  };

  for (const want of snapshot.widgets) {
    let now = currentById.get(want.id);
    if (!now) {
      // It may have been moved to another area rather than deleted; look it up by ID.
      try {
        now = await client.get<WidgetRecord>(`widgets/${enc(want.id)}?context=edit`);
      } catch {
        now = undefined;
      }
    }
    if (!now) {
      const content = want.instance?.raw?.content;
      if (want.id_base === "block" && typeof content === "string") {
        await attempt(`Could not recreate ${label(want)}`, async () => {
          const created = await client.post<WidgetRecord>("widgets", {
            id_base: "block",
            sidebar: sidebarId,
            instance: { raw: want.instance?.raw },
          });
          changes.push(`Recreated ${label(want)} as ${created.id}`);
        });
      } else {
        failed.push(
          `Could not recreate ${label(want)}: it is a ${want.id_base ?? "legacy"} widget and only block widgets can be created again`,
        );
      }
      continue;
    }
    const body: Record<string, unknown> = {};
    const what: string[] = [];
    if (want.instance?.raw !== undefined && !same(now.instance?.raw, want.instance.raw)) {
      body.instance = { raw: want.instance.raw };
      what.push("settings");
    }
    if (now.sidebar !== sidebarId) {
      body.sidebar = sidebarId;
      what.push("area");
    }
    if (!what.length) continue;
    await attempt(`Could not restore ${label(want)}`, async () => {
      await client.post(`widgets/${enc(want.id)}`, body);
      changes.push(`Restored ${what.join(", ")} of ${label(want)}`);
    });
  }

  const deletionSkipped = failed.length > 0;
  if (!deletionSkipped) {
    for (const w of current) {
      if (wantedIds.has(w.id)) continue;
      await attempt(`Could not delete ${label(w)}`, async () => {
        await client.delete(`widgets/${enc(w.id)}?force=true`);
        changes.push(`Deleted ${label(w)} (added after the snapshot)`);
      });
    }
  }
  return { backup, changes, failed, deletionSkipped };
}
