/**
 * sitecap Chrome extension service worker.
 *
 * Connects to the sitecap CLI's WebSocket server and bridges commands
 * to Chrome's extension APIs (chrome.debugger, chrome.tabs, chrome.cookies).
 *
 * Protocol: JSON messages over WebSocket.
 *   CLI → Extension: { id, method, params }
 *   Extension → CLI: { id, result } | { id, error }
 */

const DEFAULT_PORT = 9333;
const RECONNECT_DELAY_MS = 3000;

let ws = null;
let debugTargets = new Map(); // tabId → true (tracks which tabs we've attached debugger to)

// --- WebSocket lifecycle ---

function connect(port = DEFAULT_PORT) {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  ws = new WebSocket(`ws://127.0.0.1:${port}`);

  ws.onopen = () => {
    console.log(`[sitecap] connected to CLI on port ${port}`);
    chrome.action.setBadgeText({ text: "ON" });
    chrome.action.setBadgeBackgroundColor({ color: "#4CAF50" });
    ws.send(JSON.stringify({ type: "hello", version: "0.1.0" }));
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      console.error("[sitecap] invalid JSON from CLI:", event.data);
      return;
    }
    await handleMessage(msg);
  };

  ws.onclose = () => {
    ws = null;
    chrome.action.setBadgeText({ text: "" });
    setTimeout(() => connect(port), RECONNECT_DELAY_MS);
  };

  ws.onerror = () => {
    // Connection refused errors are expected when CLI isn't running.
    // Don't call ws.close() here — browser auto-closes after error per
    // WebSocket spec, and explicit close would double-fire onclose.
  };
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function reply(id, result) {
  send({ id, result });
}

function replyError(id, error) {
  send({ id, error: String(error) });
}

// --- Command handlers ---

async function handleMessage(msg) {
  const { id, method, params } = msg;

  try {
    switch (method) {
      case "ping":
        return reply(id, { pong: true });

      case "tabs.create":
        return reply(id, await handleTabsCreate(params));

      case "tabs.close":
        return reply(id, await handleTabsClose(params));

      case "tabs.navigate":
        return reply(id, await handleTabsNavigate(params));

      case "cookies.getAll":
        return reply(id, await handleCookiesGetAll(params));

      case "debugger.attach":
        return reply(id, await handleDebuggerAttach(params));

      case "debugger.detach":
        return reply(id, await handleDebuggerDetach(params));

      case "debugger.sendCommand":
        return reply(id, await handleDebuggerSendCommand(params));

      default:
        return replyError(id, `unknown method: ${method}`);
    }
  } catch (err) {
    replyError(id, err.message || String(err));
  }
}

// --- Tab management ---

async function handleTabsCreate(params) {
  const tab = await chrome.tabs.create({
    url: params.url || "about:blank",
    active: params.active !== false,
  });
  return { tabId: tab.id, url: tab.url };
}

async function handleTabsClose(params) {
  await chrome.tabs.remove(params.tabId);
  // Clean up debugger if attached
  if (debugTargets.has(params.tabId)) {
    try {
      await chrome.debugger.detach({ tabId: params.tabId });
    } catch {
      // Tab already closed
    }
    debugTargets.delete(params.tabId);
  }
  return { closed: true };
}

async function handleTabsNavigate(params) {
  const { tabId, url } = params;
  const NAV_TIMEOUT_MS = 30_000;
  await chrome.tabs.update(tabId, { url });

  // Wait for the tab to finish loading (with timeout)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      // Resolve with current state rather than hanging forever
      chrome.tabs.get(tabId).then((tab) => {
        resolve({ tabId: tab.id, url: tab.url, title: tab.title, timedOut: true });
      }).catch(() => reject(new Error(`Navigation to ${url} timed out after ${NAV_TIMEOUT_MS / 1000}s`)));
    }, NAV_TIMEOUT_MS);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        chrome.tabs.get(tabId).then((tab) => {
          resolve({ tabId: tab.id, url: tab.url, title: tab.title });
        });
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// --- Cookies ---

async function handleCookiesGetAll(params) {
  const cookies = await chrome.cookies.getAll({
    domain: params.domain,
    url: params.url,
  });
  return { cookies };
}

// --- Debugger (CDP bridge) ---

async function handleDebuggerAttach(params) {
  const { tabId } = params;
  if (debugTargets.has(tabId)) {
    return { attached: true, alreadyAttached: true };
  }
  await chrome.debugger.attach({ tabId }, "1.3");
  debugTargets.set(tabId, true);
  return { attached: true };
}

async function handleDebuggerDetach(params) {
  const { tabId } = params;
  if (debugTargets.has(tabId)) {
    await chrome.debugger.detach({ tabId });
    debugTargets.delete(tabId);
  }
  return { detached: true };
}

async function handleDebuggerSendCommand(params) {
  const { tabId, method, commandParams } = params;
  if (!debugTargets.has(tabId)) {
    throw new Error(`debugger not attached to tab ${tabId}. Call debugger.attach first.`);
  }
  const result = await chrome.debugger.sendCommand(
    { tabId },
    method,
    commandParams || {}
  );
  return result;
}

// --- Cleanup on tab close ---

chrome.tabs.onRemoved.addListener((tabId) => {
  if (debugTargets.has(tabId)) {
    debugTargets.delete(tabId);
  }
});

// --- Debugger detach events ---

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId) {
    debugTargets.delete(source.tabId);
    send({ type: "event", event: "debugger.detached", tabId: source.tabId, reason });
  }
});

// --- CDP event forwarding ---

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId) {
    send({ type: "event", event: "cdp", tabId: source.tabId, method, params });
  }
});

// --- Start (auto-connect with silent retry) ---
// Connection refused errors are Chrome-level logs visible only in the
// extension's service worker DevTools — normal users never see them.
// Long-term fix: migrate to Native Messaging (see EXT-2).

connect();
