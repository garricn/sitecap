# sitecap

Exhaustive web page capture tool. Connects to an existing Chrome session via CDP (or auto-launches headless) and captures 6 data types per page into structured directories.

## Tech Stack

- Node.js (ESM)
- Playwright (CDP connection to existing Chrome, or auto-launch)
- No build step

## Project Structure

```
bin/sitecap.js    — CLI entry point
lib/capture.js    — core capture logic (capturePage, navigateAndCapture, waitForPageSettle)
lib/chrome.js     — Chrome profile discovery and launch (findChromeExecutable, resolveProfileDir, launchChromeWithProfile)
```

## Commands

```bash
node bin/sitecap.js <url> --launch -o ./output         # auto-launch headless Chrome
node bin/sitecap.js <url> -o ./output                   # connect to existing Chrome on port 9222
node bin/sitecap.js -m manifest.json -o ./out           # capture from manifest
node bin/sitecap.js <url> -v 1920x1080 -c 6 --launch   # custom viewport, 6 parallel tabs
make check                                              # lint + test
```

## Chrome Connection

Three modes:
- **Attach** (default): connects to Chrome via `--remote-debugging-port` (default 9222). Inherits cookies/auth state.
- **Launch** (`--launch`): auto-launches headless Chromium via Playwright. Clean session, no auth.
- **Profile** (`--profile <name>`): launches real Chrome with user's profile (cookies, auth, extensions) and connects via CDP. Chrome must not already be running. Use `--no-keep-open` to close Chrome after capture.

## Key Features

- **Parallel capture**: `--concurrency N` (default 4) runs N tabs simultaneously in the same browser context
- **Dynamic page settle**: `waitForPageSettle()` uses MutationObserver + PerformanceObserver instead of fixed timeouts
- **Custom viewport**: `--viewport WxH` (default 1280x720)

## Capture Types

Each page produces 6 files + meta.json in its output directory:
- `screenshot.png` — full-page scroll capture
- `accessibility.txt` — ARIA snapshot tree
- `page-source.html` — rendered DOM
- `network.json` — XHR/fetch requests with response bodies
- `console.json` — console messages
- `storage.json` — cookies + localStorage + sessionStorage
- `meta.json` — URL, timestamp, capture results, errors
