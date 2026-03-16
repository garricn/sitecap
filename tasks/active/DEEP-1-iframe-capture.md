# DEEP-1: Cross-origin iframe content capture

Closes #19

## Context

Playwright's `ariaSnapshot()` and `page.content()` don't traverse cross-origin iframe boundaries. For apps like GHL where the main content is inside a cross-origin iframe (e.g., `client-app-automation-workflows.leadconnectorhq.com` inside `app.gohighlevel.com`), sitecap captures nearly empty accessibility trees and misses iframe DOM content.

CDP's `Accessibility.getFullAXTree` and `DOM.getDocument` DO traverse iframe boundaries. Chrome DevTools MCP uses this approach and captures full iframe content.

## Goal

Capture accessibility tree and HTML source from cross-origin iframes using CDP sessions, falling back to Playwright's APIs when CDP is unavailable.

## Files to modify

- **lib/capture.js** — replace `ariaSnapshot()` with CDP-based capture for accessibility, add iframe DOM capture for HTML

## Approach

### Accessibility tree

Replace `page.locator(":root").ariaSnapshot()` with:
1. Open a CDP session via `page.context().newCDPSession(page)`
2. Call `Accessibility.getFullAXTree` — returns all nodes including cross-origin iframe content
3. Format the AX tree into a readable text format (role, name, value per node, indented by depth)
4. Detach CDP session

Fallback: if CDP session fails (e.g., non-CDP connection), fall back to `ariaSnapshot()`.

### HTML source

After `page.content()` for the main frame:
1. Enumerate all frames via `page.frames()`
2. For each cross-origin frame, get its content via `frame.content()`
3. Append iframe content as commented sections in the HTML, or save as separate files per iframe

**Decision**: save as separate files — `page-source.html` (main frame) + `iframe-{n}.html` (each cross-origin frame). Keeps files clean and individually parseable.

### Network/console/storage

These already capture cross-origin requests (the response listener sees all requests regardless of iframe origin). No changes needed.

### Screenshot

`page.screenshot({ fullPage: true })` already captures iframe content visually. No changes needed.

## CDP AX tree formatting

`Accessibility.getFullAXTree` returns flat array of nodes with `parentId` references. Format as indented text:

```
- document "Page Title"
  - navigation
    - link "Home"
    - link "Settings"
  - main
    - iframe "Workflow Builder"  [cross-origin: client-app.leadconnectorhq.com]
      - region "Canvas"
        - button "Add Node"
        - group "Node: Send Email"
          - text "Send Email"
```

Include a marker for cross-origin iframe boundaries so consumers know where iframe content begins.

## Dependency direction

`lib/capture.js` uses CDP via `page.context().newCDPSession(page)` — no new dependencies. CDP is available on any Playwright page connected via CDP or launched by Playwright.

## Edge cases

| Scenario | Behavior |
|----------|----------|
| No iframes | Identical to current behavior |
| Same-origin iframes | `ariaSnapshot()` already handles these; CDP captures them too |
| Cross-origin iframes | CDP captures content; Playwright fallback misses them |
| Nested iframes (iframe inside iframe) | CDP `getFullAXTree` handles this — flat list with parent refs |
| CDP session unavailable | Fall back to `ariaSnapshot()` with a warning |
| Iframe with no content (loading/error) | Capture empty node with the iframe's src URL |

## Agent Team

Recommended: No — single file change, sequential logic (CDP session must be opened before tree capture).

## Before closing
- [ ] Run make check
- [ ] Verify CDP accessibility tree captures cross-origin iframe content
- [ ] Verify fallback to ariaSnapshot() works when CDP is unavailable
- [ ] Verify iframe HTML files are saved alongside main page-source.html
- [ ] Verify meta.json lists iframe files in captures
