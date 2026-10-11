#!/usr/bin/env node

// Guided setup for first-time users: checks the machine, tests the WP login, saves it to .env,
// blocks the dangerous tools in Claude Code's deny list, registers the server, and starts it once.
//
//   npm run workshop -- [--name wp] [--dry-run] [--allow-admin]
//
// Every check that can fail runs before anything is written, and the deny list is written before the
// server is registered, so a failure never leaves a registered server without its blocked tools.
// The app password comes from a hidden prompt and is written only to .env (mode 600). It is never
// passed on a command line, so it cannot end up in shell history or ~/.claude.json.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { execFileSync, spawn } from "child_process";
import { createInterface } from "readline/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { Writable } from "stream";
import { parse as parseDotenv } from "dotenv";
import { serializeEnvFile } from "./setup.js";

const defaultRootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIN_NODE = "22.14.0";

export const DENIED_TOOLS = [
  "wp_delete_page",
  "wp_delete_post",
  "wp_delete_media",
  "wp_delete_comment",
  "wp_delete_category",
  "wp_delete_tag",
  "wp_delete_user",
  "wp_delete_application_password",
  "wp_create_user",
  "wp_update_user",
  "wp_create_application_password",
  "wp_switch_auth_method",
  "wp_update_site_settings",
];

/** A failure with a message written for the person running the script. */
export class SetupError extends Error {}
const fail = (message) => {
  throw new SetupError(message);
};

export function denyRules(serverName) {
  return DENIED_TOOLS.map((tool) => `mcp__${serverName}__${tool}`);
}

/** True when `version` (e.g. "v22.14.0") is at least `min`. */
export function nodeVersionOk(version, min = MIN_NODE) {
  const parse = (v) =>
    String(v)
      .replace(/^v/, "")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const [a, b] = [parse(version), parse(min)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

/** True for localhost, loopback, link-local, .local and private-range hosts, which the server refuses by default. */
export function isPrivateHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    (host.includes(":") && /^(f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/i.test(host))
  );
}

/** Adds https:// when missing, strips trailing slashes and a pasted /wp-admin or /wp-json path. */
export function normalizeSiteUrl(input) {
  let url = String(input).trim();
  if (!url) throw new Error("Site URL is empty.");
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${input}" does not look like a web address. Use the full address, e.g. https://example.com`);
  }
  const warning =
    parsed.protocol === "http:" && !isPrivateHost(parsed.hostname)
      ? "This URL is http://. WordPress only offers Application Passwords over HTTPS, so use the https:// address."
      : null;
  const path = parsed.pathname.replace(/\/(wp-admin|wp-json)(\/.*)?$/i, "").replace(/\/+$/, "");
  return { url: `${parsed.origin}${path}`, warning };
}

/** Decides whether the account the user connected is safe to hand to Claude. */
export function checkAccount(me, { allowAdmin = false } = {}) {
  const roles = Array.isArray(me?.roles) ? me.roles : [];
  if (roles.includes("administrator") && !allowAdmin) {
    return {
      level: "block",
      message:
        "This account is an Administrator. Claude should not hold admin keys. Create a separate user with the Editor role and use that one.",
    };
  }
  if (roles.length > 0 && !roles.includes("editor") && !roles.includes("administrator")) {
    return {
      level: "warn",
      message: `This account has the role "${roles.join(", ")}". Editing pages needs Editor, so some tools may fail.`,
    };
  }
  if (roles.length === 0) {
    return { level: "warn", message: "WordPress did not report this account's role. Check that it is Editor." };
  }
  return { level: "ok", message: `Role: ${roles.join(", ")}` };
}

/**
 * Returns a copy of settings with the rules added to permissions.deny. Never removes or reorders
 * anything the user already had.
 */
export function mergeDeny(settings, rules) {
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("settings.json is not a JSON object.");
  }
  const permissions = settings.permissions ?? {};
  if (typeof permissions !== "object" || Array.isArray(permissions)) {
    throw new Error("settings.json has a permissions value that is not an object.");
  }
  const deny = permissions.deny ?? [];
  if (!Array.isArray(deny)) throw new Error("settings.json has a permissions.deny value that is not a list.");
  const missing = rules.filter((rule) => !deny.includes(rule));
  return {
    settings: { ...settings, permissions: { ...permissions, deny: [...deny, ...missing] } },
    added: missing.length,
    alreadyPresent: rules.length - missing.length,
  };
}

/** Environment variables that would override .env or the server's URL checks if set in the caller's shell. */
export const OVERRIDE_ENV = /^(WORDPRESS_|MCP_WORDPRESS_|ALLOW_PRIVATE_URLS$|ALLOW_INSECURE_HTTP$)/;

export function overrideNames(env) {
  return Object.keys(env).filter((key) => OVERRIDE_ENV.test(key) && env[key] !== undefined);
}

/** A copy of env without anything that could shadow the values saved in .env. */
export function cleanEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !OVERRIDE_ENV.test(key)));
}

/**
 * Writes a temp file next to the target and renames it into place, so an interrupted write never
 * truncates the original. Follows symlinks (a dotfile-manager link stays a link) and keeps an
 * existing file's permissions unless `mode` is given.
 */
export function writeFileAtomic(filePath, content, mode) {
  const real = existsSync(filePath) ? realpathSync(filePath) : filePath;
  const finalMode = mode ?? (existsSync(real) ? statSync(real).mode & 0o777 : 0o600);
  const tmp = `${real}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, content, { mode: finalMode });
    chmodSync(tmp, finalMode);
    renameSync(tmp, real);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return real;
}

/** Copies a file that may hold secrets to <file>.bak-<time> with owner-only permissions. */
export function backupFile(filePath) {
  const real = realpathSync(filePath);
  const backup = `${real}.bak-${Date.now()}`;
  copyFileSync(real, backup);
  chmodSync(backup, 0o600);
  return backup;
}

/** Reads settings.json, or {} when absent. Throws SetupError when the file is not valid JSON. */
export function readSettings(settingsPath) {
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return fail(
      `${settingsPath} is not valid JSON, so nothing was changed. Fix it (or ask Claude to), then run this again.`,
    );
  }
}

/**
 * Looks up a user-scope MCP registration in ~/.claude.json.
 * Returns undefined when there is none, the entry when there is, and null when the file cannot be read.
 */
export function findRegistration(homeDir, name) {
  const file = join(homeDir, ".claude.json");
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"))?.mcpServers?.[name];
  } catch {
    return null;
  }
}

/** Calls /users/me with the app password and turns every failure into a plain-English message. */
export async function fetchMe(siteUrl, username, appPassword, fetchImpl = fetch) {
  const auth = Buffer.from(`${username}:${appPassword}`).toString("base64");
  let response;
  try {
    response = await fetchImpl(`${siteUrl}/wp-json/wp/v2/users/me?context=edit`, {
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
      redirect: "manual",
    });
  } catch (error) {
    return { ok: false, message: `Could not reach ${siteUrl}: ${error.cause?.code ?? error.message}` };
  }
  if (response.status >= 300 && response.status < 400) {
    return {
      ok: false,
      message: `The site redirected to ${response.headers.get("location")}. Use that final address (usually https:// and the exact www or non-www form) as the Site URL.`,
    };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      message:
        "WordPress rejected the login (401/403). Check the username and app password. If both are right, the host or a firewall may be stripping the Authorization header, or a security plugin may block the REST API.",
    };
  }
  if (response.status === 404) {
    return {
      ok: false,
      message:
        "The REST API was not found (404). In WP admin go to Settings, Permalinks and choose Post name. Also check that the Site URL is the WordPress address.",
    };
  }
  if (!response.ok) return { ok: false, message: `WordPress answered with HTTP ${response.status}.` };
  try {
    return { ok: true, me: await response.json() };
  } catch {
    return { ok: false, message: "The site answered, but not with WordPress JSON. Check the Site URL." };
  }
}

/**
 * Starts the built server the way Claude Code will (without the caller's WordPress overrides), lists its
 * tools, and calls one read-only tool so the check covers the real login, not just startup.
 * Resolves with { tools, callText, callError }, or rejects with the reason the server did not start.
 */
export function probeServer({ rootDir = defaultRootDir, env = process.env, callTool, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [join(rootDir, "bin", "mcp-wordpress.js")], {
      cwd: rootDir,
      env: cleanEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
    let initialized = false;
    let tools;
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const finish = (fn, value) => {
      clearTimeout(timer);
      child.kill();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("The server did not answer in time.")), timeoutMs);
    child.on("error", (error) => finish(reject, error));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code) => {
      if (code)
        finish(reject, new Error(`The server exited with code ${code}. ${stderr.trim().split("\n").pop() ?? ""}`));
    });
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (const line of buffer.split("\n")) {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue; // partial line, keep reading
        }
        if (message.id === 1 && !initialized) {
          initialized = true;
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        }
        if (message.id === 2 && message.result && !tools) {
          tools = message.result.tools.map((t) => t.name);
          if (!callTool) return finish(resolve, { tools });
          send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: callTool, arguments: {} } });
        }
        if (message.id === 3) {
          const callError = Boolean(message.error || message.result?.isError);
          return finish(resolve, { tools, callError, callText: JSON.stringify(message.result ?? message.error ?? "") });
        }
      }
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "workshop-setup", version: "1" } },
    });
  });
}

export function parseArgs(argv, env = process.env) {
  const args = { name: "wp", dryRun: env.npm_config_dry_run === "true", allowAdmin: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--name") args.name = argv[++i];
    else if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--allow-admin") args.allowAdmin = true;
    else throw new Error(`Unknown option "${argv[i]}". Options: --name <server>, --dry-run, --allow-admin.`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(args.name ?? "")) throw new Error("--name may only contain letters, numbers, - and _.");
  return args;
}

function makePrompter() {
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY });
  let finished = false;
  rl.on("close", () => {
    if (finished) return;
    console.error("\n  STOP  Input ended before setup finished. Run this in a normal terminal window.\n");
    process.exit(1);
  });
  return {
    ask: (text) => rl.question(text).then((v) => v.trim()),
    askHidden: async (text) => {
      process.stdout.write(text);
      muted = true;
      const value = await rl.question("");
      muted = false;
      process.stdout.write("\n");
      return value.trim();
    },
    close: () => {
      finished = true;
      rl.close();
    },
  };
}

/**
 * Runs the setup. `overrides` replaces the machine-touching pieces (home folder, repo folder, prompts,
 * child processes, network) so the whole flow can be tested against a temp directory.
 */
export async function run(argv = process.argv.slice(2), overrides = {}) {
  const d = {
    rootDir: defaultRootDir,
    homeDir: homedir(),
    env: process.env,
    nodeVersion: process.version,
    fetchImpl: fetch,
    execFile: execFileSync,
    probe: probeServer,
    log: console.log,
    ...overrides,
  };
  const args = parseArgs(argv, d.env);
  const prompt = d.prompter ?? makePrompter();
  const step = (n, text) => d.log(`\n[${n}/6] ${text}`);
  const ok = (text) => d.log(`  ok  ${text}`);
  const note = (text) => d.log(`  note  ${text}`);

  try {
    d.log(`WP MCP setup${args.dryRun ? " (dry run: nothing will be written, built or registered)" : ""}`);

    // 1. Machine
    step(1, "Checking this machine");
    if (!nodeVersionOk(d.nodeVersion)) {
      fail(
        `Node ${d.nodeVersion} is too old. Install Node ${MIN_NODE} or newer from nodejs.org, open a new terminal, and run this again.`,
      );
    }
    ok(`Node ${d.nodeVersion}`);
    try {
      ok(`Claude Code ${String(d.execFile("claude", ["--version"], { encoding: "utf8" })).trim()}`);
    } catch {
      fail("Claude Code was not found. Install it, then run this again.");
    }
    if (!existsSync(join(d.rootDir, "dist", "index.js"))) {
      if (args.dryRun) {
        note("The server is not built yet. A real run would build it (about 15 seconds).");
      } else {
        d.log("  Building the server (about 15 seconds)...");
        try {
          d.execFile("npm", ["run", "build"], { cwd: d.rootDir, stdio: "inherit" });
        } catch {
          fail("The build failed. Run: npm ci && npm run build, and read the first error.");
        }
      }
    } else {
      ok("Server is built");
    }
    const shadowing = overrideNames(d.env);
    if (shadowing.length) {
      note(
        `Your shell sets ${shadowing.join(", ")}. Those override .env for anything started from this shell, so the checks below ignore them.`,
      );
    }

    // 2. Login, and every check that must pass before anything is written
    step(2, "Testing your WordPress login");
    let site;
    try {
      site = normalizeSiteUrl(await prompt.ask("Site URL (the site you chose, https://...): "));
    } catch (error) {
      fail(error.message);
    }
    const { url, warning } = site;
    const extraEnv = {};
    if (new URL(url).protocol === "http:") {
      if (d.env.ALLOW_INSECURE_HTTP !== "true") {
        fail(
          `${warning ?? "This URL is http://."} The server refuses http:// addresses unless ALLOW_INSECURE_HTTP=true (for local development only).`,
        );
      }
      extraEnv.ALLOW_INSECURE_HTTP = "true";
    }
    if (isPrivateHost(new URL(url).hostname)) {
      if (d.env.ALLOW_PRIVATE_URLS !== "true") {
        fail(
          `${url} is a local or private address, and the server refuses those by default. Use a site with a public https:// address, or set ALLOW_PRIVATE_URLS=true if you are developing locally.`,
        );
      }
      extraEnv.ALLOW_PRIVATE_URLS = "true";
    }
    const username = (await prompt.ask("WordPress username [ai-editor]: ")) || "ai-editor";
    const appPassword = await prompt.askHidden("Application password (paste it; nothing shows as you type): ");
    if (!appPassword) fail("No password entered.");
    const result = await fetchMe(url, username, appPassword, d.fetchImpl);
    if (!result.ok) fail(result.message);
    const verdict = checkAccount(result.me, { allowAdmin: args.allowAdmin });
    if (verdict.level === "block") fail(verdict.message);
    ok(`Logged in as "${result.me.name}". ${verdict.message}`);
    if (verdict.level === "warn") note(verdict.message);

    const envPath = join(d.rootDir, ".env");
    const settingsPath = join(d.homeDir, ".claude", "settings.json");
    const entry = join(d.rootDir, "bin", "mcp-wordpress.js");
    const rules = denyRules(args.name);

    let planned;
    try {
      planned = mergeDeny(readSettings(settingsPath), rules);
    } catch (error) {
      if (error instanceof SetupError) throw error;
      fail(`${error.message} ${settingsPath} was left untouched.`);
    }
    const existing = findRegistration(d.homeDir, args.name);
    const sameServer =
      existing &&
      existing.command === "node" &&
      existing.args?.[0] === entry &&
      Object.keys(existing.env ?? {}).length === 0;
    if (existing !== undefined && !sameServer) {
      fail(
        `Claude Code already has a different MCP server named "${args.name}" and this script will not overwrite it. Run again with --name <other-name>, or remove it yourself: claude mcp remove ${args.name} --scope user`,
      );
    }
    const existingEnv = existsSync(envPath) ? parseDotenv(readFileSync(envPath, "utf8")) : null;
    if (existingEnv && !args.dryRun) {
      const keep = Object.keys(existingEnv).filter(
        (key) =>
          !["WORDPRESS_SITE_URL", "WORDPRESS_USERNAME", "WORDPRESS_APP_PASSWORD", "WORDPRESS_AUTH_METHOD"].includes(
            key,
          ),
      );
      const answer = await prompt.ask(
        `  .env already exists. Replace the WordPress login in it${keep.length ? ` (keeping ${keep.join(", ")})` : ""}? (y/N): `,
      );
      if (answer.toLowerCase() !== "y") fail("Left .env unchanged. Move or delete it, then run this again.");
    }
    ok("Everything that can fail has been checked. Nothing has been written yet.");

    // 3. Save the login
    step(3, "Saving the login to .env");
    if (!args.dryRun) {
      if (existingEnv) note(`Old .env copied to ${backupFile(envPath)} (owner-only; delete it when you are done).`);
      writeFileAtomic(
        envPath,
        serializeEnvFile({
          ...existingEnv,
          WORDPRESS_SITE_URL: url,
          WORDPRESS_USERNAME: username,
          WORDPRESS_APP_PASSWORD: appPassword,
          WORDPRESS_AUTH_METHOD: "app-password",
          ...extraEnv,
        }),
        0o600,
      );
    }
    ok(`${envPath} (owner-only). This is the only place the password is stored.`);
    if (Object.keys(extraEnv).length)
      note(`Also saved ${Object.keys(extraEnv).join(", ")} there, because this site needs it.`);

    // 4. Block the dangerous tools BEFORE the server exists in Claude Code
    step(4, "Blocking the dangerous tools in Claude's deny list");
    if (!args.dryRun && planned.added > 0) {
      mkdirSync(dirname(settingsPath), { recursive: true });
      if (existsSync(settingsPath)) note(`Old settings copied to ${backupFile(settingsPath)}.`);
      writeFileAtomic(settingsPath, `${JSON.stringify(planned.settings, null, 2)}\n`);
    }
    ok(`${planned.added} rules added, ${planned.alreadyPresent} already there (${settingsPath})`);

    // 5. Register
    step(5, `Registering the server with Claude Code as "${args.name}"`);
    if (!args.dryRun) {
      const addArgs = ["mcp", "add", args.name, "--scope", "user", "--", "node", entry];
      const manual = `claude mcp add ${args.name} --scope user -- node "${entry}"`;
      try {
        if (sameServer) {
          d.execFile("claude", ["mcp", "remove", args.name, "--scope", "user"], { stdio: "ignore" });
          note(`Replacing your earlier "${args.name}" entry for this same folder.`);
        }
        d.execFile("claude", addArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        fail(
          `Your login is saved and the tools are blocked, but registering failed: ${error.stderr || error.message}\n  Run this yourself: ${manual}`,
        );
      }
    }
    ok(`${args.name} -> node ${entry}`);

    // 6. Verify with the real login
    step(6, "Starting the server and calling WordPress");
    if (args.dryRun) {
      note("Skipped in a dry run.");
    } else {
      let probed;
      try {
        probed = await d.probe({ rootDir: d.rootDir, env: d.env, callTool: "wp_get_current_user" });
      } catch (error) {
        fail(`The server did not start: ${error.message}\n  Run: npm run status`);
      }
      ok(`Server started with ${probed.tools.length} tools`);
      if (probed.callError || (result.me.name && !probed.callText.includes(result.me.name))) {
        fail(
          `The server started but could not reach WordPress as "${username}". Run: npm run status\n  (Your login, the blocked tools and the registration are in place; only this check failed.)`,
        );
      }
      ok(`Server reached WordPress as "${result.me.name}"`);
      const unknown = DENIED_TOOLS.filter((tool) => !probed.tools.includes(tool));
      if (unknown.length) note(`These blocked names are not tools in this version (harmless): ${unknown.join(", ")}`);
      if (!probed.tools.includes("wp_restore_revision"))
        note("wp_restore_revision is missing. Run git pull, then npm run build.");
    }

    d.log(`
Done${args.dryRun ? " (dry run, nothing changed)" : ""}. What was stored where:
  password, site URL, username -> ${envPath}
  blocked tools                -> ${settingsPath}
  Claude Code registration     -> ~/.claude.json (the command only, no password)

Next:
  1. Quit and reopen Claude Code, then run /mcp. "${args.name}" should show as connected.
  2. Ask: "List my 5 most recent pages."
  3. Ask: "Create a draft page called MCP test, then delete it." The delete should be blocked.
`);
  } finally {
    prompt.close?.();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run().catch((error) => {
    console.error(`\n  STOP  ${error.message}\n`);
    process.exit(1);
  });
}
