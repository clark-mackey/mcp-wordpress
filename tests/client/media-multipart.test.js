import { describe, it, expect, afterEach, vi } from "vitest";
import nock from "nock";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WordPressClient } from "@/client/api.js";
import { CachedWordPressClient } from "@/client/CachedWordPressClient.js";
import { MediaTools } from "@/tools/media.js";

let directory;
afterEach(async () => {
  nock.abortPendingRequests();
  nock.cleanAll();
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("wp_upload_media multipart request", () => {
  it.each([WordPressClient, CachedWordPressClient])("sends multipart bytes and metadata via %s", async (Client) => {
    directory = await mkdtemp(join(tmpdir(), "wp-media-"));
    vi.stubEnv("MCP_UPLOAD_BASE_DIR", directory);
    const filePath = join(directory, "upload.txt");
    await writeFile(filePath, "file bytes, not JSON");
    const client = new Client({
      baseUrl: "https://upload.example.com",
      auth: { method: "app-password", username: "testuser", appPassword: "testpass123" },
    });
    let contentType;
    let body;
    const request = nock("https://upload.example.com")
      .post("/wp-json/wp/v2/media")
      .reply(function (_uri, requestBody) {
        contentType = this.req.headers["content-type"];
        body = Buffer.isBuffer(requestBody) ? requestBody.toString() : String(requestBody);
        return [
          201,
          { id: 123, title: { rendered: "Display title" }, source_url: "https://upload.example.com/upload.txt" },
        ];
      });

    const result = await new MediaTools().handleUploadMedia(client, {
      file_path: filePath,
      title: "Display title",
      alt_text: "Alt text",
    });
    expect(result).toContain("Media uploaded successfully");
    expect(request.isDone()).toBe(true);
    expect(contentType).toMatch(/^multipart\/form-data;\s*boundary=/);
    expect(contentType).not.toContain("application/json");
    expect(body).toContain('filename="upload.txt"');
    expect(body).toContain("file bytes, not JSON");
    expect(body).toContain("Display title");
    expect(body).toContain("Alt text");
  });
});
