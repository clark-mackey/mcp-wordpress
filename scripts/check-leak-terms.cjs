#!/usr/bin/env node
/**
 * Leak guard: fails when new content contains a protected term.
 *
 * This repo is public and mirrored downstream, so names and details from any one deployment must not land here. The
 * terms themselves are private: they come from the LEAK_TERMS environment variable (CI secret) or from the file named
 * by LEAK_TERMS_FILE (default ~/.config/mcp-wordpress/leak-terms.txt). One term per line, `#` starts a comment, matching
 * is case-insensitive on whole words. Output never contains a term: a location that itself matches is redacted.
 *
 * Usage:
 *   check-leak-terms.cjs --staged                 added lines and paths in the staged diff (pre-commit)
 *   check-leak-terms.cjs --message-file <path>    a commit message (commit-msg)
 *   check-leak-terms.cjs --range <base>..<head>   every commit in the range: its patch and message, plus the
 *                                                 endpoint diff (CI)
 *   --require-terms                               fail when no terms are configured (CI)
 * In GitHub Actions, the pull request title and body are read from GITHUB_EVENT_PATH, never from step env (step env
 * is printed in public logs).
 *
 * ponytail: whole-word literal matching only, and merge commits are covered by the endpoint diff rather than their own
 * combined patch; add a `re:` prefix or `--cc` parsing here if either ceiling is hit.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_TERMS_FILE = path.join(os.homedir(), ".config", "mcp-wordpress", "leak-terms.txt");
// --text and --no-textconv keep binary-looking and `-diff` files from hiding their content.
const DIFF_OPTIONS = ["-U0", "--text", "--no-textconv", "--no-ext-diff", "--no-color"];
const SCISSORS = "# ------------------------ >8 ------------------------";

function parseTerms(text) {
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ term: line.replace(/#.*/, "").trim(), number: index + 1 }))
    .filter((entry) => entry.term.length > 0);
}

function compileTerms(entries) {
  return entries.map(({ term, number }) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return { number, pattern: new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "i") };
  });
}

/**
 * Items to scan from a `git diff -U0` patch: each added line (with file and new-file line number) and each new path.
 * File headers are read only between `diff --git` and the first hunk, so added content that looks like a header
 * (`+++ x`) is still scanned as content.
 */
function addedLines(diffText) {
  const items = [];
  let file = null;
  let inHunk = false;
  let lineNumber = 0;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = null;
      inHunk = false;
    } else if (!inHunk && line.startsWith("+++ ")) {
      file =
        line === "+++ /dev/null"
          ? null
          : line
              .slice(4)
              .replace(/^"?b\//, "")
              .replace(/"$/, "");
      if (file) items.push({ where: "file path", text: file });
    } else if (!inHunk && /^(rename|copy) to /.test(line)) {
      items.push({ where: "file path", text: line.replace(/^(rename|copy) to /, "") });
    } else if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
      inHunk = true;
      lineNumber = Number(/ \+(\d+)/.exec(line)[1]);
    } else if (inHunk && line.startsWith("+")) {
      items.push({ where: file ? `${file}:${lineNumber}` : "added line", text: line.slice(1) });
      lineNumber += 1;
    }
  }
  return items;
}

/** A commit message as git stores it: comment lines and everything below the `commit -v` scissors line dropped. */
function messageText(raw) {
  const cut = raw.indexOf(SCISSORS);
  return (cut === -1 ? raw : raw.slice(0, cut))
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n");
}

function findHits(items, matchers) {
  const hits = [];
  for (const item of items) {
    const where = matchers.some((matcher) => matcher.pattern.test(item.where)) ? "[redacted location]" : item.where;
    for (const matcher of matchers) {
      if (matcher.pattern.test(item.text)) hits.push({ where, number: matcher.number });
    }
  }
  return hits;
}

function formatHit(hit) {
  return `${hit.where}: matches protected term on line ${hit.number} of the term list`;
}

function loadTerms(env) {
  if (env.LEAK_TERMS && env.LEAK_TERMS.trim()) return parseTerms(env.LEAK_TERMS);
  const file = env.LEAK_TERMS_FILE || DEFAULT_TERMS_FILE;
  return fs.existsSync(file) ? parseTerms(fs.readFileSync(file, "utf8")) : [];
}

function pullRequestItems(env) {
  if (!env.GITHUB_EVENT_PATH || !fs.existsSync(env.GITHUB_EVENT_PATH)) return [];
  const pullRequest = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8")).pull_request;
  if (!pullRequest) return [];
  return [
    { where: "pull request title", text: pullRequest.title || "" },
    { where: "pull request body", text: pullRequest.body || "" },
  ];
}

function collectItems(args, env, cwd) {
  const git = (gitArgs) =>
    execFileSync("git", ["-c", "core.quotePath=false", ...gitArgs], {
      cwd,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  const items = [];
  const range = args.includes("--range") ? args[args.indexOf("--range") + 1] : null;
  const messageFile = args.includes("--message-file") ? args[args.indexOf("--message-file") + 1] : null;

  if (args.includes("--staged")) {
    items.push(...addedLines(git(["diff", "--cached", ...DIFF_OPTIONS])));
  }
  if (range) {
    // Each commit's own patch catches a term added in one commit and removed in a later one; the endpoint diff covers
    // content introduced by merge resolutions.
    items.push(...addedLines(git(["diff", ...DIFF_OPTIONS, range])));
    const commits = git(["rev-list", range.replace("...", "..")])
      .split("\n")
      .filter(Boolean);
    for (const sha of commits) {
      if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error("unexpected commit id from git rev-list");
      items.push(...addedLines(git(["diff-tree", "--root", "--no-commit-id", "-p", ...DIFF_OPTIONS, sha])));
      items.push({ where: `commit ${sha.slice(0, 12)} message`, text: git(["show", "-s", "--format=%B", sha]) });
    }
  }
  if (messageFile) {
    items.push({ where: "commit message", text: messageText(fs.readFileSync(messageFile, "utf8")) });
  }
  items.push(...pullRequestItems(env));
  return items;
}

function main(args, env, cwd = process.cwd()) {
  const terms = loadTerms(env);
  if (terms.length === 0) {
    if (args.includes("--require-terms")) {
      console.error("Leak guard: no protected terms configured (LEAK_TERMS is empty).");
      return 1;
    }
    return 0;
  }
  let items;
  try {
    items = collectItems(args, env, cwd);
  } catch (error) {
    // Never echo the error object: it can carry the git output being scanned.
    console.error(`Leak guard: could not read the changes to scan (${error.code || error.status || "error"}).`);
    return 1;
  }
  const hits = findHits(items, compileTerms(terms));
  if (hits.length === 0) return 0;
  console.error("Leak guard: this change contains deployment-specific terms. Remove them before it reaches the repo.");
  for (const hit of hits) console.error(`  ${formatHit(hit)}`);
  return 1;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2), process.env);
}

module.exports = { parseTerms, compileTerms, addedLines, messageText, findHits, formatHit, main };
