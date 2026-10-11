import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const plugin = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "wordpress",
  "mu-plugins",
  "mcp-wordpress-auth.php",
);

function hasPhp() {
  try {
    execFileSync("php", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Loads the mu-plugin with the given $_SERVER values and returns the resulting login fields. */
function loadWith(server) {
  const script = `
    define('ABSPATH', '/');
    $_SERVER = array_merge($_SERVER, json_decode($argv[1], true));
    include $argv[2];
    echo json_encode([$_SERVER['PHP_AUTH_USER'] ?? null, $_SERVER['PHP_AUTH_PW'] ?? null]);
  `;
  return JSON.parse(execFileSync("php", ["-r", script, JSON.stringify(server), plugin], { encoding: "utf8" }));
}

const basic = (value) => `Basic ${Buffer.from(value).toString("base64")}`;

describe.skipIf(!hasPhp())("mcp-wordpress-auth mu-plugin", () => {
  it("fills in the login from X-MCP-WP-Auth when Authorization never arrived", () => {
    expect(loadWith({ HTTP_X_MCP_WP_AUTH: basic("ai-editor:abcd efgh:ij") })).toEqual(["ai-editor", "abcd efgh:ij"]);
  });

  it("leaves a login that did arrive untouched", () => {
    expect(loadWith({ PHP_AUTH_USER: "real", PHP_AUTH_PW: "pw", HTTP_X_MCP_WP_AUTH: basic("other:x") })).toEqual([
      "real",
      "pw",
    ]);
    expect(loadWith({ HTTP_AUTHORIZATION: basic("a:b"), HTTP_X_MCP_WP_AUTH: basic("other:x") })).toEqual([null, null]);
  });

  it("ignores malformed values", () => {
    expect(loadWith({ HTTP_X_MCP_WP_AUTH: "Bearer abc" })).toEqual([null, null]);
    expect(loadWith({ HTTP_X_MCP_WP_AUTH: "Basic !!!not-base64" })).toEqual([null, null]);
    expect(loadWith({ HTTP_X_MCP_WP_AUTH: basic("no-colon") })).toEqual([null, null]);
  });
});
