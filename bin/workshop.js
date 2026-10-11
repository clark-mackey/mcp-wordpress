#!/usr/bin/env node

// Guided setup for first-time users: checks the machine, tests the WP login, saves it to .env,
// registers the server with Claude Code, and blocks the dangerous tools in Claude's deny list.
//
//   npm run workshop [-- --name wp] [--dry-run] [--allow-admin]
//
// The app password is read from a hidden prompt. It is written only to .env (mode 600) and is
// never passed on a command line, so it cannot end up in shell history or ~/.claude.json.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { execFileSync, spawn } from "child_process";
import { createInterface } from "readline/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { Writable } from "stream";
import { serializeEnvFile } from "./setup.js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
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

/** True for localhost, loopback, .local and private-range hosts, which the server refuses by default. */
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
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

/** Adds https:// when missing, strips trailing slashes and a pasted /wp-admin or /wp-json path. */
export function normalizeSiteUrl(input) {
  let url = String(input).trim();
  if (!url) throw new Error("Site URL is empty.");
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const parsed = new URL(url);
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
      message: `This account has the role "${roles.join(", ")}". Editing pages needs Editor, so some tools will fail.`,
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
 * Starts the built server the way Claude Code will, asks it for its tool list, and shuts it down.
 * Resolves with the list of tool names, or rejects with the reason it did not start.
 */
export function listServerTools(timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [join(rootDir, "bin", "mcp-wordpress.js")], { stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    let stderr = "";
    let initialized = false;
    const done = (fn, value) => {
      clearTimeout(timer);
      child.kill();
      fn(value);
    };
    const timer = setTimeout(() => done(reject, new Error("The server did not answer in time.")), timeoutMs);
    child.on("error", (error) => done(reject, error));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code) => {
      if (code)
        done(reject, new Error(`The server exited with code ${code}. ${stderr.trim().split("\n").pop() ?? ""}`));
    });
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
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
        if (message.id === 2 && message.result)
          return done(
            resolve,
            message.result.tools.map((t) => t.name),
          );
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

function parseArgs(argv) {
  const args = { name: "wp", dryRun: false, allowAdmin: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--name") args.name = argv[++i];
    else if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--allow-admin") args.allowAdmin = true;
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

const step = (n, text) => console.log(`\n[${n}/6] ${text}`);
const ok = (text) => console.log(`  ok  ${text}`);
const fail = (text) => {
  console.error(`\n  STOP  ${text}\n`);
  process.exit(1);
};

export async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const prompt = makePrompter();
  console.log(`WP MCP setup${args.dryRun ? " (dry run: nothing will be written or registered)" : ""}`);

  step(1, "Checking this machine");
  if (!nodeVersionOk(process.version))
    fail(
      `Node ${process.version} is too old. Install Node ${MIN_NODE} or newer from nodejs.org, open a new terminal, and run this again.`,
    );
  ok(`Node ${process.version}`);
  try {
    ok(`Claude Code ${execFileSync("claude", ["--version"], { encoding: "utf8" }).trim()}`);
  } catch {
    fail("Claude Code was not found. Install it, then run this again.");
  }
  if (!existsSync(join(rootDir, "dist", "index.js"))) {
    console.log("  Building the server (about 15 seconds)...");
    try {
      execFileSync("npm", ["run", "build"], { cwd: rootDir, stdio: "inherit" });
    } catch {
      fail("The build failed. Run: npm ci && npm run build, and read the first error.");
    }
  }
  ok("Server is built");

  step(2, "Testing your WordPress login");
  const { url, warning } = normalizeSiteUrl(await prompt.ask("Site URL (the site you chose, https://...): "));
  if (warning && process.env.ALLOW_INSECURE_HTTP !== "true") {
    fail(`${warning} (The server refuses http:// addresses unless ALLOW_INSECURE_HTTP=true.)`);
  }
  if (isPrivateHost(new URL(url).hostname) && process.env.ALLOW_PRIVATE_URLS !== "true") {
    fail(
      `${url} is a local or private address, and the server refuses those by default. Use a site with a public https:// address, or set ALLOW_PRIVATE_URLS=true if you are developing locally.`,
    );
  }
  const username = (await prompt.ask("WordPress username [ai-editor]: ")) || "ai-editor";
  const appPassword = await prompt.askHidden("Application password (paste it; nothing shows as you type): ");
  if (!appPassword) fail("No password entered.");
  const result = await fetchMe(url, username, appPassword);
  if (!result.ok) fail(result.message);
  const verdict = checkAccount(result.me, { allowAdmin: args.allowAdmin });
  if (verdict.level === "block") fail(verdict.message);
  ok(`Logged in as "${result.me.name}". ${verdict.message}`);
  if (verdict.level === "warn") console.log(`  note  ${verdict.message}`);

  step(3, "Saving the login to .env");
  const envPath = join(rootDir, ".env");
  if (!args.dryRun) {
    if (existsSync(envPath) && (await prompt.ask("  .env already exists. Replace it? (y/N): ")).toLowerCase() !== "y") {
      fail("Left .env unchanged. Move or delete it, then run this again.");
    }
    writeFileSync(
      envPath,
      serializeEnvFile({
        WORDPRESS_SITE_URL: url,
        WORDPRESS_USERNAME: username,
        WORDPRESS_APP_PASSWORD: appPassword,
        WORDPRESS_AUTH_METHOD: "app-password",
      }),
      { mode: 0o600 },
    );
    chmodSync(envPath, 0o600);
  }
  ok(`${envPath} (owner-only). This is the only place the password is stored.`);
  prompt.close();

  step(4, `Registering the server with Claude Code as "${args.name}"`);
  const entry = join(rootDir, "bin", "mcp-wordpress.js");
  const addArgs = ["mcp", "add", args.name, "--scope", "user", "--", "node", entry];
  if (!args.dryRun) {
    const tryAdd = () => execFileSync("claude", addArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    try {
      tryAdd();
    } catch (error) {
      if (!/already exists/i.test(`${error.stdout}${error.stderr}`))
        fail(`claude mcp add failed: ${error.stderr || error.message}`);
      execFileSync("claude", ["mcp", "remove", args.name, "--scope", "user"], { stdio: "ignore" });
      tryAdd();
      console.log(`  note  Replaced an existing "${args.name}" entry.`);
    }
  }
  ok(`${args.name} -> node ${entry}`);

  step(5, "Blocking the dangerous tools in Claude's deny list");
  const settingsPath = join(homedir(), ".claude", "settings.json");
  const rules = denyRules(args.name);
  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {
      fail(
        `${settingsPath} is not valid JSON, so it was left untouched. Fix it or ask Claude to, then run this again.`,
      );
    }
  }
  let merged;
  try {
    merged = mergeDeny(settings, rules);
  } catch (error) {
    fail(`${error.message} ${settingsPath} was left untouched.`);
  }
  if (!args.dryRun && merged.added > 0) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    if (existsSync(settingsPath)) copyFileSync(settingsPath, `${settingsPath}.bak-${Date.now()}`);
    writeFileSync(`${settingsPath}.tmp`, `${JSON.stringify(merged.settings, null, 2)}\n`);
    renameSync(`${settingsPath}.tmp`, settingsPath);
  }
  ok(`${merged.added} rules added, ${merged.alreadyPresent} already there (${settingsPath})`);

  step(6, "Starting the server to check it works");
  let tools;
  try {
    tools = await listServerTools();
  } catch (error) {
    fail(`The server did not start: ${error.message}\n  Run: npm run status`);
  }
  ok(`Server started with ${tools.length} tools`);
  const unknown = DENIED_TOOLS.filter((tool) => !tools.includes(tool));
  if (unknown.length) {
    console.log(
      `  note  These blocked names are not tools in this version (harmless, but tell Clark): ${unknown.join(", ")}`,
    );
  }
  if (!tools.includes("wp_restore_revision"))
    console.log("  note  wp_restore_revision is missing. Run git pull, then npm run build.");

  console.log(`
Done${args.dryRun ? " (dry run, nothing changed)" : ""}. What was stored where:
  password, site URL, username -> ${envPath}
  Claude Code registration     -> ~/.claude.json (the command only, no password)
  blocked tools                -> ${settingsPath}

Next:
  1. Quit and reopen Claude Code, then run /mcp. "${args.name}" should show as connected.
  2. Ask: "List my 5 most recent pages."
  3. Ask: "Create a draft page called MCP test, then delete it." The delete should be blocked.
`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run().catch((error) => {
    console.error(`\n  STOP  ${error.message}\n`);
    process.exit(1);
  });
}
