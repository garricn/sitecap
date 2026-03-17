# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [1.0.0]

First public release. Includes all features from v0.2.0-v0.9.0 development milestones.

## [0.9.0]

### Added

- Session video recording
- Network-filter flag for selective request capture

## [0.8.0]

### Added

- Iframe capture support
- Click-flow exploration for interactive pages

## [0.7.0]

### Added

- Auto-auth for Google login
- Auth-flow YAML for user-defined login sequences
- API codegen tooling

## [0.6.0]

### Added

- Library API for programmatic usage
- MCP server integration
- REST API
- Skill.md definition
- Wait-for-auth mode (profile launch, poll for login, save cookies)

## [0.5.0]

### Added

- MHTML capture (opt-in)
- Auth cookie injection for headless runs
- Video recording of page loads (opt-in)

## [0.4.0]

### Added

- Diff subcommand for comparing two capture directories
- Performance capture (Core Web Vitals, navigation timing)
- Filter and exclude options for crawl

## [0.3.0]

### Added

- Crawl mode with BFS link extraction
- Max-depth and max-pages limits

## [0.2.0]

### Added

- Custom viewport support
- Dynamic page settle (MutationObserver + PerformanceObserver)
- Parallel capture with configurable concurrency
- Auto-launch headless Chromium mode
