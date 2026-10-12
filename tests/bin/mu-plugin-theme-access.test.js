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
  "mcp-wordpress-theme-access.php",
);

function hasPhp() {
  try {
    execFileSync("php", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads the mu-plugin against a minimal hook system, replays one request, and returns the
 * capabilities user_has_cap ends up with. Scenario fields:
 *   login/id    the user the cap check is for
 *   authed      who app-password auth fired for ({login, id}), or null for a cookie login
 *   checks      the primitive caps WordPress is asking about
 *   constant    optional override of MCP_WP_THEME_ACCESS_LOGIN, defined before the plugin loads
 */
function run(scenario) {
  const script = `
    define('ABSPATH', '/');
    $s = json_decode($argv[1], true);
    $GLOBALS['hooks'] = [];
    function add_action($n, $cb, $p = 10, $a = 1) { $GLOBALS['hooks'][$n][] = $cb; }
    function add_filter($n, $cb, $p = 10, $a = 1) { $GLOBALS['hooks'][$n][] = $cb; }
    function do_action($n, ...$args) { foreach ($GLOBALS['hooks'][$n] ?? [] as $cb) $cb(...$args); }
    function apply_filters($n, $v, ...$args) { foreach ($GLOBALS['hooks'][$n] ?? [] as $cb) $v = $cb($v, ...$args); return $v; }
    class WP_User { public function __construct(public $ID, public $user_login) {} }
    if (isset($s['constant'])) define('MCP_WP_THEME_ACCESS_LOGIN', $s['constant']);
    include $argv[2];
    // Each request: core resolves the user (determine_current_user), and an Application Password
    // login additionally fires application_password_did_authenticate. Several requests in one
    // process mimic a long-lived worker that keeps PHP statics between requests.
    $requests = $s['requests'] ?? [['authed' => $s['authed']]];
    $user = new WP_User($s['id'], $s['login']);
    $base = ['edit_posts' => true, 'edit_pages' => true];
    $out = [];
    foreach ($requests as $r) {
      apply_filters('determine_current_user', $s['id']);
      if ($r['authed']) do_action('application_password_did_authenticate', new WP_User($r['authed']['id'], $r['authed']['login']), []);
      $out[] = apply_filters('user_has_cap', $base, $s['checks'], [$s['checks'][0], $s['id']], $user);
    }
    echo json_encode(isset($s['requests']) ? $out : $out[0]);
  `;
  return JSON.parse(execFileSync("php", ["-r", script, JSON.stringify(scenario), plugin], { encoding: "utf8" }));
}

const ai = { login: "ai-editor", id: 7 };
const base = { edit_posts: true, edit_pages: true };

describe.skipIf(!hasPhp())("mcp-wordpress-theme-access mu-plugin", () => {
  it("grants edit_theme_options to ai-editor when the request used an Application Password", () => {
    expect(run({ ...ai, authed: ai, checks: ["edit_theme_options"] })).toEqual({ ...base, edit_theme_options: true });
  });

  it("grants nothing on a cookie (browser) login", () => {
    expect(run({ ...ai, authed: null, checks: ["edit_theme_options"] })).toEqual(base);
  });

  it("grants nothing to another user, even when that user used an Application Password", () => {
    const bob = { login: "bob", id: 8 };
    expect(run({ ...bob, authed: bob, checks: ["edit_theme_options"] })).toEqual(base);
  });

  it("grants nothing when someone else authenticated and ai-editor is only being checked", () => {
    expect(run({ ...ai, authed: { login: "bob", id: 8 }, checks: ["edit_theme_options"] })).toEqual(base);
  });

  it("does not let a different account with the same login text but another ID inherit the flag", () => {
    expect(run({ login: "ai-editor", id: 9, authed: ai, checks: ["edit_theme_options"] })).toEqual(base);
  });

  it("does not carry the flag into a later cookie request in a long-lived worker", () => {
    const [appRequest, cookieRequest, appAgain] = run({
      ...ai,
      checks: ["edit_theme_options"],
      requests: [{ authed: ai }, { authed: null }, { authed: ai }],
    });
    expect(appRequest).toEqual({ ...base, edit_theme_options: true });
    expect(cookieRequest).toEqual(base);
    expect(appAgain).toEqual({ ...base, edit_theme_options: true });
  });

  it("leaves every other capability alone", () => {
    for (const cap of ["manage_options", "switch_themes", "edit_themes", "install_plugins", "edit_users"]) {
      expect(run({ ...ai, authed: ai, checks: [cap] }), cap).toEqual(base);
    }
  });

  it("honours a login name set before the plugin loads, and stops granting the default one", () => {
    const other = { login: "site-bot", id: 11 };
    expect(run({ ...other, authed: other, constant: "site-bot", checks: ["edit_theme_options"] })).toEqual({
      ...base,
      edit_theme_options: true,
    });
    expect(run({ ...ai, authed: ai, constant: "site-bot", checks: ["edit_theme_options"] })).toEqual(base);
  });
});
