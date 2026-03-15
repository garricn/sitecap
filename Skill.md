# /capture

Capture a web page using sitecap — screenshot, accessibility tree, HTML, network, console, storage, and performance data.

## Usage

```
/capture <url> [options]
```

## Instructions

When this skill is invoked, run sitecap to capture the specified URL:

```bash
npx sitecap <url> --launch -o /tmp/sitecap-capture
```

After capture completes, read and summarize the key files:
1. Read the `meta.json` to confirm what was captured
2. Read `screenshot.png` to see the page visually
3. Read `accessibility.txt` for the page structure
4. Read `console.json` for any errors
5. Read `performance.json` for load metrics
6. Read `network.json` for request summary (count, failed requests)

Report findings concisely. If the user asked a question about the page, answer it using the captured data.

## Options

Pass additional flags after the URL:
- `--crawl --max-pages N` — crawl the site
- `-t screenshot,accessibility` — capture specific types only
- `-v 375x812` — mobile viewport
- `--profile Default` — use Chrome profile for authenticated pages

## Examples

```
/capture https://example.com
/capture https://example.com -v 375x812
/capture https://myapp.com/dashboard --profile Default
```
