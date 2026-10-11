import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parse as parseDotenv } from "dotenv";
import {
  DENIED_TOOLS,
  SetupError,
  cleanEnv,
  overrideNames,
  parseArgs,
  run,
  writeFileAtomic,
} from "../../bin/workshop.js";

const PASSWORD = "abcd efgh ijkl mnop qrst uvwx";
const EDITOR = { id: 7, name: "AI Editor", roles: ["editor"] };

describe("workshop run() flow", () => {
  let root;
  let home;
  let calls;
  let logs;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "workshop-root-"));
    home = mkdtempSync(join(tmpdir(), "workshop-home-"));
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "index.js"), "");
    mkdirSync(join(home, ".claude"));
    calls = [];
    logs = [];
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const settingsPath = () => join(home, ".claude", "settings.json");
  const readSettingsFile = () => JSON.parse(readFileSync(settingsPath(), "utf8"));
  const mode = (path) => statSync(path).mode & 0o777;

  /** Builds the injected pieces. `answers` feed the prompts in order. */
  function harness({
    answers = ["https://example.com", "", PASSWORD],
    me = EDITOR,
    addFails = false,
    probeResult,
    env = {},
  } = {}) {
    const queue = [...answers];
    const prompter = {
      ask: async () => {
        if (!queue.length) throw new Error("test ran out of answers");
        return queue.shift();
      },
      askHidden: async () => queue.shift(),
      close: () => {},
    };
    const execFile = (cmd, args) => {
      const record = { cmd, args: [...args] };
      if (args[0] === "mcp" && args[1] === "add") {
        // Capture what was already on disk at the moment the server got registered.
        record.settingsAtAdd = existsSync(settingsPath()) ? readFileSync(settingsPath(), "utf8") : null;
        record.envAtAdd = existsSync(join(root, ".env"));
        if (addFails) throw Object.assign(new Error("boom"), { stderr: "claude exploded" });
      }
      calls.push(record);
      return args[0] === "--version" ? "9.9.9 (test)\n" : "";
    };
    return {
      rootDir: root,
      homeDir: home,
      env,
      prompter,
      execFile,
      log: (line) => logs.push(line),
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        headers: { get: () => null },
        json: async () => me,
      }),
      probe: async (options) => {
        calls.push({ probe: options });
        return (
          probeResult ?? {
            tools: [...DENIED_TOOLS, "wp_restore_revision"],
            callError: false,
            callText: JSON.stringify({ content: `Display Name: ${me.name}` }),
          }
        );
      },
    };
  }

  const added = () => calls.find((c) => c.args?.[1] === "add");
  const removed = () => calls.find((c) => c.args?.[1] === "remove");

  it("saves the login, blocks the tools, registers the server, and verifies it, in that order", async () => {
    await run([], harness());

    const env = parseDotenv(readFileSync(join(root, ".env"), "utf8"));
    expect(env).toMatchObject({
      WORDPRESS_SITE_URL: "https://example.com",
      WORDPRESS_USERNAME: "ai-editor",
      WORDPRESS_APP_PASSWORD: PASSWORD,
      WORDPRESS_AUTH_METHOD: "app-password",
    });
    expect(mode(join(root, ".env"))).toBe(0o600);

    expect(readSettingsFile().permissions.deny).toHaveLength(DENIED_TOOLS.length);
    expect(readSettingsFile().permissions.deny[0]).toBe("mcp__wp__wp_delete_page");

    // The deny list must already be on disk when the server is registered.
    expect(JSON.parse(added().settingsAtAdd).permissions.deny).toHaveLength(DENIED_TOOLS.length);
    expect(added().envAtAdd).toBe(true);
    expect(added().args).toEqual([
      "mcp",
      "add",
      "wp",
      "--scope",
      "user",
      "--",
      process.execPath,
      join(root, "bin", "mcp-wordpress.js"),
    ]);
  });

  it("never prints the password", async () => {
    await run([], harness());
    expect(logs.join("\n")).not.toContain(PASSWORD);
  });

  it("stops on an invalid settings.json before writing .env or registering anything", async () => {
    writeFileSync(settingsPath(), "{ not json");

    await expect(run([], harness())).rejects.toThrow(SetupError);

    expect(existsSync(join(root, ".env"))).toBe(false);
    expect(added()).toBeUndefined();
    expect(readFileSync(settingsPath(), "utf8")).toBe("{ not json");
  });

  it("refuses an Administrator and writes nothing", async () => {
    await expect(run([], harness({ me: { ...EDITOR, roles: ["administrator"] } }))).rejects.toThrow(/Administrator/);

    expect(existsSync(join(root, ".env"))).toBe(false);
    expect(existsSync(settingsPath())).toBe(false);
    expect(added()).toBeUndefined();
  });

  it("keeps other settings and an owner-only mode, follows a symlink, and backs the old file up owner-only", async () => {
    const dotfiles = mkdtempSync(join(tmpdir(), "workshop-dotfiles-"));
    const target = join(dotfiles, "settings.json");
    writeFileSync(target, JSON.stringify({ model: "keep-me", env: { SECRET: "x" } }));
    chmodSync(target, 0o600);
    symlinkSync(target, settingsPath());

    await run([], harness());

    expect(lstatSync(settingsPath()).isSymbolicLink()).toBe(true);
    expect(mode(target)).toBe(0o600);
    const written = JSON.parse(readFileSync(target, "utf8"));
    expect(written.model).toBe("keep-me");
    expect(written.env).toEqual({ SECRET: "x" });
    expect(written.permissions.deny).toHaveLength(DENIED_TOOLS.length);

    const backups = readdirSync(dotfiles).filter((f) => f.includes(".bak-"));
    expect(backups).toHaveLength(1);
    expect(mode(join(dotfiles, backups[0]))).toBe(0o600);
    expect(readdirSync(dotfiles).some((f) => f.includes(".tmp-"))).toBe(false);
    rmSync(dotfiles, { recursive: true, force: true });
  });

  it("keeps unrelated .env keys, backs up the old file, and asks first", async () => {
    writeFileSync(join(root, ".env"), "DEBUG='true'\nWORDPRESS_SITE_URL='https://old.example'\n", { mode: 0o600 });

    await run([], harness({ answers: ["https://example.com", "", PASSWORD, "y"] }));

    const env = parseDotenv(readFileSync(join(root, ".env"), "utf8"));
    expect(env.DEBUG).toBe("true");
    expect(env.WORDPRESS_SITE_URL).toBe("https://example.com");
    const backups = readdirSync(root).filter((f) => f.startsWith(".env.bak-"));
    expect(backups).toHaveLength(1);
    expect(mode(join(root, backups[0]))).toBe(0o600);
  });

  it("leaves an existing .env alone when the user says no", async () => {
    writeFileSync(join(root, ".env"), "DEBUG='true'\n", { mode: 0o600 });

    await expect(run([], harness({ answers: ["https://example.com", "", PASSWORD, "n"] }))).rejects.toThrow(
      /unchanged/,
    );

    expect(readFileSync(join(root, ".env"), "utf8")).toBe("DEBUG='true'\n");
    expect(added()).toBeUndefined();
  });

  describe("an existing registration with the same name", () => {
    const claudeJson = (entry) =>
      writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { wp: entry } }));

    it("refuses to overwrite a different server, and changes nothing", async () => {
      claudeJson({ type: "stdio", command: "node", args: ["/somewhere/else.js"], env: {} });

      await expect(run([], harness())).rejects.toThrow(/different MCP server named "wp"/);

      expect(removed()).toBeUndefined();
      expect(existsSync(join(root, ".env"))).toBe(false);
      expect(existsSync(settingsPath())).toBe(false);
    });

    it("refuses when ~/.claude.json cannot be read", async () => {
      writeFileSync(join(home, ".claude.json"), "{ broken");
      await expect(run([], harness())).rejects.toThrow(/different MCP server/);
      expect(removed()).toBeUndefined();
    });

    it("replaces its own earlier entry for the same folder", async () => {
      claudeJson({ type: "stdio", command: "node", args: [join(root, "bin", "mcp-wordpress.js")], env: {} });

      await run([], harness());

      expect(removed().args).toEqual(["mcp", "remove", "wp", "--scope", "user"]);
      expect(added().args).toContain(process.execPath);
    });

    it("also replaces its own entry registered with the full Node path", async () => {
      claudeJson({ type: "stdio", command: process.execPath, args: [join(root, "bin", "mcp-wordpress.js")], env: {} });
      await run([], harness());
      expect(removed()).toBeDefined();
    });
  });

  it("tells the user the exact command when registering fails, with the tools already blocked", async () => {
    await expect(run([], harness({ addFails: true }))).rejects.toThrow(/claude mcp add wp --scope user/);

    expect(readSettingsFile().permissions.deny).toHaveLength(DENIED_TOOLS.length);
    expect(existsSync(join(root, ".env"))).toBe(true);
  });

  it("fails when the server starts but cannot reach WordPress, and says what is already in place", async () => {
    const failing = harness({ probeResult: { tools: DENIED_TOOLS, callError: true, callText: "{}" } });

    await expect(run([], failing)).rejects.toThrow(/could not reach WordPress/);
  });

  it("fails when the server answers as a different account than the one just tested", async () => {
    const wrong = harness({
      probeResult: { tools: DENIED_TOOLS, callError: false, callText: '"Display Name: Someone Else"' },
    });

    await expect(run([], wrong)).rejects.toThrow(/could not reach WordPress/);
  });

  it("stores the overrides a local or http site needs in .env, so Claude can start it too", async () => {
    await run(
      [],
      harness({
        answers: ["http://127.0.0.1:8080", "", PASSWORD],
        env: { ALLOW_PRIVATE_URLS: "true", ALLOW_INSECURE_HTTP: "true" },
      }),
    );

    const env = parseDotenv(readFileSync(join(root, ".env"), "utf8"));
    expect(env.ALLOW_PRIVATE_URLS).toBe("true");
    expect(env.ALLOW_INSECURE_HTTP).toBe("true");
  });

  it("turns the page cache off so Claude never edits a stale copy", async () => {
    await run([], harness());
    expect(parseDotenv(readFileSync(join(root, ".env"), "utf8")).DISABLE_CACHE).toBe("true");
  });

  it("drops local-only overrides left in an old .env when the new site is public https", async () => {
    writeFileSync(join(root, ".env"), "ALLOW_PRIVATE_URLS='true'\nALLOW_INSECURE_HTTP='true'\n", { mode: 0o600 });
    await run([], harness({ answers: ["https://example.com", "", PASSWORD, "y"] }));
    const env = parseDotenv(readFileSync(join(root, ".env"), "utf8"));
    expect(env.ALLOW_PRIVATE_URLS).toBeUndefined();
    expect(env.ALLOW_INSECURE_HTTP).toBeUndefined();
  });

  it("stops before writing anything when the username has characters the server rejects", async () => {
    await expect(run([], harness({ answers: ["https://example.com", "bad!name", PASSWORD] }))).rejects.toThrow(
      /username/i,
    );
    expect(existsSync(join(root, ".env"))).toBe(false);
  });

  it("accepts usernames with spaces", async () => {
    await run([], harness({ answers: ["https://example.com", "AI Editor", PASSWORD] }));
    expect(parseDotenv(readFileSync(join(root, ".env"), "utf8")).WORDPRESS_USERNAME).toBe("AI Editor");
  });

  it("rejects http and private addresses unless explicitly overridden", async () => {
    await expect(run([], harness({ answers: ["http://example.com", "", PASSWORD] }))).rejects.toThrow(/http/);
    await expect(run([], harness({ answers: ["https://192.168.1.5", "", PASSWORD] }))).rejects.toThrow(/private/);
  });

  it("notes shell variables that would shadow .env, by name only", async () => {
    await run([], harness({ env: { WORDPRESS_SITE_URL: "https://other.example", PATH: "/bin" } }));

    const text = logs.join("\n");
    expect(text).toContain("WORDPRESS_SITE_URL");
    expect(text).not.toContain("https://other.example");
  });

  describe("dry run", () => {
    it.each([
      ["--dry-run flag", ["--dry-run"], {}],
      ["npm_config_dry_run (npm run workshop --dry-run without the -- separator)", [], { npm_config_dry_run: "true" }],
    ])("changes nothing: %s", async (_label, argv, env) => {
      rmSync(join(root, "dist"), { recursive: true }); // not built yet: a dry run must not build

      await run(argv, harness({ env }));

      expect(existsSync(join(root, ".env"))).toBe(false);
      expect(existsSync(settingsPath())).toBe(false);
      expect(calls.some((c) => c.args?.[0] === "mcp")).toBe(false);
      expect(calls.some((c) => c.cmd === "npm")).toBe(false);
      expect(calls.some((c) => c.probe)).toBe(false);
    });
  });

  it("builds a missing dist on a real run", async () => {
    rmSync(join(root, "dist"), { recursive: true });
    await run([], harness());
    expect(calls.some((c) => c.cmd === "npm" && c.args.join(" ") === "run build")).toBe(true);
  });

  it("uses the chosen server name for the registration and the deny rules", async () => {
    await run(["--name", "site2"], harness());

    expect(added().args[2]).toBe("site2");
    expect(readSettingsFile().permissions.deny[0]).toBe("mcp__site2__wp_delete_page");
  });
});

describe("workshop helpers", () => {
  it("rejects unknown options instead of ignoring a typo", () => {
    expect(() => parseArgs(["--dryrun"], {})).toThrow(/Unknown option/);
    expect(() => parseArgs(["--name"], {})).toThrow();
    expect(parseArgs(["--dry-run"], {}).dryRun).toBe(true);
    expect(parseArgs([], { npm_config_dry_run: "true" }).dryRun).toBe(true);
  });

  it("strips every variable that could shadow .env before the check starts the server", () => {
    const env = {
      PATH: "/bin",
      HOME: "/h",
      WORDPRESS_SITE_URL: "x",
      WORDPRESS_APP_PASSWORD: "y",
      MCP_WORDPRESS_ALLOW_MULTI_SITE: "true",
      ALLOW_PRIVATE_URLS: "true",
      ALLOW_INSECURE_HTTP: "true",
    };
    expect(cleanEnv(env)).toEqual({ PATH: "/bin", HOME: "/h" });
    expect(overrideNames(env)).toHaveLength(5);
  });

  it("writes atomically: no temp file is left behind and the mode is kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "workshop-atomic-"));
    const file = join(dir, "f.json");
    writeFileSync(file, "old", { mode: 0o640 });
    chmodSync(file, 0o640);

    writeFileAtomic(file, "new");

    expect(readFileSync(file, "utf8")).toBe("new");
    expect(statSync(file).mode & 0o777).toBe(0o640);
    expect(readdirSync(dir)).toEqual(["f.json"]);
    rmSync(dir, { recursive: true, force: true });
  });
});
