import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Capture a single page with the full 6-file standard set.
 *
 * @param {import('playwright').Page} page - Playwright page (already navigated)
 * @param {string} outDir - Output directory for this page's captures
 * @param {object} [opts]
 * @param {string[]} [opts.types] - Capture types to include. Default: all 6.
 * @param {number} [opts.waitMs] - Extra wait after load before capturing. Default: 2000.
 * @param {import('playwright').Page} [opts.networkPage] - Page to read network from (if different)
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
    ]
  );
  const waitMs = opts.waitMs ?? 2000;

  await mkdir(outDir, { recursive: true });

  // Extra settle time for SPAs
  await page.waitForTimeout(waitMs);

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
      const snapshot = await page.accessibility.snapshot({ interestingOnly: false });
      await writeFile(filePath, JSON.stringify(snapshot, null, 2));
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

  // Network requests (XHR/Fetch only)
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
 * Captured requests are stored on page.__sitecapNetwork.
 */
export function setupNetworkCapture(page) {
  page.__sitecapNetwork = [];

  page.on("response", async (response) => {
    const request = response.request();
    const resourceType = request.resourceType();

    // Only capture XHR/Fetch (API calls), not images/css/fonts
    if (resourceType !== "xhr" && resourceType !== "fetch") return;

    const entry = {
      url: request.url(),
      method: request.method(),
      status: response.status(),
      statusText: response.statusText(),
      resourceType,
      requestHeaders: request.headers(),
      responseHeaders: response.headers(),
    };

    // Try to capture response body (may fail for large/binary responses)
    try {
      const body = await response.text();
      // Only store if it looks like JSON or text, skip huge blobs
      if (body.length < 500_000) {
        entry.body = body;
        try {
          entry.bodyJson = JSON.parse(body);
        } catch {
          // not JSON, that's fine
        }
      } else {
        entry.body = `[truncated: ${body.length} bytes]`;
      }
    } catch {
      entry.body = "[could not read body]";
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
 * Navigate to a URL with full capture setup, then capture.
 * Convenience wrapper that combines setup + navigate + capture.
 *
 * @param {import('playwright').Page} page
 * @param {string} url
 * @param {string} outDir
 * @param {object} [opts] - Same as capturePage opts
 */
export async function navigateAndCapture(page, url, outDir, opts = {}) {
  // Reset capture buffers
  setupNetworkCapture(page);
  setupConsoleCapture(page);

  // Navigate
  await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });

  // Capture
  return capturePage(page, outDir, opts);
}
