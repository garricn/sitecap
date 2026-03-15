import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

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

  // Accessibility tree
  if (types.has("accessibility")) {
    try {
      const filePath = join(outDir, "accessibility.txt");
      const snapshot = await page.locator(":root").ariaSnapshot();
      await writeFile(filePath, snapshot);
      results.accessibility = filePath;
    } catch (e) {
      errors.accessibility = e.message;
    }
  }

  // HTML source (rendered DOM)
  if (types.has("html")) {
    try {
      const filePath = join(outDir, "page-source.html");
      const html = await page.content();
      await writeFile(filePath, html);
      results.html = filePath;
    } catch (e) {
      errors.html = e.message;
    }
  }

  // Network requests (all resource types with timing)
  // Note: network logging must be set up BEFORE navigation via setupNetworkCapture()
  if (types.has("network") && page.__sitecapNetwork) {
    try {
      const filePath = join(outDir, "network.json");
      await writeFile(filePath, JSON.stringify(page.__sitecapNetwork, null, 2));
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

  // Write capture metadata
  const meta = {
    url: page.url(),
    timestamp: new Date().toISOString(),
    captures: results,
    errors: Object.keys(errors).length > 0 ? errors : undefined,
  };
  await writeFile(join(outDir, "meta.json"), JSON.stringify(meta, null, 2));

  return meta;
}

/**
 * Set up network request logging on a page. Call BEFORE navigating.
 * Captures ALL resource types (not just XHR/fetch) with timing data.
 * Captured requests are stored on page.__sitecapNetwork.
 */
export function setupNetworkCapture(page) {
  page.__sitecapNetwork = [];

  page.on("response", async (response) => {
    const request = response.request();

    const entry = {
      url: request.url(),
      method: request.method(),
      status: response.status(),
      statusText: response.statusText(),
      resourceType: request.resourceType(),
      timing: request.timing(),
      requestHeaders: request.headers(),
      responseHeaders: response.headers(),
    };

    // Content-Length from headers
    const contentLength = response.headers()["content-length"];
    if (contentLength) {
      entry.size = parseInt(contentLength, 10);
    }

    // Capture response body for XHR/fetch only (API calls)
    if (request.resourceType() === "xhr" || request.resourceType() === "fetch") {
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
 */
export async function navigateAndCapture(page, url, outDir, opts = {}) {
  // Reset capture buffers
  setupNetworkCapture(page);
  setupConsoleCapture(page);

  // Navigate
  await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });

  // Wait for page to fully settle (replaces fixed timeout)
  await waitForPageSettle(page, {
    quietMs: opts.quietMs,
    maxTimeout: opts.maxTimeout,
  });

  // Capture
  return capturePage(page, outDir, opts);
}
