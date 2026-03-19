/**
 * sitecap extension bridge — CLI-side WebSocket server.
 *
 * Starts a localhost WebSocket server that the sitecap Chrome extension
 * connects to. Provides an async RPC interface to call extension methods
 * (tabs, cookies, debugger/CDP) from the CLI.
 *
 * Usage:
 *   const bridge = await createExtensionBridge({ port: 9333 });
 *   const { tabId } = await bridge.call("tabs.create", { url: "https://example.com" });
 *   const result = await bridge.call("debugger.sendCommand", { tabId, method: "Page.captureScreenshot" });
 *   await bridge.close();
 */

import { WebSocketServer } from "ws";

const DEFAULT_PORT = 9333;
const CONNECT_TIMEOUT_MS = 30_000;

/**
 * Create a WebSocket bridge to the sitecap Chrome extension.
 *
 * @param {object} opts
 * @param {number} [opts.port=9333] - Port to listen on
 * @param {number} [opts.timeout=30000] - Max ms to wait for extension to connect
 * @param {function} [opts.log=console.log] - Logger function
 * @returns {Promise<ExtensionBridge>}
 */
export async function createExtensionBridge(opts = {}) {
  const port = opts.port || DEFAULT_PORT;
  const timeout = opts.timeout || CONNECT_TIMEOUT_MS;
  const log = opts.log || console.log;

  const wss = new WebSocketServer({ host: "127.0.0.1", port });
  let client = null;
  let nextId = 1;
  const pending = new Map(); // id → { resolve, reject, timer }
  const eventHandlers = new Map(); // event → [handler]

  // Wait for the extension to connect
  const connected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `sitecap extension did not connect within ${timeout / 1000}s.\n` +
            `Make sure the extension is loaded in Chrome:\n` +
            `  1. Open chrome://extensions\n` +
            `  2. Enable Developer mode\n` +
            `  3. Click "Load unpacked" and select the sitecap/extension/ directory\n` +
            `  4. Verify the extension shows "sitecap" with no errors`
        )
      );
      wss.close();
    }, timeout);

    wss.on("connection", (ws) => {
      client = ws;
      clearTimeout(timer);

      ws.on("message", (data) => {
        let msg;
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }

        // Hello handshake
        if (msg.type === "hello") {
          log(`Extension connected (v${msg.version})`);
          resolve();
          return;
        }

        // Event from extension
        if (msg.type === "event") {
          const handlers = eventHandlers.get(msg.event) || [];
          for (const h of handlers) h(msg);
          return;
        }

        // RPC response
        if (msg.id && pending.has(msg.id)) {
          const { resolve: res, reject: rej, timer: t } = pending.get(msg.id);
          clearTimeout(t);
          pending.delete(msg.id);
          if (msg.error) {
            rej(new Error(msg.error));
          } else {
            res(msg.result);
          }
        }
      });

      ws.on("close", () => {
        client = null;
        // Reject all pending calls
        for (const [id, { reject: rej, timer: t }] of pending) {
          clearTimeout(t);
          rej(new Error("Extension disconnected"));
          pending.delete(id);
        }
      });
    });
  });

  await connected;

  /**
   * Call a method on the extension.
   * @param {string} method - e.g., "tabs.create", "debugger.sendCommand"
   * @param {object} [params={}]
   * @param {number} [callTimeout=30000]
   * @returns {Promise<any>}
   */
  function call(method, params = {}, callTimeout = 30_000) {
    return new Promise((resolve, reject) => {
      if (!client || client.readyState !== 1) {
        return reject(new Error("Extension not connected"));
      }

      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Extension call "${method}" timed out after ${callTimeout / 1000}s`));
      }, callTimeout);

      pending.set(id, { resolve, reject, timer });
      client.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Listen for events from the extension.
   * @param {string} event
   * @param {function} handler
   */
  function on(event, handler) {
    if (!eventHandlers.has(event)) eventHandlers.set(event, []);
    eventHandlers.get(event).push(handler);
  }

  /**
   * Close the bridge and WebSocket server.
   */
  async function close() {
    for (const [, { reject: rej, timer }] of pending) {
      clearTimeout(timer);
      rej(new Error("Bridge closed"));
    }
    pending.clear();

    if (client) {
      client.close();
      client = null;
    }
    await new Promise((resolve) => wss.close(resolve));
  }

  return { call, on, close };
}
