import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "http";
import { readdirSync, readFileSync, statSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  DENIED_TOOLS,
  denyRules,
  nodeVersionOk,
  normalizeSiteUrl,
  isPrivateHost,
  checkAccount,
  mergeDeny,
  fetchMe,
} from "../../bin/workshop.js";

const srcTools = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "tools");

function sourceText(dir) {
  return readdirSync(dir)
    .map((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? sourceText(path) : readFileSync(path, "utf8");
    })
    .join("\n");
}

describe("workshop setup helpers", () => {
  describe("DENIED_TOOLS", () => {
    it("names only tools that exist in src/tools, so a rename cannot silently unblock one", () => {
      const source = sourceText(srcTools);
      for (const tool of DENIED_TOOLS) expect(source, tool).toContain(`"${tool}"`);
    });

    it("blocks every delete tool", () => {
      const deleteTools = [...sourceText(srcTools).matchAll(/"(wp_delete_[a-z_]+)"/g)].map((m) => m[1]);
      for (const tool of new Set(deleteTools)) expect(DENIED_TOOLS, tool).toContain(tool);
    });

    it("builds rules for the chosen server name", () => {
      expect(denyRules("wp")[0]).toBe("mcp__wp__wp_delete_page");
      expect(denyRules("site2")).toHaveLength(DENIED_TOOLS.length);
    });
  });

  describe("nodeVersionOk", () => {
    it.each([
      ["v22.14.0", true],
      ["v22.15.1", true],
      ["v26.0.0", true],
      ["v22.13.9", false],
      ["v20.18.0", false],
    ])("%s -> %s", (version, expected) => {
      expect(nodeVersionOk(version)).toBe(expected);
    });
  });

  describe("normalizeSiteUrl", () => {
    it("adds https and strips trailing slashes", () => {
      expect(normalizeSiteUrl("example.com/").url).toBe("https://example.com");
    });

    it("strips a pasted wp-admin or wp-json path but keeps a subdirectory install", () => {
      expect(normalizeSiteUrl("https://example.com/wp-admin/profile.php").url).toBe("https://example.com");
      expect(normalizeSiteUrl("https://example.com/blog/wp-json/wp/v2").url).toBe("https://example.com/blog");
    });

    it("warns on plain http for a real host but not for localhost", () => {
      expect(normalizeSiteUrl("http://example.com").warning).toMatch(/HTTPS/);
      expect(normalizeSiteUrl("http://localhost:8080").warning).toBeNull();
    });

    it.each([
      ["localhost", true],
      ["127.0.0.1", true],
      ["mysite.local", true],
      ["10.1.2.3", true],
      ["192.168.1.5", true],
      ["172.20.0.1", true],
      ["172.32.0.1", false],
      ["example.com", false],
    ])("isPrivateHost(%s) -> %s", (host, expected) => {
      expect(isPrivateHost(host)).toBe(expected);
    });

    it("rejects an empty value", () => {
      expect(() => normalizeSiteUrl("  ")).toThrow();
    });
  });

  describe("checkAccount", () => {
    it("accepts an editor", () => {
      expect(checkAccount({ roles: ["editor"] }).level).toBe("ok");
    });

    it("blocks an administrator unless explicitly allowed", () => {
      expect(checkAccount({ roles: ["administrator"] }).level).toBe("block");
      expect(checkAccount({ roles: ["administrator"] }, { allowAdmin: true }).level).toBe("ok");
    });

    it("warns when the role cannot edit pages or is unknown", () => {
      expect(checkAccount({ roles: ["subscriber"] }).level).toBe("warn");
      expect(checkAccount({}).level).toBe("warn");
    });
  });

  describe("mergeDeny", () => {
    const rules = ["a", "b", "c"];

    it("creates permissions.deny when the file is empty", () => {
      const { settings, added } = mergeDeny({}, rules);
      expect(settings.permissions.deny).toEqual(rules);
      expect(added).toBe(3);
    });

    it("keeps everything already in the file and does not duplicate", () => {
      const existing = { model: "x", permissions: { allow: ["Bash(ls)"], deny: ["z", "b"] }, hooks: { a: 1 } };
      const { settings, added, alreadyPresent } = mergeDeny(existing, rules);
      expect(settings.permissions.deny).toEqual(["z", "b", "a", "c"]);
      expect(settings.permissions.allow).toEqual(["Bash(ls)"]);
      expect(settings.model).toBe("x");
      expect(settings.hooks).toEqual({ a: 1 });
      expect([added, alreadyPresent]).toEqual([2, 1]);
    });

    it("does not mutate its input and is idempotent", () => {
      const existing = { permissions: { deny: ["z"] } };
      const once = mergeDeny(existing, rules).settings;
      expect(existing.permissions.deny).toEqual(["z"]);
      expect(mergeDeny(once, rules).added).toBe(0);
    });

    it.each([[null], [[]], [{ permissions: [] }], [{ permissions: { deny: "x" } }]])(
      "refuses an unexpected shape %j instead of overwriting it",
      (bad) => {
        expect(() => mergeDeny(bad, rules)).toThrow();
      },
    );
  });

  describe("fetchMe", () => {
    let server;
    afterEach(() => server?.close());

    async function start(handler) {
      server = createServer(handler);
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${server.address().port}`;
    }

    it("sends the app password as basic auth and returns the account", async () => {
      let seen;
      const url = await start((req, res) => {
        seen = { path: req.url, auth: req.headers.authorization };
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ name: "AI Editor", roles: ["editor"] }));
      });
      const result = await fetchMe(url, "ai-editor", "abcd efgh");
      expect(result.ok).toBe(true);
      expect(result.me.roles).toEqual(["editor"]);
      expect(seen.path).toBe("/wp-json/wp/v2/users/me?context=edit");
      expect(seen.auth).toBe(`Basic ${Buffer.from("ai-editor:abcd efgh").toString("base64")}`);
    });

    it.each([
      [401, /rejected the login/],
      [404, /Permalinks/],
      [500, /HTTP 500/],
    ])("explains HTTP %i", async (status, message) => {
      const url = await start((req, res) => {
        res.statusCode = status;
        res.end("{}");
      });
      const result = await fetchMe(url, "u", "p");
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(message);
    });

    it("explains a redirect instead of following it (fetch drops the password on redirect)", async () => {
      const url = await start((req, res) => {
        res.statusCode = 301;
        res.setHeader("Location", "https://www.example.com/wp-json/wp/v2/users/me");
        res.end();
      });
      const result = await fetchMe(url, "u", "p");
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/redirected/);
    });

    it("explains a non-WordPress answer and an unreachable host", async () => {
      const url = await start((req, res) => res.end("<html>hello</html>"));
      expect((await fetchMe(url, "u", "p")).message).toMatch(/not with WordPress JSON/);
      expect((await fetchMe("http://127.0.0.1:1", "u", "p")).message).toMatch(/Could not reach/);
    });
  });
});
