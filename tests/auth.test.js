import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import { writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { runAuthFlow, buildSectionTree } from "../lib/auth.js";
import { startTestServer } from "./helpers/server.js";

const TEST_DIR = "/tmp/sitecap-test-flow";

describe("flow executor", () => {
  let browser, context, page, server, baseUrl;

  beforeAll(async () => {
    server = await startTestServer();
    baseUrl = server.url;
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterAll(async () => {
    await browser.close();
    await server.close();
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe("basic steps", () => {
    it("executes goto step", async () => {
      const flowPath = join(TEST_DIR, "goto-flow.yaml");
      await writeFile(flowPath, `
name: goto-test
steps:
  - goto: ${baseUrl}
  - wait: settle
`);
      await page.goto("about:blank");
      const result = await runAuthFlow(flowPath, page, context);
      expect(result).toBe(true);
      expect(page.url()).toBe(`${baseUrl}/`);
    });

    it("executes click step", async () => {
      await page.goto(baseUrl, { waitUntil: "networkidle" });
      const flowPath = join(TEST_DIR, "click-flow.yaml");
      await writeFile(flowPath, `
name: click-test
steps:
  - click: "a:has-text('About')"
    timeout: 3000
`);
      const result = await runAuthFlow(flowPath, page, context);
      expect(result).toBe(true);
    }, 15_000);

    it("handles optional steps gracefully", async () => {
      await page.goto(baseUrl, { waitUntil: "networkidle" });
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
      await page.goto(baseUrl, { waitUntil: "networkidle" });
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
      await page.goto(baseUrl, { waitUntil: "networkidle" });
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
      await page.goto(baseUrl, { waitUntil: "networkidle" });
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
      await page.goto(baseUrl, { waitUntil: "networkidle" });
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
      expect(existsSync(join(captureOutDir, "paragraph-0", "page-source.html"))).toBe(true);
    });

    it("handles zero elements gracefully", async () => {
      await page.goto(baseUrl, { waitUntil: "networkidle" });
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
      await page.goto(baseUrl, { waitUntil: "networkidle" });

      await context.addCookies([{
        name: "test_cookie",
        value: "test_value",
        domain: "127.0.0.1",
        path: "/",
      }]);

      const flowPath = join(TEST_DIR, "cookie-roundtrip.yaml");

      await writeFile(flowPath, `
name: cookie-save
steps:
  - cookies: save
`);
      const result = await runAuthFlow(flowPath, page, context);
      expect(result).toBe(true);

      await context.clearCookies();

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

  describe("buildSectionTree", () => {
    it("groups flat sections into tree by dot-path names", () => {
      const sections = [
        { name: "workflow", selector: ".workflow" },
        { name: "workflow.node", selector: ".node" },
        { name: "workflow.node.config", selector: ".config" },
        { name: "funnel", selector: ".funnel" },
        { name: "funnel.step", selector: ".step" },
      ];

      const roots = buildSectionTree(sections);
      expect(roots).toHaveLength(2);
      expect(roots[0].name).toBe("workflow");
      expect(roots[0].children).toHaveLength(1);
      expect(roots[0].children[0].name).toBe("workflow.node");
      expect(roots[0].children[0].children).toHaveLength(1);
      expect(roots[0].children[0].children[0].name).toBe("workflow.node.config");
      expect(roots[1].name).toBe("funnel");
      expect(roots[1].children).toHaveLength(1);
      expect(roots[1].children[0].name).toBe("funnel.step");
    });

    it("handles single root with no children", () => {
      const roots = buildSectionTree([{ name: "items", selector: ".item" }]);
      expect(roots).toHaveLength(1);
      expect(roots[0].children).toHaveLength(0);
    });

    it("handles multiple roots", () => {
      const roots = buildSectionTree([
        { name: "a", selector: ".a" },
        { name: "b", selector: ".b" },
        { name: "c", selector: ".c" },
      ]);
      expect(roots).toHaveLength(3);
    });
  });

  describe("sections executor", () => {
    it("executes flat sections YAML and captures to nested slug dirs", async () => {
      const outDir = join(TEST_DIR, "sections-out");
      await mkdir(outDir, { recursive: true });

      const flowPath = join(TEST_DIR, "sections-flow.yaml");
      await writeFile(flowPath, `
name: sections-test
sections:
  - name: item
    url: ${baseUrl}/sections-test
    selector: ".item"
    wait: 500
`);

      await page.goto(`${baseUrl}/sections-test`);
      const result = await runAuthFlow(flowPath, page, context, {
        outDir,
        types: ["screenshot"],
      });
      expect(result).toBe(true);

      // Should have created item-0/, item-1/, item-2/ directories
      expect(existsSync(join(outDir, "item-0"))).toBe(true);
      expect(existsSync(join(outDir, "item-1"))).toBe(true);
      expect(existsSync(join(outDir, "item-2"))).toBe(true);
    });

    it("supports capture: false to skip capturing at a level", async () => {
      const outDir = join(TEST_DIR, "sections-nocap");
      await mkdir(outDir, { recursive: true });

      const flowPath = join(TEST_DIR, "sections-nocap.yaml");
      await writeFile(flowPath, `
name: nocap-test
sections:
  - name: nav
    url: ${baseUrl}/sections-test
    selector: ".item"
    wait: 500
    capture: false
`);

      await page.goto(`${baseUrl}/sections-test`);
      const result = await runAuthFlow(flowPath, page, context, {
        outDir,
        types: ["screenshot"],
      });
      expect(result).toBe(true);

      // Should NOT have created any capture directories
      expect(existsSync(join(outDir, "nav-0"))).toBe(false);
    });

    it("uses wait-for-text and settle-timeout to wait for slow SPA content", async () => {
      const outDir = join(TEST_DIR, "sections-slow");
      await mkdir(outDir, { recursive: true });

      const flowPath = join(TEST_DIR, "sections-slow.yaml");
      await writeFile(flowPath, `
name: slow-spa-test
sections:
  - name: item
    url: ${baseUrl}/sections-slow
    selector: ".item"
    wait-for-text: "Dashboard Ready"
    settle-timeout: 5000
`);

      await page.goto("about:blank");
      const result = await runAuthFlow(flowPath, page, context, {
        outDir,
        types: ["screenshot"],
      });
      expect(result).toBe(true);

      // Items are injected after 300ms delay — settle should find them
      expect(existsSync(join(outDir, "item-0"))).toBe(true);
      expect(existsSync(join(outDir, "item-1"))).toBe(true);
      expect(existsSync(join(outDir, "item-2"))).toBe(true);
    });

    it("applies post-settle wait delay after settle completes", async () => {
      const outDir = join(TEST_DIR, "sections-postwait");
      await mkdir(outDir, { recursive: true });

      const flowPath = join(TEST_DIR, "sections-postwait.yaml");
      await writeFile(flowPath, `
name: postwait-test
sections:
  - name: item
    url: ${baseUrl}/sections-test
    selector: ".item"
    settle-timeout: 5000
    wait: 200
`);

      await page.goto("about:blank");
      const result = await runAuthFlow(flowPath, page, context, {
        outDir,
        types: ["screenshot"],
      });
      expect(result).toBe(true);

      // Should still capture successfully with post-settle delay
      expect(existsSync(join(outDir, "item-0"))).toBe(true);
    });

    it("clips screenshots to element bounding box with clip: element", async () => {
      const outDir = join(TEST_DIR, "sections-clip");
      await mkdir(outDir, { recursive: true });

      const flowPath = join(TEST_DIR, "sections-clip.yaml");
      await writeFile(flowPath, `
name: clip-test
sections:
  - name: item
    url: ${baseUrl}/sections-test
    selector: ".item"
    clip: element
    settle-timeout: 5000
`);

      await page.goto("about:blank");
      const result = await runAuthFlow(flowPath, page, context, {
        outDir,
        types: ["screenshot"],
      });
      expect(result).toBe(true);

      expect(existsSync(join(outDir, "item-0"))).toBe(true);
      const data = await readFile(join(outDir, "item-0/screenshot.png"));
      // Valid PNG
      expect(data[0]).toBe(0x89);
      // Element screenshot should be smaller than full page (720px viewport)
      const height = data.readUInt32BE(20);
      expect(height).toBeLessThan(200);
    });
  });
});
