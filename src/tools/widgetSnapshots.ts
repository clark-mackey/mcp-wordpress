import { readFile } from "node:fs/promises";
import { WordPressClient } from "@/client/api.js";
import { isUnsafePlainText, isUnsafeWordPressContent } from "@/security/InputValidator.js";
import { WordPressAPIError } from "@/types/client.js";
import { getErrorMessage } from "@/utils/error.js";
import {
  assertSameSite,
  freshGet,
  backupRoot,
  resolveSnapshotFile,
  siteKey,
  writeSnapshotFile,
} from "./localSnapshots.js";

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

export const widgetBackupRoot = (): string => backupRoot("widgets", "MCP_WP_WIDGET_BACKUP_DIR");
export { siteKey };

export async function fetchWidgets(client: WordPressClient, sidebarId: string): Promise<WidgetRecord[]> {
  const widgets = await freshGet<WidgetRecord[]>(client, `widgets?sidebar=${enc(sidebarId)}&per_page=100&context=edit`);
  // A full page may be cut off; a truncated snapshot would make restore delete the widgets it never saw.
  if (widgets.length >= 100)
    throw new Error(`Widget area ${sidebarId} has 100 or more widgets, more than a snapshot can safely hold.`);
  return widgets;
}

export async function writeWidgetSnapshot(
  client: WordPressClient,
  sidebarId: string,
): Promise<{ file: string; path: string }> {
  const sidebar = await freshGet<Record<string, unknown>>(client, `sidebars/${enc(sidebarId)}?context=edit`);
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
  return writeSnapshotFile(client, widgetBackupRoot(), sidebarId, takenAt, snapshot);
}

export const resolveWidgetSnapshotPath = (client: WordPressClient, input: string): Promise<string> =>
  resolveSnapshotFile(client, widgetBackupRoot(), input, "widgets");

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
  // The saved area must be the one the file claims, and a file that lists no widgets while its own area
  // listed some is damaged (one-way: widgets of a deactivated plugin may sit in sidebar.widgets without
  // being returned by the widgets endpoint, so the reverse is not checked). Restoring such a file would
  // move every current widget to Inactive Widgets.
  const sidebar = data.sidebar as { id?: unknown; widgets?: unknown } | undefined;
  if (!sidebar || typeof sidebar !== "object" || sidebar.id !== data.sidebar_id) {
    throw new WordPressAPIError(
      "Snapshot file does not match its widget area (sidebar id differs).",
      400,
      "INVALID_PARAMETER",
    );
  }
  if (data.widgets.length === 0 && Array.isArray(sidebar.widgets) && sidebar.widgets.length > 0) {
    throw new WordPressAPIError(
      "Snapshot file lists no widgets although its area had some, so it looks damaged. Nothing was changed.",
      400,
      "INVALID_PARAMETER",
    );
  }
  assertSameSite(data.site_url, client);
  return data;
}

export interface WidgetRestoreReport {
  backup: string;
  changes: string[];
  failed: string[];
  deletionSkipped: boolean;
}

/** Key-order-independent deep equality, so a reordered but identical settings object is not rewritten. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : val,
  );
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const label = (w: WidgetRecord) => `widget ${w.id}`;

/**
 * Settings values that are new compared with what is live and look like script. A crafted snapshot file
 * must not be able to put script on the site, but restoring an existing widget (an analytics snippet
 * that was already there) must keep working, so only values that DIFFER from the live widget are checked.
 */
function unsafeNewValues(want: WidgetRecord, now: WidgetRecord | undefined): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(want.instance?.raw ?? {})) {
    if (typeof value !== "string" || same(value, now?.instance?.raw?.[key])) continue;
    const unsafe = key === "content" || key === "text" ? isUnsafeWordPressContent(value) : isUnsafePlainText(value);
    if (unsafe) out.push(key);
  }
  return out;
}

/**
 * Puts a widget area back: widgets still on the site get their settings (instance.raw, where
 * WordPress exposes it) and area back, deleted block widgets are created again (new IDs), and widgets
 * added since are MOVED to Inactive Widgets (never force-deleted; settings stay and can be recovered in
 * WP admin), but ONLY if every earlier step succeeded; a failed step means the picture is incomplete, so
 * nothing is moved. A widget that was moved to Inactive Widgets is found by ID and moved back. Order
 * within the area is not restored. The current state is snapshotted first, so a restore can itself be undone.
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
      // It may have been moved to another area (or to Inactive Widgets) rather than deleted; look it up by ID.
      try {
        now = await freshGet<WidgetRecord>(client, `widgets/${enc(want.id)}?context=edit`);
      } catch (error) {
        // Only a clean 404 means "gone". Anything else (outage, permissions) is unknown, so it counts as a failure.
        if (!(error instanceof WordPressAPIError && error.statusCode === 404)) {
          failed.push(`Could not look up ${label(want)}: ${getErrorMessage(error)}`);
          continue;
        }
      }
    }
    // WordPress can hand an old ID to a different widget type; that is not this widget.
    if (now && want.id_base && now.id_base && now.id_base !== want.id_base) now = undefined;
    if (!now) {
      const content = want.instance?.raw?.content;
      const unsafe = unsafeNewValues(want, undefined);
      if (want.id_base === "block" && typeof content === "string") {
        if (unsafe.length) {
          failed.push(`Refused to recreate ${label(want)}: unsafe content in ${unsafe.join(", ")}`);
          continue;
        }
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
      const unsafe = unsafeNewValues(want, now);
      if (unsafe.length) {
        failed.push(`Refused to restore settings of ${label(want)}: unsafe content in ${unsafe.join(", ")}`);
      } else {
        body.instance = { raw: want.instance.raw };
        what.push("settings");
      }
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
      await attempt(`Could not move ${label(w)} to Inactive Widgets`, async () => {
        // No force: core then assigns the widget to wp_inactive_widgets with its settings intact.
        await client.delete(`widgets/${enc(w.id)}`);
        changes.push(`Moved ${label(w)} to Inactive Widgets (recover in WP admin)`);
      });
    }
  }
  return { backup, changes, failed, deletionSkipped };
}
