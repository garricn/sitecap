import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startTestServer } from "./helpers/server.js";

const exec = promisify(execFile);
const CLI = "node";
const BIN = join(import.meta.dirname, "..", "bin", "sitecap.js");
const TEST_DIR = "/tmp/sitecap-test-cli";

describe("CLI", () => {
  let server, baseUrl;

  beforeAll(async () => {
    server = await startTestServer();
    baseUrl = server.url;
  });

  afterAll(async () => {
    await server.close();
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe("help", () => {
    it("shows help with --help", async () => {
      const { stdout } = await exec(CLI, [BIN, "--help"]);
      expect(stdout).toContain("sitecap — exhaustive web page capture");
      expect(stdout).toContain("--launch");
      expect(stdout).toContain("--crawl");
      expect(stdout).toContain("--explore");
      expect(stdout).toContain("--auth-flow");
    });

    it("shows help with no args", async () => {
      const { stdout } = await exec(CLI, [BIN]);
      expect(stdout).toContain("sitecap — exhaustive web page capture");
    });

    it("shows diff help", async () => {
      const { stdout } = await exec(CLI, [BIN, "diff", "--help"]);
      expect(stdout).toContain("sitecap diff");
      expect(stdout).toContain("--threshold");
    });
  });

  describe("capture", () => {
    it("captures a page with --launch", async () => {
      const outDir = join(TEST_DIR, "capture");
      const { stdout } = await exec(CLI, [BIN, baseUrl, "--launch", "-o", outDir], {
        timeout: 30_000,
      });
      expect(stdout).toContain("1 captured, 0 failed");
      expect(existsSync(join(outDir, "127.0.0.1", "screenshot.png"))).toBe(true);
      expect(existsSync(join(outDir, "127.0.0.1", "meta.json"))).toBe(true);
    }, 30_000);

    it("captures selective types", async () => {
      const outDir = join(TEST_DIR, "selective");
      await exec(CLI, [BIN, baseUrl, "--launch", "-o", outDir, "-t", "html,screenshot"], {
        timeout: 30_000,
      });
      expect(existsSync(join(outDir, "127.0.0.1", "screenshot.png"))).toBe(true);
      expect(existsSync(join(outDir, "127.0.0.1", "page-source.html"))).toBe(true);
    }, 30_000);

    it("--download-assets with multiple URLs creates shared assets/ at outDir root", async () => {
      const outDir = join(TEST_DIR, "shared-cli");
      await exec(CLI, [BIN, baseUrl, `${baseUrl}/about`, "--launch", "-o", outDir, "--download-assets"], {
        timeout: 30_000,
      });
      expect(existsSync(join(outDir, "assets"))).toBe(true);
      expect(existsSync(join(outDir, "assets", "manifest.json"))).toBe(true);
    }, 30_000);

    it("--download-assets --crawl creates shared assets/ at outDir root", async () => {
      const outDir = join(TEST_DIR, "shared-crawl");
      await exec(CLI, [BIN, baseUrl, "--launch", "-o", outDir, "--download-assets", "--crawl", "--max-pages", "3"], {
        timeout: 60_000,
      });
      // Shared assets/ dir exists at outDir root
      expect(existsSync(join(outDir, "assets"))).toBe(true);
      // Site-level manifest exists in shared assets dir
      expect(existsSync(join(outDir, "assets", "manifest.json"))).toBe(true);
      const siteManifest = JSON.parse(await readFile(join(outDir, "assets", "manifest.json"), "utf-8"));
      expect(siteManifest).toHaveProperty("files");
      expect(siteManifest).toHaveProperty("stats");
      expect(siteManifest.stats.totalFiles).toBeGreaterThan(0);
    }, 60_000);

    it("--download-assets --crawl wires sharedAssetsDir to per-page manifests", async () => {
      // Reuse the output from the previous crawl test
      const outDir = join(TEST_DIR, "shared-crawl");
      // Find a per-page assets/manifest.json (the seed page slug is the hostname)
      const seedPageManifest = join(outDir, "127.0.0.1", "assets", "manifest.json");
      expect(existsSync(seedPageManifest)).toBe(true);
      const perPage = JSON.parse(await readFile(seedPageManifest, "utf-8"));
      // Per-page manifest must have deduped flag and sharedDir reference
      expect(perPage.deduped).toBe(true);
      expect(perPage.sharedDir).toBeDefined();
      expect(perPage.assets).toBeDefined();
    }, 10_000);

    it("uses correct viewport", async () => {
      const outDir = join(TEST_DIR, "viewport");
      const { stdout } = await exec(CLI, [BIN, baseUrl, "--launch", "-o", outDir, "-v", "800x600"], {
        timeout: 30_000,
      });
      expect(stdout).toContain("800x600");
    }, 30_000);
  });

  describe("validation", () => {
    it("rejects invalid viewport format", async () => {
      try {
        await exec(CLI, [BIN, baseUrl, "--launch", "-v", "invalid"]);
        expect.unreachable();
      } catch (e) {
        expect(e.stderr).toContain("Invalid viewport format");
      }
    });

    it("rejects --video --session-video together", async () => {
      try {
        await exec(CLI, [BIN, baseUrl, "--launch", "--video", "--session-video"]);
        expect.unreachable();
      } catch (e) {
        expect(e.stderr).toContain("mutually exclusive");
      }
    });

    it("rejects --wait-for-auth without --profile", async () => {
      try {
        await exec(CLI, [BIN, baseUrl, "--wait-for-auth"]);
        expect.unreachable();
      } catch (e) {
        expect(e.stderr).toContain("requires --profile");
      }
    });
  });

  describe("dry-run", () => {
    it("outputs inventory JSON to stdout with no capture files", async () => {
      const { stdout } = await exec(CLI, [BIN, baseUrl, "--launch", "--dry-run", "--max-pages", "3"], {
        timeout: 30_000,
      });
      const inventory = JSON.parse(stdout);
      expect(inventory.pages.length).toBeGreaterThan(0);
      expect(inventory.summary.totalPages).toBe(inventory.pages.length);
      expect(inventory.pages[0].resources).toBeDefined();
      expect(Array.isArray(inventory.pages[0].links)).toBe(true);
      expect(inventory.seed).toBe(baseUrl);
      expect(inventory.timestamp).toBeDefined();
      expect(inventory.duration_ms).toBeGreaterThan(0);
      // No capture files should be written to default output dir
      expect(existsSync(join("output", "127.0.0.1", "screenshot.png"))).toBe(false);
      expect(existsSync(join("output", "127.0.0.1", "meta.json"))).toBe(false);
    }, 30_000);

    it("respects --max-pages", async () => {
      const { stdout } = await exec(CLI, [BIN, baseUrl, "--launch", "--dry-run", "--max-pages", "2"], {
        timeout: 30_000,
      });
      const inventory = JSON.parse(stdout);
      expect(inventory.pages.length).toBeLessThanOrEqual(2);
    }, 30_000);

    it("includes CMS data when -t cms is specified", async () => {
      const { stdout } = await exec(CLI, [BIN, `${baseUrl}/wordpress`, "--launch", "--dry-run", "-t", "cms", "--max-pages", "1"], {
        timeout: 30_000,
      });
      const inventory = JSON.parse(stdout);
      expect(inventory.pages[0].cms).toBeDefined();
      expect(inventory.pages[0].cms.detected).toBe(true);
      expect(inventory.pages[0].cms.cms).toBe("wordpress");
      expect(inventory.pages[0].cms.confidence).toBeDefined();
    }, 30_000);

    it("shows --dry-run in help text", async () => {
      const { stdout } = await exec(CLI, [BIN, "--help"]);
      expect(stdout).toContain("--dry-run");
    });

    it("writes inventory.json when -o is explicitly set", async () => {
      const outDir = join(TEST_DIR, "dry-run-file");
      await exec(CLI, [BIN, baseUrl, "--launch", "--dry-run", "-o", outDir, "--max-pages", "1"], {
        timeout: 30_000,
      });
      expect(existsSync(join(outDir, "inventory.json"))).toBe(true);
      const inventory = JSON.parse(await readFile(join(outDir, "inventory.json"), "utf-8"));
      expect(inventory.pages.length).toBeGreaterThan(0);
    }, 30_000);
  });

  describe("diff", () => {
    it("diffs two identical captures", async () => {
      const outA = join(TEST_DIR, "diff-a");
      const outB = join(TEST_DIR, "diff-b");

      await exec(CLI, [BIN, baseUrl, "--launch", "-o", outA], { timeout: 30_000 });
      await exec(CLI, [BIN, baseUrl, "--launch", "-o", outB], { timeout: 30_000 });

      const { stdout } = await exec(CLI, [BIN, "diff", join(outA, "127.0.0.1"), join(outB, "127.0.0.1")]);
      expect(stdout).toContain("identical");
    }, 60_000);

    it("exits 0 for identical", async () => {
      const outA = join(TEST_DIR, "diff-a", "127.0.0.1");
      const outB = join(TEST_DIR, "diff-b", "127.0.0.1");

      const { stdout } = await exec(CLI, [BIN, "diff", outA, outB]);
      expect(stdout).toContain("0 changed");
    }, 10_000);
  });
});
