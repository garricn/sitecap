# CMS-1: CMS auto-detection

## Context

sitecap captures page data but doesn't identify the CMS powering the site. Knowing the CMS unlocks downstream tasks: CMS-2 (MODX extraction), CMS-3 (WordPress extraction), CMS-4 (field values), CMS-5 (template graphs). Detection must happen first.

## Goal

Add a `cms` capture type that detects which CMS (if any) powers the page. Writes `cms-detect.json` per page. Opt-in via `-t cms` (not in default captures — most sites aren't CMS-powered).

## Design decisions

**Opt-in, not default**: CMS detection adds page.evaluate() calls that are wasted on non-CMS sites. Keep the default 7 types lean. Users doing CMS work explicitly opt in.

**Detection signals** (ordered by reliability):

| Signal | Source | Confidence | Examples |
|--------|--------|------------|---------|
| JS globals | `page.evaluate()` | high | `window.MODx`, `window.wp`, `window.Drupal` |
| Meta tags | `page.evaluate()` | high | `<meta name="generator" content="WordPress 6.4">` |
| Response headers | `page.__sitecapNetwork` | medium | `X-Powered-By: Drupal`, `X-Redirect-By: WordPress` |
| API endpoints | `page.__sitecapNetwork` | medium | `/wp-json/`, `/connectors/index.php` |
| HTML patterns | `page.evaluate()` | low | `wp-content/`, `sites/default/files/` |

**Confidence scoring**: If multiple signals agree, confidence = `high`. Single weak signal = `low`. The `indicators` array records what matched so humans can verify.

**CMS list for v1**: WordPress, MODX, Drupal. Extensible — each CMS is a detector object with `name`, `detect(page, network)` method.

## Output schema: cms-detect.json

```json
{
  "detected": true,
  "cms": "wordpress",
  "version": "6.4",
  "confidence": "high",
  "indicators": [
    { "type": "js-global", "key": "window.wp", "value": true },
    { "type": "meta-tag", "content": "WordPress 6.4" },
    { "type": "network", "url": "/wp-json/wp/v2/" }
  ],
  "admin": false
}
```

When no CMS detected:
```json
{
  "detected": false,
  "cms": null,
  "version": null,
  "confidence": null,
  "indicators": [],
  "admin": false
}
```

The `admin` field indicates whether an admin session appears active (e.g. `window.wp.heartbeat`, MODX manager cookie). This informs CMS-2/CMS-3 whether extraction is possible.

## Phase 1: Detection engine

### Files to create

**`lib/cms.js`** — CMS detection module.

Exports:
- `detectCms(page, network)` — runs all detectors, returns cms-detect.json object
- `cmsDetectors` — array of detector objects (for extensibility)

Each detector has shape: `{ name: string, detect: async (page, network) => { detected, version, indicators, admin } }`

**Detector: WordPress**
- JS globals: `window.wp`, `window.wpApiSettings`
- Meta: `<meta name="generator" content="WordPress ...">`
- Network: any request URL containing `/wp-json/` or `/wp-admin/`
- HTML: `wp-content/` in any `link[href]` or `script[src]`
- Admin: `window.wp.heartbeat` exists or `/wp-admin/` in network

**Detector: MODX**
- JS globals: `window.MODx`, `window.MODx.config`
- Meta: `<meta name="generator" content="MODX">`
- Network: `/connectors/index.php` or `/manager/` in URLs
- Admin: `window.MODx.config.auth_token` exists

**Detector: Drupal**
- JS globals: `window.Drupal`, `window.drupalSettings`
- Meta: `<meta name="generator" content="Drupal ...">`
- Network: `X-Drupal-Cache` or `X-Generator: Drupal` headers
- HTML: `sites/default/files/` in any attribute
- Admin: `window.drupalSettings.user.uid` > 0

**Aggregation logic**: Run all detectors. If exactly one returns `detected: true`, use it. If multiple match, pick highest confidence. If tied, pick the one with more indicators.

| Detectors matched | Result |
|-------------------|--------|
| 0 | `{ detected: false, cms: null }` |
| 1 | Use that detector's result |
| 2+ | Pick highest confidence, most indicators |

### Files to modify

**`lib/capture.js`** — add `cms` type handler in `capturePage()`:
- Import `detectCms` from `./cms.js`
- After the `performance` block, add `cms` block
- Pass `page` and `page.__sitecapNetwork` to `detectCms()`
- Write result to `cms-detect.json`

**`bin/sitecap.js`** — update help text to include `cms` in the types list (line ~103). Do NOT add to default list.

### Dependency direction

`lib/cms.js` imports nothing from sitecap — it receives `page` and `network` as arguments. `lib/capture.js` imports from `lib/cms.js`. No circular deps.

## Phase 2: Tests

### Files to modify

**`tests/helpers/server.js`** — add CMS test routes:
- `/wordpress` — page with `<script>window.wp = { heartbeat: {} };</script>` and `<meta name="generator" content="WordPress 6.4">`
- `/modx` — page with `<script>window.MODx = { config: {} };</script>`
- `/drupal` — page with `<script>window.Drupal = {}; window.drupalSettings = { user: { uid: 0 } };</script>`
- `/no-cms` — plain page (already exists as `/`)

**`tests/cms.test.js`** — new test file:

- `detectCms on WordPress page returns wordpress with high confidence`
  - Assert: `result.detected === true`
  - Assert: `result.cms === "wordpress"`
  - Assert: `result.confidence === "high"`
  - Assert: `result.indicators.length >= 2`
  - Assert: `result.version === "6.4"`

- `detectCms on MODX page returns modx`
  - Assert: `result.detected === true`
  - Assert: `result.cms === "modx"`

- `detectCms on Drupal page returns drupal`
  - Assert: `result.detected === true`
  - Assert: `result.cms === "drupal"`

- `detectCms on plain page returns not detected`
  - Assert: `result.detected === false`
  - Assert: `result.cms === null`
  - Assert: `result.indicators.length === 0`

- `capturePage with types: ["cms"] writes cms-detect.json`
  - Navigate to `/wordpress`, capture with `types: ["cms"]`
  - Assert: `existsSync(join(outDir, "cms-detect.json"))`
  - Parse JSON, assert `cms === "wordpress"`

- `capturePage without cms type does NOT write cms-detect.json`
  - Navigate to `/wordpress`, capture with default types
  - Assert: `!existsSync(join(outDir, "cms-detect.json"))`

## Validation

**Automated (local):**
- `make check` — all existing tests pass + new cms.test.js
- New tests cover: 3 CMS detections, 1 negative case, opt-in/opt-out behavior

**Automated (CI):**
- Same as local — CI runs `make check`

**Manual (post-merge):**
- Run against a real WordPress site: `node bin/sitecap.js https://wordpress.org --launch -t cms -o /tmp/wp-test`
- Verify cms-detect.json has `cms: "wordpress"` with real-world indicators

**sitecap self-test:**
- `sitecap diff` can compare cms-detect.json across captures (JSON diff already works for arbitrary JSON files)

## Agent Team

Recommended: No — Phase 2 tests depend on Phase 1 detection engine. Single sequential flow.

## Before closing

- [ ] `make check` passes (generate + lint + 56+ tests)
- [ ] `cms` type opt-in only — not in default capture list
- [ ] WordPress, MODX, Drupal each detected on test pages
- [ ] Plain page returns `detected: false`
- [ ] `cms-detect.json` written only when `cms` type requested
- [ ] `admin` field populated correctly (false for non-admin sessions)
- [ ] Help text updated with `cms` type
- [ ] No new dependencies added (pure page.evaluate + network inspection)
