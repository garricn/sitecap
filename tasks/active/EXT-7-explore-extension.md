# EXT-7: Enable --explore with --extension mode

## Context

`--explore <flow.yaml>` drives click-flow YAML (foreach, click, fill, wait, capture steps) via `runAuthFlow()` in `lib/auth.js`. Currently silently skipped when `--extension` is active (line 357 of `bin/sitecap.js`: `if (values.explore && !extensionBridge)`).

The blocker: `runAuthFlow()` calls Playwright `Page` APIs that `ExtensionPage` doesn't implement — locator interactions (click, fill, all, waitFor) and page-level waits (waitForURL, waitForLoadState, waitForTimeout, reload).

## Goal

Make `--explore` work with `--extension` so users can run click-flow YAML against authenticated sessions in their real Chrome.

## Phase 1: ExtensionPage Locator API

**File: `lib/extension-page.js`**

### 1A. Locator class with element resolution

Replace the stub `locator()` method (lines 362–371) with a real `ExtensionLocator` that stores the selector and resolves to a DOM element via CDP.

Element resolution strategy — use `Runtime.evaluate` to find elements:
- CSS selectors: `document.querySelectorAll(selector)`
- `>> nth={N}` suffix: parse it off, use `querySelectorAll` then index
- Return a `Runtime.RemoteObject` with `objectId` for subsequent operations

The locator must support:
- `.all()` → array of locators (one per matched element, using `nth=` indexing)
- `.first()` → locator with `nth=0`
- `.click()` → resolve element → get bounding box → `Input.dispatchMouseEvent`
- `.fill(value)` → resolve element → focus → clear → type via `Input.dispatchKeyEvent` (or `Runtime.evaluate` to set `.value` + dispatch `input`/`change` events)
- `.waitFor({ state: "visible", timeout })` → poll via `Runtime.evaluate` checking element exists + is visible (offsetParent !== null, visibility !== hidden, display !== none)
- `.ariaSnapshot()` → existing implementation (keep as-is)

### 1B. Click implementation detail

To click an element by its resolved `objectId`:

```
1. DOM.getBoxModel({ objectId }) → get content quad
2. Calculate center point (x, y) from quad vertices
3. Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 })
4. Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 })
```

Edge case: if element is off-screen, scroll it into view first via `Runtime.evaluate` → `element.scrollIntoView({ block: "center" })`.

### 1C. Fill implementation detail

Simplest reliable approach — use `Runtime.evaluate` directly:

```
1. Focus the element: Runtime.evaluate → element.focus()
2. Clear existing value: Runtime.evaluate → element.value = ''
3. Set new value: Runtime.evaluate → element.value = 'text'
4. Dispatch events: Runtime.evaluate → element.dispatchEvent(new Event('input', {bubbles: true}))
   + element.dispatchEvent(new Event('change', {bubbles: true}))
```

This handles React/Vue controlled inputs that listen on `input` events.

## Phase 2: Page-level wait methods

**File: `lib/extension-page.js`**

Add these methods to `ExtensionPage`:

| Method | Implementation |
|--------|---------------|
| `waitForTimeout(ms)` | `new Promise(r => setTimeout(r, ms))` |
| `waitForURL(predicate, { timeout })` | Poll `this.url()` (refresh via `Runtime.evaluate` → `location.href`) against predicate. Also listen for CDP `Page.frameNavigated` events for faster response. |
| `waitForLoadState(state)` | For `"networkidle"`: track in-flight requests via Network.requestWillBeSent / loadingFinished counts, resolve when 0 for 500ms. For `"domcontentloaded"`: `Runtime.evaluate` → `document.readyState`. |
| `reload({ waitUntil })` | `Page.reload` CDP command, then `waitForLoadState(waitUntil)`. |

## Phase 3: Wire up explore in extension mode

**File: `bin/sitecap.js`**

### 3A. Remove the `!extensionBridge` guard

Change line 357 from:
```javascript
if (values.explore && !extensionBridge) {
```
to:
```javascript
if (values.explore) {
```

### 3B. Handle extension page creation differently

The current explore block (lines 359–363) creates a Playwright page:
```javascript
const explorePage = await context.newPage();
await explorePage.goto(exploreTarget, { waitUntil: "domcontentloaded", timeout: 30_000 });
await explorePage.waitForLoadState("networkidle").catch(() => {});
```

For extension mode, use the existing extension page (or create a new tab):
```javascript
let explorePage;
if (extensionBridge) {
  const { createExtensionPage } = await import("../lib/extension-page.js");
  explorePage = await createExtensionPage(extensionBridge, { url: exploreTarget, viewport });
  // Wait for page to settle (extension goto already navigates)
  await explorePage.waitForLoadState("networkidle").catch(() => {});
} else {
  explorePage = await context.newPage();
  await explorePage.setViewportSize(viewport);
  await explorePage.goto(exploreTarget, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await explorePage.waitForLoadState("networkidle").catch(() => {});
}
```

### 3C. Context mock for extension mode

`runAuthFlow()` receives `context` as third argument. It uses:
- `context.waitForEvent("page")` — popup detection
- `context.cookies()` — cookie access
- `context.addCookies()` — cookie restore

For extension mode, pass a thin context adapter:
```javascript
const extContext = {
  waitForEvent(event, opts) {
    // Listen for new tabs via extension bridge
    // Return a promise that resolves with a new ExtensionPage when a tab opens
  },
  async cookies(url) {
    return explorePage.context().cookies(url);
  },
  async addCookies(cookies) {
    // Not supported in extension mode — cookies are already in the real browser
    console.log("  (skipping addCookies in extension mode — browser already authenticated)");
  }
};
```

### 3D. Cleanup

Extension mode cleanup differs — don't close the tab if it was pre-existing. The existing `explorePage.close()` logic in `ExtensionPage` already handles this (it checks `_existingTab`).

Remove the video cleanup block for extension mode (extension doesn't support video recording):
```javascript
if (!extensionBridge) {
  if (values["session-video"] && explorePage.video()) { ... }
}
```

## Phase 4: Unsupported step graceful degradation

Some steps won't work in extension mode. Handle gracefully:

| Step | Extension support | Degradation |
|------|-------------------|-------------|
| `click` | ✅ Phase 1 | — |
| `fill` | ✅ Phase 1 | — |
| `foreach` | ✅ Phase 1 | — |
| `capture` | ✅ Already works (capturePage uses ExtensionPage) | — |
| `wait: popup` | ⚠️ Partial | Log warning, skip if no tab event within timeout |
| `wait: redirect` | ✅ Phase 2 | — |
| `wait: settle` | ✅ Phase 2 | — |
| `wait: { ms }` | ✅ Phase 2 | — |
| `wait: { selector }` | ✅ Phase 1 (locator.waitFor) | — |
| `goto` | ✅ Already works | — |
| `cookies: save` | ⚠️ Skip | Log: "cookies already in browser" |
| `cookies: restore` | ⚠️ Skip | Log: "cookies already in browser" |

## Dependency direction

```
bin/sitecap.js
  → imports lib/extension-page.js (ExtensionPage, createExtensionPage)
  → imports lib/auth.js (runAuthFlow)
lib/auth.js
  → calls page.locator(), page.waitForURL(), etc. (duck-typed, works with ExtensionPage)
  → calls context.waitForEvent(), context.cookies() (duck-typed, works with ext context adapter)
lib/extension-page.js
  → talks to extension bridge (WebSocket → service worker → CDP)
  → no imports from auth.js or sitecap.js
```

## Files to modify

1. **`lib/extension-page.js`** — Add `ExtensionLocator` class, locator interaction methods, page wait methods
2. **`bin/sitecap.js`** — Remove `!extensionBridge` guard, add extension-mode explore block with context adapter
3. **`extension/service-worker.js`** — May need `tabs.onCreated` forwarding for popup detection (Phase 4, stretch)

## Testing strategy

1. **Unit**: Create an explore YAML that clicks elements and captures — run with `--extension` against a local test page
2. **Integration**: Use an authenticated site (e.g., a CMS admin panel) — verify explore captures work with real auth
3. **Regression**: Run existing `--explore` tests with `--launch` to confirm no breakage

### Key assertions

- `locator(selector).all()` returns correct count for a page with known element count
- `locator(selector).click()` triggers the click (verify via page state change)
- `locator(selector).fill(value)` sets input value (verify via evaluate)
- `waitForTimeout(500)` resolves after ~500ms (not 0ms, not >1000ms)
- Explore flow with `--extension` produces capture output identical in structure to `--launch` output
- Cookie save/restore steps log skip message in extension mode, don't error

## Before closing

- [ ] Run `make check` (lint + test)
- [ ] Re-read each AC and locate the line of code that enforces it
- [ ] For every boolean condition, verify both True and False paths are covered by tests
- [ ] Verify `--explore` with `--launch` still works (regression)
- [ ] Verify `--explore` with `--extension` produces captures in expected directory structure
