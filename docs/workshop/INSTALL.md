# Your WP MCP: 3 Steps

You need: a Mac or Linux machine (Windows: use WSL), Node 22.14 or newer, git, Claude Code, and a WP site you can afford
to break (yours or a staging copy, not a client's live site). The site must use HTTPS.

No suitable site, or yours blocks app passwords? Make a free throwaway WP site (InstaWP or similar) and use that.

Check first. Both must print a version, and node must be v22.14 or higher:

```bash
node -v
git --version
```

No node? Install the current LTS from nodejs.org, then reopen the terminal.

---

## Step 1: Make the key (WP admin, 3 minutes)

1. Users, Add New. Username `ai-editor`. Role **Editor**. Never Administrator. Use a strong password you won't use
   again.
2. Users, edit `ai-editor`, scroll to **Application Passwords**. Name it `Claude Code`. Click Add.
3. Copy the password now. WP shows it once.

Done when you have the password copied. Setup in Step 3 tests it for you.

---

## Step 2: Build the server (about 2 minutes)

```bash
git clone https://github.com/clark-mackey/mcp-wordpress.git
cd mcp-wordpress
npm ci
npm run build
```

Done when the build finishes without an error.

---

## Step 3: Connect Claude and lock it (about 3 minutes)

Run this in your own terminal window, inside the `mcp-wordpress` folder:

```bash
npm run workshop
```

It asks for three things: your site URL, the username (press Enter for `ai-editor`), and the application password (paste
it; nothing shows as you type, that is normal). Then it:

1. Tests the login and **refuses an Administrator account**
2. Checks everything that could fail (your Claude settings file, an existing `wp` entry) **before it writes anything**
3. Saves the login to `.env` (owner-only file inside the `mcp-wordpress` folder)
4. Adds 13 tools to Claude's deny list (all deletes, user and app-password tools, site settings), **before** the server
   is registered
5. Registers the server with Claude Code as `wp`
6. Starts the server and calls WordPress as your `ai-editor` user to confirm it works

Then quit and reopen Claude Code, and run `/mcp`. `wp` should show as connected.

**You are done when all three work:**

1. "List my 5 most recent pages and when each was last modified." Claude returns real pages.
2. "Create a draft page called MCP test, then delete it." The create works, the delete is blocked.
3. "Change the text of the MCP test page to something worse. Then restore the earlier version." Both succeed, and WP
   admin shows the change in Revisions.

The test page keeps all of this away from your real content. Trash it from WP admin when you are done.

Every tool not on the deny list asks before it runs. Reads can be set to "always allow" the first time Claude asks.

### What is stored where

| What                             | Where                                                                                                           |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Site URL, username, app password | `mcp-wordpress/.env` on your laptop (owner-only). The only place the password is stored                         |
| Claude Code registration         | `~/.claude.json`: the command only, no password                                                                 |
| Blocked tools                    | `~/.claude/settings.json` under `permissions.deny`. Your old file is copied to `settings.json.bak-<time>` first |

---

## If it doesn't work

| You see                                | Fix                                                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `node -v` is below 22.14               | Install current LTS from nodejs.org                                                                                    |
| No Application Passwords section in WP | Site needs HTTPS, or a security plugin turned it off. Try a throwaway site                                             |
| Setup says "rejected the login"        | Check the username and password. If both are right, the host or firewall strips the login header. Try a throwaway site |
| Setup says "REST API was not found"    | WP Settings, Permalinks, choose Post name                                                                              |
| Setup says "redirected"                | Use the final address it prints as the Site URL                                                                        |
| Setup says Administrator               | Make an Editor user and use that one                                                                                   |
| `/mcp` shows `wp` failed               | In the `mcp-wordpress` folder run `npm run status` and read the first error                                            |
| Claude can't see the tools             | Quit and reopen Claude Code                                                                                            |

Run `npm run workshop -- --dry-run` (the `--` matters) to see what it would do without changing anything. Run it again
any time: it updates the login in `.env` (keeping your other settings there), does not duplicate rules, and replaces its
own earlier `wp` entry. It will not overwrite a different server that is already named `wp`: use `--name <other-name>`
instead. Old copies of `.env` and `settings.json` are kept next to the originals as `.bak-<time>` (owner-only; delete
them when you are done).

### Doing Step 3 by hand

Only if the script cannot run. In the `mcp-wordpress` folder:

```bash
npm run setup
claude mcp add wp --scope user -- node "$(pwd)/bin/mcp-wordpress.js"
```

Then in Claude Code, ask it to merge the 13 `mcp__wp__...` deny rules listed in `bin/workshop.js` (`DENIED_TOOLS`) into
the `permissions.deny` list in `~/.claude/settings.json`, keeping everything already there.
