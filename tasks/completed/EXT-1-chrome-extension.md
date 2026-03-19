# EXT-1: sitecap Chrome Extension — Authenticated Capture via Extension Bridge

## Context & Problem

### Why this is needed

sitecap's four Chrome connection modes are all broken or unsafe for authenticated capture on Chrome 146+:

| Mode | Status | Problem |
|------|--------|---------|
| **Attach** (default, port 9222) | **Broken** | Chrome 146 silently refuses `--remote-debugging-port` when `--user-data-dir` points to the real profile dir |
| **Profile** (`--profile`) | **Unsafe** | Playwright's `launchPersistentContext` injects `--password-store=basic`, `--use-mock-keychain`, `--disable-sync`, `--enable-automation` — these flags **corrupt the real Chrome profile**, wiping session cookies and disconnecting Google sync |
| **Launch** (`--launch`) | Works | Clean headless session — no auth, useless for authenticated pages |
| **Auth** (`--auth cookies.json`) | Works | Requires manually exporting cookies; sessions expire |

### What broke

Timeline (from git history, March 15–18, 2026):

1. **Original `--profile`** worked via `launchPersistentContext` with `executablePath` pointing to system Chrome
2. **FedCM/Google OAuth fix attempt** — tried switching to `spawn()` + `connectOverCDP()`, but macOS sandbox won't bind TCP ports from `spawn()`
3. **Reverted to `launchPersistentContext`** with `channel: "chrome"` — works but FedCM broken, marked as known limitation
4. **Chrome 136+ change** — `--remote-debugging-port` now requires `--user-data-dir`, breaking attach mode instructions
5. **Chrome 146** (current, March 2026) — silently refuses CDP on the real user data dir entirely; `--remote-debugging-port` + real `--user-data-dir` produces: `"DevTools remote debugging requires a non-default data directory"`

**Root cause**: Chrome progressively locked down CDP access to prevent profile hijacking. The same security change that protects users from malware also blocks legitimate tools like sitecap from accessing the real profile.

### How other tools solve this

**Claude in Chrome (extension model)**:
- Chrome extension that runs **inside** the user's browser process
- Communicates with Claude Desktop via WebSocket
- Inherits all cookies/auth/sessions automatically — it IS the browser
- Uses `chrome.debugger` API for CDP access (extension-level, no port needed)
- Zero profile corruption risk — never launches a new process, never touches profile files on disk
- Tools: `tabs_context_mcp`, `navigate`, `read_page`, `javascript_tool`, etc.

**OpenClaw (v2026.3.13-beta.1)**:
- Three-tier approach: isolated managed Chromium (default), attach to running Chrome via Chrome DevTools MCP, or remote CDP
- Attach mode uses `chrome://inspect/#remote-debugging` consent flow
- Never touches the user's profile directory directly
- Loopback-only, token-gated API access

**Key insight**: Both tools that successfully access authenticated sessions do so by **connecting to the running Chrome from inside** (extension) or **with user consent** (DevTools MCP), never by launching a new Chrome process against the real profile.

## Goal

Add a fifth connection mode to sitecap: `--extension` — a Chrome extension bridge that enables authenticated capture through the user's running Chrome without launching a new process or touching profile files.

## Architecture

```
sitecap CLI (capture logic)
    ↕ WebSocket (localhost)
sitecap Chrome extension (Manifest V3)
    ↕ chrome.debugger API (CDP)
    ↕ chrome.cookies API
    ↕ chrome.tabs API
User's authenticated Chrome (unchanged, running normally)
```

### Extension responsibilities (thin bridge)
- Accept WebSocket connections from sitecap CLI on localhost
- Create/manage tabs on behalf of sitecap
- Forward CDP commands via `chrome.debugger.sendCommand()`
- Provide cookie access via `chrome.cookies.getAll()`
- Report tab lifecycle events back to CLI

### CLI responsibilities (existing capture logic)
- All capture types (screenshot, accessibility, HTML, network, console, storage, performance, MHTML, video)
- Page settle detection (MutationObserver + PerformanceObserver)
- Crawl/BFS link extraction
- Diff engine
- Output to disk

### What stays the same
- All 7+ capture types
- Page settle logic
- Crawl mode
- Diff mode
- Parallel capture (multiple tabs)
- All existing connection modes (attach, profile, launch, auth) remain available

## Comparison: sitecap vs Claude in Chrome vs OpenClaw

| Aspect | sitecap (current) | Claude in Chrome | OpenClaw | sitecap (with extension) |
|--------|-------------------|------------------|----------|-------------------------|
| **Connection** | Launch new Chrome / attach to CDP port | Extension inside Chrome | Isolated Chromium / DevTools MCP attach | Extension inside Chrome |
| **Auth inheritance** | Broken on Chrome 146 | Automatic | Automatic (attach mode) | Automatic |
| **Profile safety** | Unsafe (Playwright corrupts profile) | Safe (never touches profile) | Safe (never touches profile) | Safe (never touches profile) |
| **Chrome must restart** | Yes (profile) or manual flags (attach) | No | No (attach mode) | No |
| **Capture depth** | 7+ types, settle detection, MHTML | Screenshot, DOM, console, network | Varies | 7+ types, settle detection, MHTML |
| **Parallelism** | Worker pool (4 tabs) | Single tab | Single tab | Worker pool (4 tabs) |
| **Diffing** | Pixel + text + JSON diffs | None | None | Pixel + text + JSON diffs |

## Decisions

1. **WebSocket** for CLI↔extension communication. No native messaging host manifest needed, works cross-platform without per-platform config. Localhost-only binding (`ws://127.0.0.1:<port>`) for security.

2. **Developer mode only** for distribution. No Chrome Web Store review delays. Users load the unpacked extension from the sitecap repo (`extension/` dir).

3. **CDP via chrome.debugger** for full capture capability. The "debugging" infobar is acceptable for a capture tool. Needed for: MHTML export, full accessibility tree, network timing, performance metrics. Can't get these from tabs API alone.

4. **Opt-in via `--extension` flag**. Existing modes remain. May become default in a future version once proven stable.

5. **`chrome.tabCapture`** for video recording. Replaces Playwright's `recordVideo` in extension mode.

## Open Questions

1. **Infobar UX**: `chrome.debugger.attach()` shows "sitecap started debugging this tab" infobar. Can we minimize user annoyance? (Detach immediately after capture? Use a single long-lived debug session?)

2. **Port selection**: Fixed port (e.g., 9333) or dynamic with discovery? Fixed is simpler; dynamic avoids conflicts.

## Implementation Phases

### Phase 1: Extension scaffold + WebSocket bridge
- Manifest V3 extension with `chrome.debugger`, `chrome.tabs`, `chrome.cookies` permissions
- Service worker that connects to CLI's WebSocket server
- CLI-side WebSocket server in `lib/extension.js`
- Basic handshake: CLI starts WS server → extension connects → ready signal

### Phase 2: Tab management + navigation
- CLI sends `navigate(url)` → extension creates tab, navigates, reports load
- CLI sends `cookies(domain)` → extension returns cookies via `chrome.cookies.getAll()`
- Tab lifecycle events forwarded to CLI

### Phase 3: CDP bridge
- CLI sends CDP commands → extension forwards via `chrome.debugger.sendCommand()` → returns results
- Support all existing capture types through the CDP bridge
- Page settle detection works as-is (MutationObserver injected via `chrome.debugger`)

### Phase 4: Full integration
- Wire `--extension` flag in `bin/sitecap.js`
- Parallel capture via multiple tabs (existing worker pool logic)
- Crawl mode via extension
- Video capture via `chrome.tabCapture`

### File changes

| File | Change |
|------|--------|
| `extension/manifest.json` | New — Manifest V3, permissions, service worker |
| `extension/service-worker.js` | New — WebSocket client, CDP bridge, tab management |
| `lib/extension.js` | New — WebSocket server, command protocol, connection management |
| `bin/sitecap.js` | Modify — add `--extension` flag, route to extension bridge |
| `lib/capture.js` | Modify — accept extension-provided page/CDP session alongside Playwright page |

### Dependency direction

```
bin/sitecap.js → lib/extension.js → WebSocket → extension/service-worker.js
                                                        ↓
bin/sitecap.js → lib/capture.js ← CDP commands ← chrome.debugger API
```

`lib/capture.js` must accept either a Playwright `page` object OR an extension CDP session. Abstract the interface so capture logic doesn't know which backend it's using.

## Before closing
- [ ] Run make check (lint + typecheck + tests pass)
- [ ] Re-read each AC and locate the line of code that enforces it
- [ ] Test extension with Chrome 146 specifically
- [ ] Verify extension does NOT require `--remote-debugging-port` flag
- [ ] Verify extension does NOT touch profile files on disk
- [ ] Test authenticated capture on a real MODX manager page
