import { vi } from "vitest";
import { SEOPressTools } from "@/tools/seopress/index.js";
import { WordPressAPIError } from "@/types/client.js";

const SITE = "https://site.example.com";
const API = `${SITE}/wp-json/seopress/v1/`;

const ROBOTS_KEYS = [
  "_seopress_robots_index",
  "_seopress_robots_follow",
  "_seopress_robots_imageindex",
  "_seopress_robots_snippet",
  "_seopress_robots_canonical",
  "_seopress_robots_primary_cat",
  "_seopress_robots_freeze_modified_date",
];
const ROBOTS_CHECKBOXES = new Set(ROBOTS_KEYS.filter((key) => !/canonical|primary_cat/.test(key)));
const SOCIAL_KEYS = ["fb", "twitter"].flatMap((network) =>
  ["title", "desc", "img", "img_attachment_id", "img_width", "img_height"].map(
    (field) => `_seopress_social_${network}_${field}`,
  ),
);
const REDIRECT_KEYS = [
  "_seopress_redirections_enabled",
  "_seopress_redirections_logged_status",
  "_seopress_redirections_type",
  "_seopress_redirections_value",
];

/**
 * In-memory stand-in for SEOPress's REST routes, modelled on SEOPress 10.3:
 * per-post field routes answer lists of { key, value, can_modify }, PUT answers
 * "success" whatever it stores, and options POST replaces the whole option.
 */
function fakeSEOPress() {
  const meta = new Map([[42, {}]]);
  const options = {
    titles: {
      seopress_titles_sep: "-",
      seopress_titles_single_titles: { page: { title: "%%post_title%%", noindex: "1" } },
    },
  };
  const state = {
    meta,
    options,
    locked: new Set(),
    published: true,
    // Keys SEOPress drops when saving, to simulate a sanitizer or a plugin interfering.
    dropOnSave: new Set(),
    listItems: { pages: [], posts: [] },
  };
  const metaOf = (id) => {
    if (!meta.has(id)) throw new WordPressAPIError("Sorry, you are not allowed to do that.", 403);
    return meta.get(id);
  };
  const entries = (id, keys, checkboxes = new Set(), booleanCheckboxes = false) =>
    keys.map((key) => {
      const value = metaOf(id)[key] ?? "";
      return {
        key,
        can_modify: !state.locked.has(key),
        value: checkboxes.has(key) ? (booleanCheckboxes ? value === "yes" : value === "yes" ? "yes" : "") : value,
      };
    });
  const save = (id, body, keys) => {
    for (const [key, value] of Object.entries(body)) {
      if (!keys.includes(key) || state.dropOnSave.has(key)) continue;
      const clean = String(value).replace(/\s+/g, " ").trim();
      if (clean) metaOf(id)[key] = clean;
      else delete metaOf(id)[key];
    }
    return { code: "success" };
  };

  const get = (path) => {
    let match;
    if ((match = path.match(/^posts\/(\d+)\/title-description-metas$/))) {
      const m = metaOf(Number(match[1]));
      return { title: m._seopress_titles_title ?? "", description: m._seopress_titles_desc ?? "" };
    }
    if ((match = path.match(/^posts\/(\d+)\/meta-robot-settings$/)))
      return entries(Number(match[1]), ROBOTS_KEYS, ROBOTS_CHECKBOXES);
    if ((match = path.match(/^posts\/(\d+)\/social-settings$/))) return entries(Number(match[1]), SOCIAL_KEYS);
    if ((match = path.match(/^posts\/(\d+)\/redirection-settings$/)))
      return entries(Number(match[1]), REDIRECT_KEYS, new Set(["_seopress_redirections_enabled"]), true);
    if ((match = path.match(/^posts\/(\d+)\/redirection-test$/)))
      return {
        source_url: `${SITE}/item-${match[1]}/`,
        destination_url: metaOf(Number(match[1]))._seopress_redirections_value,
        status_code: 200,
      };
    if ((match = path.match(/^posts\/(\d+)\/target-keywords$/))) {
      const stored = metaOf(Number(match[1]))._seopress_analysis_target_kw ?? "";
      return stored
        .split(",")
        .filter(Boolean)
        .map((key) => ({ key, rows: [] }));
    }
    if ((match = path.match(/^posts\/(\d+)$/))) {
      const m = metaOf(Number(match[1]));
      return {
        success: true,
        data: state.published
          ? { title: m._seopress_titles_title || "Rendered Title", description: "", canonical: "" }
          : null,
      };
    }
    if ((match = path.match(/^options\/([a-z]+)-settings$/))) {
      if (!(match[1] in options)) throw new WordPressAPIError("No route was found", 404);
      return JSON.parse(JSON.stringify(options[match[1]]));
    }
    throw new WordPressAPIError("No route was found matching the URL and request method.", 404);
  };

  const client = {
    getSiteUrl: () => SITE,
    requestWithMetadata: vi.fn(async (method, url) => {
      if (url.startsWith(API)) return { data: get(url.slice(API.length)), status: 200, headers: {} };
      // Relative /wp/v2 listing: "<base>?status=...&page=N..."
      const [base, query] = url.split("?");
      const page = Number(new URLSearchParams(query).get("page"));
      const items = state.listItems[base] ?? [];
      return {
        data: items.slice((page - 1) * 100, page * 100),
        status: 200,
        headers: { "x-wp-totalpages": String(Math.max(1, Math.ceil(items.length / 100))) },
      };
    }),
    put: vi.fn(async (url, body) => {
      const path = url.slice(API.length);
      const id = Number(path.split("/")[1]);
      if (path.endsWith("title-description-metas")) {
        const mapped = {};
        if ("title" in body) mapped._seopress_titles_title = body.title;
        if ("description" in body) mapped._seopress_titles_desc = body.description;
        return save(id, mapped, ["_seopress_titles_title", "_seopress_titles_desc"]);
      }
      if (path.endsWith("meta-robot-settings")) return save(id, body, ROBOTS_KEYS);
      if (path.endsWith("social-settings")) return save(id, body, SOCIAL_KEYS);
      if (path.endsWith("redirection-settings")) return save(id, body, REDIRECT_KEYS);
      if (path.endsWith("target-keywords")) return save(id, body, ["_seopress_analysis_target_kw"]);
      throw new WordPressAPIError("No route was found", 404);
    }),
    post: vi.fn(async (url, body) => {
      const path = url.slice(API.length);
      if (path === "diagnostics/sitemap-test") return { status: "ok", checks: [] };
      const section = path.match(/^options\/([a-z]+)-settings$/)[1];
      const kept = JSON.parse(JSON.stringify(body));
      for (const key of state.dropOnSave) delete kept[key];
      options[section] = kept;
      return { success: true, data: kept };
    }),
    get: vi.fn(async () => ({
      post: { rest_base: "posts", rest_namespace: "wp/v2", viewable: true },
      page: { rest_base: "pages", rest_namespace: "wp/v2", viewable: true },
      attachment: { rest_base: "media", rest_namespace: "wp/v2", viewable: true },
      wp_block: { rest_base: "blocks", rest_namespace: "wp/v2", viewable: false },
    })),
    getMediaItem: vi.fn(async (id) =>
      id === 7
        ? { source_url: `${SITE}/og.jpg`, mime_type: "image/jpeg", media_details: { width: 1200, height: 630 } }
        : { source_url: `${SITE}/doc.pdf`, mime_type: "application/pdf", media_details: {} },
    ),
  };
  return { client, state };
}

describe("SEOPressTools", () => {
  let tools;
  let client;
  let state;
  const run = (name, params) =>
    tools
      .getTools()
      .find((tool) => tool.name === name)
      .handler(client, params);

  beforeEach(() => {
    ({ client, state } = fakeSEOPress());
    tools = new SEOPressTools();
  });

  it("exposes ten tools with handlers", () => {
    const list = tools.getTools();
    expect(list.map((tool) => tool.name)).toEqual([
      "wp_seopress_get_post_seo",
      "wp_seopress_update_title_description",
      "wp_seopress_update_robots",
      "wp_seopress_update_social",
      "wp_seopress_update_target_keywords",
      "wp_seopress_update_redirect",
      "wp_seopress_list_issues",
      "wp_seopress_get_settings",
      "wp_seopress_update_settings",
      "wp_seopress_test_sitemap",
    ]);
    list.forEach((tool) => expect(typeof tool.handler).toBe("function"));
  });

  describe("wp_seopress_get_post_seo", () => {
    it("reports every field, global overrides, and the rendered output", async () => {
      Object.assign(state.meta.get(42), {
        _seopress_titles_title: "Stored Title",
        _seopress_robots_canonical: "https://site.example.com/canonical/",
        _seopress_analysis_target_kw: "tuba,breast augmentation",
      });
      state.locked.add("_seopress_robots_index");

      const result = await run("wp_seopress_get_post_seo", { id: 42 });

      expect(result).toContain('**Title:** "Stored Title"');
      expect(result).toContain("**noindex:** no (set by SEOPress global settings");
      expect(result).toContain('**canonical:** "https://site.example.com/canonical/"');
      expect(result).toContain("tuba, breast augmentation");
      expect(result).toContain("**Output**");
    });

    it("explains a missing SEOPress route", async () => {
      client.requestWithMetadata.mockRejectedValueOnce(new WordPressAPIError("No route was found", 404));
      await expect(run("wp_seopress_get_post_seo", { id: 42 })).rejects.toThrow("SEOPress REST route was not found");
    });

    it("explains a permission denial", async () => {
      await expect(run("wp_seopress_get_post_seo", { id: 99 })).rejects.toThrow("not permitted");
    });
  });

  describe("wp_seopress_update_title_description", () => {
    it("saves only the given field, verifies it, and reports the output", async () => {
      state.meta.get(42)._seopress_titles_desc = "Keep me";

      const result = await run("wp_seopress_update_title_description", { id: 42, title: "  New   Title " });

      expect(client.put).toHaveBeenCalledWith(`${API}posts/42/title-description-metas`, { title: "  New   Title " });
      expect(state.meta.get(42)._seopress_titles_desc).toBe("Keep me");
      expect(result).toContain('"  New   Title " (was (empty))');
      expect(result).toContain('**Output:** title "New Title"');
    });

    it("fails and reports the previous value when SEOPress stores something else", async () => {
      state.meta.get(42)._seopress_titles_title = "Old";
      state.dropOnSave.add("_seopress_titles_title");

      await expect(run("wp_seopress_update_title_description", { id: 42, title: "New" })).rejects.toThrow(
        '- title: sent "New", stored "Old", previously "Old"',
      );
    });

    it("requires a field", async () => {
      await expect(run("wp_seopress_update_title_description", { id: 42 })).rejects.toThrow("Provide a title");
    });
  });

  describe("wp_seopress_update_robots", () => {
    it("maps booleans to SEOPress values and verifies them", async () => {
      const result = await run("wp_seopress_update_robots", {
        id: 42,
        noindex: true,
        canonical: "https://site.example.com/a/",
        primary_category: 12,
      });

      expect(client.put).toHaveBeenCalledWith(`${API}posts/42/meta-robot-settings`, {
        _seopress_robots_index: "yes",
        _seopress_robots_canonical: "https://site.example.com/a/",
        _seopress_robots_primary_cat: "12",
      });
      expect(result).toContain('**noindex:** "yes" (was (empty))');
    });

    it("clears values", async () => {
      Object.assign(state.meta.get(42), { _seopress_robots_index: "yes", _seopress_robots_primary_cat: "12" });

      await run("wp_seopress_update_robots", { id: 42, noindex: false, primary_category: 0 });

      expect(state.meta.get(42)).toEqual({});
    });

    it("refuses a field set by global settings without saving", async () => {
      state.locked.add("_seopress_robots_index");

      await expect(run("wp_seopress_update_robots", { id: 42, noindex: true })).rejects.toThrow(
        "noindex is set by SEOPress global settings",
      );
      expect(client.put).not.toHaveBeenCalled();
    });
  });

  describe("wp_seopress_update_social", () => {
    it("resolves an image ID into URL, ID, and size", async () => {
      const result = await run("wp_seopress_update_social", { id: 42, facebook_title: "OG", facebook_image_id: 7 });

      expect(client.put).toHaveBeenCalledWith(`${API}posts/42/social-settings`, {
        _seopress_social_fb_title: "OG",
        _seopress_social_fb_img: `${SITE}/og.jpg`,
        _seopress_social_fb_img_attachment_id: "7",
        _seopress_social_fb_img_width: "1200",
        _seopress_social_fb_img_height: "630",
      });
      expect(result).toContain('**facebook_image_id:** "7"');
    });

    it("rejects media that is not an image", async () => {
      await expect(run("wp_seopress_update_social", { id: 42, x_image_id: 8 })).rejects.toThrow("is not an image");
      expect(client.put).not.toHaveBeenCalled();
    });
  });

  describe("wp_seopress_update_target_keywords", () => {
    it("stores the list and verifies it", async () => {
      const result = await run("wp_seopress_update_target_keywords", { id: 42, keywords: [" tuba ", "breast lift"] });

      expect(state.meta.get(42)._seopress_analysis_target_kw).toBe("tuba,breast lift");
      expect(result).toContain("tuba, breast lift (was (none))");
    });

    it("rejects keywords containing commas", async () => {
      await expect(run("wp_seopress_update_target_keywords", { id: 42, keywords: ["a, b"] })).rejects.toThrow(
        "cannot contain commas",
      );
    });
  });

  describe("wp_seopress_update_redirect", () => {
    it("refuses to enable a redirect without a destination", async () => {
      await expect(run("wp_seopress_update_redirect", { id: 42, enabled: true })).rejects.toThrow(
        "without a destination url",
      );
      expect(client.put).not.toHaveBeenCalled();
    });

    it("saves, verifies, and tests an enabled redirect", async () => {
      const result = await run("wp_seopress_update_redirect", {
        id: 42,
        enabled: true,
        url: "/breast/new/",
        type: "301",
      });

      expect(result).toContain("verified");
      expect(result).toContain("**Redirect test:**");
      expect(result).toContain("HTTP 200");
    });
  });

  describe("wp_seopress_list_issues", () => {
    it("uses REST meta when present and falls back to the SEOPress route otherwise", async () => {
      state.meta.set(1, { _seopress_titles_title: "Has title" });
      state.listItems.pages = [
        {
          id: 1,
          title: { raw: "With meta" },
          link: `${SITE}/one/`,
          meta: { _seopress_titles_title: "", _seopress_titles_desc: "" },
        },
        {
          id: 2,
          title: { raw: "Titled" },
          link: `${SITE}/two/`,
          meta: { _seopress_titles_title: "T", _seopress_titles_desc: "" },
        },
      ];
      state.listItems.posts = [{ id: 1, title: { raw: "No REST meta" }, link: `${SITE}/three/` }];

      const result = await run("wp_seopress_list_issues", { issue: "missing_title" });

      expect(result).toContain('[pages] 1 "With meta"');
      expect(result).not.toContain("Titled");
      expect(result).not.toContain("No REST meta");
      expect(result).toContain("(posts, pages)");
    });

    it("pages through results and stops at max_items", async () => {
      state.listItems.posts = Array.from({ length: 150 }, (_, index) => ({
        id: index + 1,
        title: { raw: `Post ${index + 1}` },
        meta: { _seopress_robots_index: "yes" },
      }));

      const result = await run("wp_seopress_list_issues", { issue: "noindex", post_types: ["posts"], max_items: 120 });

      expect(result).toContain("120+ of");
      expect(result).toContain("Post 120");
      expect(result).not.toContain("Post 121");
    });
  });

  describe("settings", () => {
    it("refuses credential-holding sections", async () => {
      await expect(run("wp_seopress_get_settings", { section: "indexing" })).rejects.toThrow("restricted");
      await expect(run("wp_seopress_update_settings", { section: "license", changes: { a: 1 } })).rejects.toThrow(
        "cannot be written",
      );
    });

    it("merges changes into the whole option, keeps other keys, and removes null keys", async () => {
      const result = await run("wp_seopress_update_settings", {
        section: "titles",
        changes: { seopress_titles_sep: "|", seopress_titles_single_titles: { page: { noindex: null } } },
      });

      expect(state.options.titles).toEqual({
        seopress_titles_sep: "|",
        seopress_titles_single_titles: { page: { title: "%%post_title%%" } },
      });
      expect(result).toContain('**seopress_titles_sep:** "|" (was "-")');
      expect(result).toContain('**seopress_titles_single_titles.page.noindex:** (empty) (was "1")');
    });

    it("fails when SEOPress drops a setting", async () => {
      state.dropOnSave.add("seopress_titles_sep");

      await expect(
        run("wp_seopress_update_settings", { section: "titles", changes: { seopress_titles_sep: "|" } }),
      ).rejects.toThrow('- seopress_titles_sep: sent "|", stored (empty), previously "-"');
    });

    it("requires confirmation for the advanced section", async () => {
      await expect(run("wp_seopress_update_settings", { section: "advanced", changes: { a: "1" } })).rejects.toThrow(
        "confirm_advanced",
      );
      expect(client.post).not.toHaveBeenCalled();
    });
  });

  it("runs the sitemap diagnostic", async () => {
    const result = await run("wp_seopress_test_sitemap", {});
    expect(client.post).toHaveBeenCalledWith(`${API}diagnostics/sitemap-test`);
    expect(result).toContain('"status": "ok"');
  });
});
