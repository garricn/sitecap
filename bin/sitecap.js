#!/usr/bin/env node

import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { chromium } from "playwright";
import { navigateAndCapture, extractLinks } from "../lib/capture.js";

// Handle diff subcommand before parseArgs
if (process.argv[2] === "diff") {
  const args = process.argv.slice(3);
  const dirA = args[0];
  const dirB = args[1];

  if (!dirA || !dirB || args.includes("--help") || args.includes("-h")) {
    console.log(`sitecap diff — compare two capture directories

Usage:
  sitecap diff <dir-a> <dir-b> [options]

Options:
  --threshold <n>    Screenshot diff threshold as % (default: 0.1)
  --output <file>    Write JSON report to file (default: terminal)
  --types <list>     Capture types to diff (default: screenshot,accessibility,console,network,storage)
`);
    process.exit(0);
  }

  const { diffCaptures, formatDiffReport } = await import("../lib/diff.js");

  const diffOpts = {};
  const threshIdx = args.indexOf("--threshold");
  if (threshIdx !== -1 && args[threshIdx + 1]) {
    diffOpts.threshold = parseFloat(args[threshIdx + 1]);
  }
  const typesIdx = args.indexOf("--types");
  if (typesIdx !== -1 && args[typesIdx + 1]) {
    diffOpts.types = args[typesIdx + 1].split(",").map((s) => s.trim());
  }
  const outputIdx = args.indexOf("--output");
  const outputFile = outputIdx !== -1 ? args[outputIdx + 1] : null;

  const report = await diffCaptures(resolve(dirA), resolve(dirB), diffOpts);

  if (outputFile) {
    await writeFile(resolve(outputFile), JSON.stringify(report, null, 2));
    console.log(`Diff report written to ${outputFile}`);
  } else {
    console.log(formatDiffReport(report));
  }

  process.exit(report.identical ? 0 : 1);
}

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
    crawl: { type: "boolean", default: false },
    "max-depth": { type: "string", default: "3" },
    "max-pages": { type: "string", default: "50" },
    filter: { type: "string" },
    exclude: { type: "string" },
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
                           Types: screenshot,accessibility,html,network,console,storage,performance
  -v, --viewport <WxH>     Viewport size (default: 1280x720)
  -c, --concurrency <n>    Parallel tabs (default: 4)
  --launch                 Auto-launch headless Chrome if not running
  --crawl                  Crawl same-origin links from captured pages
  --max-depth <n>          Max crawl depth (default: 3)
  --max-pages <n>          Max pages to crawl (default: 50)
  --filter <regex>         Only crawl URLs matching pattern
  --exclude <regex>        Skip URLs matching pattern
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
  sitecap https://example.com --crawl --max-depth 2 --max-pages 20 --launch
  sitecap https://example.com/a https://example.com/b -o ./captures -c 2
  sitecap -m manifest.json -o ./captures -t screenshot,accessibility
`);
  process.exit(0);
}

const outDir = resolve(values.output);
const port = parseInt(values.port, 10);
const concurrency = Math.max(1, parseInt(values.concurrency, 10));
const types = values.types ? values.types.split(",").map((s) => s.trim()) : undefined;
const crawl = values.crawl;
const maxDepth = parseInt(values["max-depth"], 10);
const maxPages = parseInt(values["max-pages"], 10);
const filterRe = values.filter ? new RegExp(values.filter) : null;
const excludeRe = values.exclude ? new RegExp(values.exclude) : null;

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

if (crawl) {
  console.log(`sitecap: crawling from ${targets.length} seed(s) → ${outDir} (max-depth: ${maxDepth}, max-pages: ${maxPages})`);
} else {
  console.log(`sitecap: ${targets.length} page(s) → ${outDir}`);
}
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

// BFS crawl queue: { url, slug, depth }
const queue = targets.map((t) => ({ ...t, depth: 0 }));
const visited = new Set(targets.map((t) => normalizeUrl(t.url)));
let captured = 0;
let failed = 0;
let nextIndex = 0;
let totalEnqueued = queue.length;

async function worker() {
  const page = await context.newPage();
  await page.setViewportSize(viewport);

  while (nextIndex < queue.length) {
    const idx = nextIndex++;
    const target = queue[idx];
    const pageDir = join(outDir, target.slug);
    const label = crawl ? `[${idx + 1}/${totalEnqueued}+]` : `[${idx + 1}/${queue.length}]`;
    console.log(`${label} ${target.url}${crawl ? ` (depth ${target.depth})` : ""}`);

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

      // Crawl: extract links and enqueue new ones
      if (crawl && target.depth < maxDepth && totalEnqueued < maxPages) {
        const links = await extractLinks(page);
        for (const link of links) {
          if (totalEnqueued >= maxPages) break;
          const norm = normalizeUrl(link);
          if (visited.has(norm)) continue;
          if (filterRe && !filterRe.test(link)) continue;
          if (excludeRe && excludeRe.test(link)) continue;
          visited.add(norm);
          queue.push({ url: link, slug: slugify(link), depth: target.depth + 1 });
          totalEnqueued++;
        }
      }
    } catch (e) {
      console.error(`  ✗ ${e.message}`);
      failed++;
    }
  }

  await page.close();
}

// Launch workers up to concurrency limit (or target count if fewer)
const workerCount = Math.min(concurrency, queue.length);
const workers = [];
for (let i = 0; i < workerCount; i++) {
  workers.push(worker());
}
await Promise.all(workers);

await browser.close();

console.log(`\nDone: ${captured} captured, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    // Strip trailing slash for dedup
    return u.href.replace(/\/+$/, "");
  } catch {
    return url;
  }
}

function slugify(url) {
  try {
    const u = new URL(url);
    const path = u.pathname
      .replace(/^\/+|\/+$/g, "")
      .replace(/\//g, "-")
      .replace(/[^a-zA-Z0-9-_]/g, "_");
    return path ? `${u.hostname}/${path}` : u.hostname;
  } catch {
    return url.replace(/[^a-zA-Z0-9-_]/g, "_");
  }
}
