# CMS-6 + CMS-7 + CMS-10: MODX uncapped TV extraction, MODx.load() parsing, WordPress ACF media

## Context

CMS-4 implemented TV value extraction with two known limitations:
1. MODX resources capped at 100 (`modx.js:99`) to avoid runaway API calls
2. MODX `resource/tv/getlist` connector returns TV *definitions* per resource but omits file/image *values* — those are only in the rendered manager edit page's `MODx.load()` JavaScript block
3. WordPress ACF image/file fields return only attachment IDs in `p.acf`, not URLs or downloadable media

These three tasks lift those limitations in parallel — CMS-6/7 touch `lib/cms/modx.js`, CMS-10 touches `lib/cms/wordpress.js`.

---

## CMS-6: Remove 100-resource cap

### Goal
Fetch TV values for ALL resources, not just the first 100.

### Design
- Remove `result.resources.slice(0, 100)` on `modx.js:99`
- Add batched concurrency: process resources in batches of 20 (configurable via `MODX_TV_BATCH_SIZE` constant) to avoid overwhelming the server
- Add a `tvStats` summary to the return object: `{totalResources: N, tvsFetched: N, tvErrors: N}`
- Log a warning to `meta` (not stdout) if resource count exceeds 500 — large site indicator, not a hard cap

### Files to modify
- `lib/cms/modx.js` — remove slice, add batch loop, add tvStats
- `tests/helpers/server.js` — add mock route returning 150+ resources to test uncapped behavior
- `tests/cms.test.js` — add test for >100 resources

### Key decisions
- **No hard cap**: the task says "all resources regardless of count." If the site has 10,000 resources, we fetch 10,000. The batch size prevents connection exhaustion but doesn't limit total.
- **Sequential batches, not parallel**: MODX connectors share a PHP session — parallel fetches cause session lock contention. Process each batch of 20 sequentially within the batch, batches themselves sequential.

### Test assertions
```
assert resources.length === 150 (mock returns 150)
assert resources[149].fields !== undefined
assert result.tvStats.totalResources === 150
assert result.tvStats.tvsFetched === 150
```

---

## CMS-7: Parse MODx.load() blocks for image/file TV values

### Goal
For each MODX resource, fetch the manager edit page HTML and parse `MODx.load()` JavaScript blocks to extract image/file TV values that the connector API omits.

### Background
The MODX manager renders resource edit pages with a `MODx.load()` call containing ExtJS component configs. Image/file TVs appear as config objects with `value: "/path/to/file.jpg"` inside panel definitions. The connector `resource/tv/getlist` returns TV metadata but not the stored values for file-type TVs.

### Design

**Phase 1: Fetch resource edit page**
- For each resource, fetch `{connectorsUrl}../manager/?a=resource/update&id={resourceId}` via `page.evaluate(fetch(...))`
- This returns the full manager HTML for the resource edit form
- Only fetch if the resource has TVs that are type `image`, `file`, or `migx` (known from `result.tvs` array)

**Phase 2: Parse MODx.load() block**
- Extract the `MODx.load({...})` call from the HTML using regex: `MODx\.load\((\{[\s\S]*?\})\s*\);`
- The config object contains nested panel items with `fieldLabel` (TV name) and `value` (TV stored value)
- Parse as JSON after light cleanup (trailing commas, unquoted keys) — or use a more robust approach: find `"name":"<tv_name>"` patterns paired with `"value":"<val>"`
- Merge parsed values into `resource.fields`, overwriting any empty/missing values from Phase 1 (CMS-6's connector-based extraction)

**Phase 3: Fallback chain**

| Source | Has TV name? | Has TV value? | When to use |
|--------|-------------|---------------|-------------|
| `resource/tv/getlist` connector | Yes | Sometimes (text TVs) | Always — first pass |
| `MODx.load()` parse | Yes | Yes (file/image TVs) | Second pass — fills gaps |

Decision: connector values are authoritative for non-empty text values. `MODx.load()` values fill in where connector returned empty string for file/image types.

### Files to modify
- `lib/cms/modx.js` — add `fetchResourceEditPage(page, connectorsUrl, siteId, resourceId)` and `parseModxLoadBlock(html, tvNames)` functions. Call after TV connector fetch in the per-resource loop.
- `tests/helpers/server.js` — add mock route for `GET /manager/?a=resource/update&id=*` returning HTML with a `MODx.load()` block containing image TV values
- `tests/cms.test.js` — test that file/image TVs are populated from MODx.load() parse

### Key decisions
- **Only fetch edit pages for resources that have image/file/migx TVs**: skip if all TVs are text/textarea/number types (check `result.tvs[].type`)
- **Rate limit**: same sequential batching as CMS-6 — these are full page fetches, heavier than connector calls
- **Parse strategy**: regex, not eval. The MODx.load() block is not valid JSON — it's ExtJS config syntax. Use targeted regex to find `name`/`value` pairs near TV field labels rather than trying to parse the whole block.

### Test assertions
```
assert resource.fields.hero_image === "/assets/images/hero.jpg" (from MODx.load parse, not connector)
assert resource.fields.sidebar_file === "/assets/docs/guide.pdf" (file TV from MODx.load)
assert resource.fields.plain_text === "Hello" (still from connector — not overwritten)
```

---

## CMS-10: WordPress ACF image/file field extraction + media download

### Goal
Extract full ACF image/file field data (not just attachment IDs) and download source media files.

### Background
WordPress ACF image fields return attachment IDs in the REST API (`acf: {hero: 123}`). To get the actual URL, you need to resolve the attachment via `/wp-json/wp/v2/media/<id>`. File fields behave the same way.

### Design

**Phase 1: Resolve ACF attachment IDs → URLs**
- After posts/pages are fetched (existing code), scan each item's `fields` object
- For any value that is a bare integer (attachment ID), call `/wp-json/wp/v2/media/<id>` to get the full media object
- Replace the integer with a rich object: `{id: 123, url: "https://...", mime: "image/jpeg", alt: "...", width: 1200, height: 800}`
- Batch media lookups: collect all unique attachment IDs across all posts/pages, fetch in one pass, then map back

**Phase 2: Download media files**
- Add optional `downloadMedia` flag to extraction context (default: false)
- When enabled, download each resolved media URL to `{outDir}/cms-media/{id}-{filename}`
- Add `localPath` to the resolved field object: `{id: 123, url: "...", localPath: "cms-media/123-hero.jpg"}`
- Use `page.evaluate(fetch(url))` + response.arrayBuffer() to download through the authenticated session

**Phase 3: Media manifest**
- Write `cms-media.json` alongside `cms.json` with: `{total: N, downloaded: N, errors: N, files: [{id, url, localPath, mime, size}]}`

### Files to modify
- `lib/cms/wordpress.js` — add `resolveAcfMedia(page, apiRoot, nonce, fields)` function. Add `downloadMedia(page, mediaItems, outDir)` function. Call after posts/pages extraction.
- `lib/capture.js` — pass `outDir` through to WordPress extraction when `downloadMedia` is requested (new option in capture types: `cms:media`)
- `tests/helpers/server.js` — add `/wp-json/wp/v2/media/<id>` mock route, add a downloadable media file route
- `tests/cms.test.js` — test ACF field resolution and media download

### Key decisions
- **Detect attachment IDs heuristically**: an ACF field value that is a positive integer AND the field key contains `image`, `file`, `photo`, `logo`, `media`, `attachment`, `document` — OR just resolve all integer values and handle 404s gracefully
- **Simpler approach — resolve all integers**: try `/wp-json/wp/v2/media/<id>` for every integer ACF value. If 404, leave the integer as-is. This avoids guessing field semantics.
- **Download is opt-in**: extraction always resolves IDs to URLs. Download only happens with explicit `downloadMedia: true`.

| ACF field value | Action | Result |
|----------------|--------|--------|
| Integer (e.g. 123) | Resolve via media API | `{id, url, mime, ...}` or original int if 404 |
| String URL | Keep as-is | Unchanged |
| Object (array, nested) | Recurse | Resolve nested integers |
| Other (bool, null) | Skip | Unchanged |

### Test assertions
```
assert post.fields.hero.url === "http://localhost:PORT/wp-content/uploads/hero.jpg"
assert post.fields.hero.id === 123
assert post.fields.hero.mime === "image/jpeg"
assert post.fields.plain_text === "Welcome" (string field unchanged)
assert post.fields.missing_ref === 999 (404 media — left as integer)
```

With `downloadMedia: true`:
```
assert existsSync(join(outDir, "cms-media/123-hero.jpg"))
assert manifest.total === 1
assert manifest.files[0].localPath === "cms-media/123-hero.jpg"
```

---

## Validation

### Automated (local)
- `make test` — all existing CMS tests still pass (no regressions)
- New tests for each task as described above
- `make lint` + `make typecheck` — clean

### Automated (CI)
- Existing CI pipeline runs tests on push

### Manual
- **CMS-6/7**: test against a real MODX site with >100 resources and image TVs (requires admin session via `--wait-for-auth`). Verify `cms.json` contains all resources with populated image fields.
- **CMS-10**: test against a real WordPress site with ACF image fields. Verify attachment IDs are resolved to full media objects. Test `downloadMedia` flag downloads files.

### sitecap self-test
- Run `sitecap capture --type cms` against mock server — verify output files contain expected data

---

## Agent Team

Recommended: Yes — Agent A: `lib/cms/modx.js` + MODX test routes/tests (CMS-6 + CMS-7), Agent B: `lib/cms/wordpress.js` + WP test routes/tests (CMS-10). Independent adapters sharing no code. Only shared file is `tests/helpers/server.js` (additive mock routes — no conflicts) and `tests/cms.test.js` (additive test blocks — no conflicts).

If merge conflicts arise in shared files, they'll be trivially additive (new route blocks, new describe blocks).

---

## Before closing
- [x] Run `make check` (lint + typecheck + tests pass) — 85/85 pass
- [x] Re-read each task description and locate the code that implements it
- [x] For CMS-6: verify no `.slice()` remains on resources array — removed, batched processing added
- [x] For CMS-7: verify file/image TVs are populated, text TVs are not overwritten — tested
- [x] For CMS-10: verify integer ACF values are resolved, non-integer values are unchanged — tested
- [x] Verify all new mock routes return realistic data shapes — 150 resources, media endpoint, MODx.load() HTML
