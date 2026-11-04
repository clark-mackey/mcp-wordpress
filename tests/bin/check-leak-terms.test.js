import { createRequire } from "module";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { vi } from "vitest";

// scripts/check-leak-terms.cjs is CommonJS; load it natively so the test exercises what the hooks and CI execute.
const require = createRequire(import.meta.url);
const {
  parseTerms,
  compileTerms,
  addedLines,
  messageText,
  findHits,
  formatHit,
  main,
} = require("../../scripts/check-leak-terms.cjs");

const TERMS = "Acme Studio";

const DIFF = [
  "diff --git a/docs/a.md b/docs/a.md",
  "--- a/docs/a.md",
  "+++ b/docs/a.md",
  "@@ -3,0 +4,3 @@",
  "+Acme Studio runs this server.",
  "+Nothing to see here.",
  "++++ /dev/null",
  "diff --git a/old.md b/old.md",
  "--- a/old.md",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-Acme Studio was here.",
].join("\n");

/** Runs main() with console.error captured; returns the exit code and everything printed. */
function run(args, env, cwd) {
  const output = [];
  const spy = vi.spyOn(console, "error").mockImplementation((line) => output.push(line));
  try {
    return { code: main(args, env, cwd), output: output.join("\n") };
  } finally {
    spy.mockRestore();
  }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "leak-terms-"));
}

describe("check-leak-terms", () => {
  // A GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE inherited from a hook or wrapper would point the temp-repo git commands
  // (here and in the script) at the real checkout.
  const GIT_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"];
  const savedGitEnv = {};
  beforeAll(() => {
    for (const name of GIT_ENV) {
      savedGitEnv[name] = process.env[name];
      delete process.env[name];
    }
  });
  afterAll(() => {
    for (const name of GIT_ENV) {
      if (savedGitEnv[name] !== undefined) process.env[name] = savedGitEnv[name];
    }
  });

  it("parses one term per line, skipping blanks and comments", () => {
    expect(parseTerms("# private list\nAcme Studio\n\nbravo-corp  # client\n")).toEqual([
      { term: "Acme Studio", number: 2 },
      { term: "bravo-corp", number: 4 },
    ]);
  });

  it("matches whole words case-insensitively and escapes regex characters", () => {
    const [acme, dotted] = compileTerms([
      { term: "acme", number: 1 },
      { term: "a.b", number: 2 },
    ]);
    expect(acme.pattern.test("Built by ACME.")).toBe(true);
    expect(acme.pattern.test("acme_sites")).toBe(true);
    expect(acme.pattern.test("pacmeal")).toBe(false);
    expect(acme.pattern.test("acmecorp")).toBe(false);
    expect(dotted.pattern.test("a.b")).toBe(true);
    expect(dotted.pattern.test("axb")).toBe(false);
  });

  it("reads added lines and new paths, scanning header-like content and ignoring deletions", () => {
    expect(addedLines(DIFF)).toEqual([
      { where: "file path", text: "docs/a.md" },
      { where: "docs/a.md:4", text: "Acme Studio runs this server." },
      { where: "docs/a.md:5", text: "Nothing to see here." },
      { where: "docs/a.md:6", text: "+++ /dev/null" },
    ]);
  });

  it("scans the destination of a pure rename", () => {
    const rename =
      "diff --git a/x.md b/acme-studio.md\nsimilarity index 100%\nrename from x.md\nrename to acme-studio.md";
    expect(addedLines(rename)).toEqual([{ where: "file path", text: "acme-studio.md" }]);
  });

  it("drops comment lines and the commit -v diff from a message", () => {
    const raw =
      "fix: tidy docs\n# Please enter the commit message\n# ------------------------ >8 ------------------------\n-Acme Studio\n";
    expect(messageText(raw)).toBe("fix: tidy docs\n");
  });

  it("reports hits without the term, redacting locations that contain it", () => {
    const items = [
      { where: "docs/a.md:4", text: "Acme Studio" },
      { where: "docs/acme studio.md:1", text: "about Acme Studio" },
    ];
    const hits = findHits(items, compileTerms(parseTerms(TERMS)));
    expect(hits.map(formatHit)).toEqual([
      "docs/a.md:4: matches protected term on line 1 of the term list",
      "[redacted location]: matches protected term on line 1 of the term list",
    ]);
  });

  it("passes when no terms are configured, unless terms are required", () => {
    const env = { LEAK_TERMS_FILE: path.join(os.tmpdir(), "no-such-leak-terms.txt") };
    expect(run([], env).code).toBe(0);
    expect(run(["--require-terms"], env).code).toBe(1);
  });

  it("checks the commit message and the pull request event, never printing the term", () => {
    const dir = tempDir();
    try {
      const messageFile = path.join(dir, "COMMIT_EDITMSG");
      fs.writeFileSync(messageFile, "docs: notes for Acme Studio\n");
      const eventFile = path.join(dir, "event.json");
      fs.writeFileSync(eventFile, JSON.stringify({ pull_request: { title: "generic", body: "for acme studio" } }));

      const message = run(["--message-file", messageFile], { LEAK_TERMS: TERMS });
      const event = run([], { LEAK_TERMS: TERMS, GITHUB_EVENT_PATH: eventFile });
      expect(message.code).toBe(1);
      expect(event.code).toBe(1);
      expect(event.output).toMatch(/pull request body/);
      expect(message.output + event.output).not.toMatch(/acme/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds a term added in one commit and removed in the next, and in binary-looking files", () => {
    const dir = tempDir();
    const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    try {
      git("init", "-q");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      fs.writeFileSync(path.join(dir, "a.md"), "start\n");
      git("add", ".");
      git("commit", "-q", "-m", "base");
      const base = git("rev-parse", "HEAD");

      fs.writeFileSync(path.join(dir, "a.md"), "start\nAcme Studio\n");
      git("commit", "-q", "-am", "add");
      fs.writeFileSync(path.join(dir, "a.md"), "start\n");
      git("commit", "-q", "-am", "remove");
      const history = run(["--range", `${base}..HEAD`], { LEAK_TERMS: TERMS }, dir);
      expect(history.code).toBe(1);

      fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from("\0\0Acme Studio\0"));
      git("add", "blob.bin");
      expect(run(["--staged"], { LEAK_TERMS: TERMS }, dir).code).toBe(1);
      expect(history.output).not.toMatch(/acme/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed without echoing git output when the range cannot be read", () => {
    const dir = tempDir();
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      const result = run(["--range", "0000000000000000000000000000000000000000..HEAD"], { LEAK_TERMS: TERMS }, dir);
      expect(result.code).toBe(1);
      expect(result.output).toMatch(/could not read the changes/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
