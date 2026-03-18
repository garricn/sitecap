import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { detectCms } from "../lib/cms.js";
import { navigateAndCapture } from "../lib/capture.js";
import { startTestServer } from "./helpers/server.js";

const TEST_DIR = "/tmp/sitecap-test-cms";

describe("CMS detection", () => {
  let browser, context, page, server, baseUrl;

  beforeAll(async () => {
    server = await startTestServer();
    baseUrl = server.url;
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();
  });

  afterAll(async () => {
    await browser.close();
    await server.close();
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe("detectCms", () => {
    it("detects WordPress with high confidence", async () => {
      await page.goto(`${baseUrl}/wordpress`, { waitUntil: "networkidle" });
      const result = await detectCms(page, []);
      expect(result.detected).toBe(true);
      expect(result.cms).toBe("wordpress");
      expect(result.confidence).toBe("high");
      expect(result.indicators.length).toBeGreaterThanOrEqual(2);
      expect(result.version).toBe("6.4");
      expect(result.admin).toBe(true);
    });

    it("detects MODX", async () => {
      await page.goto(`${baseUrl}/modx`, { waitUntil: "networkidle" });
      const result = await detectCms(page, []);
      expect(result.detected).toBe(true);
      expect(result.cms).toBe("modx");
      expect(result.indicators.length).toBeGreaterThanOrEqual(1);
      expect(result.admin).toBe(false);
    });

    it("detects MODX admin session via site_id", async () => {
      await page.goto(`${baseUrl}/modx-admin`, { waitUntil: "networkidle" });
      const result = await detectCms(page, []);
      expect(result.detected).toBe(true);
      expect(result.cms).toBe("modx");
      expect(result.admin).toBe(true);
    });

    it("detects Drupal", async () => {
      await page.goto(`${baseUrl}/drupal`, { waitUntil: "networkidle" });
      const result = await detectCms(page, []);
      expect(result.detected).toBe(true);
      expect(result.cms).toBe("drupal");
      expect(result.version).toBe("10");
      expect(result.indicators.length).toBeGreaterThanOrEqual(2);
      expect(result.admin).toBe(false);
    });

    it("returns not detected on plain page", async () => {
      await page.goto(baseUrl, { waitUntil: "networkidle" });
      const result = await detectCms(page, []);
      expect(result.detected).toBe(false);
      expect(result.cms).toBeNull();
      expect(result.indicators.length).toBe(0);
    });
  });

  describe("capture integration", () => {
    it("writes cms-detect.json when cms type requested", async () => {
      const outDir = join(TEST_DIR, "cms-capture");
      await navigateAndCapture(page, `${baseUrl}/wordpress`, outDir, {
        types: ["cms"],
      });
      const filePath = join(outDir, "cms-detect.json");
      expect(existsSync(filePath)).toBe(true);
      const data = JSON.parse(await readFile(filePath, "utf-8"));
      expect(data.cms).toBe("wordpress");
    });

    it("does NOT write cms-detect.json with default types", async () => {
      const outDir = join(TEST_DIR, "no-cms-capture");
      await navigateAndCapture(page, `${baseUrl}/wordpress`, outDir);
      expect(existsSync(join(outDir, "cms-detect.json"))).toBe(false);
    });
  });
});
