import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import { diffCaptures, formatDiffReport } from "../lib/diff.js";

const TEST_DIR = "/tmp/sitecap-test-diff";
const DIR_A = join(TEST_DIR, "a");
const DIR_B = join(TEST_DIR, "b");

describe("diff", () => {
  beforeAll(async () => {
    await mkdir(DIR_A, { recursive: true });
    await mkdir(DIR_B, { recursive: true });
  });

  afterAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe("identical captures", () => {
    beforeAll(async () => {
      // Create identical files in both dirs
      await writeFile(join(DIR_A, "accessibility.txt"), "- document\n  - heading \"Hello\"");
      await writeFile(join(DIR_B, "accessibility.txt"), "- document\n  - heading \"Hello\"");

      await writeFile(join(DIR_A, "console.json"), JSON.stringify([
        { type: "log", text: "info message" },
      ]));
      await writeFile(join(DIR_B, "console.json"), JSON.stringify([
        { type: "log", text: "info message" },
      ]));

      await writeFile(join(DIR_A, "network.json"), JSON.stringify([
        { url: "https://example.com/", method: "GET", status: 200 },
      ]));
      await writeFile(join(DIR_B, "network.json"), JSON.stringify([
        { url: "https://example.com/", method: "GET", status: 200 },
      ]));

      await writeFile(join(DIR_A, "storage.json"), JSON.stringify({
        cookies: [{ name: "session", value: "abc" }],
        localStorage: { key: "val" },
      }));
      await writeFile(join(DIR_B, "storage.json"), JSON.stringify({
        cookies: [{ name: "session", value: "abc" }],
        localStorage: { key: "val" },
      }));

      // Create identical PNGs
      const png = new PNG({ width: 10, height: 10 });
      for (let i = 0; i < png.data.length; i += 4) {
        png.data[i] = 255;     // R
        png.data[i + 1] = 0;   // G
        png.data[i + 2] = 0;   // B
        png.data[i + 3] = 255; // A
      }
      const pngBuf = PNG.sync.write(png);
      await writeFile(join(DIR_A, "screenshot.png"), pngBuf);
      await writeFile(join(DIR_B, "screenshot.png"), pngBuf);
    });

    it("reports identical when files match", async () => {
      const report = await diffCaptures(DIR_A, DIR_B);
      expect(report.identical).toBe(true);
      expect(report.changed).toBe(0);
    });

    it("all individual diffs report unchanged", async () => {
      const report = await diffCaptures(DIR_A, DIR_B);
      expect(report.diffs.screenshot.changed).toBe(false);
      expect(report.diffs.accessibility.changed).toBe(false);
      expect(report.diffs.console.changed).toBe(false);
      expect(report.diffs.network.changed).toBe(false);
      expect(report.diffs.storage.changed).toBe(false);
    });
  });

  describe("different captures", () => {
    const DIFF_A = join(TEST_DIR, "diff-a");
    const DIFF_B = join(TEST_DIR, "diff-b");

    beforeAll(async () => {
      await mkdir(DIFF_A, { recursive: true });
      await mkdir(DIFF_B, { recursive: true });

      // Different accessibility
      await writeFile(join(DIFF_A, "accessibility.txt"), "- document\n  - heading \"Old Title\"");
      await writeFile(join(DIFF_B, "accessibility.txt"), "- document\n  - heading \"New Title\"");

      // Different console (new error in B)
      await writeFile(join(DIFF_A, "console.json"), JSON.stringify([]));
      await writeFile(join(DIFF_B, "console.json"), JSON.stringify([
        { type: "error", text: "Uncaught TypeError" },
      ]));

      // Different network (new request in B)
      await writeFile(join(DIFF_A, "network.json"), JSON.stringify([
        { url: "https://example.com/", method: "GET", status: 200 },
      ]));
      await writeFile(join(DIFF_B, "network.json"), JSON.stringify([
        { url: "https://example.com/", method: "GET", status: 200 },
        { url: "https://example.com/api/new", method: "POST", status: 201 },
      ]));

      // Different storage (new cookie in B)
      await writeFile(join(DIFF_A, "storage.json"), JSON.stringify({
        cookies: [], localStorage: {},
      }));
      await writeFile(join(DIFF_B, "storage.json"), JSON.stringify({
        cookies: [{ name: "tracking", value: "xyz" }], localStorage: { newKey: "val" },
      }));

      // Different screenshots
      const pngA = new PNG({ width: 10, height: 10 });
      const pngB = new PNG({ width: 10, height: 10 });
      for (let i = 0; i < pngA.data.length; i += 4) {
        pngA.data[i] = 255; pngA.data[i + 1] = 0; pngA.data[i + 2] = 0; pngA.data[i + 3] = 255;
        pngB.data[i] = 0; pngB.data[i + 1] = 255; pngB.data[i + 2] = 0; pngB.data[i + 3] = 255;
      }
      await writeFile(join(DIFF_A, "screenshot.png"), PNG.sync.write(pngA));
      await writeFile(join(DIFF_B, "screenshot.png"), PNG.sync.write(pngB));
    });

    it("detects differences", async () => {
      const report = await diffCaptures(DIFF_A, DIFF_B);
      expect(report.identical).toBe(false);
      expect(report.changed).toBeGreaterThan(0);
    });

    it("detects screenshot pixel diff", async () => {
      const report = await diffCaptures(DIFF_A, DIFF_B);
      expect(report.diffs.screenshot.changed).toBe(true);
      expect(report.diffs.screenshot.diffPercent).toBeGreaterThan(0);
    });

    it("detects accessibility changes", async () => {
      const report = await diffCaptures(DIFF_A, DIFF_B);
      expect(report.diffs.accessibility.changed).toBe(true);
      expect(report.diffs.accessibility.added.length).toBeGreaterThan(0);
      expect(report.diffs.accessibility.removed.length).toBeGreaterThan(0);
    });

    it("detects new console errors", async () => {
      const report = await diffCaptures(DIFF_A, DIFF_B);
      expect(report.diffs.console.changed).toBe(true);
      expect(report.diffs.console.added).toContain("Uncaught TypeError");
    });

    it("detects new network requests", async () => {
      const report = await diffCaptures(DIFF_A, DIFF_B);
      expect(report.diffs.network.changed).toBe(true);
      expect(report.diffs.network.added.length).toBe(1);
      expect(report.diffs.network.added[0].request).toContain("/api/new");
    });

    it("detects new storage keys", async () => {
      const report = await diffCaptures(DIFF_A, DIFF_B);
      expect(report.diffs.storage.changed).toBe(true);
      expect(report.diffs.storage.cookies.added).toContain("tracking");
      expect(report.diffs.storage.localStorage.added).toContain("newKey");
    });
  });

  describe("missing files", () => {
    const MISS_A = join(TEST_DIR, "miss-a");
    const MISS_B = join(TEST_DIR, "miss-b");

    beforeAll(async () => {
      await mkdir(MISS_A, { recursive: true });
      await mkdir(MISS_B, { recursive: true });
      // Only A has accessibility
      await writeFile(join(MISS_A, "accessibility.txt"), "- document");
    });

    it("reports missing file gracefully", async () => {
      const report = await diffCaptures(MISS_A, MISS_B, { types: ["accessibility"] });
      expect(report.diffs.accessibility.changed).toBe(true);
      expect(report.diffs.accessibility.error).toContain("missing");
    });
  });

  describe("screenshot dimension mismatch", () => {
    const DIM_A = join(TEST_DIR, "dim-a");
    const DIM_B = join(TEST_DIR, "dim-b");

    beforeAll(async () => {
      await mkdir(DIM_A, { recursive: true });
      await mkdir(DIM_B, { recursive: true });

      const pngSmall = new PNG({ width: 10, height: 10 });
      const pngBig = new PNG({ width: 20, height: 20 });
      pngSmall.data.fill(255);
      pngBig.data.fill(255);
      await writeFile(join(DIM_A, "screenshot.png"), PNG.sync.write(pngSmall));
      await writeFile(join(DIM_B, "screenshot.png"), PNG.sync.write(pngBig));
    });

    it("reports dimension difference", async () => {
      const report = await diffCaptures(DIM_A, DIM_B, { types: ["screenshot"] });
      expect(report.diffs.screenshot.changed).toBe(true);
      expect(report.diffs.screenshot.reason).toBe("dimensions differ");
      expect(report.diffs.screenshot.dimA).toBe("10x10");
      expect(report.diffs.screenshot.dimB).toBe("20x20");
    });
  });

  describe("formatDiffReport", () => {
    it("formats identical report", async () => {
      const report = await diffCaptures(DIR_A, DIR_B);
      const output = formatDiffReport(report);
      expect(output).toContain("identical");
      expect(output).toContain("0 changed");
    });

    it("formats changed report", async () => {
      const DIFF_A = join(TEST_DIR, "diff-a");
      const DIFF_B = join(TEST_DIR, "diff-b");
      const report = await diffCaptures(DIFF_A, DIFF_B);
      const output = formatDiffReport(report);
      expect(output).toContain("✗");
      expect(output).toContain("changed");
    });
  });

  describe("threshold", () => {
    it("passes with high threshold on different screenshots", async () => {
      const DIFF_A = join(TEST_DIR, "diff-a");
      const DIFF_B = join(TEST_DIR, "diff-b");
      const report = await diffCaptures(DIFF_A, DIFF_B, { types: ["screenshot"], threshold: 100 });
      expect(report.diffs.screenshot.changed).toBe(false);
    });
  });
});
