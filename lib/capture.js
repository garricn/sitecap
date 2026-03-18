import { mkdir, writeFile, readFile as readFileAsync } from "node:fs/promises";
import { join, relative } from "node:path";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { detectCms, extractCmsStructure, buildDependencyGraph } from "./cms.js";

/**
 * Format a CDP Accessibility.getFullAXTree result into readable indented text.
 * Handles cross-origin iframe content that ariaSnapshot() misses.
 */
function formatAXTree(nodes) {
  if (!nodes || nodes.length === 0) return "";

  // Build parent→children map
  const childrenMap = new Map();
  const nodeMap = new Map();
  for (const node of nodes) {
    nodeMap.set(node.nodeId, node);
    if (node.parentId) {
      if (!childrenMap.has(node.parentId)) childrenMap.set(node.parentId, []);
      childrenMap.get(node.parentId).push(node.nodeId);
    }
  }

  // Find roots (nodes without parents)
  const roots = nodes.filter((n) => !n.parentId).map((n) => n.nodeId);

  const lines = [];

  function walk(nodeId, depth) {
    const node = nodeMap.get(nodeId);
    if (!node) return;

    const role = node.role?.value || "";
    const name = node.name?.value || "";
    const value = node.value?.value || "";

    // Skip ignored nodes
    if (role === "none" || node.ignored) {
      // Still walk children
      const children = childrenMap.get(nodeId) || [];
      for (const childId of children) walk(childId, depth);
      return;
    }

    const indent = "  ".repeat(depth);
    let line = `${indent}- ${role}`;
    if (name) line += ` "${name}"`;
    if (value) line += ` [value: "${value}"]`;

    // Mark cross-origin iframe boundaries
    if (role === "Iframe" || role === "iframe") {
      const src = node.properties?.find((p) => p.name === "url")?.value?.value;
      if (src) line += ` [src: ${src}]`;
    }

    lines.push(line);

    const children = childrenMap.get(nodeId) || [];
    for (const childId of children) walk(childId, depth + 1);
  }

  for (const rootId of roots) walk(rootId, 0);
  return lines.join("\n");
}

/**
 * Wait for page to settle: no DOM mutations AND no new network resources
 * for `quietMs` consecutive milliseconds.
 *
 * @param {import('playwright').Page} page
 * @param {object} [opts]
 * @param {number} [opts.quietMs] - Required quiet period. Default: 500.
 * @param {number} [opts.maxTimeout] - Absolute max wait. Default: 10000.
 */
export async function waitForPageSettle(page, opts = {}) {
  const quietMs = opts.quietMs ?? 500;
  const maxTimeout = opts.maxTimeout ?? 10_000;

  await page.waitForFunction(
    (qMs) => {
      return new Promise((resolve) => {
        let timer = null;
        let lastActivity = Date.now();

        const reset = () => {
          lastActivity = Date.now();
          clearTimeout(timer);
          timer = setTimeout(check, qMs);
        };

        const check = () => {
          if (Date.now() - lastActivity >= qMs) {
            observer.disconnect();
            resolve(true);
          } else {
            timer = setTimeout(check, qMs - (Date.now() - lastActivity));
          }
        };

        const observer = new MutationObserver(() => reset());
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });

        try {
          const perfObserver = new PerformanceObserver(() => reset());
          perfObserver.observe({ entryTypes: ["resource"] });
        } catch {
          // PerformanceObserver not available, rely on DOM only
        }

        timer = setTimeout(check, qMs);
      });
    },
    quietMs,
    { timeout: maxTimeout }
  ).catch(() => {
    // maxTimeout hit — page never fully settled, proceed anyway
  });
}

/**
 * Capture a single page with the full 6-file standard set.
 *
 * @param {import('playwright').Page} page - Playwright page (already navigated)
 * @param {string} outDir - Output directory for this page's captures
 * @param {object} [opts]
 * @param {string[]} [opts.types] - Capture types to include. Default: all 6.
 */
export async function capturePage(page, outDir, opts = {}) {
  const types = new Set(
    opts.types ?? [
      "screenshot",
      "accessibility",
      "html",
      "network",
      "console",
      "storage",
      "performance",
    ]
  );

  const startTime = Date.now();

  await mkdir(outDir, { recursive: true });

  const results = {};
  const errors = {};

  // Screenshot (full page)
  if (types.has("screenshot")) {
    try {
      const filePath = join(outDir, "screenshot.png");
      await page.screenshot({ path: filePath, fullPage: true });
      results.screenshot = filePath;
    } catch (e) {
      errors.screenshot = e.message;
    }
  }

  // Accessibility tree (CDP for cross-origin iframe support, fallback to ariaSnapshot)
  if (types.has("accessibility")) {
    try {
      const filePath = join(outDir, "accessibility.txt");
      let snapshot;
      try {
        const client = await page.context().newCDPSession(page);
        const { nodes } = await client.send("Accessibility.getFullAXTree");
        snapshot = formatAXTree(nodes);
        await client.detach();
      } catch {
        // CDP unavailable, fall back to Playwright's ariaSnapshot
        snapshot = await page.locator(":root").ariaSnapshot();
      }
      await writeFile(filePath, snapshot);
      results.accessibility = filePath;
    } catch (e) {
      errors.accessibility = e.message;
    }
  }

  // HTML source (rendered DOM + cross-origin iframe content)
  if (types.has("html")) {
    try {
      const filePath = join(outDir, "page-source.html");
      const html = await page.content();
      await writeFile(filePath, html);
      results.html = filePath;

      // Capture cross-origin iframe content as separate files
      const frames = page.frames();
      let iframeIdx = 0;
      for (const frame of frames) {
        if (frame === page.mainFrame()) continue;
        const frameUrl = frame.url();
        if (!frameUrl || frameUrl === "about:blank") continue;
        try {
          const iframePath = join(outDir, `iframe-${iframeIdx}.html`);
          const iframeHtml = await frame.content();
          await writeFile(iframePath, `<!-- iframe src: ${frameUrl} -->\n${iframeHtml}`);
          if (!results.iframes) results.iframes = [];
          results.iframes.push({ path: iframePath, src: frameUrl });
          iframeIdx++;
        } catch {
          // Frame may have navigated or been detached
        }
      }
    } catch (e) {
      errors.html = e.message;
    }
  }

  // Network requests (all resource types with timing)
  // Note: network logging must be set up BEFORE navigation via setupNetworkCapture()
  if (types.has("network") && page.__sitecapNetwork) {
    try {
      const filePath = join(outDir, "network.json");
      const networkData = page.__sitecapNetwork.map((entry) => {
        const clean = { ...entry };
        delete clean.__body;
        return clean;
      });
      await writeFile(filePath, JSON.stringify(networkData, null, 2));
      results.network = filePath;
    } catch (e) {
      errors.network = e.message;
    }
  }

  // Console messages
  // Note: console logging must be set up BEFORE navigation via setupConsoleCapture()
  if (types.has("console") && page.__sitecapConsole) {
    try {
      const filePath = join(outDir, "console.json");
      await writeFile(filePath, JSON.stringify(page.__sitecapConsole, null, 2));
      results.console = filePath;
    } catch (e) {
      errors.console = e.message;
    }
  }

  // Storage state (cookies + localStorage + sessionStorage)
  if (types.has("storage")) {
    try {
      const filePath = join(outDir, "storage.json");
      const storage = {};

      // Cookies from browser context
      storage.cookies = await page.context().cookies();

      // localStorage and sessionStorage from page
      storage.localStorage = await page.evaluate(() => {
        const items = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          items[key] = localStorage.getItem(key);
        }
        return items;
      });

      storage.sessionStorage = await page.evaluate(() => {
        const items = {};
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          items[key] = sessionStorage.getItem(key);
        }
        return items;
      });

      await writeFile(filePath, JSON.stringify(storage, null, 2));
      results.storage = filePath;
    } catch (e) {
      errors.storage = e.message;
    }
  }

  // MHTML archive (offline-viewable snapshot)
  if (types.has("mhtml")) {
    try {
      const filePath = join(outDir, "page.mhtml");
      const client = await page.context().newCDPSession(page);
      const { data } = await client.send("Page.captureSnapshot", { format: "mhtml" });
      await writeFile(filePath, data);
      await client.detach();
      results.mhtml = filePath;
    } catch (e) {
      errors.mhtml = e.message;
    }
  }

  // Performance metrics (Core Web Vitals + navigation timing)
  if (types.has("performance")) {
    try {
      const filePath = join(outDir, "performance.json");
      const perf = await page.evaluate(() => {
        const result = {};

        // Navigation timing
        const nav = performance.getEntriesByType("navigation")[0];
        if (nav) {
          result.navigation = {
            domContentLoaded: nav.domContentLoadedEventEnd - nav.startTime,
            load: nav.loadEventEnd - nav.startTime,
            ttfb: nav.responseStart - nav.startTime,
            domInteractive: nav.domInteractive - nav.startTime,
            transferSize: nav.transferSize,
            encodedBodySize: nav.encodedBodySize,
            decodedBodySize: nav.decodedBodySize,
          };
        }

        // Largest Contentful Paint
        const lcpEntries = performance.getEntriesByType("largest-contentful-paint");
        if (lcpEntries.length > 0) {
          const lcp = lcpEntries[lcpEntries.length - 1];
          result.lcp = { value: lcp.startTime, element: lcp.element?.tagName || null };
        }

        // Cumulative Layout Shift
        const clsEntries = performance.getEntriesByType("layout-shift");
        if (clsEntries.length > 0) {
          result.cls = {
            value: clsEntries.reduce((sum, e) => sum + (e.hadRecentInput ? 0 : e.value), 0),
            shifts: clsEntries.length,
          };
        }

        // First Contentful Paint
        const fcpEntries = performance.getEntriesByType("paint");
        const fcp = fcpEntries.find((e) => e.name === "first-contentful-paint");
        if (fcp) {
          result.fcp = { value: fcp.startTime };
        }

        // Resource summary
        const resources = performance.getEntriesByType("resource");
        result.resources = {
          count: resources.length,
          totalTransferSize: resources.reduce((sum, r) => sum + (r.transferSize || 0), 0),
          byType: {},
        };
        for (const r of resources) {
          const type = r.initiatorType || "other";
          if (!result.resources.byType[type]) {
            result.resources.byType[type] = { count: 0, totalTransferSize: 0 };
          }
          result.resources.byType[type].count++;
          result.resources.byType[type].totalTransferSize += r.transferSize || 0;
        }

        return result;
      });
      await writeFile(filePath, JSON.stringify(perf, null, 2));
      results.performance = filePath;
    } catch (e) {
      errors.performance = e.message;
    }
  }

  // Download assets (opt-in via downloadAssets option)
  if (opts.downloadAssets) {
    try {
      const shared = opts.sharedAssetsDir;
      const assetsDir = shared || join(outDir, "assets");
      await mkdir(assetsDir, { recursive: true });
      const manifest = {};
      const contentTypeToExt = {
        "text/css": "css", "application/javascript": "js", "text/javascript": "js",
        "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg", "image/gif": "gif",
        "font/woff2": "woff2", "font/woff": "woff", "font/ttf": "ttf", "application/font-woff2": "woff2",
      };

      for (const entry of (page.__sitecapNetwork || [])) {
        if (!entry.__body) continue;
        // Hash content (not URL) for true dedup across different URLs serving same file
        const hash = createHash("sha256").update(entry.__body).digest("hex").slice(0, 16);
        const ct = (entry.responseHeaders?.["content-type"] || "").split(";")[0].trim();
        const ext = contentTypeToExt[ct] || "bin";
        const filename = `${hash}.${ext}`;
        const filePath = join(assetsDir, filename);
        // Skip if already written (dedup across pages)
        if (!existsSync(filePath)) {
          await writeFile(filePath, entry.__body);
        }
        manifest[entry.url] = { file: filename, contentType: ct, size: entry.__body.length };
      }

      // Per-page manifest
      const pageManifestDir = shared ? join(outDir, "assets") : assetsDir;
      if (shared) await mkdir(pageManifestDir, { recursive: true });
      const manifestPath = join(pageManifestDir, "manifest.json");
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
      results.assets = manifestPath;

      // Rewrite URLs in page-source.html → page-source-local.html
      // For shared assets, use relative path from pageDir to shared dir
      const assetPrefix = shared ? `${relative(outDir, shared)}/` : "assets/";
      if (results.html) {
        let html = await readFileAsync(results.html, "utf-8");
        for (const [url, info] of Object.entries(manifest)) {
          html = html.replaceAll(url, `${assetPrefix}${info.file}`);
          try {
            const pathname = new URL(url).pathname;
            if (pathname && pathname !== "/") {
              html = html.replaceAll(`"${pathname}"`, `"${assetPrefix}${info.file}"`);
              html = html.replaceAll(`'${pathname}'`, `'${assetPrefix}${info.file}'`);
            }
          } catch { /* invalid URL, skip */ }
        }
        const localPath = join(outDir, "page-source-local.html");
        await writeFile(localPath, html);
        results.htmlLocal = localPath;
      }
    } catch (e) {
      errors.assets = e.message;
    }
  }

  // CMS detection + extraction (opt-in)
  if (types.has("cms")) {
    try {
      const detectPath = join(outDir, "cms-detect.json");
      const cmsData = await detectCms(page, page.__sitecapNetwork || []);
      await writeFile(detectPath, JSON.stringify(cmsData, null, 2));
      results.cms = detectPath;

      // Extract CMS structure if admin session detected
      const cmsStructure = await extractCmsStructure(page, cmsData);
      const structurePath = join(outDir, "cms.json");
      await writeFile(structurePath, JSON.stringify(cmsStructure, null, 2));
      results.cmsStructure = structurePath;

      // Build dependency graph if structure was extracted
      if (cmsStructure.extracted) {
        const graph = await buildDependencyGraph(page, cmsStructure, cmsData.context || {});
        const graphPath = join(outDir, "dependency-graph.json");
        await writeFile(graphPath, JSON.stringify(graph, null, 2));
        results.dependencyGraph = graphPath;
      }
    } catch (e) {
      errors.cms = e.message;
    }
  }

  // Write capture metadata
  const meta = {
    url: page.url(),
    timestamp: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
    captures: results,
    errors: Object.keys(errors).length > 0 ? errors : undefined,
  };
  await writeFile(join(outDir, "meta.json"), JSON.stringify(meta, null, 2));

  return meta;
}

/**
 * Set up network request logging on a page. Call BEFORE navigating.
 * Captured requests are stored on page.__sitecapNetwork.
 *
 * @param {import('playwright').Page} page
 * @param {object} [opts]
 * @param {string} [opts.networkFilter] - "all" (default), "xhr" (XHR/fetch only), "none" (skip)
 * @param {boolean} [opts.downloadAssets] - if true, capture response bodies for static assets
 */
export function setupNetworkCapture(page, opts = {}) {
  const filter = opts.networkFilter || "all";
  const downloadAssets = opts.downloadAssets || false;
  const assetTypes = new Set(["stylesheet", "script", "image", "font"]);
  if (filter === "none") {
    page.__sitecapNetwork = [];
    return;
  }

  page.__sitecapNetwork = [];

  page.on("response", async (response) => {
    const request = response.request();
    const resourceType = request.resourceType();

    // Filter by resource type
    if (filter === "xhr" && resourceType !== "xhr" && resourceType !== "fetch") {
      return;
    }

    const entry = {
      url: request.url(),
      method: request.method(),
      status: response.status(),
      statusText: response.statusText(),
      resourceType,
      timing: request.timing(),
      requestHeaders: request.headers(),
      responseHeaders: response.headers(),
    };

    // Content-Length from headers
    const contentLength = response.headers()["content-length"];
    if (contentLength) {
      entry.size = parseInt(contentLength, 10);
    }

    // Capture response body for assets when download-assets is active
    if (downloadAssets && assetTypes.has(resourceType)) {
      try {
        entry.__body = await response.body();
      } catch {
        // body unavailable (e.g. response was redirected)
      }
    }

    // Capture response body for XHR/fetch only (API calls)
    if (resourceType === "xhr" || resourceType === "fetch") {
      try {
        const body = await response.text();
        if (body.length < 500_000) {
          entry.body = body;
          try {
            entry.bodyJson = JSON.parse(body);
          } catch {
            // not JSON
          }
        } else {
          entry.body = `[truncated: ${body.length} bytes]`;
        }
      } catch {
        entry.body = "[could not read body]";
      }
    }

    page.__sitecapNetwork.push(entry);
  });
}

/**
 * Set up console message logging on a page. Call BEFORE navigating.
 * Captured messages are stored on page.__sitecapConsole.
 */
export function setupConsoleCapture(page) {
  page.__sitecapConsole = [];

  page.on("console", (msg) => {
    page.__sitecapConsole.push({
      type: msg.type(),
      text: msg.text(),
      location: msg.location(),
      timestamp: new Date().toISOString(),
    });
  });
}

/**
 * Extract same-origin links from the current page.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<string[]>} Array of absolute URLs, deduplicated, same-origin only.
 */
export async function extractLinks(page) {
  const origin = new URL(page.url()).origin;
  const links = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("a[href]"))
      .map((a) => {
        try {
          return new URL(a.href, document.baseURI).href;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  });
  // Deduplicate, same-origin only, strip fragments
  const seen = new Set();
  const result = [];
  for (const link of links) {
    try {
      const u = new URL(link);
      if (u.origin !== origin) continue;
      u.hash = "";
      const normalized = u.href;
      if (!seen.has(normalized)) {
        seen.add(normalized);
        result.push(normalized);
      }
    } catch {
      // skip invalid URLs
    }
  }
  return result;
}

/**
 * Navigate to a URL with full capture setup, then capture.
 * Convenience wrapper that combines setup + navigate + capture.
 *
 * @param {import('playwright').Page} page
 * @param {string} url
 * @param {string} outDir
 * @param {object} [opts] - Same as capturePage opts, plus settle options
 * @param {number} [opts.quietMs] - Settle quiet period. Default: 500.
 * @param {number} [opts.maxTimeout] - Settle max timeout. Default: 10000.
 * @param {string} [opts.networkFilter] - "all", "xhr", or "none". Default: "all".
 */
export async function navigateAndCapture(page, url, outDir, opts = {}) {
  // Reset capture buffers
  setupNetworkCapture(page, { networkFilter: opts.networkFilter, downloadAssets: opts.downloadAssets });
  setupConsoleCapture(page);

  // Navigate
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // Wait for page to fully settle (replaces fixed timeout)
  await waitForPageSettle(page, {
    quietMs: opts.quietMs,
    maxTimeout: opts.maxTimeout,
  });

  // Capture
  return capturePage(page, outDir, opts);
}
