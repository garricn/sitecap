# sitecap

Exhaustive web page capture tool. Connects to your running Chrome (inheriting all logged-in sessions) or auto-launches headless Chromium. Captures up to 9 data types per page into structured directories.

## Quick Start

```bash
npm install
```

### Public sites (no auth needed)

```bash
node bin/sitecap.js https://example.com --launch -o ./output
```

### Authenticated sites (use your real Chrome sessions)

1. Launch Chrome with remote debugging (your profiles and logins stay intact):

```bash
# macOS
open -a "Google Chrome" --args --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222
```

2. Browse normally — you're signed in everywhere as usual.

3. Capture:

```bash
node bin/sitecap.js https://your-app.com/dashboard -o ./output
```

sitecap connects to your Chrome and inherits all cookies, auth state, and sessions.

### CI with auth

Export cookies from a local session, then reuse in CI:

```bash
# Local: capture storage from an authenticated session
node bin/sitecap.js https://your-app.com -o ./auth-capture
# Use the captured storage.json as auth input
node bin/sitecap.js https://your-app.com --launch --auth ./auth-capture/your-app.com/storage.json -o ./output
```

## Capture Types

Each page produces up to 9 files + `meta.json`:

| File | Type flag | Description |
|------|-----------|-------------|
| `screenshot.png` | `screenshot` | Full-page scroll capture |
| `accessibility.txt` | `accessibility` | ARIA snapshot tree |
| `page-source.html` | `html` | Rendered DOM (post-JavaScript) |
| `network.json` | `network` | All requests with timing data |
| `console.json` | `console` | Console messages |
| `storage.json` | `storage` | Cookies + localStorage + sessionStorage |
| `performance.json` | `performance` | Core Web Vitals (LCP, CLS, FCP) + navigation timing |
| `page.mhtml` | `mhtml` | Offline-viewable archive |
| `video.webm` | via `--video` | Page load recording |

Default captures: screenshot, accessibility, html, network, console, storage, performance.
MHTML and video are opt-in.

## Options

```
-o, --output <dir>       Output directory (default: ./output)
-p, --port <port>        Chrome DevTools port (default: 9222)
-t, --types <list>       Comma-separated capture types
-v, --viewport <WxH>     Viewport size (default: 1280x720)
-c, --concurrency <n>    Parallel tabs (default: 4)
--launch                 Auto-launch headless Chrome (clean session)
--crawl                  Crawl same-origin links from captured pages
--max-depth <n>          Max crawl depth (default: 3)
--max-pages <n>          Max pages to crawl (default: 50)
--filter <regex>         Only crawl URLs matching pattern
--exclude <regex>        Skip URLs matching pattern
--auth <file>            Load cookies from JSON before capture
--video                  Record page video (off by default)
-m, --manifest <file>    JSON manifest of URLs to capture
-h, --help               Show help
```

## Examples

```bash
# Crawl a site (max 20 pages, 2 levels deep)
node bin/sitecap.js https://example.com --crawl --max-depth 2 --max-pages 20 --launch

# Mobile viewport
node bin/sitecap.js https://example.com -v 375x812 --launch

# Only screenshot + accessibility
node bin/sitecap.js https://example.com -t screenshot,accessibility --launch

# Crawl docs only, skip API routes
node bin/sitecap.js https://example.com --crawl --filter '/docs' --exclude '/api' --launch

# Compare two captures
node bin/sitecap.js diff ./before/example.com ./after/example.com

# Record video of page load
node bin/sitecap.js https://example.com --video --launch
```

## Diff

Compare two capture directories:

```bash
node bin/sitecap.js diff <dir-a> <dir-b> [--threshold 0.5] [--output report.json]
```

Compares screenshots (pixel diff), accessibility tree, console errors, network requests, and storage keys. Exit code 0 if identical, 1 if differences found.

## Manifest Format

```json
[
  { "url": "https://example.com/page1", "slug": "page1" },
  { "url": "https://example.com/page2", "slug": "subdir/page2" }
]
```

## License

MIT
