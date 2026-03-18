# CMS-5: Template dependency graph

## Context

CMS-2/3 extract template metadata (names, IDs). This task fetches actual template **source code** and parses it to build a dependency graph — which templates include which chunks/partials. Output: `dependency-graph.json` for rebuild planning and migration.

## Goal

Fetch template/chunk source code from CMS APIs, parse include/embed references, output a directed graph of template dependencies.

## Design decisions

**Template content requires individual GET calls**: List endpoints return metadata only. To get source code:
- MODX: `element/template/get?id=<id>` returns `content` field with raw template markup
- MODX chunks: `element/chunk/get?id=<id>` returns `content` field
- WordPress: `/wp-json/wp/v2/templates/<id>` with `context=edit` returns `content.raw` (block markup)

**Parsing strategy per CMS**:

| CMS | Include syntax | Regex pattern |
|-----|---------------|---------------|
| MODX | `[[$chunkName]]` | `\[\[\$([^\]?]+?)(?:\?[^\]]*?)?\]\]` |
| MODX | `[[snippetName]]` | `\[\[!?([a-zA-Z_]\w*?)(?:\?[^\]]*?)?\]\]` |
| WordPress | `<!-- wp:template-part {"slug":"header"} -->` | `wp:template-part.*?"slug"\s*:\s*"([^"]+)"` |

**Output schema: `dependency-graph.json`**

```json
{
  "cms": "modx",
  "nodes": [
    { "id": "template:1", "name": "BaseTemplate", "type": "template" },
    { "id": "chunk:5", "name": "header", "type": "chunk" },
    { "id": "snippet:3", "name": "getResources", "type": "snippet" }
  ],
  "edges": [
    { "from": "template:1", "to": "chunk:5", "syntax": "[[$header]]" },
    { "from": "template:1", "to": "snippet:3", "syntax": "[[getResources]]" },
    { "from": "chunk:5", "to": "chunk:8", "syntax": "[[$nav]]" }
  ]
}
```

**Cap**: Fetch content for at most 50 templates + 100 chunks. Skip if counts exceed limits.

## Files to create

**`lib/cms/graph.js`** — exports `buildDependencyGraph(page, cmsData, context)`:
- Receives the already-extracted `cms.json` data from CMS-2/3
- Fetches template/chunk content via adapter-specific API calls
- Parses include references
- Returns graph object

## Files to modify

**`lib/cms/modx.js`** — add `fetchElementContent(page, connectorsUrl, siteId, elementType, id)` helper that calls `element/<type>/get?id=<id>`.

**`lib/cms/wordpress.js`** — add `fetchTemplateContent(page, apiRoot, nonce, templateId)` that calls `/wp-json/wp/v2/templates/<id>?context=edit`.

**`lib/cms.js`** — after extraction, call `buildDependencyGraph()` and return graph alongside cms.json data.

**`lib/capture.js`** — write `dependency-graph.json` alongside `cms.json` when graph data returned.

**`tests/helpers/server.js`** — add individual element GET routes returning mock content with include syntax.

**`tests/cms.test.js`** — test graph has correct nodes/edges for mock templates with known includes.

## Validation

**Automated**: `make check` — verify graph nodes/edges from mock templates with embedded `[[$chunk]]` and `[[snippet]]` syntax.

**Manual (post-merge)**: Run against real MODX site, verify graph matches actual template includes in manager.

## Agent Team

Recommended: No — sequential: needs adapter content-fetch helpers before graph builder.

## Before closing

- [ ] `make check` passes
- [ ] MODX templates parsed for `[[$chunk]]` and `[[snippet]]` references
- [ ] WP templates parsed for `wp:template-part` references
- [ ] Graph has correct nodes (templates, chunks, snippets) and directed edges
- [ ] `dependency-graph.json` written alongside `cms.json`
- [ ] Content fetch capped at 50 templates + 100 chunks
