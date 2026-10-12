import { vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeMenuSnapshot,
  resolveSnapshotPath,
  readMenuSnapshot,
  restoreMenuSnapshot,
} from "@/tools/menuSnapshots.js";
import { siteKey } from "@/tools/localSnapshots.js";

const item = (id, title, over = {}) => ({
  id,
  title: { raw: title, rendered: title },
  url: `https://test-site.com/${id}`,
  parent: 0,
  menu_order: id,
  type: "custom",
  object: "custom",
  object_id: id,
  ...over,
});

/** A client whose menu 5 holds `items`; records writes. */
function makeClient(items, host = "https://test-site.com") {
  const calls = [];
  let nextId = 100;
  const client = {
    calls,
    getSiteUrl: () => host,
    get: vi.fn(async (endpoint) => {
      if (endpoint.startsWith("menus/5")) return { id: 5, name: "Main", locations: ["primary"] };
      if (endpoint.startsWith("menu-items?menus=5")) return items;
      throw new Error(`unexpected GET ${endpoint}`);
    }),
    post: vi.fn(async (endpoint, body) => {
      calls.push(["POST", endpoint, body]);
      return { id: nextId++ };
    }),
    delete: vi.fn(async (endpoint) => {
      calls.push(["DELETE", endpoint]);
      return { deleted: true };
    }),
    requestWithMetadata: vi.fn(async (_m, e) => ({ data: await client.get(e) })),
  };
  return client;
}

describe("menu snapshots", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "menu-snap-"));
    process.env.MCP_WP_MENU_BACKUP_DIR = dir;
  });
  afterEach(() => {
    delete process.env.MCP_WP_MENU_BACKUP_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes menu + items to <root>/<host>/<menuId>-<timestamp>.json with owner-only permissions", async () => {
    const client = makeClient([item(1, "Home"), item(2, "About")], "https://test-site.com:8443");
    const { file, path } = await writeMenuSnapshot(client, 5);

    expect(file).toMatch(/^5-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.json$/);
    expect(siteKey(client)).toMatch(/^test-site\.com_8443-[0-9a-f]{8}$/);
    expect(path).toBe(join(dir, siteKey(client), file));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved).toMatchObject({ version: 1, menu_id: 5, menu: { name: "Main" } });
    expect(saved.items.map((i) => i.id)).toEqual([1, 2]);
  });

  it("never overwrites an existing snapshot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-11T12:00:00.000Z"));
    try {
      const client = makeClient([item(1, "Home")]);
      const a = await writeMenuSnapshot(client, 5);
      const b = await writeMenuSnapshot(client, 5);
      expect(a.file).not.toBe(b.file);
      expect(readdirSync(join(dir, siteKey(client)))).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pages through menus with more than 100 items", async () => {
    const many = Array.from({ length: 100 }, (_, i) => item(i + 1, `n${i}`));
    const client = makeClient([]);
    client.get.mockImplementation(async (endpoint) => {
      if (endpoint.startsWith("menus/5")) return { id: 5 };
      return endpoint.includes("page=1&") ? many : [item(101, "last")];
    });
    const { path } = await writeMenuSnapshot(client, 5);
    expect(JSON.parse(readFileSync(path, "utf8")).items).toHaveLength(101);
  });

  describe("resolveSnapshotPath", () => {
    let client;
    let file;
    beforeEach(async () => {
      client = makeClient([item(1, "Home")]);
      file = (await writeMenuSnapshot(client, 5)).file;
    });

    it("accepts a bare file name and a path inside the folder", async () => {
      const real = await resolveSnapshotPath(client, file);
      expect(real.endsWith(file)).toBe(true);
      await expect(resolveSnapshotPath(client, join(dir, siteKey(client), file))).resolves.toBe(real);
    });

    it.each(["../secret.json", "test-site.com/../../etc/passwd.json", "..\\x.json", "a/../../b.json"])(
      "rejects path traversal: %s",
      async (bad) => {
        await expect(resolveSnapshotPath(client, bad)).rejects.toThrow(/Invalid snapshot/);
      },
    );

    it("rejects absolute paths outside the folder and non-json files", async () => {
      const outside = join(tmpdir(), "outside.json");
      writeFileSync(outside, "{}");
      try {
        await expect(resolveSnapshotPath(client, outside)).rejects.toThrow(/inside the backups\/menus folder/);
      } finally {
        rmSync(outside, { force: true });
      }
      await expect(resolveSnapshotPath(client, "/etc/passwd")).rejects.toThrow(/Invalid snapshot/);
      await expect(resolveSnapshotPath(client, "")).rejects.toThrow(/Invalid snapshot/);
    });

    it("rejects a symlink that points outside the folder", async () => {
      const outside = join(tmpdir(), `outside-${Date.now()}.json`);
      writeFileSync(outside, "{}");
      symlinkSync(outside, join(dir, siteKey(client), "evil.json"));
      try {
        await expect(resolveSnapshotPath(client, "evil.json")).rejects.toThrow(/inside the backups\/menus folder/);
      } finally {
        rmSync(outside, { force: true });
      }
    });

    it("refuses another site's snapshot", async () => {
      const other = makeClient([item(1, "Home")], "https://other-site.com");
      const otherFile = (await writeMenuSnapshot(other, 5)).path;
      await expect(resolveSnapshotPath(client, otherFile)).rejects.toThrow(/different site/);
      await expect(resolveSnapshotPath(client, "nope.json")).rejects.toThrow(/no snapshot file found/);
    });

    it("rejects files that are not menu snapshots", async () => {
      const bad = join(dir, siteKey(client), "5-bad.json");
      mkdirSync(join(dir, siteKey(client)), { recursive: true });
      writeFileSync(bad, JSON.stringify({ version: 1, items: "nope" }));
      await expect(readMenuSnapshot(bad, client)).rejects.toThrow(/does not look like a menu snapshot/);
      writeFileSync(bad, "not json");
      await expect(readMenuSnapshot(bad, client)).rejects.toThrow(/not readable JSON/);
    });
  });

  describe("restoreMenuSnapshot", () => {
    const snapshotOf = (items) => ({
      version: 1,
      site_url: "https://test-site.com",
      taken_at: "t",
      menu_id: 5,
      menu: {},
      items,
    });

    it("reapplies changed fields, recreates deleted items (parents first) and deletes added ones", async () => {
      const original = [
        item(1, "Home"),
        item(2, "About", { parent: 0 }),
        item(3, "Team", { parent: 2, menu_order: 3 }),
        item(4, "Contact", { menu_order: 4 }),
      ];
      // Now: About deleted (and with it Team), Home renamed + moved, Contact reparented, Extra added.
      const now = [
        item(1, "Homepage", { menu_order: 9, url: "https://test-site.com/1" }),
        item(4, "Contact", { parent: 1, menu_order: 4 }),
        item(8, "Extra", { menu_order: 10 }),
      ];
      const client = makeClient(now);
      const report = await restoreMenuSnapshot(client, snapshotOf(original));

      const posts = client.calls.filter((c) => c[0] === "POST");
      // New snapshot of the current state is written first (undo for the restore).
      expect(report.backup).toMatch(/^5-.*\.json$/);

      const recreateAbout = posts.find((c) => c[1] === "menu-items" && c[2].title === "About");
      const recreateTeam = posts.find((c) => c[1] === "menu-items" && c[2].title === "Team");
      expect(recreateAbout[2]).toMatchObject({
        menus: 5,
        parent: 0,
        type: "custom",
        url: "https://test-site.com/2",
        status: "publish",
      });
      // About came back as item 100, so Team must hang under 100 and not under the dead ID 2.
      expect(recreateTeam[2].parent).toBe(100);
      expect(posts.indexOf(recreateAbout)).toBeLessThan(posts.indexOf(recreateTeam));

      expect(posts.find((c) => c[1] === "menu-items/1")[2]).toEqual({ title: "Home", menu_order: 1 });
      expect(posts.find((c) => c[1] === "menu-items/4")[2]).toEqual({ parent: 0 });
      expect(client.calls).toContainEqual(["DELETE", "menu-items/8?force=true"]);

      expect(report.failed).toEqual([]);
      expect(report.changes).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Recreated "About"'),
          expect.stringContaining('Recreated "Team"'),
          expect.stringContaining('Restored title, order of "Home"'),
          expect.stringContaining('Restored parent of "Contact"'),
          expect.stringContaining('Deleted "Extra"'),
        ]),
      );
    });

    it("changes nothing when the menu already matches", async () => {
      const items = [item(1, "Home"), item(2, "About")];
      const client = makeClient(items);
      const report = await restoreMenuSnapshot(client, snapshotOf(items));
      expect(report.changes).toEqual([]);
      expect(client.calls).toEqual([]);
    });

    it("keeps going and reports when one item fails", async () => {
      const client = makeClient([item(1, "Wrong")]);
      client.post.mockImplementation(async (endpoint) => {
        if (endpoint === "menu-items/1") throw new Error("boom");
        return { id: 50 };
      });
      const report = await restoreMenuSnapshot(client, snapshotOf([item(1, "Home"), item(2, "About")]));
      expect(report.failed).toEqual([expect.stringContaining("boom")]);
      expect(report.changes).toEqual([expect.stringContaining('Recreated "About"')]);
    });

    it("does not send an unsafe URL back to WordPress", async () => {
      const client = makeClient([]);
      await restoreMenuSnapshot(client, snapshotOf([item(1, "Bad", { url: "javascript:alert(1)" })]));
      expect(client.calls.find((c) => c[1] === "menu-items")[2]).not.toHaveProperty("url");
    });

    it("does not loop forever on a parent cycle in a hand-edited file", async () => {
      const client = makeClient([]);
      const report = await restoreMenuSnapshot(
        client,
        snapshotOf([item(1, "A", { parent: 2 }), item(2, "B", { parent: 1 })]),
      );
      expect(report.changes).toHaveLength(2);
    });
  });
});

describe("menu snapshot hardening", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "menu-snap2-"));
    process.env.MCP_WP_MENU_BACKUP_DIR = dir;
  });
  afterEach(() => {
    delete process.env.MCP_WP_MENU_BACKUP_DIR;
    rmSync(dir, { recursive: true, force: true });
  });
  const snapshotOf = (items, site = "https://test-site.com") => ({
    version: 1,
    site_url: site,
    taken_at: "t",
    menu_id: 5,
    menu: {},
    items,
  });

  it("keeps two installs on one host apart (same host, different path) and refuses a forged site_url", async () => {
    const root = makeClient([item(1, "Home")], "https://test-site.com");
    const blog = makeClient([item(1, "Home")], "https://test-site.com/blog");
    expect(siteKey(root)).not.toBe(siteKey(blog));

    const { path, file } = await writeMenuSnapshot(root, 5);
    await expect(resolveSnapshotPath(blog, file)).rejects.toThrow(/no snapshot file found/);
    await expect(resolveSnapshotPath(blog, path)).rejects.toThrow(/different site/);

    // Copy it into the other install's folder: the recorded URL still gives it away.
    const forged = JSON.parse(readFileSync(path, "utf8"));
    const dest = join(dir, siteKey(blog));
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "5-copy.json"), JSON.stringify(forged));
    const real = await resolveSnapshotPath(blog, "5-copy.json");
    await expect(readMenuSnapshot(real, blog)).rejects.toThrow(/not https:\/\/test-site\.com\/blog/);
  });

  it("asks for drafts too and throws instead of saving a truncated snapshot", async () => {
    const full = Array.from({ length: 100 }, (_, i) => item(i + 1, `n${i}`));
    const client = makeClient([]);
    client.get.mockImplementation(async (endpoint) => (endpoint.startsWith("menus/5") ? { id: 5 } : full));
    await expect(writeMenuSnapshot(client, 5)).rejects.toThrow(/more than a snapshot can safely hold/);
    expect(client.get.mock.calls.some(([e]) => e.includes("status=publish,draft,pending,private"))).toBe(true);
    expect(() => readdirSync(dir)).not.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("rejects a non-positive menu id", async () => {
    await expect(writeMenuSnapshot(makeClient([]), 0)).rejects.toThrow(/positive integer/);
  });

  it("restores a retargeted link and changed attributes, only for fields the snapshot carries", async () => {
    const wanted = item(1, "About", {
      type: "post_type",
      object: "page",
      object_id: 12,
      target: "_blank",
      classes: ["a", "b"],
    });
    const now = item(1, "About", { type: "post_type", object: "page", object_id: 99, target: "", classes: ["a"] });
    const client = makeClient([now]);
    const report = await restoreMenuSnapshot(client, snapshotOf([wanted]));
    const body = client.calls.find((c) => c[1] === "menu-items/1")[2];
    expect(body).toEqual({ object_id: 12, target: "_blank", classes: ["a", "b"] });
    expect(report.changes[0]).toContain("object_id, target, classes");
  });

  it("does not delete items added since the snapshot when an earlier step failed, and says what it skipped", async () => {
    const client = makeClient([item(1, "Wrong"), item(8, "Extra", { menu_order: 8 })]);
    client.post.mockRejectedValue(new Error("boom"));
    const report = await restoreMenuSnapshot(client, snapshotOf([item(1, "Home")]));
    expect(report.failed).toHaveLength(1);
    expect(client.delete).not.toHaveBeenCalled();
    expect(report.skippedDeletes).toEqual(['"Extra" (item 8)']);
  });

  it("recreates a draft item as a draft", async () => {
    const client = makeClient([]);
    await restoreMenuSnapshot(client, snapshotOf([item(1, "Soon", { status: "draft" })]));
    expect(client.calls.find((c) => c[1] === "menu-items")[2].status).toBe("draft");
  });
});

describe("menu snapshots and the read cache", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "menu-cache-"));
    process.env.MCP_WP_MENU_BACKUP_DIR = dir;
  });
  afterEach(() => {
    delete process.env.MCP_WP_MENU_BACKUP_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("snapshots read through the uncached path, so two in a row see current data", async () => {
    let items = [item(1, "v1")];
    const client = {
      getSiteUrl: () => "https://test-site.com",
      get: vi.fn(async () => {
        throw new Error("cached path must not be used");
      }),
      requestWithMetadata: vi.fn(async (_m, e) => ({ data: e.startsWith("menus/") ? { id: 5 } : items })),
    };
    const a = await writeMenuSnapshot(client, 5);
    items = [item(1, "v2")];
    const b = await writeMenuSnapshot(client, 5);
    expect(JSON.parse(readFileSync(a.path, "utf8")).items[0].title.raw).toBe("v1");
    expect(JSON.parse(readFileSync(b.path, "utf8")).items[0].title.raw).toBe("v2");
    expect(client.get).not.toHaveBeenCalled();
  });

  it("refuses new script in a crafted title but allows unchanged text", async () => {
    const now = [item(1, "Home"), item(2, "Safe")];
    const client = makeClient(now);
    const snap = {
      version: 1,
      site_url: "https://test-site.com",
      taken_at: "t",
      menu_id: 5,
      menu: {},
      items: [item(1, "<img src=x onerror=alert(1)>"), item(2, "Safe2", { menu_order: 2 })],
    };
    const report = await restoreMenuSnapshot(client, snap);
    expect(report.failed).toEqual([expect.stringContaining("unsafe text in title")]);
    expect(client.calls.find((c) => c[1] === "menu-items/1")).toBeUndefined();
    expect(client.calls.find((c) => c[1] === "menu-items/2")[2]).toEqual({ title: "Safe2" });
  });
});
