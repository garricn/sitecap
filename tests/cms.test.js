import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { detectCms, extractCmsStructure, buildDependencyGraph } from "../lib/cms.js";
import { navigateAndCapture } from "../lib/capture.js";
import { startTestServer } from "./helpers/server.js";
import { parseModxLoadBlock, listModxMediaSources } from "../lib/cms/modx.js";
import { collectWpMediaUrls } from "../lib/cms/wordpress.js";
import { downloadCmsMedia } from "../lib/cms/media.js";

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

  describe("detectCms context", () => {
    it("returns WP context with nonce and apiRoot", async () => {
      await page.goto(`${baseUrl}/wordpress`, { waitUntil: "networkidle" });
      const result = await detectCms(page, []);
      expect(result.context).toBeDefined();
      expect(result.context.nonce).toBe("test-nonce-123");
      expect(result.context.apiRoot).toBe("/wp-json/");
    });

    it("returns MODX context with siteId and connectorsUrl", async () => {
      await page.goto(`${baseUrl}/modx-admin`, { waitUntil: "networkidle" });
      const result = await detectCms(page, []);
      expect(result.context).toBeDefined();
      expect(result.context.siteId).toBe("abc123");
      expect(result.context.connectorsUrl).toBe("/connectors/");
    });
  });

  describe("extractCmsStructure", () => {
    it("extracts WordPress posts/pages/types on admin page", async () => {
      await page.goto(`${baseUrl}/wordpress`, { waitUntil: "networkidle" });
      const detection = await detectCms(page, []);
      const result = await extractCmsStructure(page, detection);
      expect(result.extracted).toBe(true);
      expect(result.cms).toBe("wordpress");
      expect(result.types).toHaveProperty("post");
      expect(result.types).toHaveProperty("page");
      expect(result.posts.length).toBeGreaterThan(0);
      expect(result.posts[0].fields).toBeDefined();
      expect(result.posts[0].fields.hero_text).toBe("Welcome");
      expect(result.pages.length).toBeGreaterThan(0);
      expect(result.pages[0].fields).toBeDefined();
    });

    it("resolves ACF integer fields to media objects", async () => {
      await page.goto(`${baseUrl}/wordpress`, { waitUntil: "networkidle" });
      const detection = await detectCms(page, []);
      const result = await extractCmsStructure(page, detection);
      const hero = result.posts[0].fields.hero_image;
      expect(hero).toEqual({
        id: 123,
        url: expect.stringContaining("/wp-content/uploads/hero.jpg"),
        mime: "image/jpeg",
        alt: "Hero image",
        width: 1200,
        height: 800,
      });
    });

    it("leaves 404 media references as integers", async () => {
      await page.goto(`${baseUrl}/wordpress`, { waitUntil: "networkidle" });
      const detection = await detectCms(page, []);
      const result = await extractCmsStructure(page, detection);
      expect(result.posts[0].fields.missing_ref).toBe(999);
    });

    it("preserves string ACF field values unchanged", async () => {
      await page.goto(`${baseUrl}/wordpress`, { waitUntil: "networkidle" });
      const detection = await detectCms(page, []);
      const result = await extractCmsStructure(page, detection);
      expect(result.posts[0].fields.hero_text).toBe("Welcome");
    });

    it("extracts MODX templates/chunks with TV fields on admin page", async () => {
      await page.goto(`${baseUrl}/modx-admin`, { waitUntil: "networkidle" });
      const detection = await detectCms(page, []);
      const result = await extractCmsStructure(page, detection);
      expect(result.extracted).toBe(true);
      expect(result.cms).toBe("modx");
      expect(result.templates.length).toBeGreaterThan(0);
      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.resources.length).toBeGreaterThan(0);
      expect(result.resources[0].fields).toBeDefined();
      expect(result.resources[0].fields.hero_image).toBe("/assets/hero.jpg");
    });

    it("handles >100 resources without cap (CMS-6)", async () => {
      await page.goto(`${baseUrl}/modx-admin`, { waitUntil: "networkidle" });
      const detection = await detectCms(page, []);
      const result = await extractCmsStructure(page, detection);
      // Server returns 150 resources — all should be processed
      expect(result.resources.length).toBe(150);
      // Verify TV values were fetched for all resources (not just first 100)
      expect(result.resources[149].fields).toBeDefined();
      expect(result.resources[149].fields.hero_image).toBeDefined();
    }, 30000);

    it("includes tvStats in result (CMS-6)", async () => {
      await page.goto(`${baseUrl}/modx-admin`, { waitUntil: "networkidle" });
      const detection = await detectCms(page, []);
      const result = await extractCmsStructure(page, detection);
      expect(result.tvStats).toBeDefined();
      expect(result.tvStats.totalResources).toBe(150);
      expect(result.tvStats.tvsFetched).toBe(150);
      expect(result.tvStats.tvErrors).toBe(0);
    }, 30000);

    it("populates image/file TVs from MODx.load() when connector returns empty (CMS-7)", async () => {
      await page.goto(`${baseUrl}/modx-admin`, { waitUntil: "networkidle" });
      const detection = await detectCms(page, []);
      const result = await extractCmsStructure(page, detection);
      // Resource ID 2 (even) has empty hero_image from connector — MODx.load() should fill it
      const resource2 = result.resources.find(r => r.id === 2);
      expect(resource2.fields.hero_image).toBe("/assets/images/hero.jpg");
      // sidebar_file is always empty from connector — should be filled by MODx.load()
      expect(resource2.fields.sidebar_file).toBe("/assets/docs/guide.pdf");
    }, 30000);

    it("does NOT overwrite non-empty connector text values with MODx.load() (CMS-7)", async () => {
      await page.goto(`${baseUrl}/modx-admin`, { waitUntil: "networkidle" });
      const detection = await detectCms(page, []);
      const result = await extractCmsStructure(page, detection);
      // plain_text has "Connector text" from connector — should NOT be overwritten by "Hello from load"
      const resource1 = result.resources.find(r => r.id === 1);
      expect(resource1.fields.plain_text).toBe("Connector text");
    }, 30000);

    it("returns extracted: false when not admin", async () => {
      await page.goto(`${baseUrl}/modx`, { waitUntil: "networkidle" });
      const detection = await detectCms(page, []);
      const result = await extractCmsStructure(page, detection);
      expect(result.extracted).toBe(false);
      expect(result.reason).toContain("No admin session");
    });

    it("returns extracted: false for Drupal (no adapter)", async () => {
      await page.goto(`${baseUrl}/drupal`, { waitUntil: "networkidle" });
      // Simulate admin drupal
      const detection = { detected: true, cms: "drupal", admin: true, context: {} };
      const result = await extractCmsStructure(page, detection);
      expect(result.extracted).toBe(false);
      expect(result.reason).toContain("not yet implemented");
    });
  });

  describe("parseModxLoadBlock", () => {
    it("extracts TV values from MODx.load() HTML", () => {
      const html = `<script>MODx.load({xtype:"modx-panel-resource",items:[{xtype:"modx-panel-resource-tv",items:[{"fieldLabel":"hero_image","name":"tv123","xtype":"modx-panel-tv-image","value":"/assets/hero.jpg"},{"fieldLabel":"sidebar","name":"tv456","xtype":"modx-panel-tv-file","value":"/docs/file.pdf"}]}]});</script>`;
      const tvNames = new Set(["hero_image", "sidebar"]);
      const result = parseModxLoadBlock(html, tvNames);
      expect(result.hero_image).toBe("/assets/hero.jpg");
      expect(result.sidebar).toBe("/docs/file.pdf");
    });

    it("returns empty object for empty input", () => {
      expect(parseModxLoadBlock("", new Set(["foo"]))).toEqual({});
      expect(parseModxLoadBlock(null, new Set(["foo"]))).toEqual({});
      expect(parseModxLoadBlock("<html></html>", new Set())).toEqual({});
    });

    it("only extracts named TVs", () => {
      const html = `<script>MODx.load({items:[{"fieldLabel":"hero_image","name":"tv1","value":"/img.jpg"},{"fieldLabel":"other","name":"tv2","value":"val"}]});</script>`;
      const result = parseModxLoadBlock(html, new Set(["hero_image"]));
      expect(result.hero_image).toBe("/img.jpg");
      expect(result.other).toBeUndefined();
    });
  });

  describe("buildDependencyGraph", () => {
    it("builds MODX graph with chunk and snippet edges", async () => {
      await page.goto(`${baseUrl}/modx-admin`, { waitUntil: "networkidle" });
      const detection = await detectCms(page, []);
      const cmsData = await extractCmsStructure(page, detection);
      const graph = await buildDependencyGraph(page, cmsData, detection.context);
      expect(graph.cms).toBe("modx");
      expect(graph.nodes.length).toBeGreaterThan(0);
      expect(graph.edges.length).toBeGreaterThan(0);
      // Mock template content is: "<html>[[$header]][[getResources]]</html>"
      expect(graph.edges.some((e) => e.to === "chunk:header")).toBe(true);
      expect(graph.edges.some((e) => e.to === "snippet:getResources")).toBe(true);
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

    it("writes cms-detect.json, cms.json, and dependency-graph.json on admin page", async () => {
      const outDir = join(TEST_DIR, "cms-full");
      await navigateAndCapture(page, `${baseUrl}/modx-admin`, outDir, {
        types: ["cms"],
      });
      expect(existsSync(join(outDir, "cms-detect.json"))).toBe(true);
      expect(existsSync(join(outDir, "cms.json"))).toBe(true);
      expect(existsSync(join(outDir, "dependency-graph.json"))).toBe(true);
      const structure = JSON.parse(await readFile(join(outDir, "cms.json"), "utf-8"));
      expect(structure.extracted).toBe(true);
      const graph = JSON.parse(await readFile(join(outDir, "dependency-graph.json"), "utf-8"));
      expect(graph.nodes.length).toBeGreaterThan(0);
    });

    it("does NOT write cms-detect.json with default types", async () => {
      const outDir = join(TEST_DIR, "no-cms-capture");
      await navigateAndCapture(page, `${baseUrl}/wordpress`, outDir);
      expect(existsSync(join(outDir, "cms-detect.json"))).toBe(false);
    });
  });

  describe("CMS media download", () => {
    it("discovers MODX media sources", async () => {
      await page.goto(`${baseUrl}/modx-admin`, { waitUntil: "networkidle" });
      const detection = await detectCms(page, []);
      const context = detection.context;
      const resolvedConnectorsUrl = new URL(context.connectorsUrl, page.url()).href;
      const sources = await listModxMediaSources(page, resolvedConnectorsUrl, context.siteId);
      expect(sources.length).toBe(2);
      expect(sources[0].name).toBe("Assets");
      expect(sources[0].baseUrl).toBe("/assets/");
      expect(sources[1].name).toBe("Images");
      expect(sources[1].baseUrl).toBe("/assets/images/");
    });

    it("downloads MODX media files and writes manifest", async () => {
      const outDir = join(TEST_DIR, "cms-media-modx");
      await rm(outDir, { recursive: true, force: true });
      await page.goto(`${baseUrl}/modx-admin`, { waitUntil: "networkidle" });
      const detection = await detectCms(page, []);
      const cmsStructure = await extractCmsStructure(page, detection);

      await downloadCmsMedia(page, cmsStructure, detection, outDir, { downloadMedia: true });

      // Manifest should exist
      const manifestPath = join(outDir, "cms-media.json");
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));

      // Sources should be listed
      expect(manifest.sources.length).toBe(2);
      expect(manifest.sources[0].name).toBe("Assets");
      expect(manifest.sources[0].baseUrl).toBe("/assets/");

      // Files should be downloaded
      expect(manifest.files.length).toBeGreaterThanOrEqual(1);
      expect(manifest.stats.downloaded).toBeGreaterThanOrEqual(1);
      expect(manifest.stats.errors).toBe(0);

      // Check exact localPath format, mime populated, and file on disk
      const downloadedFile = manifest.files.find(f => f.localPath && !f.error);
      expect(downloadedFile).toBeDefined();
      expect(downloadedFile.localPath).toMatch(/^cms-media\/modx\/\d+\//);
      expect(downloadedFile.mime).not.toBe("");
      expect(existsSync(join(outDir, downloadedFile.localPath))).toBe(true);
    }, 30000);

    it("downloads WordPress media files and writes manifest", async () => {
      const outDir = join(TEST_DIR, "cms-media-wp");
      await rm(outDir, { recursive: true, force: true });
      await page.goto(`${baseUrl}/wordpress`, { waitUntil: "networkidle" });
      const detection = await detectCms(page, []);
      const cmsStructure = await extractCmsStructure(page, detection);

      await downloadCmsMedia(page, cmsStructure, detection, outDir, { downloadMedia: true });

      // Manifest should exist
      const manifestPath = join(outDir, "cms-media.json");
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));

      // File should be downloaded
      expect(manifest.files.length).toBeGreaterThanOrEqual(1);
      expect(manifest.stats.downloaded).toBeGreaterThanOrEqual(1);
      expect(manifest.stats.errors).toBe(0);

      // Check WP file on disk
      const wpFile = manifest.files.find(f => f.localPath.includes("123-hero.jpg"));
      expect(wpFile).toBeDefined();
      expect(existsSync(join(outDir, wpFile.localPath))).toBe(true);

      // Check referencedBy
      expect(wpFile.referencedBy).toContain("post:1:hero_image");
    }, 30000);

    it("validates referencedBy format", async () => {
      await page.goto(`${baseUrl}/wordpress`, { waitUntil: "networkidle" });
      const detection = await detectCms(page, []);
      const cmsStructure = await extractCmsStructure(page, detection);
      const mediaMap = collectWpMediaUrls(cmsStructure);

      for (const [, media] of mediaMap) {
        for (const ref of media.referencedBy) {
          expect(ref).toMatch(/^(resource|post|page):\d+:\w+(\.\w+)*$/);
        }
      }
    });

    it("collects WP media URLs from resolved ACF fields", async () => {
      // Build a mock cmsStructure with resolved ACF media
      const cmsStructure = {
        posts: [
          {
            id: 1, type: "post", fields: {
              hero_image: { id: 123, url: "http://example.com/hero.jpg", mime: "image/jpeg" },
              hero_text: "Welcome",
              gallery: [
                { id: 456, url: "http://example.com/img1.jpg", mime: "image/png" },
              ],
            },
          },
        ],
        pages: [
          {
            id: 2, fields: {
              banner: { id: 123, url: "http://example.com/hero.jpg", mime: "image/jpeg" },
            },
          },
        ],
      };
      const mediaMap = collectWpMediaUrls(cmsStructure);
      expect(mediaMap.size).toBe(2); // 123 and 456
      expect(mediaMap.get(123).referencedBy).toContain("post:1:hero_image");
      expect(mediaMap.get(123).referencedBy).toContain("page:2:banner");
      expect(mediaMap.get(456).referencedBy).toContain("post:1:gallery.0");
    });

    it("does NOT create cms-media/ dir when downloadMedia is false", async () => {
      const outDir = join(TEST_DIR, "cms-media-off");
      await rm(outDir, { recursive: true, force: true });
      await page.goto(`${baseUrl}/modx-admin`, { waitUntil: "networkidle" });
      const detection = await detectCms(page, []);
      const cmsStructure = await extractCmsStructure(page, detection);

      await downloadCmsMedia(page, cmsStructure, detection, outDir, { downloadMedia: false });

      expect(existsSync(join(outDir, "cms-media"))).toBe(false);
      expect(existsSync(join(outDir, "cms-media.json"))).toBe(false);
    }, 30000);

    it("does NOT create cms-media/ dir via capture without downloadMedia flag", async () => {
      const outDir = join(TEST_DIR, "cms-capture-no-media");
      await rm(outDir, { recursive: true, force: true });
      await navigateAndCapture(page, `${baseUrl}/modx-admin`, outDir, {
        types: ["cms"],
      });
      expect(existsSync(join(outDir, "cms-media"))).toBe(false);
      expect(existsSync(join(outDir, "cms-media.json"))).toBe(false);
    });
  });
});
