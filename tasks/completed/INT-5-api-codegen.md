# INT-5: Schema-driven API codegen

## Context

sitecap v0.6.0 added MCP, REST, and library surfaces by hand-writing each one. The MCP server (`bin/mcp-server.js`) and REST API (`bin/api-server.js`) duplicate `slugify`, `normalizeUrl`, crawl logic, browser lifecycle, and viewport parsing. This approach doesn't scale and will drift.

All Primitive Shell projects must support every API surface (CLI, REST, MCP, function-calling tools, Skill.md) generated from a single schema. UI only exists after core + APIs. This matches the patterns proven in prim (OpenAPI hub) and fieldbase (`defineOp()` registry).

**Reference implementation**: sitetest PR #7 implemented this pattern successfully. This plan incorporates lessons learned from that PR.

## Goal

Replace hand-written API surfaces with a schema-driven codegen pipeline. Define operations once, generate all surfaces.

## Architecture

```
lib/operations.js          ← defineOp() + Zod schemas (SSoT)
lib/registry.js            ← collects all operations, exports allOperations[]
lib/capture.js             ← core logic (unchanged)
lib/diff.js                ← core logic (unchanged)
lib/chrome.js              ← core logic (unchanged)
lib/url.js                 ← extracted: slugify(), normalizeUrl() (shared utilities)
lib/browser.js             ← extracted: browser lifecycle (launch, singleton, cleanup)
scripts/generate.js        ← codegen orchestrator
generated/
  mcp-tools.js             ← MCP tool definitions + handler
  api-routes.js            ← REST route handler
  openapi.json             ← OpenAPI 3.1 spec
  tools.json               ← function-calling tool definitions
  cli-commands.js           ← CLI command definitions (stretch)
bin/mcp-server.js          ← thin shell: imports generated/mcp-tools.js, wires transport
bin/api-server.js          ← thin shell: imports generated/api-routes.js, wires http server
bin/sitecap.js             ← keep as-is initially, migrate to generated/cli-commands.js later
```

**Dependency direction**: `lib/operations.js` imports Zod only. `lib/registry.js` imports operations + core logic. Generators read the registry. Bin files import generated code. Core logic (`lib/capture.js`, `lib/diff.js`) imports nothing from the API layer.

## Phase 1: Extract shared code (no behavior change)

Extract duplicated code from `bin/mcp-server.js` and `bin/api-server.js` into shared modules.

### Files to create

**`lib/url.js`**
- Move `slugify(url)` here (currently duplicated in both bin files)
- Move `normalizeUrl(url)` here
- Export both

**`lib/browser.js`**
- `createBrowser()` — launches headless Chromium, returns browser instance
- `createCaptureContext(browser, viewport)` — creates context + page with viewport
- `cleanupPage(page, context)` — closes page + context
- `parseViewport(str)` — parses "WxH" string, returns `{width, height}` with 1280x720 default

### Files to modify

**`bin/mcp-server.js`** — replace inline `slugify`, `normalizeUrl`, `parseViewport` with imports from `lib/url.js` and `lib/browser.js`

**`bin/api-server.js`** — same replacements. Replace singleton `getBrowser()` with `lib/browser.js` functions.

### Validation

- `npm run mcp` still starts and responds to tool calls
- `npm run api` still starts, `GET /health` returns 200
- `make check` passes

## Phase 2: Define operations with Zod schemas

### Files to create

**`lib/operations.js`**

Define a `defineOp()` helper and all operations:

```js
import { z } from "zod";

function defineOp({ name, description, type, input, handler }) {
  return { name, description, type, input, handler };
}
```

Four operations:

| name | type | description |
|------|------|-------------|
| `capture` | mutation | Capture a web page — screenshot, a11y, HTML, network, console, storage, performance |
| `diff` | query | Compare two sitecap capture directories |
| `crawl` | mutation | Crawl a site and capture all same-origin pages |
| `read_capture` | query | Read a specific file from a capture directory |

Input schemas (Zod):

```
capture:
  url: z.string()            — required
  output: z.string()         — optional, default /tmp/sitecap
  types: z.string()          — optional, comma-separated capture types
  viewport: z.string()       — optional, default "1280x720"

diff:
  dirA: z.string()           — required
  dirB: z.string()           — required
  threshold: z.number()      — optional, screenshot diff threshold %

crawl:
  url: z.string()            — required
  output: z.string()         — optional, default /tmp/sitecap
  maxDepth: z.number()       — optional, default 3
  maxPages: z.number()       — optional, default 50
  filter: z.string()         — optional, regex include
  exclude: z.string()        — optional, regex exclude

read_capture:
  path: z.string()           — required
```

Each operation's `handler` is a function that takes validated input and returns a result. Handlers import from `lib/capture.js`, `lib/diff.js`, `lib/url.js`, `lib/browser.js`. This is where the actual logic lives — one implementation, used by all surfaces.

**Security**: `read_capture` handler must validate that `path` is under an allowed output directory (default `/tmp/sitecap*`). Reject absolute paths outside that prefix.

**`lib/registry.js`**

```js
import { captureOp, diffOp, crawlOp, readCaptureOp } from "./operations.js";
export const allOperations = [captureOp, diffOp, crawlOp, readCaptureOp];
```

### Validation

- Import `lib/registry.js` and verify all 4 operations are present with correct schemas
- No behavior change yet — bin files still use their own code

## Phase 3: Codegen generators

### Files to create

**`scripts/generate.js`**

Orchestrator script. Run via `npm run generate` / `make generate`.

Reads `allOperations` from `lib/registry.js` and generates:

1. **`generated/mcp-tools.js`** — for each operation:
   - MCP `Tool` definition object (name, description, JSON Schema from Zod)
   - `handleTool(name, args)` switch function that validates input through Zod **before** calling handler: `ops.<name>Op.handler(ops.<name>Op.input.parse(args))`
   - Use `// BEGIN:GENERATED` / `// END:GENERATED` markers if manual code is needed

2. **`generated/api-routes.js`** — for each operation:
   - Route definition: `{ method, path, handler }`
   - Mutations → `POST /<name>`, queries → `GET /<name>`
   - Route matching must use `pathname` (not full `req.url`) to handle query strings correctly: `const parsed = new URL(req.url, "http://localhost"); const pathname = parsed.pathname;`
   - GET routes extract params from `parsed.searchParams`
   - Each route: parse body/query, validate with Zod `.parse()`, call `op.handler()`, return JSON
   - Plus `GET /health` (reads version from package.json)

3. **`generated/openapi.json`** — OpenAPI 3.1 spec:
   - Convert Zod schemas to JSON Schema via `z.toJSONSchema()` (Zod v4 built-in, no extra dep)
   - Paths from operations (POST for mutations, GET for queries)
   - Server URL: `http://localhost:3100`

4. **`generated/tools.json`** — function-calling tool definitions:
   - OpenAI/Claude compatible format
   - Name: `sitecap_<operation_name>`
   - Parameters from Zod → JSON Schema

### Zod → JSON Schema

Use Zod v4's built-in `z.toJSONSchema(schema)`. No need for `zod-to-json-schema` as a separate dependency.

### Known pitfalls from sitetest PR #7

These were caught in review and must not be repeated:

| Pitfall | Wrong | Right |
|---------|-------|-------|
| MCP input validation | `op.handler(args)` — skips Zod | `op.handler(op.input.parse(args))` — validates + applies defaults |
| Generated file comment | `/ AUTO-GENERATED` | `// AUTO-GENERATED` |
| GET route matching | `r.path === req.url` — fails with query strings | `r.path === pathname` where pathname parsed from URL |
| Version in bin files | Hardcoded `"0.6.0"` | Read from `package.json` at startup |
| Zod defaults in `required` | Zod v4 `toJSONSchema()` puts defaulted fields in `required` | OK — `.parse()` applies defaults before handler sees args. Verify MCP clients handle this. |

### Files to modify

**`package.json`**
- Add `"generate": "node scripts/generate.js"` to scripts
- Add `zod` as direct dependency (Zod v4: `^4.3.6`)

**`Makefile`**
- Add `generate` target
- Add `generate` as prerequisite to `check`

### Validation

- `npm run generate` produces all 4 files in `generated/`
- Generated files are valid JS/JSON (import without errors)
- `make check` still passes

## Phase 4: Wire bin files to generated code

### Files to modify

**`bin/mcp-server.js`** — gut and replace:
```js
#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { tools, handleTool } from "../generated/mcp-tools.js";

const pkg = JSON.parse(await readFile(resolve(import.meta.dirname, "../package.json"), "utf-8"));
const server = new Server({ name: "sitecap", version: pkg.version }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await handleTool(name, args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

**`bin/api-server.js`** — gut and replace:
```js
#!/usr/bin/env node
import { createServer } from "node:http";
import { handleRequest } from "../generated/api-routes.js";

const PORT = parseInt(process.env.SITECAP_PORT || "3100", 10);
const server = createServer(handleRequest);
server.listen(PORT, () => console.log(`sitecap API on :${PORT}`));
process.on("SIGINT", () => process.exit(0));
```

### Validation

- `npm run mcp` — MCP server starts, all 4 tools respond correctly
- `npm run api` — REST server starts, all endpoints return correct responses
- `GET /health` returns `{ok: true, version: "..."}` with version from package.json
- `POST /capture` with a test URL produces capture files
- `POST /diff` with two capture dirs returns diff report
- `make check` passes

## Phase 5: Skill.md + CLI (stretch)

### Skill.md

Can be auto-generated from operation metadata (name, description, input schema). Add to `scripts/generate.js`. Low priority — current hand-written Skill.md is fine.

### CLI migration

The existing `bin/sitecap.js` is feature-rich (concurrency, profiles, manifests, video, auth). Migrating it to generated code is a larger effort. Defer unless the CLI needs new operations.

When ready: generate `cli-commands.js` that maps operations to Commander.js or parseArgs commands, similar to fieldbase's `cli.ts` generator.

## Commit strategy

One commit per phase. Each commit leaves the project in a working state.

| Commit | Description |
|--------|-------------|
| 1 | refactor: extract shared url and browser utilities |
| 2 | feat: define operations with Zod schemas and registry |
| 3 | feat: add codegen script for MCP, REST, OpenAPI, tools |
| 4 | refactor: wire bin files to generated code |
| 5 | chore: add Skill.md generation (optional) |

## Before closing

- [ ] Run `make check` (lint + test pass)
- [ ] `npm run generate` produces valid output
- [ ] `npm run mcp` starts without errors
- [ ] `npm run api` starts, `/health` returns 200
- [ ] `POST /capture` with a real URL produces capture files
- [ ] `read_capture` handler rejects paths outside allowed prefix
- [ ] No hardcoded paths (global pre-commit hook catches these)
- [ ] Generated files are committed (not gitignored) so consumers don't need to run codegen
- [ ] Version string read from package.json, not hardcoded in generated files or bin files
- [ ] MCP handleTool validates input through Zod `.parse()` before calling handler
- [ ] GET route matching uses `pathname`, not full `req.url`
- [ ] Generated file comments use `//` prefix, not `/`
