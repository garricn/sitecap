# DEEP-2: Click-flow YAML for page exploration

Closes #20

## Context

sitecap captures surface-level page state. For apps with interactive sub-content (tabs, expandable panels, detail views, workflow nodes), you need to click through elements and capture at each step. The auth-flow YAML (`lib/auth.js`) already has a step executor with click/wait/fill. Extend it with `foreach` and `capture` steps for exploration.

## Goal

Add `foreach` and `capture` step types to the YAML flow executor. A flow file can iterate over elements, click each one, capture the resulting state, then continue.

## Usage

```bash
sitecap https://app.example.com/workflows --profile Work --auth-flow auth/login.yaml --explore explore/workflow-nodes.yaml -o ./output
```

New `--explore <file>` flag. Runs after auth and initial page load, before the standard capture. Each `capture` step inside the explore flow saves to a subdirectory.

## YAML format

```yaml
name: ghl-workflow-nodes
steps:
  - wait: settle
  - foreach:
      selector: "button[description*='Press enter or space to select a node']"
      steps:
        - click: $element
        - wait: settle
        - capture: node-{index}
        - click: "button:has-text('Close panel')"
        - wait: settle
```

### New step types

| Step | Description |
|------|-------------|
| `foreach` | Iterate over elements matching `selector`. Execute nested `steps` for each. `$element` references the current element. `{index}` is 0-based. |
| `capture` | Trigger a full sitecap capture (all configured types) to `<outDir>/<name>/`. Name supports `{index}` substitution. |

### Variables

- `$element` — in a `foreach` body, references the current element (used as a click target)
- `{index}` — in a `foreach` body, the 0-based iteration index
- `$VAR` — environment variable (already supported)

## Files to modify

- **lib/auth.js** → rename to **lib/flow.js** — generalize from auth-only to any flow (auth + exploration use the same step executor)
- **bin/sitecap.js** — add `--explore` flag, run explore flow after auth and before standard capture
- **lib/capture.js** — no changes (capture steps in the flow call `capturePage()` directly)

## Dependency direction

`lib/flow.js` imports from `lib/capture.js` (for `capture` steps). `bin/sitecap.js` imports from `lib/flow.js`.

## Rename: auth.js → flow.js

The step executor in `auth.js` is generic — it handles click, wait, fill, goto, cookies. Auth flows and exploration flows use the same engine. Rename to `flow.js` and export `runFlow()` instead of `runAuthFlow()`. Keep `--auth-flow` flag working (it calls the same function).

## foreach implementation

1. Query all elements matching `selector` → get count
2. For each element (by index):
   - Resolve `$element` to `selector >> nth={index}` (Playwright's nth selector)
   - Resolve `{index}` in all string values within nested steps
   - Execute nested steps sequentially
3. Log progress: `[foreach 3/204] ...`

## capture step implementation

1. Call `capturePage(page, join(outDir, name), { types })` from `lib/capture.js`
2. The `name` field supports `{index}` substitution
3. Uses the same capture types as the main sitecap run

## Edge cases

| Scenario | Behavior |
|----------|----------|
| `foreach` finds 0 elements | Skip with warning, continue flow |
| Nested `foreach` | Supported — inner foreach resolves `$element` and `{index}` in its own scope |
| `capture` outside `foreach` | Works — captures to named subdirectory |
| Element disappears mid-iteration | Log error, continue to next element (graceful) |
| Hundreds of elements (204 GHL nodes) | Each gets its own capture dir. Log progress. |

## Agent Team

Recommended: No — sequential changes across two files with shared flow executor logic.

## Before closing
- [ ] Run make check
- [ ] Verify `foreach` iterates over all matching elements
- [ ] Verify `capture` step produces full capture set in subdirectory
- [ ] Verify `{index}` and `$element` substitution works
- [ ] Verify `--auth-flow` still works after rename to flow.js
- [ ] Verify `--explore` runs after auth flow
- [ ] Test with 0 elements (empty foreach)
