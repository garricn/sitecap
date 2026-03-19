/**
 * ExtensionPage — a Playwright-compatible page adapter backed by the sitecap
 * Chrome extension bridge.
 *
 * Implements the subset of Playwright's Page API that capturePage() uses:
 *   page.goto(url, opts)
 *   page.url()
 *   page.content()
 *   page.screenshot({ path, fullPage })
 *   page.evaluate(fn)
 *   page.locator(sel).ariaSnapshot()
 *   page.context().newCDPSession(page) → client.send(method, params)
 *   page.context().cookies()
 *   page.frames()
 *   page.mainFrame()
 *   page.waitForFunction(fn, args, opts)
 *   page.setViewportSize({ width, height })
 *   page.close()
 *
 * Also supports the __sitecapNetwork and __sitecapConsole buffers
 * via CDP event subscriptions.
 */

import { writeFile } from "node:fs/promises";

export class ExtensionPage {
  /**
   * @param {object} bridge - ExtensionBridge from lib/extension.js
   * @param {number} tabId - Chrome tab ID
   */
  constructor(bridge, tabId) {
    this._bridge = bridge;
    this._tabId = tabId;
    this._url = "";
    this._debuggerAttached = false;
    this.__sitecapNetwork = [];
    this.__sitecapConsole = [];
  }

  /** Attach debugger to the tab (idempotent). */
  async _ensureDebugger() {
    if (!this._debuggerAttached) {
      await this._bridge.call("debugger.attach", { tabId: this._tabId });
      this._debuggerAttached = true;
    }
  }

  /** Send a CDP command through the debugger. */
  async _cdp(method, params = {}) {
    await this._ensureDebugger();
    return this._bridge.call("debugger.sendCommand", {
      tabId: this._tabId,
      method,
      commandParams: params,
    });
  }

  // --- Navigation ---

  async goto(url) {
    const result = await this._bridge.call("tabs.navigate", {
      tabId: this._tabId,
      url,
    });
    this._url = result.url;
    return result;
  }

  url() {
    return this._url;
  }

  // --- Content ---

  async content() {
    const { result } = await this._cdp("Runtime.evaluate", {
      expression: "document.documentElement.outerHTML",
      returnByValue: true,
    });
    return result.value;
  }

  // --- Screenshot ---

  async screenshot(opts = {}) {
    const params = { format: "png" };
    if (opts.fullPage) {
      // Get full page dimensions
      const metrics = await this._cdp("Page.getLayoutMetrics");
      const { width, height } = metrics.contentSize || metrics.cssContentSize;
      params.clip = { x: 0, y: 0, width, height, scale: 1 };
      params.captureBeyondViewport = true;
    }

    const { data } = await this._cdp("Page.captureScreenshot", params);
    const buffer = Buffer.from(data, "base64");

    if (opts.path) {
      await writeFile(opts.path, buffer);
    }
    return buffer;
  }

  // --- JavaScript evaluation ---

  async evaluate(fn, ...args) {
    let expression;
    if (typeof fn === "function") {
      expression = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})`;
    } else {
      expression = fn;
    }

    const { result, exceptionDetails } = await this._cdp("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });

    if (exceptionDetails) {
      throw new Error(exceptionDetails.text || exceptionDetails.exception?.description || "Evaluation failed");
    }
    return result.value;
  }

  // --- Wait for function (used by waitForPageSettle) ---

  async waitForFunction(fn, args = {}, opts = {}) {
    const timeout = opts.timeout || 10_000;
    const pollInterval = opts.polling || 100;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      try {
        const result = await this.evaluate(fn, args);
        if (result) return result;
      } catch {
        // Function threw, keep polling
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }
    throw new Error(`waitForFunction timed out after ${timeout}ms`);
  }

  // --- Viewport ---

  async setViewportSize({ width, height }) {
    await this._cdp("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  // --- Locator (minimal, for ariaSnapshot fallback) ---

  locator() {
    const page = this;
    return {
      async ariaSnapshot() {
        // Fall through to CDP accessibility tree — extension always has CDP
        const { nodes } = await page._cdp("Accessibility.getFullAXTree");
        // Return raw nodes; capturePage will format them
        return nodes;
      },
    };
  }

  // --- Context (for cookies, CDP sessions) ---

  context() {
    const page = this;
    return {
      async cookies(urlFilter) {
        const params = {};
        if (urlFilter) params.url = urlFilter;
        const { cookies } = await page._bridge.call("cookies.getAll", params);
        return cookies;
      },

      async newCDPSession() {
        // Return an object with send() that routes through the bridge
        await page._ensureDebugger();
        return {
          async send(method, params = {}) {
            return page._cdp(method, params);
          },
          async detach() {
            // No-op — we keep the debugger attached for the session
          },
        };
      },
    };
  }

  // --- Frames (minimal — extension mode doesn't support cross-origin frames yet) ---

  frames() {
    return [this.mainFrame()];
  }

  mainFrame() {
    return { _isMainFrame: true };
  }

  // --- Cleanup ---

  async close() {
    if (this._debuggerAttached) {
      try {
        await this._bridge.call("debugger.detach", { tabId: this._tabId });
      } catch {
        // Tab may already be closed
      }
      this._debuggerAttached = false;
    }
    await this._bridge.call("tabs.close", { tabId: this._tabId });
  }
}

/**
 * Create an ExtensionPage — creates a tab and wraps it.
 *
 * @param {object} bridge - ExtensionBridge
 * @param {object} [opts]
 * @param {string} [opts.url] - Initial URL
 * @param {object} [opts.viewport] - { width, height }
 * @returns {Promise<ExtensionPage>}
 */
export async function createExtensionPage(bridge, opts = {}) {
  const { tabId } = await bridge.call("tabs.create", {
    url: opts.url || "about:blank",
    active: true,
  });

  const page = new ExtensionPage(bridge, tabId);

  if (opts.viewport) {
    await page.setViewportSize(opts.viewport);
  }

  if (opts.url) {
    page._url = opts.url;
  }

  return page;
}
