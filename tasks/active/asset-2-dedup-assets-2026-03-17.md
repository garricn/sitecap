# ASSET-2: Deduplicate shared assets across pages

## Context

ASSET-1 downloads assets per page into `<pageDir>/assets/`. On a 50-page crawl with shared CSS/JS, the same files are downloaded and stored 50 times. A 200KB Bootstrap CSS becomes 10MB of waste.

## Goal

When `--download-assets` is used with multi-page captures (crawl or manifest), deduplicate assets into a single site-level `assets/` directory. Each page references the shared directory instead of maintaining its own copy.

## Design decisions

**Site-level `assets/` at outDir root**: Move from `<pageDir>/assets/` to `<outDir>/assets/`. Each page's `page-source-local.html` uses relative paths back to the shared directory.

**Hash content, not URL**: Current approach hashes the URL. Two different URLs can serve the same content (CDN aliases, versioned URLs). Hash the actual content instead: `sha256(body).slice(0,16).ext`. This catches true duplicates even across different URLs.

**Per-page manifest stays**: Each `<pageDir>/assets/manifest.json` still lists what that page uses, but points to files in the shared directory. Add a `deduped: true` flag and `sharedDir` path.

**Backwards compatible**: When capturing a single page (no crawl), behavior is unchanged — assets go in `<pageDir>/assets/` as before. Dedup only activates for multi-page captures.

| Capture mode | Asset location | Manifest |
|-------------|---------------|----------|
| Single page | `<pageDir>/assets/` | Local files |
| Multi-page (crawl/manifest) | `<outDir>/assets/` | References shared dir |

**URL rewriting path**: For multi-page, `page-source-local.html` uses `../assets/<hash>.ext` (relative path from pageDir to outDir/assets).

## Phase 1: Shared asset directory for multi-page captures

### Files to modify

**`lib/capture.js`** — modify the asset download block in `capturePage()`:
- Accept new option `opts.sharedAssetsDir` (path to shared assets directory)
- When set: write assets to `sharedAssetsDir` instead of `<outDir>/assets/`
- Hash content (`sha256(body)`) instead of URL
- Skip writing if file already exists (dedup)
- Per-page manifest still written to `<pageDir>/assets/manifest.json` but with `sharedDir` reference
- `page-source-local.html` uses relative path to shared dir

**`bin/sitecap.js`** — when `--download-assets` and multi-page:
- Create `<outDir>/assets/` before starting workers
- Pass `sharedAssetsDir` to each `navigateAndCapture()` call
- After all workers complete, write `<outDir>/assets/manifest.json` (merged from all pages)

Detection logic for "multi-page":

| Condition | Multi-page? |
|-----------|------------|
| `targets.length > 1` | Yes |
| `values.crawl` | Yes |
| `targets.length === 1 && !values.crawl` | No — single page, local assets |

**`lib/capture.js` — `navigateAndCapture()`**: Pass `sharedAssetsDir` through to `capturePage()`.

## Phase 2: Site-level manifest

**`bin/sitecap.js`** — after all workers complete, if `sharedAssetsDir` exists:
- Read all per-page `assets/manifest.json` files
- Merge into `<outDir>/assets/manifest.json` with per-page usage tracking:

```json
{
  "files": {
    "a1b2c3d4e5f6g7h8.css": {
      "contentType": "text/css",
      "size": 12345,
      "urls": ["https://example.com/style.css"],
      "pages": ["example.com", "example.com-about"]
    }
  },
  "stats": {
    "totalFiles": 15,
    "totalSize": 524288,
    "savedBytes": 1048576
  }
}
```

## Phase 3: Tests

**`tests/capture.test.js`** — add:

- `sharedAssetsDir writes to shared directory`
  - Call `navigateAndCapture` twice with same `sharedAssetsDir`
  - Assert: shared dir has each unique asset only once
  - Assert: per-page manifest references shared dir

- `single page without sharedAssetsDir writes local assets`
  - Assert: unchanged behavior, `<pageDir>/assets/` exists

**`tests/cli.test.js`** — add:

- `--download-assets --crawl creates shared assets/ at outDir root`
  - Would need a crawlable test server (multi-page). Use existing `/about` route.

## Validation

**Automated (local + CI):**
- `make check` — all tests pass
- Verify content-hash dedup: same CSS served from two pages → one file in shared dir
- Verify path rewriting: `../assets/<hash>.ext` in local HTML

**Manual (post-merge):**
- `node bin/sitecap.js https://example.com --crawl --max-pages 5 --launch --download-assets`
- Verify `<outDir>/assets/` has fewer files than sum of all pages' network requests
- Open any `page-source-local.html` — should render with shared assets

## Agent Team

Recommended: No — sequential changes to capture.js and CLI, each phase depends on prior.

## Before closing

- [ ] `make check` passes
- [ ] Multi-page capture: assets in `<outDir>/assets/`, not duplicated per page
- [ ] Single page capture: unchanged behavior (local `<pageDir>/assets/`)
- [ ] Content hash (not URL hash) for true dedup
- [ ] Skip writing if hash-named file already exists
- [ ] Per-page manifest still works for page-level tooling
- [ ] Site-level manifest with usage tracking and saved bytes stat
- [ ] `page-source-local.html` relative paths work from nested page dirs
