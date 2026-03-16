# CORE-12: Session video — continuous recording across full capture run

Closes #26.

## Context

`--video` creates a fresh browser context per page, producing separate short clips. There's no way to get a single continuous recording of auth flow + all pages. sitetest needs this for `--video` support on test runs.

Playwright's `recordVideo` is set at context creation time. All pages in the same context share one video. The fix: keep one context alive across the entire session when session video is requested.

## Goal

1. Add `--session-video` flag that records one continuous `.webm` across all pages
2. Export `createCaptureSession()` / `closeCaptureSession()` from the library API so sitetest can use session recording without reimplementing it
3. Keep existing `--video` behavior (per-page clips) unchanged

## Design decisions

**New flag, not repurposing `--video`**: Per-page clips are useful for comparing individual page loads. Session video serves a different use case (walkthroughs, demos, debugging). Both should coexist.

**Session video + concurrency**: Session video requires a single shared context for continuity. When `--session-video` is active, force `concurrency=1` and warn if the user passed `--concurrency > 1`. Sequential navigation in one context = one continuous video.

**Output location**: `<outDir>/session-video.webm` (alongside the per-page directories, not inside one).

**Auth cookie flow**: Session video context is the *same* context used for auth flow and captures — no cookie copying needed (unlike `--video` which creates fresh contexts).

| Flag | Context model | Video output | Concurrency |
|------|--------------|--------------|-------------|
| (none) | 1 shared context, N pages | none | N |
| `--video` | N contexts (1 per page) | `<pageDir>/video.webm` per page | N |
| `--session-video` | 1 shared context with recordVideo | `<outDir>/session-video.webm` | forced 1 |
| `--video --session-video` | error — mutually exclusive | — | — |

## Phase 1: Library API — `createCaptureSession` / `closeCaptureSession`

### Files to create/modify

**`lib/browser.js`** — add two functions:

- `createCaptureSession(browser, viewport, opts)` — creates a context (with `recordVideo: { dir: opts.videoDir }` if `opts.video` is truthy), creates a page, sets viewport. Returns `{ context, page, hasVideo: boolean }`.
- `closeCaptureSession(session)` — closes page, gets video path via `page.video()?.path()`, closes context (finalizes video), renames video file to `session-video.webm` in `opts.videoDir`. Returns `{ videoPath: string | null }`.

Signature: `createCaptureSession(browser, { width, height }, { video: boolean, videoDir: string })`

**`index.js`** — export both new functions.

### Validation

- Import `createCaptureSession` from `sitecap`, create session with `video: true`, navigate to test server, close session → `session-video.webm` exists
- Import with `video: false` → no video file

## Phase 2: CLI `--session-video` flag

### Files to modify

**`bin/sitecap.js`**:

1. Add `"session-video"` to parseArgs options (`type: "boolean", default: false`)
2. Add to help text: `--session-video          Record one continuous video across all pages`
3. Validation: if both `--video` and `--session-video` → error and exit
4. If `--session-video` and `concurrency > 1` → warn and force `concurrency = 1`
5. When `--session-video`:
   - Create the shared context with `recordVideo: { dir: outDir }` instead of plain `newContext()`
   - Workers use this shared context (same as no-video path)
   - After all workers complete, finalize: get video path, close context, rename to `session-video.webm`

The key change is at line 270 where the shared context is created:

```
// Current:
const context = profileContext || browser.contexts()[0] || await browser.newContext();

// With session-video:
const contextOpts = values["session-video"] ? { recordVideo: { dir: outDir } } : {};
const context = profileContext || browser.contexts()[0] || await browser.newContext(contextOpts);
```

And after the worker pool completes (after line 423), finalize the session video:

```
if (values["session-video"]) {
  // get video from any page that was in the context, rename to session-video.webm
}
```

**Note**: Profile contexts (`profileContext`) are created by `launchChromeWithProfile()` in `lib/chrome.js`. When `--session-video` is combined with `--profile`, the profile context must be created with `recordVideo`. This requires passing the option through to `launchPersistentContext()`. Check whether Playwright's `launchPersistentContext` supports `recordVideo` — if not, document the limitation.

### Validation

- `node bin/sitecap.js <url1> <url2> --launch --session-video -o ./out` → single `session-video.webm` in `./out/`
- `--video --session-video` → error message, exit 1
- `--session-video --concurrency 4` → warns, captures sequentially
- `--session-video` alone → no per-page video files

## Phase 3: Operations + codegen

### Files to modify

**`lib/operations.js`** — add `sessionVideo: z.boolean().optional()` to `captureOp` and `crawlOp` input schemas. Handlers create session with video when true.

**`scripts/generate.js`** — no changes needed (regenerate picks up schema changes automatically).

Run `npm run generate` to update all generated files.

### Validation

- `POST /capture` with `{"url": "...", "sessionVideo": true}` → response includes `sessionVideoPath`
- MCP `capture` tool with `sessionVideo: true` → mentions video in output

## Phase 4: Tests

### Files to modify

**`tests/capture.test.js`** — add session video tests:

- `createCaptureSession with video: true produces session-video.webm`
  - Assert: file exists at `join(outDir, "session-video.webm")`
  - Assert: file size > 0
- `createCaptureSession with video: false produces no video`
  - Assert: `!existsSync(join(outDir, "session-video.webm"))`
- `closeCaptureSession returns videoPath when video enabled`
  - Assert: `result.videoPath` ends with `session-video.webm`

**`tests/cli.test.js`** — add CLI integration test:

- `--session-video produces single video file`
  - Capture 2 URLs with `--session-video --launch`
  - Assert: `existsSync(join(outDir, "session-video.webm"))`
  - Assert: no `video.webm` in individual page dirs
- `--video --session-video exits with error`
  - Assert: stderr contains "mutually exclusive"
  - Assert: exit code 1

## Agent Team

Recommended: No — sequential dependencies. Phase 2 depends on Phase 1's API, Phase 3 depends on Phase 2's flag, Phase 4 tests all of the above.

## Before closing

- [ ] Run `make check` (generate + lint + tests pass)
- [ ] `--session-video` with 2+ URLs produces single `.webm`
- [ ] `--video` still produces per-page clips (no regression)
- [ ] `--video --session-video` errors out
- [ ] `--session-video --concurrency 4` warns and forces sequential
- [ ] `createCaptureSession` / `closeCaptureSession` exported from `index.js`
- [ ] Operations + generated files updated with `sessionVideo` param
- [ ] Profile mode (`--profile --session-video`) tested or limitation documented
