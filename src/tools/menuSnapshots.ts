import { readFile } from "node:fs/promises";
import { WordPressClient } from "@/client/api.js";
import { WordPressAPIError } from "@/types/client.js";
import { isUnsafePlainText } from "@/security/InputValidator.js";
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
 * Local undo for menus. WordPress keeps no revisions of menus or menu items, so before every
 * menu-item create, update or delete the whole menu (menu + all items) is written to
 * `<repo root>/backups/menus/<host>-<hash of site URL>/<menuId>-<timestamp>.json`, and wp_restore_menu_snapshot
 * puts a menu back from one of those files. If the snapshot cannot be written, the change is not made.
 */

export interface MenuItemRecord {
  id: number;
  title: { raw?: string; rendered?: string };
  url?: string;
  parent: number;
  menu_order: number;
  type?: string;
  object?: string;
  object_id?: number;
  attr_title?: string;
  target?: string;
  classes?: string[];
  xfn?: string[];
  description?: string;
  status?: string;
}

export interface MenuSnapshot {
  version: 1;
  site_url: string;
  taken_at: string;
  menu_id: number;
  menu: Record<string, unknown>;
  items: MenuItemRecord[];
}

const PAGE_SIZE = 100;
const MAX_PAGES = 20;

export const menuBackupRoot = (): string => backupRoot("menus", "MCP_WP_MENU_BACKUP_DIR");
export { siteKey };

const assertMenuId = (id: unknown): number => {
  if (!Number.isInteger(id) || (id as number) <= 0) {
    throw new WordPressAPIError("Menu ID must be a positive integer.", 400, "INVALID_PARAMETER");
  }
  return id as number;
};

export async function fetchMenuItems(client: WordPressClient, menuId: number): Promise<MenuItemRecord[]> {
  const items: MenuItemRecord[] = [];
  // /wp/v2/menu-items answers only status=publish by default, which would leave draft items out of a
  // snapshot (and make restore delete nothing it should keep). Its status filter takes a list of post
  // statuses like other post endpoints; "any" is not used because it is only valid for some roles.
  const status = "publish,draft,pending,private";
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await freshGet<MenuItemRecord[]>(
      client,
      `menu-items?menus=${menuId}&per_page=${PAGE_SIZE}&page=${page}&status=${status}&context=edit`,
    );
    items.push(...batch);
    if (batch.length < PAGE_SIZE) return items;
  }
  // Every page up to the cap was full: stop rather than save a truncated snapshot restore would trust.
  throw new Error(`Menu ${menuId} has more than ${MAX_PAGES * PAGE_SIZE} items, more than a snapshot can safely hold.`);
}

/** Writes the menu's current state to disk and returns where. Throws if the menu cannot be read or the file cannot be written. */
export async function writeMenuSnapshot(
  client: WordPressClient,
  menuId: number,
): Promise<{ file: string; path: string }> {
  assertMenuId(menuId);
  const menu = await freshGet<Record<string, unknown>>(client, `menus/${menuId}?context=edit`);
  const items = await fetchMenuItems(client, menuId);
  const takenAt = new Date().toISOString();
  const snapshot: MenuSnapshot = {
    version: 1,
    site_url: client.getSiteUrl(),
    taken_at: takenAt,
    menu_id: menuId,
    menu,
    items,
  };
  return writeSnapshotFile(client, menuBackupRoot(), String(menuId), takenAt, snapshot);
}

export const resolveSnapshotPath = (client: WordPressClient, input: string): Promise<string> =>
  resolveSnapshotFile(client, menuBackupRoot(), input, "menus");

export async function readMenuSnapshot(path: string, client: WordPressClient): Promise<MenuSnapshot> {
  let data: MenuSnapshot;
  try {
    data = JSON.parse(await readFile(path, "utf8")) as MenuSnapshot;
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
    Number.isInteger(data.menu_id) &&
    Array.isArray(data.items) &&
    data.items.every((i) => Number.isInteger(i?.id) && i.title && Number.isInteger(i.parent));
  if (!valid)
    throw new WordPressAPIError("Snapshot file does not look like a menu snapshot.", 400, "INVALID_PARAMETER");
  assertSameSite(data.site_url, client);
  return data;
}

export interface RestoreReport {
  backup: string;
  changes: string[];
  failed: string[];
  /** Items added since the snapshot that were left alone because an earlier step failed. */
  skippedDeletes: string[];
}

/**
 * Text fields of a restored item that are new compared with the live item and look like script. A crafted
 * snapshot must not put script on the site, but values already live (unchanged) are never questioned.
 * Titles and attributes are plain text, so the plain-text check applies; URLs are checked where they are used.
 */
function unsafeNewFields(item: MenuItemRecord, now: MenuItemRecord | undefined): string[] {
  const candidates: Array<[string, unknown, unknown]> = [
    ["title", titleOf(item), now ? titleOf(now) : undefined],
    ["attr_title", item.attr_title, now?.attr_title],
    ["description", item.description, now?.description],
  ];
  return candidates
    .filter(([, v, live]) => typeof v === "string" && v !== live && isUnsafePlainText(v))
    .map(([k]) => k);
}

const RESTORED_FIELDS = [
  "type",
  "object",
  "object_id",
  "attr_title",
  "target",
  "description",
  "classes",
  "xfn",
] as const;
const titleOf = (item: MenuItemRecord): string => item.title.raw ?? item.title.rendered ?? "";
const label = (item: MenuItemRecord): string => `"${titleOf(item)}" (item ${item.id})`;

/** Fields sent when an item has to be created again. Links to pages/categories keep their object, custom links keep their URL. */
function createBody(item: MenuItemRecord, menuId: number, parent: number): Record<string, unknown> {
  const body: Record<string, unknown> = {
    title: titleOf(item),
    menus: menuId,
    parent,
    menu_order: item.menu_order,
    status: item.status ?? "publish",
  };
  if (item.type) body.type = item.type;
  if (item.type === "custom") {
    if (item.url && !isUnsafePlainText(item.url)) body.url = item.url;
  } else {
    if (item.object) body.object = item.object;
    if (item.object_id) body.object_id = item.object_id;
  }
  for (const key of ["attr_title", "target", "description", "classes", "xfn"] as const) {
    if (item[key] !== undefined) body[key] = item[key];
  }
  return body;
}

/**
 * Puts a menu back the way the snapshot had it: items that still exist get their title, link,
 * parent and order back; deleted items are created again (they get new IDs); items added since
 * are deleted (only when nothing else failed). The menu's current state is snapshotted first, so a restore can itself be undone.
 * One failing item does not stop the rest; failures are reported.
 */
export async function restoreMenuSnapshot(client: WordPressClient, snapshot: MenuSnapshot): Promise<RestoreReport> {
  const menuId = snapshot.menu_id;
  const backup = (await writeMenuSnapshot(client, menuId)).file;
  const current = await fetchMenuItems(client, menuId);
  const currentById = new Map(current.map((i) => [i.id, i]));
  const wantedIds = new Set(snapshot.items.map((i) => i.id));
  const changes: string[] = [];
  const failed: string[] = [];
  const attempt = async (what: string, run: () => Promise<unknown>) => {
    try {
      await run();
      return true;
    } catch (error) {
      failed.push(`${what}: ${getErrorMessage(error)}`);
      return false;
    }
  };

  // 1. Recreate deleted items, parents before children. newIds maps an old ID to its replacement.
  const newIds = new Map<number, number>();
  let pending = snapshot.items.filter((i) => !currentById.has(i.id));
  while (pending.length) {
    const resolvable = (i: MenuItemRecord) =>
      i.parent === 0 || currentById.has(i.parent) || newIds.has(i.parent) || !wantedIds.has(i.parent);
    let batch = pending.filter(resolvable);
    // A parent loop in a hand-edited file: create what is left at the top level instead of spinning.
    if (!batch.length) batch = pending;
    for (const item of batch) {
      const unsafe = unsafeNewFields(item, undefined);
      if (unsafe.length) {
        failed.push(`Refused to recreate ${label(item)}: unsafe text in ${unsafe.join(", ")}`);
        newIds.set(item.id, 0); // children fall back to the top level instead of waiting forever
        continue;
      }
      const parent = newIds.get(item.parent) ?? (currentById.has(item.parent) ? item.parent : 0);
      await attempt(`Could not recreate ${label(item)}`, async () => {
        const created = await client.post<{ id: number }>("menu-items", createBody(item, menuId, parent));
        newIds.set(item.id, created.id);
        changes.push(`Recreated ${label(item)} as item ${created.id}`);
      });
    }
    pending = pending.filter((i) => !batch.includes(i));
  }

  // 2. Put surviving items back.
  for (const item of snapshot.items) {
    const now = currentById.get(item.id);
    if (!now) continue;
    const unsafe = unsafeNewFields(item, now);
    if (unsafe.length) {
      failed.push(`Refused to restore ${label(item)}: unsafe text in ${unsafe.join(", ")}`);
      continue;
    }
    const parent = newIds.get(item.parent) ?? item.parent;
    const body: Record<string, unknown> = {};
    const what: string[] = [];
    if (titleOf(now) !== titleOf(item)) {
      body.title = titleOf(item);
      what.push("title");
    }
    // Only custom links own their URL; for pages and categories WordPress derives it from the object.
    if (item.type === "custom" && item.url && now.url !== item.url && !isUnsafePlainText(item.url)) {
      body.url = item.url;
      what.push("link");
    }
    if (now.parent !== parent) {
      body.parent = parent;
      what.push("parent");
    }
    if (now.menu_order !== item.menu_order) {
      body.menu_order = item.menu_order;
      what.push("order");
    }
    // A link retargeted to another page or category, or a changed attribute: compare as JSON so arrays
    // (classes, xfn) work, and only touch fields the snapshot actually carries.
    for (const key of RESTORED_FIELDS) {
      if (item[key] !== undefined && JSON.stringify(now[key]) !== JSON.stringify(item[key])) {
        body[key] = item[key];
        what.push(key);
      }
    }
    if (!what.length) continue;
    await attempt(`Could not restore ${label(item)}`, async () => {
      await client.post(`menu-items/${item.id}`, body);
      changes.push(`Restored ${what.join(", ")} of ${label(item)}`);
    });
  }

  // 3. Remove items added since the snapshot, but only if everything above worked: a failed step means
  // the menu is not in the state the deletes assume, so nothing is deleted.
  const added = current.filter((i) => !wantedIds.has(i.id));
  const skippedDeletes = failed.length ? added.map(label) : [];
  for (const item of failed.length ? [] : added) {
    await attempt(`Could not delete ${label(item)}`, async () => {
      await client.delete(`menu-items/${item.id}?force=true`);
      changes.push(`Deleted ${label(item)} (added after the snapshot)`);
    });
  }

  return { backup, changes, failed, skippedDeletes };
}
