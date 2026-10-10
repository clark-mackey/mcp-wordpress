import { vi } from "vitest";
import { RedirectionTools } from "@/tools/redirection/index.js";
import { WordPressAPIError } from "@/types/client.js";

const SITE = "https://site.example.com";
const API = `${SITE}/wp-json/redirection/v1/`;

const redirect = (fields) => ({
  match_type: "url",
  action_type: "url",
  action_code: 301,
  action_data: { url: "/" },
  match_data: { source: { flag_query: "exact", flag_case: true, flag_trailing: true, flag_regex: false } },
  title: null,
  hits: 0,
  regex: false,
  group_id: 1,
  position: 0,
  last_access: "-",
  enabled: true,
  ...fields,
});

/**
 * In-memory stand-in for Redirection 5.10's REST routes: create and update rebuild the
 * redirect from the request (source percent-decoded, title emptied to null), create answers
 * with the first list page, and lists filter with filterBy[...] in the query string.
 */
function fakeRedirection() {
  const state = {
    items: [
      redirect({ id: 3, url: "/old-about/", action_data: { url: "/about/" }, hits: 4 }),
      redirect({ id: 5, url: "/promo", action_code: 302, action_data: { url: "/sale/" }, enabled: false }),
      redirect({ id: 8, url: "/geo", match_type: "server", action_data: { server: "x", url_from: "/y" } }),
    ],
    groups: [
      { id: 1, name: "Redirections", redirects: 3, module_id: 1, moduleName: "WordPress", enabled: true },
      { id: 2, name: "Modified Posts", redirects: 0, module_id: 1, moduleName: "WordPress", enabled: true },
      { id: 4, name: "Apache rules", redirects: 0, module_id: 2, moduleName: "Apache", enabled: true },
    ],
    nextId: 20,
    // Rewrites a saved redirect, to simulate a sanitizer or a plugin interfering.
    alterOnSave: (item) => item,
    cacheHeaders: {},
  };

  const save = (body, existing = {}) =>
    state.alterOnSave({
      ...existing,
      url: decodeURIComponent(body.url),
      match_type: body.match_type,
      action_type: body.action_type,
      action_code: body.action_code,
      action_data: body.action_data,
      group_id: body.group_id,
      title: body.title ? body.title : null,
      regex: body.regex === 1,
      position: body.position ?? 0,
      match_data: body.match_data ?? existing.match_data ?? null,
    });

  const list = (search) => {
    const filters = {};
    for (const [key, value] of search) {
      const match = key.match(/^filterBy\[(\w+)\]$/);
      if (match) filters[match[1]] = value;
    }
    let items = [...state.items].sort((a, b) => b.id - a.id);
    if (filters.id) items = items.filter((item) => item.id === Number(filters.id));
    // MySQL LIKE with the default collation ignores case.
    if (filters.url) items = items.filter((item) => item.url.toLowerCase().includes(filters.url.toLowerCase()));
    if (filters.target) items = items.filter((item) => (item.action_data?.url ?? "").includes(filters.target));
    if (filters.status) items = items.filter((item) => item.enabled === (filters.status === "enabled"));
    if (filters.group) items = items.filter((item) => item.group_id === Number(filters.group));
    const perPage = Number(search.get("per_page") ?? 25);
    const page = Number(search.get("page") ?? 0);
    return { items: items.slice(page * perPage, (page + 1) * perPage), total: items.length };
  };

  const client = {
    getSiteUrl: () => SITE,
    requestWithMetadata: vi.fn(async (method, url) => {
      const { pathname, searchParams } = new globalThis.URL(url);
      const path = pathname.replace("/wp-json/redirection/v1/", "");
      const headers = { ...state.cacheHeaders };
      if (path === "redirect") return { data: list(searchParams), status: 200, headers };
      if (path === "group") return { data: { items: state.groups, total: state.groups.length }, status: 200, headers };
      throw new WordPressAPIError("No route was found matching the URL and request method.", 404);
    }),
    post: vi.fn(async (url, body) => {
      const path = url.replace(API, "");
      let match;
      if (path === "redirect") {
        state.items.push(save(body, { id: state.nextId++, hits: 0, last_access: "-", enabled: true }));
        return list(new URLSearchParams());
      }
      if ((match = path.match(/^redirect\/(\d+)$/))) {
        const index = state.items.findIndex((item) => item.id === Number(match[1]));
        state.items[index] = save(body, state.items[index]);
        return { item: state.items[index] };
      }
      if ((match = path.match(/^bulk\/redirect\/(enable|disable)$/))) {
        for (const id of body.items) state.items.find((item) => item.id === id).enabled = match[1] === "enable";
        return list(new URLSearchParams());
      }
      throw new WordPressAPIError("No route was found matching the URL and request method.", 404);
    }),
  };
  return { client, state };
}

describe("RedirectionTools", () => {
  let client;
  let state;
  const run = (name, params) =>
    new RedirectionTools()
      .getTools()
      .find((tool) => tool.name === name)
      .handler(client, params);

  beforeEach(() => {
    ({ client, state } = fakeRedirection());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exposes six tools with handlers", () => {
    const list = new RedirectionTools().getTools();
    expect(list.map((tool) => tool.name)).toEqual([
      "wp_redirection_list_redirects",
      "wp_redirection_list_groups",
      "wp_redirection_create_redirect",
      "wp_redirection_update_redirect",
      "wp_redirection_set_enabled",
      "wp_redirection_check_redirect",
    ]);
    list.forEach((tool) => expect(typeof tool.handler).toBe("function"));
  });

  describe("wp_redirection_list_redirects", () => {
    it("sends filters in the query string, bypassing caches", async () => {
      const result = await run("wp_redirection_list_redirects", { source: "old", status: "enabled", per_page: 10 });

      expect(client.requestWithMetadata).toHaveBeenCalledWith(
        "GET",
        `${API}redirect?page=0&per_page=10&filterBy%5Burl%5D=old&filterBy%5Bstatus%5D=enabled`,
        null,
        { headers: { "Cache-Control": "no-cache", Pragma: "no-cache" } },
      );
      expect(result).toContain("Redirects 1–1 of 1");
      expect(result).toContain("#3 /old-about/ 301 → /about/ — enabled, group 1, 4 hits");
    });

    it("marks redirects that are not plain URL redirects", async () => {
      const result = await run("wp_redirection_list_redirects", {});
      expect(result).toContain("#8 /geo 301 [match: server, action: url]");
      expect(result).toContain("#5 /promo 302 → /sale/ — disabled");
    });

    it("sends whole page numbers", async () => {
      await run("wp_redirection_list_redirects", { page: 1.5, per_page: 7.5 });
      expect(client.requestWithMetadata.mock.calls[0][1]).toBe(`${API}redirect?page=0&per_page=7`);
    });

    it("refuses a page-cached response", async () => {
      state.cacheHeaders = { "x-litespeed-cache": "hit" };
      await expect(run("wp_redirection_list_redirects", {})).rejects.toThrow(/page cache answered/);
    });

    it("explains a missing plugin and a blocked route", async () => {
      client.requestWithMetadata.mockRejectedValueOnce(new WordPressAPIError("No route", 404));
      await expect(run("wp_redirection_list_redirects", {})).rejects.toThrow(/Is the Redirection plugin active/);
      client.requestWithMetadata.mockRejectedValueOnce(new WordPressAPIError("Forbidden", 403));
      await expect(run("wp_redirection_list_redirects", {})).rejects.toThrow(/redirection_role/);
    });
  });

  it("wp_redirection_list_groups lists groups with their modules", async () => {
    const result = await run("wp_redirection_list_groups", {});
    expect(result).toContain("#1 Redirections — WordPress, enabled, 3 redirects");
    expect(result).toContain("#4 Apache rules — Apache");
  });

  describe("wp_redirection_create_redirect", () => {
    it("creates a URL redirect in the default group and verifies it", async () => {
      const result = await run("wp_redirection_create_redirect", {
        source: "/tuba-faq/",
        target: "/breast-augmentation/tuba/",
        title: "Issue 20",
      });

      expect(client.post).toHaveBeenCalledWith(`${API}redirect`, {
        url: "/tuba-faq/",
        match_type: "url",
        action_type: "url",
        action_code: 301,
        action_data: { url: "/breast-augmentation/tuba/" },
        group_id: 1,
        title: "Issue 20",
        regex: 0,
      });
      expect(result).toContain("Redirect 20 created and verified: #20 /tuba-faq/ 301 → /breast-augmentation/tuba/");
      expect(result).toContain("Group: Redirections");
      expect(state.items.find((item) => item.id === 20).enabled).toBe(true);
    });

    it("accepts a source Redirection stores percent-decoded", async () => {
      await expect(
        run("wp_redirection_create_redirect", { source: "/caf%C3%A9/", target: "/cafe/" }),
      ).resolves.toContain("created and verified");
    });

    it("treats percent-encoded and decoded sources as the same redirect", async () => {
      state.items.push(redirect({ id: 11, url: "/café/", action_data: { url: "/menu/" } }));
      await expect(run("wp_redirection_create_redirect", { source: "/caf%C3%A9", target: "/y/" })).rejects.toThrow(
        /Redirect 11 already handles this source/,
      );
      await expect(run("wp_redirection_create_redirect", { source: "/menu/", target: "/caf%C3%A9/" })).rejects.toThrow(
        /Redirect 11 sends .* back to \/menu\//,
      );
      expect(client.post).not.toHaveBeenCalled();
    });

    it("refuses a regex source containing an absolute URL", async () => {
      await expect(
        run("wp_redirection_create_redirect", { source: "https://other.example/(.*)", target: "/y/", regex: true }),
      ).rejects.toThrow(/regex source must not contain an absolute URL/);
      expect(client.post).not.toHaveBeenCalled();
    });

    it("refuses a source another redirect handles, ignoring case and trailing slash", async () => {
      await expect(run("wp_redirection_create_redirect", { source: "/Old-About", target: "/team/" })).rejects.toThrow(
        /Redirect 3 already handles this source/,
      );
      await expect(run("wp_redirection_create_redirect", { source: "/promo/", target: "/team/" })).rejects.toThrow(
        /Redirect 5 already handles this source/,
      );
      expect(client.post).not.toHaveBeenCalled();
    });

    it("refuses a redirect to itself and a loop through another redirect", async () => {
      await expect(run("wp_redirection_create_redirect", { source: "/a/", target: `${SITE}/a` })).rejects.toThrow(
        /would loop/,
      );
      await expect(run("wp_redirection_create_redirect", { source: "/about/", target: "/old-about/" })).rejects.toThrow(
        /Redirect 3 sends \/old-about\/ back to \/about\//,
      );
      expect(client.post).not.toHaveBeenCalled();
    });

    it("warns when the target is itself redirected", async () => {
      const result = await run("wp_redirection_create_redirect", { source: "/older-about/", target: "/old-about/" });
      expect(result).toContain("The target is itself redirected (#3 /old-about/ 301 → /about/");
    });

    it("fails when Redirection stores something else, naming the new redirect", async () => {
      state.alterOnSave = (item) => ({ ...item, action_data: { url: "/" } });
      await expect(run("wp_redirection_create_redirect", { source: "/x/", target: "/y/" })).rejects.toThrow(
        /Redirect 20 was created but not stored as requested:\n- target: sent "\/y\/", stored "\/"/,
      );
    });

    it("validates source, target, code, and group before saving", async () => {
      await expect(
        run("wp_redirection_create_redirect", { source: "https://other.example/x", target: "/y/" }),
      ).rejects.toThrow(/source must be a path/);
      await expect(
        run("wp_redirection_create_redirect", { source: "/x", target: "javascript:alert(1)" }),
      ).rejects.toThrow(/target must be a path/);
      await expect(run("wp_redirection_create_redirect", { source: "/x", target: "/y", code: 303 })).rejects.toThrow(
        /code must be one of 301, 302, 307, 308/,
      );
      await expect(run("wp_redirection_create_redirect", { source: "/x", target: "/y", group_id: 9 })).rejects.toThrow(
        /group 9 does not exist/,
      );
      expect(client.post).not.toHaveBeenCalled();
    });

    it("notes when the group needs exported server rules", async () => {
      const result = await run("wp_redirection_create_redirect", { source: "/x/", target: "/y/", group_id: 4 });
      expect(result).toContain("Apache: takes effect only after its server rules are exported");
    });
  });

  describe("wp_redirection_update_redirect", () => {
    it("sends the whole redirect with the changes and reports the previous values", async () => {
      const result = await run("wp_redirection_update_redirect", { id: 3, target: "/team/", code: 308 });

      expect(client.post).toHaveBeenCalledWith(`${API}redirect/3`, {
        url: "/old-about/",
        match_type: "url",
        action_type: "url",
        action_code: 308,
        action_data: { url: "/team/" },
        group_id: 1,
        title: "",
        regex: 0,
        match_data: state.items[0].match_data,
        position: 0,
      });
      expect(result).toContain("Redirect 3 updated and verified: #3 /old-about/ 308 → /team/");
      expect(result).toContain("Previously: #3 /old-about/ 301 → /about/");
    });

    it("refuses redirects with other match conditions", async () => {
      await expect(run("wp_redirection_update_redirect", { id: 8, target: "/z/" })).rejects.toThrow(
        /not a plain URL redirect/,
      );
      expect(client.post).not.toHaveBeenCalled();
    });

    it("fails when the stored redirect differs", async () => {
      state.alterOnSave = (item) => ({ ...item, title: null });
      await expect(run("wp_redirection_update_redirect", { id: 3, title: "<b>x</b>" })).rejects.toThrow(
        /Redirect 3 was not stored as requested:\n- title: sent "<b>x<\/b>", stored ""\nPreviously: #3/,
      );
    });

    it("requires a change and an existing redirect", async () => {
      await expect(run("wp_redirection_update_redirect", { id: 3 })).rejects.toThrow(/Provide at least one/);
      await expect(run("wp_redirection_update_redirect", { id: 99, target: "/z/" })).rejects.toThrow(
        /Redirect 99 was not found/,
      );
    });
  });

  describe("wp_redirection_set_enabled", () => {
    it("enables and verifies", async () => {
      const result = await run("wp_redirection_set_enabled", { id: 5, enabled: true });
      expect(client.post).toHaveBeenCalledWith(`${API}bulk/redirect/enable`, { items: [5] });
      expect(result).toContain("Redirect 5 enabled and verified");
    });

    it("does nothing when already in that state", async () => {
      const result = await run("wp_redirection_set_enabled", { id: 5, enabled: false });
      expect(result).toContain("already disabled");
      expect(client.post).not.toHaveBeenCalled();
    });
  });

  describe("wp_redirection_check_redirect", () => {
    const stubFetch = (status, headers) => {
      const fetch = vi.fn(async () => new globalThis.Response(null, { status, headers }));
      vi.stubGlobal("fetch", fetch);
      return fetch;
    };

    it("requests the path anonymously without following redirects", async () => {
      const fetch = stubFetch(301, { location: "/about/", "x-redirect-by": "redirection" });
      const result = await run("wp_redirection_check_redirect", {
        path: "/old-about/",
        expected_code: 301,
        expected_target: "/about/",
      });

      const [url, options] = fetch.mock.calls[0];
      expect(String(url)).toBe(`${SITE}/old-about/`);
      expect(options.redirect).toBe("manual");
      expect(Object.keys(options.headers)).not.toContain("Authorization");
      expect(result).toContain("✅ Redirect check passed.");
      expect(result).toContain(`HTTP 301 to ${SITE}/about/`);
      expect(result).toContain("Redirected by: redirection");
    });

    it("fails when the live response differs, noting a cached page", async () => {
      stubFetch(200, { "x-litespeed-cache": "hit" });
      await expect(
        run("wp_redirection_check_redirect", { path: "/old-about/", expected_code: 301, expected_target: "/about/" }),
      ).rejects.toThrow(
        /expected HTTP 301, got 200; expected a redirect to .*\/about\/, got no redirect[\s\S]*page cache/,
      );
    });

    it("only requests paths on the site", async () => {
      const fetch = stubFetch(200, {});
      await expect(run("wp_redirection_check_redirect", { path: "//evil.example/x" })).rejects.toThrow(
        /path must start with/,
      );
      for (const path of ["/\\evil.example/x", "/\t/evil.example/x", "/\\169.254.169.254/latest/"]) {
        await expect(run("wp_redirection_check_redirect", { path })).rejects.toThrow(/path must stay on this site/);
      }
      expect(fetch).not.toHaveBeenCalled();
    });

    it("rejects a non-numeric expected_code and reports a malformed Location as sent", async () => {
      const fetch = stubFetch(301, { location: "http://[bad" });
      await expect(run("wp_redirection_check_redirect", { path: "/x", expected_code: "abc" })).rejects.toThrow(
        /expected_code must be an HTTP status/,
      );
      expect(fetch).not.toHaveBeenCalled();
      await expect(run("wp_redirection_check_redirect", { path: "/x" })).resolves.toContain("HTTP 301 to http://[bad");
    });
  });
});
