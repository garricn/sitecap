# CMS-9: Cross-reference TV file refs vs downloaded assets — coverage report

## Context

CMS-7 extracts TV/ACF field values (file paths and resolved media objects). CMS-8 downloads referenced media files and writes `cms-media.json` with `referencedBy` links. Neither produces a unified view of "which content fields reference files, and which of those files are actually downloaded."

This task produces that view: a `cms-media-coverage.json` report that cross-references every file-type TV/ACF field against the downloaded assets, showing coverage gaps.

## Goal

Generate a coverage report answering:
1. Which content items (resources/posts/pages) have file-type fields?
2. For each file reference, is the file downloaded locally?
3. What's the overall coverage percentage?
4. Which files are missing and why (not downloaded, download error, no matching source)?

---

## Data flow

```
cms.json (CMS-7)          → file field values per resource/post/page
cms-media.json (CMS-8)    → downloaded files with localPath + referencedBy
                           ↓
cms-media-coverage.json    ← cross-reference report (THIS TASK)
```

The report is a pure data join — no browser/network needed. It reads two JSON files from disk and produces a third.

---

## Design

### Input shapes

**From `cms.json` (MODX)**:
- `resources[].fields` — object mapping TV names to values (strings for file paths)
- `tvs[]` — TV definitions with `type` field (image, file, migx, text, etc.)

**From `cms.json` (WordPress)**:
- `posts[].fields` / `pages[].fields` — object mapping ACF keys to values
- Resolved media objects have shape `{id, url, mime, alt, width, height}`
- Non-media fields are strings, numbers, or other primitives

**From `cms-media.json`**:
- `files[]` — each has `url`, `localPath`, `referencedBy[]`, optional `error`/`skipped`
- `stats` — `{total, downloaded, errors, totalBytes}`

### Output: `cms-media-coverage.json`

```json
{
  "cms": "modx",
  "timestamp": "2026-03-18T...",
  "summary": {
    "totalFileFields": 25,
    "withLocalCopy": 20,
    "withError": 2,
    "missing": 3,
    "coveragePercent": 80.0
  },
  "items": [
    {
      "ref": "resource:5:hero_image",
      "url": "/assets/images/hero.jpg",
      "status": "downloaded",
      "localPath": "cms-media/modx/2/hero.jpg"
    },
    {
      "ref": "resource:12:sidebar_doc",
      "url": "/assets/docs/spec.pdf",
      "status": "missing",
      "reason": "no matching media source"
    },
    {
      "ref": "resource:8:logo",
      "url": "/assets/images/logo.png",
      "status": "error",
      "error": "HTTP 404"
    }
  ]
}
```

### Status determination

| cms-media.json file entry | Has localPath? | Has error? | Has skipped? | Coverage status |
|--------------------------|----------------|------------|--------------|-----------------|
| Exists, no error/skipped | Yes | No | No | `downloaded` |
| Exists with error | — | Yes | — | `error` |
| Exists with skipped | — | — | Yes | `skipped` |
| Not in cms-media.json | — | — | — | `missing` |

### How to match file references to downloads

**MODX**: TV value is a URL string (e.g. `/assets/images/hero.jpg`). Look up in `cms-media.json` files by matching `file.url === tvValue`.

**WordPress**: Resolved ACF field is an object `{id, url, ...}`. Look up in `cms-media.json` files by matching `file.url === field.url`.

---

## Files to modify

### New file
- **`lib/cms/coverage.js`** — exports `generateMediaCoverage(cmsStructure, mediaManifest)`. Pure function, no I/O. Returns the coverage report object.

### Modified files
- **`lib/capture.js`** — after `downloadCmsMedia`, if `cms-media.json` exists, call `generateMediaCoverage` and write `cms-media-coverage.json`. Only when `downloadMedia` is active.
- **`tests/cms.test.js`** — new `describe("CMS media coverage")` block.

### Dependency direction
```
lib/capture.js → lib/cms/coverage.js (pure function, no imports from other cms/ files)
```

`coverage.js` receives data objects, not file paths. `capture.js` reads the files and passes the parsed objects.

---

## Activation

Coverage report is automatically generated whenever `downloadMedia` is active and both `cms.json` and `cms-media.json` exist. No additional flag needed — it's a byproduct of media download.

---

## Identifying file-type fields

**MODX**: Use `cmsStructure.tvs[]` to find TVs with `type` in `["image", "file", "migx"]`. Then scan `resources[].fields` for those TV names. Also include any field whose string value starts with a known media source `baseUrl` (from `mediaManifest.sources`).

**WordPress**: Scan `posts[].fields` and `pages[].fields` recursively. Any value that is an object with `id` and `url` properties is a resolved media reference. Non-object values are not file fields.

| CMS | Field detection | ref format |
|-----|----------------|------------|
| MODX | TV type in image/file/migx OR value matches source baseUrl | `resource:{id}:{tvName}` |
| WordPress | Value is `{id, url, ...}` object | `{type}:{id}:{fieldKey}` |

---

## Test plan

### Unit tests for `generateMediaCoverage`

**MODX coverage — all downloaded:**
```
input: cmsStructure with 3 resources having file TVs, mediaManifest with all 3 downloaded
assert coverage.summary.totalFileFields === 3
assert coverage.summary.withLocalCopy === 3
assert coverage.summary.coveragePercent === 100
assert coverage.items.every(i => i.status === "downloaded")
```

**MODX coverage — partial (1 missing, 1 error):**
```
input: 3 file TVs, 1 downloaded + 1 error + 1 not in manifest
assert coverage.summary.withLocalCopy === 1
assert coverage.summary.withError === 1
assert coverage.summary.missing === 1
assert coverage.summary.coveragePercent approximately 33.3
```

**WordPress coverage:**
```
input: cmsStructure with resolved ACF media objects, mediaManifest with downloads
assert coverage.items find ref "post:1:hero_image" has status "downloaded"
assert coverage.items find ref "post:1:missing_ref" has status "missing" (integer field, not resolved)
```

**Empty input:**
```
input: no file fields, no downloads
assert coverage.summary.totalFileFields === 0
assert coverage.summary.coveragePercent === 100 (vacuously true)
assert coverage.items.length === 0
```

### Integration test (capture flow)

```
assert with downloadMedia: true on MODX admin page → cms-media-coverage.json exists
assert JSON.parse(coverage).summary.totalFileFields > 0
```

---

## Validation

### Automated (local)
- `make check` — lint + all tests pass
- Unit tests for `generateMediaCoverage` with mock data (no browser needed)
- Integration test via existing MODX admin mock server

### Automated (CI)
- Existing CI pipeline runs tests on push

### Manual
- Run against real MODX/WP site with `--download-media` and inspect `cms-media-coverage.json`

---

## Agent Team

Recommended: No — single new file (`coverage.js`) with small wiring change in `capture.js`. Sequential is simpler and faster for this scope.

---

## Before closing
- [ ] Run `make check` (lint + tests pass)
- [ ] Re-read each acceptance criterion and locate the code that implements it
- [ ] Verify MODX file-type field detection uses TV type definitions
- [ ] Verify WordPress field detection finds resolved `{id, url}` objects
- [ ] Verify status determination matches the decision table
- [ ] Verify coverage report is only generated when `downloadMedia` is active
- [ ] Verify `coveragePercent` handles zero file fields (should be 100, not NaN)
- [ ] For every boolean condition, verify both True and False paths are covered by tests
