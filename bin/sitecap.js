#!/usr/bin/env node

import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { chromium } from "playwright";
import { navigateAndCapture } from "../lib/capture.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: "string", short: "o", default: "./output" },
    port: { type: "string", short: "p", default: "9222" },
    types: { type: "string", short: "t" },
    manifest: { type: "string", short: "m" },
    viewport: { type: "string", short: "v", default: "1280x720" },
    concurrency: { type: "string", short: "c", default: "4" },
    launch: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help || (positionals.length === 0 && !values.manifest)) {
  console.log(`sitecap — exhaustive web page capture

Usage:
  sitecap <url> [<url>...] [options]
  sitecap -m manifest.json [options]

Options:
  -o, --output <dir>       Output directory (default: ./output)
  -p, --port <port>        Chrome DevTools port (default: 9222)
  -t, --types <list>       Comma-separated capture types (default: all)
                           Types: screenshot,accessibility,html,network,console,storage
  -v, --viewport <WxH>     Viewport size (default: 1280x720)
  -c, --concurrency <n>    Parallel tabs (default: 4)
  --launch                 Auto-launch headless Chrome if not running
  -m, --manifest <file>    JSON manifest of URLs to capture
  -h, --help               Show this help

Manifest format:
  [
    { "url": "https://example.com/page1", "slug": "page1" },
    { "url": "https://example.com/page2", "slug": "subdir/page2" }
  ]

Chrome setup:
  Either use --launch to auto-start headless Chrome, or start Chrome manually:
    google-chrome --remote-debugging-port=9222

Examples:
  sitecap https://example.com --launch
  sitecap https://example.com/a https://example.com/b -o ./captures -c 2
  sitecap -m manifest.json -o ./captures -t screenshot,accessibility
`);
  process.exit(0);
}

const outDir = resolve(values.output);
const port = parseInt(values.port, 10);
const concurrency = Math.max(1, parseInt(values.concurrency, 10));
const types = values.types ? values.types.split(",").map((s) => s.trim()) : undefined;

// Parse viewport
const viewportMatch = values.viewport.match(/^(\d+)x(\d+)$/);
if (!viewportMatch) {
  console.error(`Invalid viewport format: ${values.viewport}. Use WxH (e.g., 1280x720)`);
  process.exit(1);
}
const viewport = { width: parseInt(viewportMatch[1], 10), height: parseInt(viewportMatch[2], 10) };

// Build URL list from positionals or manifest
let targets = [];

if (values.manifest) {
  const raw = await readFile(resolve(values.manifest), "utf-8");
  const manifest = JSON.parse(raw);
  targets = manifest.map((entry) => ({
    url: entry.url,
    slug: entry.slug || slugify(entry.url),
  }));
}

for (const url of positionals) {
  targets.push({ url, slug: slugify(url) });
}

if (targets.length === 0) {
  console.error("No URLs to capture.");
  process.exit(1);
}

console.log(`sitecap: ${targets.length} page(s) → ${outDir}`);
console.log(`Viewport: ${viewport.width}x${viewport.height}, concurrency: ${concurrency}`);

// Connect or launch Chrome
let browser;

try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  console.log(`Connected to Chrome on port ${port}`);
} catch {
  if (values.launch) {
    console.log("No Chrome found, launching headless...");
    browser = await chromium.launch({ headless: true });
  } else {
    console.error(
      `Failed to connect to Chrome on port ${port}.\n` +
        `Use --launch to auto-start headless Chrome, or start Chrome manually:\n` +
        `  google-chrome --remote-debugging-port=${port}\n`
    );
    process.exit(1);
  }
}

const context = browser.contexts()[0] || await browser.newContext();

// Worker pool for parallel capture
let captured = 0;
let failed = 0;
let nextIndex = 0;

async function worker() {
  const page = await context.newPage();
  await page.setViewportSize(viewport);

  while (nextIndex < targets.length) {
    const idx = nextIndex++;
    const target = targets[idx];
    const pageDir = join(outDir, target.slug);
    console.log(`[${idx + 1}/${targets.length}] ${target.url}`);

    try {
      const meta = await navigateAndCapture(page, target.url, pageDir, {
        types,
      });

      if (meta.errors) {
        console.log(`  ⚠ partial: ${Object.keys(meta.errors).join(", ")}`);
      } else {
        console.log(`  ✓ ${Object.keys(meta.captures).length} files`);
      }
      captured++;
    } catch (e) {
      console.error(`  ✗ ${e.message}`);
      failed++;
    }
  }

  await page.close();
}

// Launch workers up to concurrency limit (or target count if fewer)
const workerCount = Math.min(concurrency, targets.length);
const workers = [];
for (let i = 0; i < workerCount; i++) {
  workers.push(worker());
}
await Promise.all(workers);

await browser.close();

console.log(`\nDone: ${captured} captured, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);

function slugify(url) {
  try {
    const u = new URL(url);
    return u.pathname
      .replace(/^\/+|\/+$/g, "")
      .replace(/\//g, "-")
      .replace(/[^a-zA-Z0-9-_]/g, "_")
      || "index";
  } catch {
    return url.replace(/[^a-zA-Z0-9-_]/g, "_");
  }
}
