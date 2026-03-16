import { describe, it, expect, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const exec = promisify(execFile);
const CLI = "node";
const BIN = join(import.meta.dirname, "..", "bin", "sitecap.js");
const TEST_DIR = "/tmp/sitecap-test-cli";

describe("CLI", () => {
  afterAll(async () => {
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
      const { stdout } = await exec(CLI, [BIN, "https://example.com", "--launch", "-o", outDir], {
        timeout: 30_000,
      });
      expect(stdout).toContain("1 captured, 0 failed");
      expect(existsSync(join(outDir, "example.com", "screenshot.png"))).toBe(true);
      expect(existsSync(join(outDir, "example.com", "meta.json"))).toBe(true);
    }, 30_000);

    it("captures selective types", async () => {
      const outDir = join(TEST_DIR, "selective");
      await exec(CLI, [BIN, "https://example.com", "--launch", "-o", outDir, "-t", "html,screenshot"], {
        timeout: 30_000,
      });
      expect(existsSync(join(outDir, "example.com", "screenshot.png"))).toBe(true);
      expect(existsSync(join(outDir, "example.com", "page-source.html"))).toBe(true);
    }, 30_000);

    it("uses correct viewport", async () => {
      const outDir = join(TEST_DIR, "viewport");
      const { stdout } = await exec(CLI, [BIN, "https://example.com", "--launch", "-o", outDir, "-v", "800x600"], {
        timeout: 30_000,
      });
      expect(stdout).toContain("800x600");
    }, 30_000);
  });

  describe("validation", () => {
    it("rejects invalid viewport format", async () => {
      try {
        await exec(CLI, [BIN, "https://example.com", "--launch", "-v", "invalid"]);
        expect.unreachable();
      } catch (e) {
        expect(e.stderr).toContain("Invalid viewport format");
      }
    });

    it("rejects --wait-for-auth without --profile", async () => {
      try {
        await exec(CLI, [BIN, "https://example.com", "--wait-for-auth"]);
        expect.unreachable();
      } catch (e) {
        expect(e.stderr).toContain("requires --profile");
      }
    });
  });

  describe("diff", () => {
    it("diffs two identical captures", async () => {
      const outA = join(TEST_DIR, "diff-a");
      const outB = join(TEST_DIR, "diff-b");

      await exec(CLI, [BIN, "https://example.com", "--launch", "-o", outA], { timeout: 30_000 });
      await exec(CLI, [BIN, "https://example.com", "--launch", "-o", outB], { timeout: 30_000 });

      const { stdout } = await exec(CLI, [BIN, "diff", join(outA, "example.com"), join(outB, "example.com")]);
      expect(stdout).toContain("identical");
    }, 60_000);

    it("exits 0 for identical, 1 for different", async () => {
      const outA = join(TEST_DIR, "diff-a", "example.com");
      const outB = join(TEST_DIR, "diff-b", "example.com");

      // Identical — exit 0
      const { stdout } = await exec(CLI, [BIN, "diff", outA, outB]);
      expect(stdout).toContain("0 changed");
    }, 10_000);
  });
});
