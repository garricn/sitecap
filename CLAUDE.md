# sitecap

Exhaustive web page capture tool. Connects to your running Chrome via CDP (inheriting all auth/cookies) or auto-launches headless Chromium. Captures up to 9 data types per page.

## Tech Stack

- Node.js (ESM)
- Playwright (CDP connection or auto-launch)
- No build step

## Project Structure

```
bin/sitecap.js    — CLI entry point (capture + diff subcommands)
lib/capture.js    — core capture logic (capturePage, navigateAndCapture, waitForPageSettle, extractLinks)
lib/chrome.js     — Chrome profile discovery and launch (findChromeExecutable, resolveProfileDir, launchChromeWithProfile)
lib/diff.js       — diff logic for comparing two capture directories
```

## Commands

```bash
node bin/sitecap.js <url> -o ./output                   # connect to Chrome on port 9222 (inherits auth)
node bin/sitecap.js <url> --launch -o ./output           # auto-launch headless (clean session)
node bin/sitecap.js <url> --launch --auth cookies.json   # headless with injected auth
node bin/sitecap.js <url> --crawl --max-pages 20 --launch  # crawl site
node bin/sitecap.js diff <dir-a> <dir-b>                 # compare captures
make check                                               # lint + test
```

## Chrome Connection

Four modes:
- **Attach** (default): connects to `--remote-debugging-port` (default 9222). Inherits all cookies, sessions, profiles.
- **Profile** (`--profile <name>`): launches real Chrome with user's profile (cookies, auth, extensions). Chrome must not already be running.
- **Launch** (`--launch`): auto-launches headless Chromium. Clean session, no auth. For public sites and CI.
- **Auth** (`--auth <file>`): loads cookies from JSON into a launched browser. For CI/automated auth.
- **Wait-for-auth** (`--wait-for-auth`): launches Chrome with profile, polls for URL change after login, saves cookies for future runs.
- **Auth flow** (`--auth-flow <file>`): user-defined YAML with click/fill/wait steps for complex login sequences.

Authenticated workflow: `--profile --wait-for-auth` once (saves cookies) → `--launch --auth <cookies>` for all subsequent runs (headless, no modal).

To use attach mode: `open -a "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug` (Chrome 136+ requires `--user-data-dir`).

## Capture Types

Default (7): screenshot, accessibility, html, network, console, storage, performance.
Opt-in: mhtml (`-t mhtml`), video (`--video`).

| File | Description |
|------|-------------|
| `screenshot.png` | Full-page scroll capture |
| `accessibility.txt` | ARIA snapshot tree |
| `page-source.html` | Rendered DOM |
| `network.json` | All requests with timing (DNS, TTFB, etc.) |
| `console.json` | Console messages |
| `storage.json` | Cookies + localStorage + sessionStorage |
| `performance.json` | Core Web Vitals (LCP, CLS, FCP) + navigation timing + resource summary |
| `page.mhtml` | Offline-viewable MHTML archive (opt-in) |
| `video.webm` | Page load recording (opt-in via --video) |

## Key Features

- **Parallel capture**: `--concurrency N` (default 4) — N tabs in same browser context
- **Dynamic page settle**: MutationObserver + PerformanceObserver (500ms quiet, 10s max)
- **Crawl**: `--crawl` with `--max-depth`, `--max-pages`, `--filter`, `--exclude`
- **Diff**: `sitecap diff <a> <b>` — pixel diff, a11y diff, network/console/storage diff
- **Custom viewport**: `--viewport WxH` (default 1280x720)
