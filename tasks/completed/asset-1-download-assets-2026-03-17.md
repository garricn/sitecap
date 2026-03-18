# ASSET-1: Download assets

## Context

sitecap captures `network.json` with all request URLs and `page-source.html` with the rendered DOM, but doesn't save the actual asset files (CSS, JS, images, fonts). For offline analysis, migration, and archival, users need the assets themselves — not just references to them.

MHTML already solves this as a single archive, but it's opaque (can't inspect individual files). This task saves discrete files to an `assets/` directory and rewrites URLs in `page-source.html` to point to local copies.

## Goal

Add `--download-assets` flag. When active, download static resources captured in `network.json` to `assets/` per page, and produce `page-source-local.html` with URLs rewritten to local paths.

## Design decisions

**Separate file, not overwriting**: Write `page-source-local.html` alongside `page-source.html`. Original stays untouched for diffing. The local version is for offline viewing.

**Download strategy**: Intercept responses during network capture rather than re-fetching after capture. Extend `setupNetworkCapture()` to optionally save response bodies for static resource types.

| Approach | Pros | Cons |
|----------|------|------|
| Re-fetch from URLs post-capture | Simple, no capture changes | Auth may not apply, CDN may block, race conditions |
| Intercept during capture | Bodies already available, auth inherited | More memory, larger capture |
| Use `response.body()` in network handler | Clean integration with existing flow | Need to buffer bodies in memory |

**Recommended: intercept during capture** — extend the existing `page.on("response")` handler to save bodies when `--download-assets` is active.

**Resource types to download**: `stylesheet`, `script`, `image`, `font`. Skip: `document` (captured as HTML), `xhr`/`fetch` (API data), `media` (usually too large — opt-in later via ASSET-3).

**File naming**: Hash-based — `sha256(url).ext` where ext is derived from Content-Type. This naturally deduplicates identical resources.

**Asset manifest**: Write `assets/manifest.json` mapping original URL → local filename, content-type, size.

```json
{
  "https://example.com/style.css": {
    "file": "a1b2c3d4.css",
    "contentType": "text/css",
    "size": 12345
  }
}
```

**URL rewriting in page-source-local.html**: Simple string replacement of each URL in the manifest with `assets/<filename>`. Works for `href`, `src`, `url()` in inline styles. Won't catch dynamically constructed URLs — acceptable limitation.

## Phase 1: Asset download in network capture

### Files to modify

**`lib/capture.js`** — extend `setupNetworkCapture(page, opts)`:
- New option: `opts.downloadAssets: boolean`
- When true, also save `response.body()` as Buffer for resource types: stylesheet, script, image, font
- Store on each network entry: `entry.__body = buffer` (not serialized to network.json — in-memory only)
- After capture, `capturePage` iterates entries with bodies, writes to `assets/` directory

**`bin/sitecap.js`** — add `--download-assets` flag (boolean, default false). Pass to `navigateAndCapture` as `opts.downloadAssets`.

### Phase 2: Asset writing + manifest

**`lib/capture.js`** — in `capturePage()`, after network capture, if `downloadAssets`:
1. Create `assets/` subdirectory
2. For each network entry with `__body`:
   - Hash the URL with `crypto.createHash('sha256')`
   - Derive extension from Content-Type header
   - Write body to `assets/<hash>.<ext>`
   - Add to manifest
3. Write `assets/manifest.json`
4. Add `results.assets = manifestPath` to meta

### Phase 3: URL rewriting

**`lib/capture.js`** — after writing assets, if `downloadAssets`:
1. Read `page-source.html` content (already in memory from capture)
2. For each manifest entry, replace all occurrences of the original URL with `assets/<filename>`
3. Write as `page-source-local.html`
4. Add `results.htmlLocal = localHtmlPath` to meta

### Phase 4: Tests

**`tests/helpers/server.js`** — add routes that serve actual CSS/JS/image content:
- `/style.css` → returns CSS with `Content-Type: text/css`
- `/script.js` → returns JS
- `/image.png` → returns a small PNG (1x1 pixel)
- Update main HTML to reference these resources

**`tests/capture.test.js`** — add:
- `--download-assets writes assets/ directory with files`
  - Assert: `existsSync(join(outDir, "assets"))`
  - Assert: `existsSync(join(outDir, "assets/manifest.json"))`
  - Assert: manifest has entries for style.css, script.js, image.png
- `--download-assets produces page-source-local.html`
  - Assert: file exists
  - Assert: content contains `assets/` paths, not original URLs
- `default capture does NOT create assets/ directory`
  - Assert: `!existsSync(join(outDir, "assets"))`

## Validation

**Automated (local + CI):**
- `make check` — all existing + new tests pass
- Mock server serves real CSS/JS/PNG content
- Asset hashing produces consistent filenames
- URL rewriting verified by string matching in local HTML

**Manual (post-merge):**
- Run against a real site: `node bin/sitecap.js https://example.com --launch --download-assets`
- Open `page-source-local.html` in browser — should render with local assets
- Verify `assets/manifest.json` maps all downloaded resources

## Agent Team

Recommended: No — sequential phases, each builds on prior output.

## Before closing

- [ ] `make check` passes
- [ ] `--download-assets` creates `assets/` with CSS, JS, images, fonts
- [ ] `assets/manifest.json` maps URL → local filename
- [ ] `page-source-local.html` has rewritten URLs
- [ ] Default capture (no flag) unchanged — no assets directory
- [ ] Hash-based filenames produce consistent output
- [ ] Help text updated with `--download-assets`
- [ ] Memory usage reasonable — bodies buffered only when flag active
