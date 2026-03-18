# CMS-8: CMS media source discovery and file download

## Context

CMS-7 (done) parses MODx.load() blocks to extract image/file TV values — these are relative paths like `/assets/images/hero.jpg`. CMS-10 (done) resolves WordPress ACF attachment IDs to full media objects with `source_url`, `mime_type`, and dimensions. Both adapters now produce file references, but neither downloads the actual files.

This task adds media file discovery and download for both CMS adapters — producing a local `cms-media/` directory with original uploads and a `cms-media.json` manifest.

## Goal

1. **MODX**: Discover media source base paths via the Browser/Directory connector, enumerate files in each media source, and download originals.
2. **WordPress**: Use the already-resolved `source_url` values from CMS-10's ACF media resolution to download original uploads.
3. **Both**: Write downloaded files to `cms-media/` alongside the capture output, with a `cms-media.json` manifest for cross-referencing.

---

## MODX media source discovery

### How MODX media sources work

MODX media sources define where uploaded files live. Each media source has:
- `id` — numeric identifier
- `name` — e.g. "Filesystem", "Assets"
- `basePath` — server filesystem path (e.g. `assets/images/`)
- `baseUrl` — web-accessible URL prefix (e.g. `/assets/images/`)

The default media source (id=1) is typically the `assets/` directory. Sites can have multiple media sources for different file categories.

### Discovery via connectors

**Important**: The existing `fetchConnector()` in `modx.js` cannot be reused for source/browser actions — its 2.x fallback hardcodes `element/${type}.php` paths. CMS-8 must add a new `fetchModxConnector(page, connectorsUrl, siteId, action, fallback2xPath)` helper that accepts an explicit 2.x fallback path, or add dedicated fetch functions for source/browser endpoints.

**Step 1: List media sources**
- 3.x: POST to `{connectorsUrl}index.php` with `action=source/getlist&HTTP_MODAUTH={siteId}`
- 2.x fallback: POST to `{connectorsUrl}source/index.php` with `action=getList&HTTP_MODAUTH={siteId}`
- Response: `{success: true, results: [{id: 1, name: "Filesystem", ...}]}`

**Step 2: Get media source properties (basePath, baseUrl)**
- 3.x: POST with `action=source/get&id={sourceId}`
- 2.x fallback: POST to `{connectorsUrl}source/index.php` with `action=get&id={sourceId}`
- Response includes `properties` object with `basePath` and `baseUrl` entries
- Some media sources use `{base_path}` and `{base_url}` MODX path placeholders — resolve these relative to site root

**Step 3: List files in each media source**
- 3.x: POST with `action=browser/directory/getlist&source={sourceId}&dir=/`
- 2.x fallback: POST to `{connectorsUrl}browser/directory.php` with `action=getList&source={sourceId}&dir=/`
- Response: flat list of files and directories
- Recursively list subdirectories by re-calling with `dir=/subdir/`
- Each file entry includes: `name`, `pathname`, `size`, `mime` (or `type`)

**Step 4: Download files**
- Construct download URL: `{baseUrl}{pathname}` (relative to site root)
- Fetch via authenticated `page.evaluate` using the same pattern as `resolveAcfMedia` (async IIFE with `fetch()`, `credentials: "include"`)
- Save to `cms-media/{sourceId}/{pathname}` preserving directory structure

### MODX download scope

| Source | Files to download | Rationale |
|--------|-------------------|-----------|
| TV file refs (from CMS-7) | Always download | These are the content files referenced by pages |
| Full media source listing | Opt-in via flag | May contain thousands of files; download all only when explicitly requested |

Default behavior: download only files referenced by TV values. Full media source enumeration provides the manifest (file listing) but downloads only referenced files. A `--cms-media-all` flag (or `downloadAllMedia: true` option) triggers full download.

---

## WordPress media download

### How WP media works (post-CMS-10)

CMS-10 already resolves ACF attachment IDs to rich objects with `source_url`:
```json
{"id": 123, "url": "https://example.com/wp-content/uploads/hero.jpg", "mime": "image/jpeg"}
```

### Discovery via WP REST API

**Step 1: Collect media URLs from resolved ACF fields**
- Walk all posts/pages `fields` objects recursively
- Collect every object with an `id` and `url` property (the shape CMS-10 produces)
- Deduplicate by `id`

**Step 2: Optionally enumerate full media library**
- GET `/wp-json/wp/v2/media?per_page=100&page=N` (paginated)
- Returns all uploads, not just those referenced by ACF fields
- Same opt-in scope as MODX: default = referenced files only, `--cms-media-all` = full library

**Step 3: Download files**
- Fetch each `source_url` via `page.evaluate(fetch(url))` through the authenticated session
- Save to `cms-media/{id}-{filename}` (e.g. `cms-media/123-hero.jpg`)
- Extract filename from URL path's last segment

---

## Output format

### Directory structure

```
output/
  cms.json              (existing — CMS structure with resolved media refs)
  cms-media.json        (NEW — download manifest)
  cms-media/            (NEW — downloaded files)
    modx/               (MODX: organized by media source)
      1/                (source id)
        images/hero.jpg
        docs/guide.pdf
    wp/                 (WordPress: flat by attachment id)
      123-hero.jpg
      456-logo.png
```

### Manifest format (`cms-media.json`)

```json
{
  "cms": "modx",
  "timestamp": "2026-03-18T...",
  "scope": "referenced",
  "sources": [
    {"id": 1, "name": "Filesystem", "basePath": "assets/", "baseUrl": "/assets/", "fileCount": 42}
  ],
  "files": [
    {
      "url": "/assets/images/hero.jpg",
      "localPath": "cms-media/modx/1/images/hero.jpg",
      "mime": "image/jpeg",
      "size": 245760,
      "sourceId": 1,
      "referencedBy": ["resource:5:hero_image", "resource:12:banner"]
    }
  ],
  "stats": {
    "total": 42,
    "downloaded": 40,
    "errors": 2,
    "totalBytes": 15728640
  }
}
```

The `referencedBy` array links each file to the TV/ACF fields that reference it — enabling CMS-9's cross-reference report.

### `referencedBy` format

Each string follows the pattern: `{contentType}:{contentId}:{fieldName}`

| CMS | contentType | contentId | fieldName | Example |
|-----|------------|-----------|-----------|---------|
| MODX | `resource` | resource ID | TV name | `resource:5:hero_image` |
| WordPress | post type (`post`, `page`) | post/page ID | ACF field key | `post:1:hero_image` |

For nested ACF fields (repeaters), use dot notation: `post:1:gallery.0.image`. CMS-9 will consume this format for cross-referencing.

---

## Files to modify

### New file
- **`lib/cms/media.js`** — media discovery and download logic for both adapters. Exports `downloadCmsMedia(page, cmsStructure, cmsDetection, outDir, opts)`.

### Modified files
- **`lib/cms/modx.js`** — add and export `fetchModxSource(page, connectorsUrl, siteId, action, fallback2xPath)` as a generic connector fetch that accepts explicit 2.x fallback paths (unlike `fetchConnector` which hardcodes `element/`). Also export `listModxMediaSources(page, connectorsUrl, siteId)` that uses it. Note: `fetchConnector` is not exported and should not be — the new helper is the public API for non-element connector actions.
- **`lib/cms/wordpress.js`** — export a helper `collectWpMediaUrls(cmsStructure)` that walks resolved ACF fields and returns deduped media objects. **Assumption**: `cms.json` preserves the resolved ACF objects (rich `{id, url, mime, ...}` shapes) because `extractWordPress` returns the mutated `result` object which is then serialized to JSON. This is confirmed by the existing test at `cms.test.js:116` which asserts `hero.url` is a string. No changes to extraction logic itself.
- **`lib/capture.js`** — after CMS structure extraction, call `downloadCmsMedia()` when `cms` type is active and `downloadMedia` option is set. Add `downloadMedia` to capture opts.
- **`tests/helpers/server.js`** — add mock routes for MODX `source/getlist`, `source/get`, `browser/directory/getlist`, and downloadable file endpoints. Add WP media file download endpoint.
- **`tests/cms.test.js`** — new `describe("CMS media download")` block with tests for both adapters.

### Dependency direction

```
lib/capture.js → lib/cms/media.js → lib/cms/modx.js (helper exports)
                                   → lib/cms/wordpress.js (helper exports)
```

`media.js` is the orchestrator. It imports helpers from the adapter files. Adapter files do NOT import from `media.js`. `capture.js` calls `media.js` — the same pattern as `extractCmsStructure()`.

---

## Activation

Media download is opt-in, triggered by either:
- CLI: `--download-media` flag (alongside `-t cms`)
- API: `downloadMedia: true` in capture options

| `-t cms` | `--download-media` | Behavior |
|-----------|-------------------|----------|
| No | No | No CMS capture, no media download |
| Yes | No | CMS detection + extraction, no media download |
| Yes | Yes | CMS detection + extraction + media download |
| No | Yes | Ignored — media download requires CMS extraction |

---

## Error handling

- **Network errors during download**: log to manifest `stats.errors`, continue with remaining files. Each file entry gets an `error` field if download failed.
- **Missing media source**: if `source/get` returns 404 for a source ID, skip it and log warning in manifest.
- **Large files**: set a per-file size limit (default 50MB). Files exceeding the limit are listed in the manifest with `skipped: "size_limit"` but not downloaded.
- **Timeout**: individual file downloads timeout after 30 seconds. Manifest records timeout as an error.

---

## Test plan

### Mock routes to add (`tests/helpers/server.js`)

1. **MODX `source/getlist`** — returns 2 media sources: `[{id: 1, name: "Assets"}, {id: 2, name: "Images"}]`
2. **MODX `source/get` for id=1** — returns properties with `basePath: "assets/"`, `baseUrl: "/assets/"`
3. **MODX `browser/directory/getlist`** — returns file listing: `[{name: "hero.jpg", pathname: "images/hero.jpg", type: "image/jpeg"}]`
4. **Downloadable file at `/assets/images/hero.jpg`** — returns a small binary blob (reuse existing 1x1 PNG pattern)
5. **WP media file at `/wp-content/uploads/hero.jpg`** — returns a small binary blob

### Test assertions

**MODX media source discovery:**
```
assert manifest.sources.length === 2
assert manifest.sources[0].name === "Assets"
assert manifest.sources[0].baseUrl === "/assets/"
```

**MODX file download:**
```
assert existsSync(join(outDir, "cms-media/modx/1/images/hero.jpg"))
assert manifest.files.length >= 1
assert manifest.files[0].localPath === "cms-media/modx/1/images/hero.jpg"
assert manifest.stats.downloaded >= 1
assert manifest.stats.errors === 0
```

**WordPress file download:**
```
assert existsSync(join(outDir, "cms-media/wp/123-hero.jpg"))
assert manifest.files[0].referencedBy.includes("post:1:hero_image")
```

**referencedBy format:**
```
assert referencedBy string matches /^(resource|post|page):\d+:\w+(\.\w+)*$/
```

**Opt-in behavior:**
```
assert with downloadMedia: false → no cms-media/ directory created
assert with downloadMedia: true + no CMS → no cms-media/ directory created
```

---

## Before closing
- [ ] Run `make check` (lint + tests pass)
- [ ] Re-read each acceptance criterion and locate the code that implements it
- [ ] Verify MODX media source discovery uses the same 2.x/3.x fallback pattern as existing connector calls
- [ ] Verify WordPress download reuses existing authenticated fetch pattern from `resolveAcfMedia`
- [ ] Verify `cms-media.json` manifest includes `referencedBy` links for CMS-9 consumption
- [ ] Verify opt-in activation table — no media download without explicit flag
- [ ] Verify error handling — failed downloads don't crash the capture
- [ ] For every boolean condition, verify both True and False paths are covered by tests
