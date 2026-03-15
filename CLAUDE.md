# sitecap

Exhaustive web page capture tool. Connects to an existing Chrome session via CDP and captures 6 data types per page into structured directories.

## Tech Stack

- Node.js (ESM)
- Playwright (CDP connection to existing Chrome)
- No build step

## Project Structure

```
bin/sitecap.js    — CLI entry point
lib/capture.js    — core capture logic (capturePage, navigateAndCapture, setup helpers)
```

## Commands

```bash
node bin/sitecap.js <url> -o ./output          # capture single page
node bin/sitecap.js -m manifest.json -o ./out   # capture from manifest
```

## Chrome Connection

Connects to Chrome via `--remote-debugging-port` (default 9222). Uses the first browser context (inherits cookies/auth state from the running Chrome session).

## Capture Types

Each page produces 6 files + meta.json in its output directory:
- `screenshot.png` — full-page scroll capture
- `accessibility.txt` — a11y tree (JSON)
- `page-source.html` — rendered DOM
- `network.json` — XHR/fetch requests with response bodies
- `console.json` — console messages
- `storage.json` — cookies + localStorage + sessionStorage
- `meta.json` — URL, timestamp, capture results, errors
