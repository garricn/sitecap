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

        // Re-enable CDP domains on the new tab so listeners work
        // (listeners use page._tabId dynamically, but domains must be enabled)
        if (this._networkEnabled) {
          await this._ensureDebugger();
          await this._cdp("Network.enable");
        }
        if (this._consoleEnabled) {
          await this._ensureDebugger();
          await this._cdp("Runtime.enable");
        }

        // Clear stale request tracking from old tab
        this._pendingRequests.clear();
        this._pendingResponses.clear();
        this._bodyReady.clear();

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

  // --- Locator ---

  locator(selector) {
    return new ExtensionLocator(this, selector);
  }

  // --- Page wait methods (for explore/auth flows) ---

  async waitForTimeout(ms) {
    await new Promise((r) => setTimeout(r, ms));
  }

  async waitForURL(predicate, opts = {}) {
    const timeout = opts.timeout || 15_000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const currentUrl = await this.evaluate(() => window.location.href);
      this._url = currentUrl;
      const match = typeof predicate === "function"
        ? predicate(new URL(currentUrl))
        : currentUrl.includes(predicate);
      if (match) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`waitForURL timed out after ${timeout}ms`);
  }

  async waitForLoadState() {
    // Best-effort: wait for document.readyState === "complete" + brief network quiet
    const timeout = 10_000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const ready = await this.evaluate(() => document.readyState);
      if (ready === "complete") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    // Brief pause for trailing network activity
    await new Promise((r) => setTimeout(r, 500));
  }

  async reload() {
    await this._cdp("Page.reload");
    await this.waitForLoadState();
    this._url = await this.evaluate(() => window.location.href);
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
 * Playwright-compatible locator backed by CDP.
 * Supports: click, fill, all, first, waitFor, ariaSnapshot.
 */
class ExtensionLocator {
  constructor(page, selector, nth = undefined) {
    this._page = page;
    this._selector = selector;
    this._nth = nth;
  }

  /** Parse "selector >> nth=N" syntax used by foreach flows. */
  _parseSelector() {
    const nthMatch = this._selector.match(/^(.+?)\s*>>\s*nth=(\d+)$/);
    if (nthMatch) return { css: nthMatch[1], nth: parseInt(nthMatch[2], 10) };
    return { css: this._selector, nth: this._nth };
  }

  /** Resolve to a CDP RemoteObject via Runtime.evaluate. */
  async _resolve() {
    const { css, nth } = this._parseSelector();
    const index = nth ?? 0;
    const { result, exceptionDetails } = await this._page._cdp("Runtime.evaluate", {
      expression: `(() => {
        const els = document.querySelectorAll(${JSON.stringify(css)});
        return els[${index}] || null;
      })()`,
      returnByValue: false,
    });
    if (exceptionDetails) throw new Error("Locator resolve failed: " + (exceptionDetails.text || "unknown"));
    if (!result.objectId) throw new Error(`No element found for "${this._selector}"`);
    return result;
  }

  first() {
    return new ExtensionLocator(this._page, this._selector, 0);
  }

  async all() {
    const { css } = this._parseSelector();
    const count = await this._page.evaluate((sel) => document.querySelectorAll(sel).length, css);
    return Array.from({ length: count }, (_, i) => new ExtensionLocator(this._page, css, i));
  }

  async click() {
    const remote = await this._resolve();
    // Scroll into view
    await this._page._cdp("Runtime.callFunctionOn", {
      objectId: remote.objectId,
      functionDeclaration: "function() { this.scrollIntoView({ block: 'center', behavior: 'instant' }); }",
      returnByValue: true,
    });
    await new Promise((r) => setTimeout(r, 100));
    // Get bounding box
    const { model } = await this._page._cdp("DOM.getBoxModel", { objectId: remote.objectId });
    const quad = model.content;
    const cx = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const cy = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    // Click
    await this._page._cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 });
    await this._page._cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 });
  }

  async fill(value) {
    const remote = await this._resolve();
    await this._page._cdp("Runtime.callFunctionOn", {
      objectId: remote.objectId,
      functionDeclaration: `function(val) {
        this.focus();
        this.value = '';
        this.value = val;
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }`,
      arguments: [{ value }],
      returnByValue: true,
    });
  }

  async waitFor(opts = {}) {
    const state = opts.state || "visible";
    const timeout = opts.timeout || 10_000;
    const { css, nth } = this._parseSelector();
    const index = nth ?? 0;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const visible = await this._page.evaluate((sel, idx, wantState) => {
        const el = document.querySelectorAll(sel)[idx];
        if (!el) return wantState === "hidden" || wantState === "detached";
        if (wantState === "hidden") return el.offsetParent === null;
        if (wantState === "detached") return false;
        // "visible" or "attached"
        if (wantState === "attached") return true;
        return el.offsetParent !== null || window.getComputedStyle(el).display !== "none";
      }, css, index, state);
      if (visible) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`locator.waitFor("${state}") timed out after ${timeout}ms for "${this._selector}"`);
  }

  async ariaSnapshot() {
    const { nodes } = await this._page._cdp("Accessibility.getFullAXTree");
    return formatAXTree(nodes);
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
