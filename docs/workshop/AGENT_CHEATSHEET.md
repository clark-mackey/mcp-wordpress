# Agent Cheatsheet: Helping an Agency Owner Set Up the WP MCP

Audience: an LLM or coding agent (Claude Code or similar) assisting a person who is installing this for the first time.
The person is an agency owner, experienced with Claude Code and GitHub, not necessarily a developer. Handout for the
person: `INSTALL.md`. This file is for you.

What is being installed: `github.com/clark-mackey/mcp-wordpress`, an MCP server (Node, stdio) that lets Claude Code edit
a WordPress site through the WP REST API. It exposes 105 `wp_*` tools. It is a public fork of `docdyhr/mcp-wordpress`
(MIT).

---

## Your rules (read first)

1. **Never ask the person to paste the app password into the chat.** Anything typed in chat is saved in the session
   transcript. The password goes only into the `npm run workshop` prompt, which hides it.
2. **Never put the password in a command line or in `claude mcp add -e ...`.** That would write it in plain text to
   `~/.claude.json` and shell history. `npm run workshop` writes it to `.env` instead.
3. **Never commit `.env`.** It is gitignored. Do not remove that.
4. **Never use an Administrator account.** The WP user must have the **Editor** role.
5. **Do not point this at a client's live site during setup.** Ask which site they chose. Recommend their own site or a
   staging copy.
6. **Do the deny list.** The person is not done until delete and user tools are blocked (Step 3).
7. **Say what you did not verify.** If you could not run a check, say so. Do not claim success from a command that
   printed nothing.
8. **Ask before any action outside the setup,** such as editing live content, installing global tools, or changing shell
   config.

---

## What gets stored where (the map)

| Thing                                      | Where it lives                                                                                                         | Contains a secret?                                | Who can read it                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------ |
| The `ai-editor` user and the app password  | WordPress database (the site's host)                                                                                   | Password is stored hashed                         | WP admins                                        |
| The app password in plain text             | `mcp-wordpress/.env` on the person's laptop (permissions `600`, owner only)                                            | **Yes**                                           | Anyone with access to that laptop's user account |
| Site URL and username                      | Same `.env`                                                                                                            | No (URL and name only)                            | Same                                             |
| The server code and build                  | `mcp-wordpress/` folder: `dist/` (built), `node_modules/`                                                              | No                                                | Anyone on the laptop                             |
| The Claude Code registration (`wp` server) | `~/.claude.json` (user scope): the command `node /path/to/mcp-wordpress/bin/mcp-wordpress.js`, with an **empty** `env` | **No**, as long as you used the command in Step 3 | Anyone on the laptop                             |
| The deny list                              | `~/.claude/settings.json` under `permissions.deny`, plus a `settings.json.bak-<time>` copy of the previous file        | No                                                | Anyone on the laptop                             |
| Anything typed in chat                     | Claude Code session transcript on the laptop                                                                           | **Yes, if the password was typed there**          | Anyone on the laptop                             |
| The WP edits themselves                    | The WP site, plus WP revision history                                                                                  | n/a                                               | WP users by role                                 |

Key points to tell the person:

- **One secret, one file.** The app password exists in plain text in exactly one place, `.env`. If it is anywhere else,
  something went wrong.
- **The server finds `.env` by its own location** (the repo root), not by where Claude Code is running. Verified: it
  starts correctly when launched from a different folder.
- **Revoking is one click.** Deleting the app password in WP (Users, Profile, Application Passwords) kills access
  immediately, whatever copies exist.

---

## Prerequisites check (run these, report results)

```bash
node -v          # must be v22.14.0 or newer
git --version
claude --version
```

- Node below 22.14: stop. Have the person install the current LTS from nodejs.org, then open a new terminal.
- Windows: Command Prompt, PowerShell and WSL all work with `npm run workshop`. Have them `cd %USERPROFILE%` (cmd) or
  `cd ~` (PowerShell) before cloning, so the repo is not created in `C:\WINDOWS\system32`. In cmd, right-click pastes.
- Confirm the target site is HTTPS. WP only offers app passwords over HTTPS.

---

## Step 1: Make the key (done by the person in WP admin)

You cannot do this for them (it needs the WP admin login, which should not be shared with you). Walk them through it:

1. Users, Add New. Username `ai-editor`. Role **Editor**. A strong password they will not reuse.
2. Edit `ai-editor`, scroll to **Application Passwords**, name it `Claude Code`, click Add.
3. Copy the password. WP shows it once. Spaces in it are fine.

Do not test the password with curl. `npm run workshop` in Step 3 tests it and names the fix for each failure. A curl
command with the password in it lands in shell history, and its output tends to get pasted into chat.

Ask the person to describe what they see after clicking Add. Expected (screenshot:
`docs/workshop/images/app-password-created.png`): a green box reading "Your new password for **ai-editor** is:" followed
by six groups of four characters, a Copy button, and "You will not be able to retrieve it." Treat anything else as a
problem:

- no Application Passwords section, or a warning or error notice instead of the green box: HTTPS is missing or a
  security plugin or host disabled app passwords (see the failure map below)
- the box names a different user: they are on the wrong profile. Have them add it under `ai-editor`
- not six groups of four: they copied something else. Have them add a new one

What got stored: a user row and a hashed app password in the WP database.

Failure map:

| Symptom                          | Likely cause                                        | Fix                                                         |
| -------------------------------- | --------------------------------------------------- | ----------------------------------------------------------- |
| No Application Passwords section | Site not on HTTPS, or a security plugin disabled it | Fix HTTPS or plugin setting; otherwise use a different site |
| `401` with the right password    | Host or firewall strips the `Authorization` header  | `.htaccess` rule, or a different site                       |
| `404` or `rest_no_route`         | REST API blocked, or permalinks set to Plain        | Settings, Permalinks, Post name                             |
| `403` on writes only             | Role too low, or a plugin blocks the route          | Check role is Editor                                        |

---

## Step 2: Build the server

Run in any folder the person wants to keep the tool in (for example `~/dev`):

```bash
git clone https://github.com/clark-mackey/mcp-wordpress.git
cd mcp-wordpress
npm ci
npm run build
```

Expected: install takes about 35 seconds, build about 15 seconds (measured on a fresh clone). Pass: the build ends
without an error.

| Symptom                           | Fix                                                                |
| --------------------------------- | ------------------------------------------------------------------ |
| `npm ci` errors on engine version | Node is below 22.14                                                |
| Build errors                      | Re-run `npm ci`, then `npm run build`. Report the first error line |

---

## Step 3: Connect Claude Code and lock it

**You cannot run this step yourself.** It asks for the app password through a hidden prompt, which needs a real
terminal. Tell the person to open their own terminal window, `cd` into `mcp-wordpress`, and run:

```bash
npm run workshop
```

It asks for the site URL, the username (Enter accepts `ai-editor`), and the app password (nothing shows as they paste;
that is normal). Then it does six things and prints each result:

1. Checks Node, Claude Code, and that the server is built
2. Calls the site's REST API with the login. **It refuses an Administrator account.** Then it checks everything that can
   fail before writing anything: `~/.claude/settings.json` must be valid JSON, and a different server already named `wp`
   stops it
3. Writes `.env` (mode 600) with the URL, username and password, keeping other keys already in it. Asks before replacing
   an existing `.env` and copies the old one to `.env.bak-<time>` (mode 600)
4. Merges 15 deny rules into `~/.claude/settings.json`. It copies the old file to `settings.json.bak-<time>` first (mode
   600), keeps everything already there and the file's permissions, and follows a symlink. This happens **before**
   registration, so a failure never leaves a registered server without its blocked tools
5. Runs `claude mcp add wp --scope user -- node <path>/bin/mcp-wordpress.js`. It replaces only its own earlier entry
6. Starts the server the way Claude Code will (ignoring `WORDPRESS_*` and `ALLOW_*` variables set in the shell), lists
   its tools (expect 105), and calls `wp_get_current_user` to confirm it can reach WordPress

Flags: `--name <server>` (default `wp`; the deny rules use the same name), `--dry-run` (changes nothing),
`--allow-admin` (do not suggest this). `--dry-run` needs the `--` separator: `npm run workshop -- --dry-run`. Unknown
options are rejected.

What got stored:

- `mcp-wordpress/.env`: the only place the password lives
- `~/.claude.json`: an entry named `wp` with the command and an empty `env`. No secret
- `~/.claude/settings.json`: the deny rules, plus a `.bak-<time>` copy of the previous file

The 15 blocked tools: `wp_delete_page`, `wp_delete_post`, `wp_delete_media`, `wp_delete_comment`, `wp_delete_category`,
`wp_delete_tag`, `wp_delete_user`, `wp_delete_application_password`, `wp_create_user`, `wp_update_user`,
`wp_create_application_password`, `wp_switch_auth_method`, `wp_update_site_settings`, `wp_delete_menu_item`,
`wp_delete_widget` (each as `mcp__wp__<tool>`).

After it finishes, verify **without printing the secret**:

```bash
ls -l .env                                     # expect -rw------- (Windows: dir .env)
grep -c "WORDPRESS_APP_PASSWORD" .env          # expect 1
grep -c "mcp__wp__" ~/.claude/settings.json    # expect 15 or more
```

Do not `cat .env`. Then the person quits and reopens Claude Code and runs `/mcp`. Expect `wp` connected. Every tool not
on the deny list asks before it runs (default for MCP tools). Reads can be set to "always allow" the first time Claude
asks.

Failure map for the script:

| Message                                   | Meaning and fix                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "username or app password is wrong"       | Use the WP username, not the display name. Have them paste the app password again                                                                                                                                                                                                                                                                                               |
| "never saw the login"                     | The host strips the `Authorization` header. Have them copy `wordpress/mu-plugins/mcp-wordpress-auth.php` into the site's `wp-content/mu-plugins/` (file manager or SFTP) and re-run setup; it detects the plugin and sets `WORDPRESS_AUTH_HEADER_FALLBACK=true` in `.env`. Alternatives: `CGIPassAuth On` at the top of `.htaccess`, or ask the host to pass the header through |
| "with a web page, not WordPress"          | A firewall, bot filter or staging password blocks `/wp-json/`. Ask the host to allow it, or use a throwaway site                                                                                                                                                                                                                                                                |
| "Application Passwords are turned off"    | A security plugin or the host disabled them. Turn them back on, or use a throwaway site                                                                                                                                                                                                                                                                                         |
| "REST API was not found (404)"            | Site URL must be the Site Address visitors use. Then WP Settings, Permalinks, Post name                                                                                                                                                                                                                                                                                         |
| "redirected to ..."                       | Use the final address it prints (https, and the exact www or non-www form)                                                                                                                                                                                                                                                                                                      |
| "This URL is http://"                     | Use the https address. The server refuses http                                                                                                                                                                                                                                                                                                                                  |
| "local or private address"                | The server refuses localhost and private IPs. Use a public https site                                                                                                                                                                                                                                                                                                           |
| "This account is an Administrator"        | Make an Editor user. Never override this                                                                                                                                                                                                                                                                                                                                        |
| "different MCP server named \"wp\""       | Something else already uses that name. Re-run with `--name <other>` (and use that name in the deny rules), or let the person remove it themselves                                                                                                                                                                                                                               |
| "is not valid JSON"                       | `~/.claude/settings.json` is broken. Nothing was written. Have the person fix it (or fix it with them), then re-run                                                                                                                                                                                                                                                             |
| "registering failed"                      | Login saved and tools blocked; only registration failed. Run the `claude mcp add` command the message prints                                                                                                                                                                                                                                                                    |
| "Server did not start"                    | Run `npm run status` in the `mcp-wordpress` folder and report the first error line                                                                                                                                                                                                                                                                                              |
| `/mcp` shows `wp` failed after a good run | Quit and reopen Claude Code; then `npm run status`                                                                                                                                                                                                                                                                                                                              |

If the script cannot run, the manual path is `npm run setup`, then
`claude mcp add wp --scope user -- node "$(pwd)/bin/mcp-wordpress.js"` (Windows cmd: `"%cd%\bin\mcp-wordpress.js"`;
PowerShell: `"$PWD\bin\mcp-wordpress.js"`), then merge the 15 deny rules by hand. Use the server name `wp`, or change
every `mcp__wp__` prefix to match the name chosen.

---

## Done test (all three must pass, on a test page, not real content)

1. "List my 5 most recent pages and when each was last modified." Expect real pages from their site.
2. "Create a draft page called MCP test, then delete it." Expect: the create works (after approval), the delete is
   **blocked**.
3. "Change the text of the MCP test page to something worse. Then restore the earlier version." Expect: both succeed and
   WP admin shows the change under Revisions.

Afterwards the person trashes the MCP test page in WP admin.

Do not mark the setup finished until all three pass. If test 2 does not block the delete, the deny list is not active.
Re-check the tool names and the server name, and that Claude Code was restarted.

---

## Boundaries to explain (the reason for the deny list)

Plain version for the person: a rule in a prompt is a request, and a rule in code is a wall. These are the walls, from
the strongest to the weakest:

1. **WP role (Editor).** Enforced by WordPress. Cannot delete users, touch plugins, or change site settings, no matter
   what Claude decides.
2. **Tool list.** A tool that is not exposed cannot be called.
3. **Claude Code permissions (the deny list).** Enforced by Claude Code on the person's machine. Protects against
   Claude's mistakes, not against a leaked password.
4. **Instructions** such as "draft first" in `CLAUDE.md`. Useful for workflow, but not a safety layer.
5. **Revisions.** WP saves a revision on every page or post update. `wp_restore_revision` restores one, and the restore
   is itself undoable. Revisions do **not** cover SEO meta, custom fields, deleted media, menus (local snapshots do, see
   "Header, footer and menus"), widgets, or settings. Revisions are an undo button, not a backup, so the person still
   needs daily backups.

A restore keeps the page's status. Restoring a published page changes the live page immediately.

---

## Header, footer and menus (optional)

Only set this up if the person asks. It adds 17 tools (menus, template parts, widgets). Nothing here changes the Step 3
setup except two more deny rules, `wp_delete_menu_item` and `wp_delete_widget`, which `npm run workshop` already adds.

- **Works**: menus on any theme. Header and footer only on block themes (template parts, `wp_list_template_parts`).
- **Footer widgets** (classic themes): `wp_list_widget_areas`, `wp_get_widget_area`, `wp_update_widget` (block, core
  Text and Custom HTML only), `wp_create_widget` (block only). Other plugin widgets are readable by type only. Needs the
  same mu-plugin. Each change snapshots the area to `backups/widgets/<site-key>/` (bound to the full site URL);
  `wp_restore_widget_snapshot` reverts, recreates deleted block widgets and removes widgets added later (skipped if any
  step failed). Warn the person before restoring.
- **Does not work**: classic theme PHP headers and footers, page builders, the Customizer. The tools say "classic theme"
  in plain words; relay that and stop.
- **Permission**: Editors lack `edit_theme_options`. Have the person copy
  `wordpress/mu-plugins/mcp-wordpress-theme-access.php` into `wp-content/mu-plugins/` (set the login name at the top of
  the file if it is not `ai-editor`). It grants that one capability to that one user, only for app-password requests. A
  403 mentioning `edit_theme_options` means it is missing.
- **Undo**: menus have no revisions. Every menu-item change first writes a snapshot to
  `backups/menus/<site-host>/<menuId>-<time>.json` (gitignored, mode 0600), and `wp_restore_menu_snapshot` takes the
  file name and reverts titles, links, parents and order, recreates deleted items and removes added ones. Template parts
  use WordPress 6.4+ revisions: `wp_get_template_part_revisions`, `wp_restore_template_part_revision`. Older WordPress:
  no undo, so get a site backup first.
- Header and footer edits are site-wide and live immediately. Tell the person before making one.

---

## Maintenance and cleanup

| Task                     | How                                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Update the tool          | In the `mcp-wordpress` folder: `git pull`, `npm ci`, `npm run build`, restart Claude Code                                                                                                         |
| Rotate the password      | WP: delete the old app password, create a new one. Re-run `npm run workshop`                                                                                                                      |
| Remove access entirely   | Delete the app password in WP. `claude mcp remove wp`. Delete the `mcp-wordpress` folder (this removes `.env`)                                                                                    |
| Second site              | Do not reuse `.env`. Use a separate clone, or the multi-site config in the repo docs, with a differently named server                                                                             |
| Move to production sites | Before using on a client site: dedicated user, Editor role, one app password per machine, secret in a secrets manager rather than a plain `.env`, deny list in place, revisions on, daily backups |

---

## Report format

When you finish, give the person a short status, not a transcript:

- Built: [list what was done and verified]
- Not verified: [anything you could not check, with why]
- Stored: where the one secret lives and the two config files you touched
- Next: the one thing they should do next

Do not claim "working" without the three-part done test.
