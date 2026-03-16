# Contributing to sitecap

## Prerequisites

- Node.js 22+
- Playwright browsers (Chromium)

## Setup

```bash
npm install
npx playwright install chromium
```

## Development

Run the full check suite (generate + lint + test):

```bash
make check
```

## Branch Protection

The `main` branch is protected. All changes must go through pull requests.

## Code Style

- ESLint enforces style — run `make check` before submitting
- ESM modules throughout (no CommonJS)
- No build step — source files run directly
