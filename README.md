# sitecap

Exhaustive web page capture tool. Connects to an existing Chrome session via CDP and captures 6 data types per page into structured directories.

## Capture Types

Each page produces 6 files + `meta.json`:

| File | Description |
|------|-------------|
| `screenshot.png` | Full-page scroll capture |
| `accessibility.txt` | Accessibility tree (JSON) |
| `page-source.html` | Rendered DOM |
| `network.json` | XHR/fetch requests with response bodies |
| `console.json` | Console messages |
| `storage.json` | Cookies + localStorage + sessionStorage |

## Setup

```bash
npm install
```

Launch Chrome with remote debugging enabled:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

## Usage

```bash
# Capture a single page
node bin/sitecap.js https://example.com -o ./output

# Capture multiple pages
node bin/sitecap.js https://example.com/a https://example.com/b -o ./captures

# Capture from a manifest
node bin/sitecap.js -m manifest.json -o ./captures
```

### Options

```
-o, --output <dir>      Output directory (default: ./output)
-p, --port <port>       Chrome DevTools port (default: 9222)
-t, --types <list>      Comma-separated capture types (default: all)
                        Types: screenshot,accessibility,html,network,console,storage
-w, --wait <ms>         Extra wait after load (default: 2000)
-m, --manifest <file>   JSON manifest of URLs to capture
-h, --help              Show this help
```

### Manifest Format

```json
[
  { "url": "https://example.com/page1", "slug": "page1" },
  { "url": "https://example.com/page2", "slug": "subdir/page2" }
]
```

## License

MIT
