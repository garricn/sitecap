# sitecap

Exhaustive web page capture tool. Captures up to 9 data types per page into structured directories. Connects to your running Chrome via extension (inheriting all auth/cookies) or auto-launches headless Chromium.

## Quick Start

```bash
npm install
```

### Public sites (no auth needed)

```bash
node bin/sitecap.js https://example.com --launch -o ./output
```

### Authenticated sites (recommended)

**One-time setup:** Load the Chrome extension.

1. Open `chrome://extensions` → Enable Developer mode
2. Click "Load unpacked" → select the `extension/` directory in this repo

**Every run:**

```bash
node bin/sitecap.js https://your-app.com/dashboard --extension -o ./output
```

That's it. The extension runs inside your Chrome, inheriting all cookies, sessions, and login state. No profile corruption, no cookie export, no Chrome restart.

### CI / headless (no extension)

For CI pipelines where no browser is running, use `--launch` with exported cookies:

```bash
node bin/sitecap.js https://your-app.com/dashboard --launch --auth cookies.json -o ./output
```

### Cookie export for CI

Export cookies + localStorage from your authenticated Chrome session:

```bash
node bin/sitecap.js auth export --extension -o auth.json
node bin/sitecap.js https://your-app.com --launch --auth auth.json -o ./output
```

### Explore flows (click through SPAs)

Capture each state of a multi-step SPA — tabs, sidebar sections, wizard steps:

```bash
# Auto-discover patterns on the page
node bin/sitecap.js discover https://your-app.com/dashboard --extension

# Or write a flow manually
cat > explore.yaml << 'EOF'
name: dashboard-sections
steps:
  - capture: initial
  - foreach:
      selector: ".sidebar-nav a"
      parallel: true
      steps:
        - click: $element
        - wait:
            ms: 2000
        - capture: section-{index}
EOF

# Run the explore flow
node bin/sitecap.js https://your-app.com/dashboard --extension --explore explore.yaml -o ./output
```

`foreach` iterates DOM elements, clicking each and capturing the result. `parallel: true` distributes across multiple Chrome tabs (`--parallel N`, default 2).

### Auth flows (advanced)

For complex login sequences, define steps in YAML:

```yaml
# auth/my-app.yaml
name: my-app-login
steps:
  - cookies: restore
  - wait: settle
  - fill: { selector: "#email", value: "$LOGIN_EMAIL" }
  - fill: { selector: "#password", value: "$LOGIN_PASSWORD" }
  - click: "button[type='submit']"
  - wait: redirect
  - cookies: save
```

```bash
node bin/sitecap.js https://your-app.com --launch --auth-flow auth/my-app.yaml -o ./output
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
-t, --types <list>       Comma-separated capture types
-v, --viewport <WxH>     Viewport size (default: 1280x720)
-c, --concurrency <n>    Parallel tabs (default: 4)
--extension              Connect via Chrome extension (inherits auth, recommended)
--extension-port <port>  WebSocket port for extension bridge (default: 9333)
--launch                 Auto-launch headless Chrome (clean session)
--crawl                  Crawl same-origin links from captured pages
--max-depth <n>          Max crawl depth (default: 3)
--max-pages <n>          Max pages to crawl (default: 50)
--filter <regex>         Only crawl URLs matching pattern
--exclude <regex>        Skip URLs matching pattern
--auth <file>            Load cookies/storage from JSON before capture
--explore <file>         Run click-flow YAML (foreach/capture steps)
--parallel <n>           Tabs for parallel foreach (default: 2, requires --extension)
--wait <ms>              Delay before capture (for iframe-heavy SPAs)
--settle-timeout <ms>    Max settle wait (default: 10000)
--wait-for-text <text>   Wait for text in DOM before capturing
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

# Auto-discover clickable patterns on a page
node bin/sitecap.js discover https://your-app.com/editor --extension --wait-for-text "Steps"

# Capture with longer settle for slow SPAs
node bin/sitecap.js https://your-app.com --extension --settle-timeout 20000 --wait-for-text "Dashboard"
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
