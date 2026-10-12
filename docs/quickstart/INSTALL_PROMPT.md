# Install Prompt

Open Claude Code in an empty folder, then paste everything below the line.

---

You are helping me set up an MCP server that lets you edit one of my WordPress sites. I am an agency owner doing this
for the first time. Work one step at a time and wait for me before moving on.

First read <https://github.com/clark-mackey/mcp-wordpress/blob/main/docs/quickstart/AGENT_CHEATSHEET.md> and follow its
rules. The most important:

- Never ask me to type or paste the WordPress application password into this chat. I will type it into a setup prompt
  myself.
- Never put the password on a command line.
- The WP user must be an Editor, never an Administrator.
- Ask me which site I am using. It should be my own site or a staging copy, not a client's live site, and it must use
  HTTPS.

Steps:

1. Check `node -v` (need 22.14 or newer), `git --version` and `claude --version`. Tell me what is missing.
2. Walk me through creating the `ai-editor` user and an Application Password in WP admin. You cannot do this for me.
3. In a folder I choose, run: `git clone https://github.com/clark-mackey/mcp-wordpress.git`, then in that folder
   `npm ci` and `npm run build`. Report errors in plain English.
4. Tell me to open a separate terminal window, `cd` into the `mcp-wordpress` folder and run `npm run connect`. It will
   ask me for my site URL, username and password. You cannot run this one yourself because it needs me to type the
   password. Wait until I tell you it finished.
5. Verify without printing any secret: `ls -l .env` shows `-rw-------` (on Windows, `dir .env` shows the file),
   `node -e "console.log(require('fs').readFileSync('.env','utf8').split(/\r?\n/).filter(l=>l.startsWith('WORDPRESS_APP_PASSWORD=')).length)"`
   prints 1 (works on every OS), and `~/.claude/settings.json` has 13 `mcp__wp__` entries in `permissions.deny`. Do not
   `cat .env`.
6. Tell me to quit and reopen Claude Code, then run `/mcp` and confirm `wp` is connected.
7. After I reopen, run this test with me: list my 5 newest pages; create a draft page called "MCP test" and try to
   delete it (the delete must be blocked); edit the test page, then restore the earlier version from revisions.

Finish with a short report: what is built and verified, what you could not verify, where the one secret is stored, and
the next thing I should do. Do not say it works until all three tests pass.
