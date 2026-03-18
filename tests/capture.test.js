import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { capturePage, navigateAndCapture, extractLinks, waitForPageSettle } from "../lib/capture.js";
import { createCaptureSession, closeCaptureSession } from "../lib/browser.js";
import { startTestServer } from "./helpers/server.js";

const TEST_DIR = "/tmp/sitecap-test-capture";

describe("capture", () => {
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

  describe("capturePage", () => {
    it("captures all default types", async () => {
      await page.goto(baseUrl, { waitUntil: "networkidle" });
      const outDir = join(TEST_DIR, "all-types");
      const meta = await capturePage(page, outDir);

      expect(meta.url).toBe(`${baseUrl}/`);
      expect(meta.timestamp).toBeDefined();
      expect(meta.duration_ms).toBeGreaterThanOrEqual(0);
      expect(meta.captures.screenshot).toContain("screenshot.png");
      expect(meta.captures.accessibility).toContain("accessibility.txt");
      expect(meta.captures.html).toContain("page-source.html");
      expect(meta.captures.storage).toContain("storage.json");
      expect(meta.captures.performance).toContain("performance.json");
      expect(meta.errors).toBeUndefined();
    });

    it("captures only requested types", async () => {
      await page.goto(baseUrl, { waitUntil: "networkidle" });
      const outDir = join(TEST_DIR, "selective");
      const meta = await capturePage(page, outDir, { types: ["screenshot", "html"] });

      expect(meta.captures.screenshot).toBeDefined();
      expect(meta.captures.html).toBeDefined();
      expect(meta.captures.accessibility).toBeUndefined();
      expect(meta.captures.storage).toBeUndefined();
    });

    it("writes valid screenshot PNG", async () => {
      const outDir = join(TEST_DIR, "all-types");
      const data = await readFile(join(outDir, "screenshot.png"));
      expect(data[0]).toBe(0x89);
      expect(data[1]).toBe(0x50);
      expect(data[2]).toBe(0x4e);
      expect(data[3]).toBe(0x47);
    });

    it("writes valid accessibility tree", async () => {
      const outDir = join(TEST_DIR, "all-types");
      const tree = await readFile(join(outDir, "accessibility.txt"), "utf-8");
      expect(tree.length).toBeGreaterThan(0);
      expect(tree).toMatch(/RootWebArea|document/);
    });

    it("writes valid HTML", async () => {
      const outDir = join(TEST_DIR, "all-types");
      const html = await readFile(join(outDir, "page-source.html"), "utf-8");
      expect(html).toContain("<html");
      expect(html).toContain("Test Page");
    });

    it("writes valid performance.json", async () => {
      const outDir = join(TEST_DIR, "all-types");
      const perf = JSON.parse(await readFile(join(outDir, "performance.json"), "utf-8"));
      expect(perf.navigation).toBeDefined();
      expect(perf.navigation.ttfb).toBeGreaterThanOrEqual(0);
      expect(perf.resources).toBeDefined();
      expect(perf.resources.count).toBeGreaterThanOrEqual(0);
    });

    it("writes valid storage.json", async () => {
      const outDir = join(TEST_DIR, "all-types");
      const storage = JSON.parse(await readFile(join(outDir, "storage.json"), "utf-8"));
      expect(storage.cookies).toBeDefined();
      expect(Array.isArray(storage.cookies)).toBe(true);
      expect(storage.localStorage).toBeDefined();
      expect(storage.sessionStorage).toBeDefined();
    });

    it("writes meta.json", async () => {
      const outDir = join(TEST_DIR, "all-types");
      const meta = JSON.parse(await readFile(join(outDir, "meta.json"), "utf-8"));
      expect(meta.url).toBe(`${baseUrl}/`);
      expect(meta.timestamp).toBeDefined();
      expect(meta.captures).toBeDefined();
    });
  });

  describe("navigateAndCapture", () => {
    it("navigates and captures in one call", async () => {
      const outDir = join(TEST_DIR, "nav-capture");
      const meta = await navigateAndCapture(page, baseUrl, outDir, {
        types: ["html", "screenshot"],
      });

      expect(meta.url).toBe(`${baseUrl}/`);
      expect(meta.captures.html).toBeDefined();
      expect(meta.captures.screenshot).toBeDefined();
    });

    it("captures network requests", async () => {
      const outDir = join(TEST_DIR, "nav-network");
      await navigateAndCapture(page, baseUrl, outDir);

      const network = JSON.parse(await readFile(join(outDir, "network.json"), "utf-8"));
      expect(Array.isArray(network)).toBe(true);
      expect(network.length).toBeGreaterThan(0);
      expect(network[0].url).toContain("127.0.0.1");
      expect(network[0].status).toBe(200);
      expect(network[0].timing).toBeDefined();
    });

    it("captures console messages", async () => {
      const outDir = join(TEST_DIR, "nav-console");
      await navigateAndCapture(page, baseUrl, outDir);

      const consolePath = join(outDir, "console.json");
      expect(existsSync(consolePath)).toBe(true);
      const messages = JSON.parse(await readFile(consolePath, "utf-8"));
      expect(Array.isArray(messages)).toBe(true);
    });
  });

  describe("extractLinks", () => {
    it("extracts same-origin links", async () => {
      await page.goto(baseUrl, { waitUntil: "networkidle" });
      const links = await extractLinks(page);

      expect(Array.isArray(links)).toBe(true);
      expect(links.length).toBe(2); // /about and /contact (external filtered out)
      for (const link of links) {
        expect(link).toContain("127.0.0.1");
      }
    });

    it("filters out external links", async () => {
      await page.goto(baseUrl, { waitUntil: "networkidle" });
      const links = await extractLinks(page);
      for (const link of links) {
        expect(link).not.toContain("external.example.com");
      }
    });

    it("deduplicates links", async () => {
      await page.goto(baseUrl, { waitUntil: "networkidle" });
      const links = await extractLinks(page);
      const unique = new Set(links);
      expect(links.length).toBe(unique.size);
    });

    it("strips fragments", async () => {
      await page.goto(baseUrl, { waitUntil: "networkidle" });
      const links = await extractLinks(page);
      for (const link of links) {
        expect(link).not.toContain("#");
      }
    });
  });

  describe("createCaptureSession", () => {
    it("produces session-video.webm when video enabled", async () => {
      const outDir = join(TEST_DIR, "session-video");
      const session = await createCaptureSession(browser, { width: 1280, height: 720 }, {
        video: true,
        videoDir: outDir,
      });
      await navigateAndCapture(session.page, baseUrl, join(outDir, "page1"), { types: ["html"] });
      const result = await closeCaptureSession(session);
      expect(result.videoPath).toContain("session-video.webm");
      expect(existsSync(join(outDir, "session-video.webm"))).toBe(true);
    }, 30_000);

    it("produces no video when video disabled", async () => {
      const outDir = join(TEST_DIR, "no-session-video");
      const session = await createCaptureSession(browser, { width: 1280, height: 720 }, {
        video: false,
        videoDir: outDir,
      });
      await navigateAndCapture(session.page, baseUrl, join(outDir, "page1"), { types: ["html"] });
      const result = await closeCaptureSession(session);
      expect(result.videoPath).toBeNull();
      expect(existsSync(join(outDir, "session-video.webm"))).toBe(false);
    }, 30_000);
  });

  describe("downloadAssets", () => {
    it("downloads assets and creates manifest", async () => {
      const outDir = join(TEST_DIR, "assets-test");
      await navigateAndCapture(page, baseUrl, outDir, { downloadAssets: true });
      expect(existsSync(join(outDir, "assets"))).toBe(true);
      expect(existsSync(join(outDir, "assets", "manifest.json"))).toBe(true);
      const manifest = JSON.parse(await readFile(join(outDir, "assets", "manifest.json"), "utf-8"));
      const urls = Object.keys(manifest);
      expect(urls.some((u) => u.includes("style.css"))).toBe(true);
      expect(urls.some((u) => u.includes("script.js"))).toBe(true);
    }, 30_000);

    it("creates page-source-local.html with rewritten URLs", async () => {
      const outDir = join(TEST_DIR, "assets-test");
      expect(existsSync(join(outDir, "page-source-local.html"))).toBe(true);
      const html = await readFile(join(outDir, "page-source-local.html"), "utf-8");
      expect(html).toContain("assets/");
      expect(html).not.toContain("/style.css");
    });

    it("does NOT create assets/ without flag", async () => {
      const outDir = join(TEST_DIR, "no-assets");
      await navigateAndCapture(page, baseUrl, outDir);
      expect(existsSync(join(outDir, "assets"))).toBe(false);
    });
  });

  describe("waitForPageSettle", () => {
    it("settles on a static page quickly", async () => {
      await page.goto(baseUrl, { waitUntil: "networkidle" });
      const start = Date.now();
      await waitForPageSettle(page, { quietMs: 200, maxTimeout: 5000 });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(2000);
    });

    it("respects maxTimeout", async () => {
      await page.goto(baseUrl, { waitUntil: "networkidle" });
      const start = Date.now();
      await waitForPageSettle(page, { quietMs: 200, maxTimeout: 100 });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });
  });
});
