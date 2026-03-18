# CMS-2 + CMS-3: MODX and WordPress CMS adapters

## Context

CMS-1 added detection (`cms-detect.json`). When `admin: true`, we can extract CMS structure via the CMS's own API — MODX connectors and WordPress REST API — using the authenticated browser session. This data powers CMS-4 (field extraction) and CMS-5 (template dependency graphs).

## Goal

When CMS detection finds an admin session, automatically extract CMS structure and write `cms.json` per site. Two independent adapters: MODX (CMS-2) and WordPress (CMS-3).

## Design decisions

**Extraction happens inside `capturePage()`**: After `detectCms()` returns with `admin: true`, call the appropriate adapter. The adapter uses `page.evaluate()` + `fetch()` to call the CMS API using the existing admin session cookies + auth tokens.

**Auth tokens from detection**: The detection step already identifies admin presence. The adapters need the actual token values — detection must be enhanced to return them.

| CMS | Token needed | Source |
|-----|-------------|--------|
| MODX | `MODx.config.site_id` + `MODx.config.connectors_url` | `page.evaluate()` |
| WordPress | `wpApiSettings.nonce` + `wpApiSettings.root` | `page.evaluate()` |

**Adapter pattern**: Each adapter is a function `extractCmsData(page, detection) → object`. Lives in its own file under `lib/cms/`. The `cms.js` module orchestrates: detect → if admin → extract → merge into output.

**Output: `cms.json` (not `cms-detect.json`)**: Detection writes `cms-detect.json`. Extraction writes `cms.json` with the full CMS structure. Both files coexist — detection is lightweight and always runs; extraction is heavy and admin-only.

## Output schema: cms.json

### MODX

```json
{
  "cms": "modx",
  "extracted": true,
  "templates": [{ "id": 1, "name": "BaseTemplate", "description": "..." }],
  "chunks": [{ "id": 1, "name": "header", "category": 0 }],
  "snippets": [{ "id": 1, "name": "getResources", "description": "..." }],
  "plugins": [{ "id": 1, "name": "TinyMCE", "disabled": false }],
  "tvs": [{ "id": 1, "name": "image", "type": "image", "caption": "Hero Image" }],
  "resources": [{ "id": 1, "pagetitle": "Home", "template": 1, "published": true }]
}
```

### WordPress

```json
{
  "cms": "wordpress",
  "extracted": true,
  "types": { "post": { "name": "Posts", "rest_base": "posts" }, "page": { ... } },
  "posts": [{ "id": 123, "title": "Hello World", "slug": "hello-world", "status": "publish", "type": "post", "template": "" }],
  "pages": [{ "id": 456, "title": "About", "slug": "about", "status": "publish", "template": "page-about.php" }],
  "themes": [{ "stylesheet": "twentytwentyfour", "name": "Twenty Twenty-Four", "status": "active" }],
  "templates": [],
  "acf_field_groups": []
}
```

When extraction fails or admin is false:
```json
{
  "cms": "wordpress",
  "extracted": false,
  "reason": "No admin session detected"
}
```

## Phase 1: Refactor detection to return token values

### Files to modify

**`lib/cms.js`** — enhance detectors to return `context` object with actual values (not just booleans):

- WordPress detector: add `context.nonce`, `context.apiRoot` from `window.wpApiSettings`
- MODX detector: add `context.siteId`, `context.connectorsUrl` from `window.MODx.config`

The `detectCms()` return value gets a new `context` field alongside existing fields. This is backwards-compatible — `context` is `undefined` when no tokens found.

### Validation

- Existing CMS tests still pass (context is additive)
- New assertions: WordPress detection on admin page returns `context.nonce` defined
- MODX admin detection returns `context.siteId` defined

## Phase 2: MODX adapter (CMS-2)

### Files to create

**`lib/cms/modx.js`** — exports `extractModx(page, context)`

Uses `page.evaluate()` to call MODX connectors:
- Construct fetch URL from `context.connectorsUrl`
- Pass `HTTP_MODAUTH` from `context.siteId`
- Call `getList` for: templates, chunks, snippets, plugins, tvs, resources
- Handle pagination (MODX uses `limit=0` for all records)
- Return structured object matching schema above

**Inversion-prone logic**: MODX 2.x uses separate connector files (`/connectors/element/chunk.php`), MODX 3.x uses single entry (`/connectors/index.php?action=element/chunk/getlist`). Try 3.x first, fall back to 2.x.

| MODX version | Connector path | Action format |
|-------------|---------------|---------------|
| 3.x | `{connectorsUrl}index.php` | `action=element/chunk/getlist` in POST body |
| 2.x | `{connectorsUrl}element/chunk.php` | `action=getList` in POST body |

Detection: try 3.x endpoint first. If `success: false` or 404, try 2.x.

## Phase 3: WordPress adapter (CMS-3)

### Files to create

**`lib/cms/wordpress.js`** — exports `extractWordPress(page, context)`

Uses `page.evaluate()` to call WP REST API:
- Construct URL from `context.apiRoot`
- Pass `X-WP-Nonce` header from `context.nonce`
- Fetch: `/wp/v2/types` (discover CPTs), `/wp/v2/posts?per_page=100`, `/wp/v2/pages?per_page=100`, `/wp/v2/themes`, `/wp/v2/templates`
- Handle pagination via `X-WP-Total` / `X-WP-TotalPages` headers
- Optionally: `/acf/v3/field-groups` if ACF detected
- Return structured object matching schema above

**Pagination**: Max `per_page=100`. If `X-WP-TotalPages > 1`, fetch remaining pages. Cap at 10 pages (1000 items) to avoid runaway extraction.

**Nonce fallback**: If `wpApiSettings.nonce` is not on the page (front-end without enqueue), try fetching `/wp-admin/admin-ajax.php?action=rest-nonce` with credentials.

## Phase 4: Wire into capture pipeline

### Files to modify

**`lib/cms.js`** — after `detectCms()`, add `extractCmsStructure(page, detection)` that dispatches to the correct adapter based on `detection.cms`:

| `detection.cms` | `detection.admin` | Action |
|-----------------|-------------------|--------|
| `"wordpress"` | `true` | Call `extractWordPress(page, detection.context)` |
| `"modx"` | `true` | Call `extractModx(page, detection.context)` |
| any | `false` | Return `{ cms, extracted: false, reason: "No admin session" }` |
| `"drupal"` | `true` | Return `{ cms: "drupal", extracted: false, reason: "Drupal adapter not yet implemented" }` |

**`lib/capture.js`** — in the `cms` capture block, after writing `cms-detect.json`, call `extractCmsStructure()` and write `cms.json` if extraction returns data.

### Dependency direction

```
lib/capture.js → lib/cms.js → lib/cms/modx.js
                             → lib/cms/wordpress.js
```

No circular deps. Adapters import nothing from sitecap — they receive `page` and `context` as arguments.

## Phase 5: Tests

### Files to modify

**`tests/helpers/server.js`** — add mock API endpoints:

WordPress:
- `GET /wp-json/wp/v2/types` → `{ "post": { "name": "Posts", "rest_base": "posts" }, "page": { ... } }`
- `GET /wp-json/wp/v2/posts` → `[{ "id": 1, "title": { "rendered": "Test Post" }, ... }]` with `X-WP-Total: 1`
- `GET /wp-json/wp/v2/pages` → `[{ "id": 2, "title": { "rendered": "Test Page" }, ... }]`
- `GET /wp-json/wp/v2/themes` → `[{ "stylesheet": "test-theme", "status": "active" }]`
- Update `/wordpress` route: add `window.wpApiSettings = { root: '/wp-json/', nonce: 'test-nonce' }`

MODX:
- `POST /connectors/index.php` → route by `action` param, return `{ success: true, total: 1, results: [...] }`
- Update `/modx-admin` route: add `connectors_url: '/connectors/'` to config

**`tests/cms.test.js`** — add extraction tests:

- `extractModx returns templates/chunks/snippets on admin page`
  - Assert: `result.extracted === true`
  - Assert: `result.templates.length > 0`
  - Assert: `result.chunks.length > 0`

- `extractWordPress returns posts/pages/types on admin page`
  - Assert: `result.extracted === true`
  - Assert: `result.types` has `post` and `page` keys
  - Assert: `result.posts.length > 0`

- `extractCmsStructure returns extracted: false when not admin`
  - Assert: `result.extracted === false`
  - Assert: `result.reason` contains "No admin session"

- `capturePage with cms type writes both cms-detect.json and cms.json`
  - Navigate to WP admin page, capture with `types: ["cms"]`
  - Assert: both files exist
  - Assert: `cms.json` has `extracted: true`

## Validation

**Automated (local + CI):**
- `make check` — all existing + new tests pass
- Mock API endpoints return realistic data shapes
- Both adapters handle: success, auth failure, empty responses

**Manual (post-merge):**
- Run against a real WordPress site with admin session: `node bin/sitecap.js https://example.com --profile Default -t cms`
- Run against a real MODX site with admin session
- Verify `cms.json` contains actual site structure

## Agent Team

Recommended: Yes — Agent A: `lib/cms/modx.js` + MODX test routes (CMS-2), Agent B: `lib/cms/wordpress.js` + WP test routes (CMS-3). Independent adapters with no shared files. Phase 1 (detection refactor) and Phase 4 (wiring) must be done first sequentially, then adapters in parallel.

## Before closing

- [ ] `make check` passes
- [ ] Detection returns `context` with actual token values
- [ ] MODX adapter extracts: templates, chunks, snippets, plugins, TVs, resources
- [ ] WordPress adapter extracts: types, posts, pages, themes, templates
- [ ] Non-admin pages produce `extracted: false` with reason
- [ ] `cms.json` written alongside `cms-detect.json` when admin session active
- [ ] Pagination handled (MODX `limit=0`, WP `per_page=100` + multi-page)
- [ ] MODX 2.x/3.x connector fallback works
- [ ] WP nonce fallback works if `wpApiSettings` not on page
