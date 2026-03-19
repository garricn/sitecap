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
import { formatAXTree } from "./capture.js";

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
    this._existingTab = false;
    this.__sitecapNetwork = [];
    this.__sitecapConsole = [];
    this._eventHandlers = new Map(); // event → [handler]
    this._networkEnabled = false;
    this._consoleEnabled = false;
    this._pendingRequests = new Map(); // requestId → request info
    this._pendingResponses = new Map(); // requestId → response info
    this._bodyReady = new Map(); // requestId → Promise that resolves when body is available
    this._networkEnablePromise = null;
    this._consoleEnablePromise = null;
    this._mainFrame = null;
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

  // --- Event emitter (Playwright-compatible page.on()) ---

  /**
   * Register an event handler. Supports "response" and "console" events
   * by subscribing to CDP Network and Runtime domains.
   */
  on(event, handler) {
    if (!this._eventHandlers.has(event)) this._eventHandlers.set(event, []);
    this._eventHandlers.get(event).push(handler);

    if (event === "response" && !this._networkEnabled) {
      this._networkEnabled = true;
      this._networkEnablePromise = this._enableNetworkEvents();
    }
    if (event === "console" && !this._consoleEnabled) {
      this._consoleEnabled = true;
      this._consoleEnablePromise = this._enableConsoleEvents();
    }
  }

  _emit(event, ...args) {
    const handlers = this._eventHandlers.get(event) || [];
    for (const h of handlers) {
      try { h(...args); } catch { /* handler error */ }
    }
  }

  /** Enable CDP Network domain and forward events as Playwright-compatible objects. */
  async _enableNetworkEvents() {
    await this._ensureDebugger();
    await this._cdp("Network.enable");

    const page = this;

    this._bridge.on("cdp", (msg) => {
      if (msg.tabId !== page._tabId) return;

      if (msg.method === "Network.requestWillBeSent") {
        const { requestId, request, type } = msg.params;
        page._pendingRequests.set(requestId, {
          url: request.url,
          method: request.method,
          headers: request.headers || {},
          resourceType: (type || "other").toLowerCase(),
        });
      }

      if (msg.method === "Network.responseReceived") {
        const { requestId, response } = msg.params;
        page._pendingResponses.set(requestId, {
          status: response.status,
          statusText: response.statusText || "",
          headers: response.headers || {},
          timing: response.timing || {},
        });
      }

      if (msg.method === "Network.loadingFinished") {
        const { requestId } = msg.params;
        const reqInfo = page._pendingRequests.get(requestId);
        const resInfo = page._pendingResponses.get(requestId);
        if (!reqInfo || !resInfo) return;

        // Create a body-ready promise that resolves immediately
        // (loadingFinished means the body is available now)
        if (!page._bodyReady.has(requestId)) {
          page._bodyReady.set(requestId, Promise.resolve());
        } else {
          // body() was called before loadingFinished — resolve the existing promise
          const { resolve: res } = page._bodyReady.get(requestId);
          if (res) res();
          page._bodyReady.set(requestId, Promise.resolve());
        }

        // Create Playwright-compatible response adapter
        const responseAdapter = {
          request: () => ({
            url: () => reqInfo.url,
            method: () => reqInfo.method,
            resourceType: () => reqInfo.resourceType,
            timing: () => resInfo.timing,
            headers: () => reqInfo.headers,
          }),
          status: () => resInfo.status,
          statusText: () => resInfo.statusText,
          headers: () => resInfo.headers,
          body: async () => {
            // Wait for loadingFinished if not already
            let readyPromise = page._bodyReady.get(requestId);
            if (!readyPromise) {
              // loadingFinished hasn't fired yet — create a pending promise
              let resolveReady;
              readyPromise = new Promise((r) => { resolveReady = r; });
              page._bodyReady.set(requestId, { promise: readyPromise, resolve: resolveReady });
            } else if (readyPromise.promise) {
              // Already a pending promise object — wait on it
              readyPromise = readyPromise.promise;
            }
            await readyPromise;
            try {
              const { body, base64Encoded } = await page._cdp("Network.getResponseBody", { requestId });
              return base64Encoded ? Buffer.from(body, "base64") : Buffer.from(body);
            } catch {
              throw new Error("Could not read response body");
            }
          },
          text: async () => {
            const buf = await responseAdapter.body();
            return buf.toString("utf-8");
          },
        };

        page._emit("response", responseAdapter);
        page._pendingRequests.delete(requestId);
        page._pendingResponses.delete(requestId);
      }
    });
  }

  /** Enable CDP Runtime domain and forward console events. */
  async _enableConsoleEvents() {
    await this._ensureDebugger();
    await this._cdp("Runtime.enable");

    const page = this;

    this._bridge.on("cdp", (msg) => {
      if (msg.tabId !== page._tabId) return;

      if (msg.method === "Runtime.consoleAPICalled") {
        const { type, args, stackTrace } = msg.params;
        const text = (args || [])
          .map((a) => a.value !== undefined ? String(a.value) : a.description || "")
          .join(" ");

        const location = stackTrace?.callFrames?.[0]
          ? {
              url: stackTrace.callFrames[0].url,
              lineNumber: stackTrace.callFrames[0].lineNumber,
              columnNumber: stackTrace.callFrames[0].columnNumber,
            }
          : {};

        // Playwright-compatible ConsoleMessage adapter
        const consoleAdapter = {
          type: () => type,
          text: () => text,
          location: () => location,
        };

        page._emit("console", consoleAdapter);
      }
    });
  }

  // --- Navigation ---

  async goto(url) {
    // Ensure CDP domains are enabled before navigating (avoids missing events)
    if (this._networkEnablePromise) await this._networkEnablePromise;
    if (this._consoleEnablePromise) await this._consoleEnablePromise;

    // Try to find an existing tab with this URL (captures what user sees, no reload)
    try {
      const found = await this._bridge.call("tabs.find", { url });
      if (found.found && found.tabId !== this._tabId) {
        // Detach debugger from old tab if attached
        if (this._debuggerAttached) {
          try { await this._bridge.call("debugger.detach", { tabId: this._tabId }); } catch { /* ok */ }
          this._debuggerAttached = false;
        }
        this._tabId = found.tabId;
        this._url = found.url;
        this._existingTab = true;
        return { tabId: this._tabId, url: this._url, reused: true };
      }
    } catch { /* tabs.find unavailable, fall through to navigate */ }

    const result = await this._bridge.call("tabs.navigate", {
      tabId: this._tabId,
      url,
    });
    this._url = result.url;
    this._existingTab = false;
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
        // Use CDP accessibility tree, return formatted text (Playwright-compatible)
        const { nodes } = await page._cdp("Accessibility.getFullAXTree");
        return formatAXTree(nodes);
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
    if (!this._mainFrame) {
      const page = this;
      this._mainFrame = {
        _isMainFrame: true,
        url() { return page._url; },
        async content() { return page.content(); },
      };
    }
    return this._mainFrame;
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
    // Don't close tabs the user already had open
    if (!this._existingTab) {
      await this._bridge.call("tabs.close", { tabId: this._tabId });
    }
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
    active: false,
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
