# CORE-6: sitecap diff

## Context

sitecap captures page state. `sitecap diff` compares two captures of the same page (e.g., before/after deploy) and reports what changed. This is the foundation both sitegrade (regression detection) and sitetest (capture-based assertions) need.

## Goal

`sitecap diff <dir-a> <dir-b>` compares two capture directories and outputs a structured diff report.

## CLI

```
sitecap diff <dir-a> <dir-b> [options]
  --threshold <n>    Screenshot diff threshold as % of changed pixels (default: 0.1)
  --output <file>    Write diff report to JSON file (default: stdout)
  --types <list>     Which capture types to diff (default: all available)
```

Exit code: 0 if identical, 1 if differences found, 2 if error.

## Diff Logic Per Capture Type

| Type | File | Method | Output |
|------|------|--------|--------|
| Screenshot | screenshot.png | pixelmatch pixel comparison | diff %, diff image saved as screenshot-diff.png |
| Accessibility | accessibility.txt | Line-by-line text diff | added/removed lines |
| Console | console.json | Set diff on error-type messages | new errors, removed errors |
| Network | network.json | Set diff on request URLs + status codes | new/missing requests, changed statuses |
| Storage | storage.json | Key diff on cookies + localStorage keys | new/removed keys, changed values |
| HTML | page-source.html | Skip by default (too noisy) | N/A |

## Files to Modify

- **lib/diff.js** (new) — diff logic for each capture type
- **bin/sitecap.js** — add `diff` subcommand detection, route to diff logic

## Dependencies

- `pixelmatch` (npm) — screenshot pixel comparison
- `pngjs` (npm) — PNG read/write for pixelmatch

## Output Format

```json
{
  "dirA": "/path/to/before",
  "dirB": "/path/to/after",
  "identical": false,
  "diffs": {
    "screenshot": {
      "changed": true,
      "diffPercent": 2.3,
      "threshold": 0.1,
      "diffImage": "/path/to/before/screenshot-diff.png"
    },
    "accessibility": {
      "changed": true,
      "added": ["- button \"New Feature\""],
      "removed": ["- button \"Old Feature\""]
    },
    "console": {
      "changed": false
    },
    "network": {
      "changed": true,
      "added": [{"url": "/api/v2/data", "status": 200}],
      "removed": [{"url": "/api/v1/data", "status": 200}]
    },
    "storage": {
      "changed": false
    }
  }
}
```

Terminal output (when no --output flag):

```
sitecap diff before/ after/

  screenshot    ✗ 2.3% pixels changed (threshold: 0.1%)
                  → screenshot-diff.png saved
  accessibility ✗ 1 added, 1 removed
  console       ✓ identical
  network       ✗ 1 new request, 1 removed request
  storage       ✓ identical

  3 changed, 2 identical
```

## Dependency Direction

`bin/sitecap.js` imports from `lib/diff.js`. `lib/diff.js` is standalone — it reads files from disk, does not import from `lib/capture.js`.

## Implementation Notes

- pixelmatch requires both images to be the same dimensions. If different, report as "dimensions changed" without pixel diff.
- For network diff, compare by URL + method as key, status as value. Ignore headers and body (too noisy).
- For console diff, only diff error-type messages. Ignore log/info/warn (too noisy for regression detection).
- For storage, diff cookie names and localStorage keys. Report value changes for cookies that exist in both.

## Before closing
- [ ] Run make check
- [ ] Verify exit codes: 0 identical, 1 differences, 2 error
- [ ] Verify screenshot-diff.png is written next to dir-a
- [ ] Verify --threshold flag changes screenshot pass/fail
- [ ] Verify missing capture files in one dir are reported gracefully
