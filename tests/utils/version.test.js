import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readOwnPackageJson, getVersion } from "../../dist/utils/version.js";

describe("readOwnPackageJson", () => {
  let root;
  const writePackage = (dir, pkg) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mcp-wp-version-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("finds the plugin package.json beside a bundle directory", () => {
    writePackage(join(root, "plugin"), { name: "mcp-wordpress", version: "9.8.7" });
    mkdirSync(join(root, "plugin", "bundle"));
    expect(readOwnPackageJson(join(root, "plugin", "bundle"))?.version).toBe("9.8.7");
  });

  it("skips a package.json that belongs to another package", () => {
    writePackage(root, { name: "mcp-wordpress", version: "1.2.3" });
    writePackage(join(root, "host"), { name: "someone-elses-app", version: "5.0.0" });
    expect(readOwnPackageJson(join(root, "host"))?.version).toBe("1.2.3");
  });

  it("returns undefined when no package.json is found", () => {
    mkdirSync(join(root, "a", "b", "c", "d"), { recursive: true });
    expect(readOwnPackageJson(join(root, "a", "b", "c", "d"))).toBeUndefined();
  });

  it("reports the source checkout's package.json version", async () => {
    const { default: pkg } = await import("../../package.json", { with: { type: "json" } });
    expect(getVersion()).toBe(pkg.version);
  });
});
