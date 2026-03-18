# CMS-4: TV value extraction per resource

## Context

CMS-2/3 extract CMS structure metadata (template names, post titles, TV definitions). This task extracts the actual **field values** per page — MODX TV values per resource, WP ACF values per post/page. This data powers site migration, content auditing, and field-level diffing.

## Goal

When CMS extraction runs, also extract structured field values per resource/post. Append to `cms.json` under a `fields` key per content item.

## Design decisions

**WordPress ACF is already partially done**: The WP adapter already includes `acf` in post/page objects. CMS-4 just needs to verify this is the full field data and ensure it's preserved.

**MODX TVs require per-resource calls**: The `tvs` list from CMS-2 gives TV definitions (name, type). To get values per resource, need `resource/tv/getlist` with `resource=<id>` parameter. This means N API calls for N resources — cap at 100 resources to avoid runaway.

**Output shape**: Each content item in `cms.json` gets a `fields` object mapping field name → value:

```json
{
  "resources": [
    {
      "id": 1,
      "pagetitle": "Home",
      "fields": {
        "hero_image": "/assets/images/hero.jpg",
        "sidebar_text": "Welcome to our site"
      }
    }
  ]
}
```

For WordPress, `fields` is just the `acf` key renamed for consistency.

## Files to modify

**`lib/cms/modx.js`** — after extracting resources, iterate each (up to 100) and fetch TV values via `resource/tv/getlist?resource=<id>`. Map TV `name` → `value` into a `fields` object on each resource.

**`lib/cms/wordpress.js`** — rename `acf` to `fields` in post/page mapping for consistency. If `acf` is undefined (no ACF plugin), set `fields: {}`.

**`tests/helpers/server.js`** — add MODX connector route that handles `resource/tv/getlist` action and returns mock TV values.

**`tests/cms.test.js`** — add assertions that extracted resources/posts have `fields` property.

## Validation

**Automated**: `make check` — verify `fields` present on extracted items, MODX TV values populated from mock server.

**Manual (post-merge)**: Run against real MODX site with TVs, verify values match manager.

## Agent Team

Recommended: No — small scope, sequential changes to two adapter files.

## Before closing

- [ ] `make check` passes
- [ ] MODX resources have `fields` with TV values
- [ ] WP posts/pages have `fields` (from ACF or empty object)
- [ ] MODX TV extraction capped at 100 resources
- [ ] `fields` key consistent across CMS types
