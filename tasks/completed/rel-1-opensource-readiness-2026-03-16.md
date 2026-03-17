# REL-1: Open-source readiness

## Context

sitecap is functionally complete through v0.9.0 but missing standard open-source packaging: no LICENSE file, empty author in package.json, no npm publish filtering, and internal files (tasks.json, CLAUDE.md) would ship to users. This task makes the repo publishable to npm and presentable on GitHub.

## Goal

Make sitecap ready for `npm publish` and public GitHub visibility. No code changes — only packaging, metadata, and documentation.

## Phase 1: Critical blockers (must fix before publish)

### LICENSE

Create `LICENSE` file with MIT license text. Year: 2026. Copyright holder: match package.json author field.

### package.json metadata

- `"version"`: bump from `"0.1.0"` to `"1.0.0"`
- `"author"`: fill with name (decide: personal name or "Primitive Shell")
- `"license"`: already `"MIT"` — verify it stays in sync with LICENSE file
- `"repository"`: `{ "type": "git", "url": "https://github.com/garricn/sitecap.git" }`
- `"homepage"`: `"https://github.com/garricn/sitecap"`
- `"bugs"`: `{ "url": "https://github.com/garricn/sitecap/issues" }`

### files field (npm publish filtering)

Add `"files"` array to package.json. This is a whitelist — only listed paths ship to npm:

```json
"files": [
  "bin/",
  "lib/",
  "generated/",
  "index.js",
  "README.md",
  "LICENSE"
]
```

**Excluded by this whitelist** (stays in git, not in npm):
- `tasks.json`, `tasks/` — internal work tracking
- `CLAUDE.md` — internal dev instructions
- `Skill.md` — Claude Code skill definition
- `output/` — demo captures
- `tests/`, `tests/helpers/` — test suite
- `scripts/` — codegen (users get pre-built `generated/`)
- `.pre-commit-config.yaml`, `eslint.config.js` — dev tooling
- `.github/` — CI workflows

**Included** (ships to npm):
- `bin/` — CLI entry points (sitecap.js, mcp-server.js, api-server.js)
- `lib/` — core modules
- `generated/` — pre-built MCP/REST/OpenAPI/tools
- `index.js` — library entry point
- `README.md`, `LICENSE` — documentation

**Prerequisite**: `generated/` must be checked into git (it already is — verified). Add a `"prepublishOnly"` script to ensure generated files are fresh: `"prepublishOnly": "npm run generate"`. This guarantees `npm publish` always ships current generated output even if someone forgot to regenerate.

### SECURITY.md

Replace `hello@prim.sh` with `hello@prim.sh` (or another appropriate public contact). Keep the same format.

### Validation

- `npm pack --dry-run` — verify only whitelisted files appear
- `npm pack` — inspect tarball contents
- No tasks.json, CLAUDE.md, tests/, or output/ in the tarball

## Phase 2: Professional polish (should complete)

### CONTRIBUTING.md

Short file covering:
- Prerequisites: Node.js 22+, Playwright browsers
- Setup: `npm install && npx playwright install chromium`
- Development: `make check` (generate + lint + test)
- Branch protection: PRs required for main
- Code style: ESLint, no build step

### CHANGELOG.md

Document releases to date. Format: Keep a Changelog (keepachangelog.com).

Versions to document (brief, from git history):
- v0.2.0 — viewport, page settle, concurrency, auto-launch
- v0.3.0 — crawl with BFS link extraction
- v0.4.0 — diff, performance capture, filter/exclude
- v0.5.0 — MHTML, auth cookies, video recording
- v0.6.0 — library API, MCP server, REST API, Skill.md
- v0.7.0 — auto-auth Google, auth-flow YAML
- v0.8.0 — iframe capture, click-flow exploration
- v0.9.0 — session video, API codegen

### Validation

- README.md — already comprehensive, no changes needed
- CONTRIBUTING.md exists and covers setup through PR process
- CHANGELOG.md covers all releases

## Phase 3: Optional (nice to have)

### CODE_OF_CONDUCT.md

Contributor Covenant v2.1. Only needed if expecting external contributions. Can defer.

### GitHub issue/PR templates

`.github/ISSUE_TEMPLATE/bug_report.md` and `.github/PULL_REQUEST_TEMPLATE.md`. Low priority — can add later.

## Decision: author field

| Option | Value | Pros | Cons |
|--------|-------|------|------|
| Personal | `"Garric Nahapetian"` | Simple, clear ownership | Ties to individual |
| Org | `"Primitive Shell"` | Brand consistency across site* tools | Org doesn't have npm presence yet |

Recommend: personal name for now, change to org later if needed.

## Decision: version bump for publish

Current version is 0.1.0 but the tool is feature-rich through ~v0.9.0. The version tags in tasks.json are planning milestones, not published versions.

| Option | Version | Rationale |
|--------|---------|-----------|
| Keep 0.1.0 | `0.1.0` | First public release, semver < 1.0 signals "API may change" |
| Jump to 1.0.0 | `1.0.0` | Feature-complete, stable CLI, signals production-ready |
| Match milestones | `0.9.0` | Aligns with internal tracking |

Recommend: **1.0.0** — the tool is stable, tested, and feature-complete. Sub-1.0 signals instability that doesn't match reality.

## Agent Team

Recommended: Yes — Agent A: LICENSE + package.json + files field + SECURITY.md (Phase 1), Agent B: CONTRIBUTING.md + CHANGELOG.md (Phase 2). No file overlap.

## Before closing

- [ ] `npm pack --dry-run` shows only whitelisted files
- [ ] No tasks.json, CLAUDE.md, tests/, output/ in tarball
- [ ] LICENSE file exists with correct year and copyright holder
- [ ] package.json version is 1.0.0
- [ ] package.json has author, repository, homepage, bugs fields
- [ ] package.json license field matches LICENSE file
- [ ] SECURITY.md has appropriate public contact
- [ ] CONTRIBUTING.md exists with setup instructions
- [ ] CHANGELOG.md documents all releases
- [ ] `make check` still passes
