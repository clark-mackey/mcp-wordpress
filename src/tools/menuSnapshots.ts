import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WordPressClient } from "@/client/api.js";
import { WordPressAPIError } from "@/types/client.js";
import { isUnsafePlainText } from "@/security/InputValidator.js";
import { getErrorMessage } from "@/utils/error.js";

/**
 * Local undo for menus. WordPress keeps no revisions of menus or menu items, so before every
 * menu-item create, update or delete the whole menu (menu + all items) is written to
 * `<repo root>/backups/menus/<site-host>/<menuId>-<timestamp>.json`, and wp_restore_menu_snapshot
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

/** Backups live in the repo (dist/tools and src/tools both sit two levels below the root). MCP_WP_MENU_BACKUP_DIR overrides it, mainly for tests. */
export function backupRoot(): string {
  return (
    process.env.MCP_WP_MENU_BACKUP_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "..", "backups", "menus")
  );
}

/** Folder name for a site: its host (with port), reduced to filename-safe characters. */
export function siteHost(client: WordPressClient): string {
  return new URL(client.getSiteUrl()).host.toLowerCase().replace(/[^a-z0-9.-]/g, "_");
}

export async function fetchMenuItems(client: WordPressClient, menuId: number): Promise<MenuItemRecord[]> {
  const items: MenuItemRecord[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await client.get<MenuItemRecord[]>(
      `menu-items?menus=${menuId}&per_page=${PAGE_SIZE}&page=${page}&context=edit`,
    );
    items.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return items;
}

/** Writes the menu's current state to disk and returns where. Throws if the menu cannot be read or the file cannot be written. */
export async function writeMenuSnapshot(
  client: WordPressClient,
  menuId: number,
): Promise<{ file: string; path: string }> {
  const menu = await client.get<Record<string, unknown>>(`menus/${menuId}?context=edit`);
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

  const dir = join(backupRoot(), siteHost(client));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Colons are not allowed in Windows filenames, so the timestamp uses dashes.
  const stamp = takenAt.replace(/:/g, "-");
  for (let attempt = 0; attempt < 10; attempt++) {
    const file = `${menuId}-${stamp}${attempt ? `-${attempt}` : ""}.json`;
    const path = join(dir, file);
    try {
      // "wx": never overwrite an existing snapshot (two changes in the same millisecond).
      await writeFile(path, JSON.stringify(snapshot, null, 2), { mode: 0o600, flag: "wx" });
      return { file, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not pick a free snapshot file name.");
}

/**
 * Accepts a snapshot file name (looked up in this site's folder) or a path inside the backups/menus
 * folder, and returns the real path. Anything that leaves that folder, or belongs to another site, is refused.
 */
export async function resolveSnapshotPath(client: WordPressClient, input: string): Promise<string> {
  const refuse = (why: string) => new WordPressAPIError(`Invalid snapshot: ${why}`, 400, "INVALID_PARAMETER");
  const raw = input.trim();
  if (!raw || raw.includes("\0")) throw refuse("give a snapshot file name.");
  if (raw.split(/[\\/]/).includes("..")) throw refuse("paths with '..' are not allowed.");
  if (!raw.toLowerCase().endsWith(".json")) throw refuse("snapshot files end in .json.");

  const root = backupRoot();
  const bare = !/[\\/]/.test(raw);
  const candidate = bare ? join(root, siteHost(client), raw) : isAbsolute(raw) ? resolve(raw) : resolve(root, raw);

  let realRoot: string;
  let real: string;
  try {
    realRoot = await realpath(root);
    real = await realpath(candidate);
  } catch {
    throw refuse(`no snapshot file found at ${candidate}. List the folder to see what exists.`);
  }
  if (!real.startsWith(realRoot + sep)) throw refuse("the file must be inside the backups/menus folder.");
  if (dirname(real) !== join(realRoot, siteHost(client))) {
    throw refuse("that snapshot belongs to a different site.");
  }
  return real;
}

export async function readMenuSnapshot(path: string): Promise<MenuSnapshot> {
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
    Number.isInteger(data.menu_id) &&
    Array.isArray(data.items) &&
    data.items.every((i) => Number.isInteger(i?.id) && i.title && Number.isInteger(i.parent));
  if (!valid)
    throw new WordPressAPIError("Snapshot file does not look like a menu snapshot.", 400, "INVALID_PARAMETER");
  return data;
}

export interface RestoreReport {
  backup: string;
  changes: string[];
  failed: string[];
}

const titleOf = (item: MenuItemRecord): string => item.title.raw ?? item.title.rendered ?? "";
const label = (item: MenuItemRecord): string => `"${titleOf(item)}" (item ${item.id})`;

/** Fields sent when an item has to be created again. Links to pages/categories keep their object, custom links keep their URL. */
function createBody(item: MenuItemRecord, menuId: number, parent: number): Record<string, unknown> {
  const body: Record<string, unknown> = {
    title: titleOf(item),
    menus: menuId,
    parent,
    menu_order: item.menu_order,
    status: "publish",
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
 * are deleted. The menu's current state is snapshotted first, so a restore can itself be undone.
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
    if (!what.length) continue;
    await attempt(`Could not restore ${label(item)}`, async () => {
      await client.post(`menu-items/${item.id}`, body);
      changes.push(`Restored ${what.join(", ")} of ${label(item)}`);
    });
  }

  // 3. Remove items added since the snapshot.
  for (const item of current) {
    if (wantedIds.has(item.id)) continue;
    await attempt(`Could not delete ${label(item)}`, async () => {
      await client.delete(`menu-items/${item.id}?force=true`);
      changes.push(`Deleted ${label(item)} (added after the snapshot)`);
    });
  }

  return { backup, changes, failed };
}
