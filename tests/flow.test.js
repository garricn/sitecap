import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import { writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { runAuthFlow } from "../lib/auth.js";

const TEST_DIR = "/tmp/sitecap-test-flow";

describe("flow executor", () => {
  let browser, context, page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterAll(async () => {
    await browser.close();
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe("basic steps", () => {
    it("executes goto step", async () => {
      const flowPath = join(TEST_DIR, "goto-flow.yaml");
      await writeFile(flowPath, `
name: goto-test
steps:
  - goto: https://example.com
  - wait: settle
`);
      await page.goto("about:blank");
      const result = await runAuthFlow(flowPath, page, context);
      expect(result).toBe(true);
      expect(page.url()).toBe("https://example.com/");
    });

    it("executes click step", async () => {
      await page.goto("https://example.com", { waitUntil: "networkidle" });
      const flowPath = join(TEST_DIR, "click-flow.yaml");
      await writeFile(flowPath, `
name: click-test
steps:
  - click: "a:has-text('More information')"
    optional: true
    timeout: 2000
`);
      const result = await runAuthFlow(flowPath, page, context);
      expect(result).toBe(true);
    }, 15_000);

    it("handles optional steps gracefully", async () => {
      await page.goto("https://example.com", { waitUntil: "networkidle" });
      const flowPath = join(TEST_DIR, "optional-flow.yaml");
      await writeFile(flowPath, `
name: optional-test
steps:
  - click: "#nonexistent-button"
    optional: true
    timeout: 1000
  - wait: settle
`);
      const result = await runAuthFlow(flowPath, page, context);
      expect(result).toBe(true);
    });

    it("fails on non-optional missing element", async () => {
      await page.goto("https://example.com", { waitUntil: "networkidle" });
      const flowPath = join(TEST_DIR, "fail-flow.yaml");
      await writeFile(flowPath, `
name: fail-test
steps:
  - click: "#nonexistent-button"
    timeout: 1000
`);
      const result = await runAuthFlow(flowPath, page, context);
      expect(result).toBe(false);
    });
  });

  describe("env var resolution", () => {
    it("fails on missing env var", async () => {
      await page.goto("https://example.com", { waitUntil: "networkidle" });
      const flowPath = join(TEST_DIR, "env-missing.yaml");
      await writeFile(flowPath, `
name: env-missing
steps:
  - fill:
      selector: "input"
      value: "$NONEXISTENT_VAR_12345"
`);
      const result = await runAuthFlow(flowPath, page, context);
      expect(result).toBe(false);
    }, 15_000);
  });

  describe("capture step", () => {
    it("captures to named subdirectory", async () => {
      await page.goto("https://example.com", { waitUntil: "networkidle" });
      const flowPath = join(TEST_DIR, "capture-flow.yaml");
      const captureOutDir = join(TEST_DIR, "captures");
      await writeFile(flowPath, `
name: capture-test
steps:
  - wait: settle
  - capture: test-capture
`);
      const result = await runAuthFlow(flowPath, page, context, {
        outDir: captureOutDir,
        types: ["html"],
      });
      expect(result).toBe(true);
      expect(existsSync(join(captureOutDir, "test-capture", "page-source.html"))).toBe(true);
      expect(existsSync(join(captureOutDir, "test-capture", "meta.json"))).toBe(true);
    });
  });

  describe("foreach step", () => {
    it("iterates over matching elements", async () => {
      await page.goto("https://example.com", { waitUntil: "networkidle" });
      const flowPath = join(TEST_DIR, "foreach-flow.yaml");
      const captureOutDir = join(TEST_DIR, "foreach-captures");
      await writeFile(flowPath, `
name: foreach-test
steps:
  - wait: settle
  - foreach:
      selector: "p"
      steps:
        - capture: paragraph-{index}
`);
      const result = await runAuthFlow(flowPath, page, context, {
        outDir: captureOutDir,
        types: ["html"],
      });
      expect(result).toBe(true);
      // example.com has at least 1 paragraph
      expect(existsSync(join(captureOutDir, "paragraph-0", "page-source.html"))).toBe(true);
    });

    it("handles zero elements gracefully", async () => {
      await page.goto("https://example.com", { waitUntil: "networkidle" });
      const flowPath = join(TEST_DIR, "foreach-empty.yaml");
      await writeFile(flowPath, `
name: foreach-empty
steps:
  - foreach:
      selector: ".nonexistent-class"
      steps:
        - capture: item-{index}
`);
      const result = await runAuthFlow(flowPath, page, context, {
        outDir: join(TEST_DIR, "foreach-empty-captures"),
      });
      expect(result).toBe(true);
    });
  });

  describe("cookie steps", () => {
    it("saves and restores cookies", async () => {
      await page.goto("https://example.com", { waitUntil: "networkidle" });

      // Add a test cookie
      await context.addCookies([{
        name: "test_cookie",
        value: "test_value",
        domain: "example.com",
        path: "/",
      }]);

      // Save and restore must use the SAME flow path (cache key is derived from path)
      const flowPath = join(TEST_DIR, "cookie-roundtrip.yaml");

      await writeFile(flowPath, `
name: cookie-save
steps:
  - cookies: save
`);
      const result = await runAuthFlow(flowPath, page, context);
      expect(result).toBe(true);

      // Clear cookies
      await context.clearCookies();

      // Restore using same flow path
      await writeFile(flowPath, `
name: cookie-restore
steps:
  - cookies: restore
`);
      const result2 = await runAuthFlow(flowPath, page, context);
      expect(result2).toBe(true);

      const cookies = await context.cookies();
      const testCookie = cookies.find((c) => c.name === "test_cookie");
      expect(testCookie).toBeDefined();
      expect(testCookie.value).toBe("test_value");
    });
  });
});
