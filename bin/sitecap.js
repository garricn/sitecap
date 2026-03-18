#!/usr/bin/env node

import { parseArgs } from "node:util";
import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { chromium } from "playwright";
import { navigateAndCapture, extractLinks } from "../lib/capture.js";
import {
  launchChromeWithProfile,
  resolveProfileDir,
  findUserDataDir,
  shutdownChrome,
} from "../lib/chrome.js";

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
    profile: { type: "string" },
    "user-data-dir": { type: "string" },
    "keep-open": { type: "boolean", default: true },
    "close-after": { type: "boolean", default: false },
    crawl: { type: "boolean", default: false },
    "max-depth": { type: "string", default: "3" },
    "max-pages": { type: "string", default: "50" },
    filter: { type: "string" },
    exclude: { type: "string" },
    auth: { type: "string" },
    "wait-for-auth": { type: "boolean", default: false },
    "auth-url": { type: "string" },
    "auth-flow": { type: "string" },
    explore: { type: "string" },
    "network-filter": { type: "string", default: "all" },
    video: { type: "boolean", default: false },
    "session-video": { type: "boolean", default: false },
    "download-assets": { type: "boolean", default: false },
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
                           Opt-in: mhtml,cms
  -v, --viewport <WxH>     Viewport size (default: 1280x720)
  -c, --concurrency <n>    Parallel tabs (default: 4)
  --launch                 Auto-launch headless Chrome if not running
  --profile <name>         Launch Chrome with a named profile (e.g., "Default", "Profile 1", or display name)
  --user-data-dir <path>   Override Chrome user data directory
  --close-after            Close Chrome after capture (default: stays open with --profile)
  --crawl                  Crawl same-origin links from captured pages
  --max-depth <n>          Max crawl depth (default: 3)
  --max-pages <n>          Max pages to crawl (default: 50)
  --filter <regex>         Only crawl URLs matching pattern
  --exclude <regex>        Skip URLs matching pattern
  --auth <file>            Load cookies/storage from JSON before capture
  --wait-for-auth          Launch Chrome, wait for user to log in, then capture
  --auth-url <url>         Navigate to this URL before waiting (use with --wait-for-auth)
  --auth-flow <file>       Run auth flow from YAML before capture (e.g., login steps)
  --explore <file>         Run exploration flow (foreach/capture steps) after page load
  --network-filter <mode>  Network capture: all (default), xhr (API only), none
  --video                  Record per-page video clips (off by default)
  --session-video          Record one continuous video across all pages
  --download-assets        Download CSS/JS/images/fonts to assets/ dir
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

  Use --profile to launch Chrome with your real profile (cookies, auth, extensions):
    sitecap https://example.com --profile Default
    sitecap https://example.com --profile "Work" -o ./output

Examples:
  sitecap https://example.com --launch
  sitecap https://example.com --profile Default -o ./captures
  sitecap -m manifest.json --profile Work --wait-for-auth --auth-url https://app.example.com/login
  sitecap https://example.com --crawl --max-depth 2 --max-pages 20 --launch
  sitecap https://example.com/a https://example.com/b -o ./captures -c 2
  sitecap -m manifest.json -o ./captures -t screenshot,accessibility
`);
  process.exit(0);
}

const outDir = resolve(values.output);
const port = parseInt(values.port, 10);
let concurrency = Math.max(1, parseInt(values.concurrency, 10));
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

// Validate flag combinations
if (values["wait-for-auth"] && !values.profile) {
  console.error("--wait-for-auth requires --profile (need a visible browser to log in)");
  process.exit(1);
}
if (values["auth-flow"] && !values.profile && !values.launch) {
  console.error("--auth-flow requires --profile or --launch (need a browser to run auth steps)");
  process.exit(1);
}
if (values.video && values["session-video"]) {
  console.error("--video and --session-video are mutually exclusive");
  process.exit(1);
}
if (values["session-video"] && concurrency > 1) {
  console.log("Warning: --session-video requires sequential capture, forcing concurrency=1");
  concurrency = 1;
}

// Connect or launch Chrome
let browser;
let profileContext = null;

if (values.profile) {
  // Launch Chrome with profile via Playwright persistent context
  const userDataDir = values["user-data-dir"] || findUserDataDir();
  const profileDir = await resolveProfileDir(userDataDir, values.profile);
  console.log(`Launching Chrome with profile "${values.profile}" (dir: ${profileDir})...`);

  try {
    const result = await launchChromeWithProfile({
      profileDir,
      userDataDir,
      viewport,
    });
    profileContext = result.context;
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  console.log("Chrome launched with profile.");

  // Wait for user to authenticate if requested
  if (values["wait-for-auth"]) {
    const authPage = await profileContext.newPage();
    const authUrl = values["auth-url"] || targets[0].url;
    await authPage.goto(authUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const loginUrl = authPage.url();
    console.log(`Navigated to ${loginUrl}`);
    console.log("Waiting for auth (complete login in Chrome, URL change will be detected)...");

    // Poll for URL change — non-interactive, detects when login redirects
    await authPage.waitForURL((url) => url.href !== loginUrl, { timeout: 120_000 });
    console.log(`Auth detected: ${authPage.url()}`);

    // Save cookies for future runs
    const { saveGoogleAuthCookies } = await import("../lib/auth.js");
    const userDataDirForSave = values["user-data-dir"] || findUserDataDir();
    const profileDirForSave = await resolveProfileDir(userDataDirForSave, values.profile);
    await saveGoogleAuthCookies(profileContext, profileDirForSave);

    await authPage.close();
    console.log("Continuing with capture...");
  }
} else {
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
          `Use --launch for headless, --profile for your Chrome profile, or start Chrome manually:\n` +
          `  google-chrome --remote-debugging-port=${port} --user-data-dir=/tmp/chrome-debug\n` +
          `  (Chrome 136+ requires --user-data-dir with --remote-debugging-port)\n`
      );
      process.exit(1);
    }
  }
}

const sessionVideoOpts = values["session-video"] ? { recordVideo: { dir: outDir } } : {};
const context = profileContext || browser.contexts()[0] || await browser.newContext(sessionVideoOpts);

// Load auth state (cookies/storage) if provided
if (values.auth) {
  const authData = JSON.parse(await readFile(resolve(values.auth), "utf-8"));
  if (authData.cookies && authData.cookies.length > 0) {
    await context.addCookies(authData.cookies);
    console.log(`Loaded ${authData.cookies.length} cookies from ${values.auth}`);
  }
  if (authData.localStorage) {
    // localStorage must be injected per-page after navigation, store for later
    context.__sitecapLocalStorage = authData.localStorage;
  }
}

// Run auth flow if provided
if (values["auth-flow"]) {
  const { runAuthFlow } = await import("../lib/auth.js");
  const authPage = await context.newPage();
  await authPage.setViewportSize(viewport);

  // Navigate to first target URL as starting point
  const authTarget = targets[0].url;
  await authPage.goto(authTarget, { waitUntil: "domcontentloaded", timeout: 30_000 });

  const success = await runAuthFlow(resolve(values["auth-flow"]), authPage, context);

  if (success) {
    console.log("Auth flow completed.");
  } else {
    console.log("Auth flow did not complete — proceeding without auth.");
  }
  // Delete auth page's video artifact — session video should only come from the capture page
  if (values["session-video"] && authPage.video()) {
    const authVideoPath = await authPage.video().path();
    await authPage.close();
    try { await (await import("node:fs/promises")).unlink(authVideoPath); } catch { /* video may not exist */ }
  } else {
    await authPage.close();
  }
}

// Run exploration flow if provided
if (values.explore) {
  const { runAuthFlow } = await import("../lib/auth.js");
  const explorePage = await context.newPage();
  await explorePage.setViewportSize(viewport);

  const exploreTarget = targets[0].url;
  await explorePage.goto(exploreTarget, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await explorePage.waitForLoadState("networkidle").catch(() => {});

  const success = await runAuthFlow(resolve(values.explore), explorePage, context, {
    outDir,
    types,
  });

  if (success) {
    console.log("Exploration flow completed.");
  } else {
    console.log("Exploration flow did not complete.");
  }
  if (values["session-video"] && explorePage.video()) {
    const exploreVideoPath = await explorePage.video().path();
    await explorePage.close();
    try { await (await import("node:fs/promises")).unlink(exploreVideoPath); } catch { /* video may not exist */ }
  } else {
    await explorePage.close();
  }
}

// Shared assets directory for multi-page captures
const isMultiPage = targets.length > 1 || crawl;
const sharedAssetsDir = (values["download-assets"] && isMultiPage) ? join(outDir, "assets") : null;

// BFS crawl queue: { url, slug, depth }
const queue = targets.map((t) => ({ ...t, depth: 0 }));
const visited = new Set(targets.map((t) => normalizeUrl(t.url)));
let captured = 0;
let failed = 0;
let nextIndex = 0;
let totalEnqueued = queue.length;

async function worker() {
  const page = values.video ? null : await context.newPage();
  if (page) await page.setViewportSize(viewport);

  while (nextIndex < queue.length) {
    const idx = nextIndex++;
    const target = queue[idx];
    const pageDir = join(outDir, target.slug);
    const label = crawl ? `[${idx + 1}/${totalEnqueued}+]` : `[${idx + 1}/${queue.length}]`;
    console.log(`${label} ${target.url}${crawl ? ` (depth ${target.depth})` : ""}`);

    // For video: create a fresh context+page per URL so each gets its own recording
    let activePage = page;
    let videoCtx = null;
    if (values.video) {
      const { mkdir: mkdirSync } = await import("node:fs/promises");
      await mkdirSync(pageDir, { recursive: true });
      videoCtx = await browser.newContext({
        viewport,
        recordVideo: { dir: pageDir },
      });
      if (values.auth || values["auth-flow"]) {
        const cookies = await context.cookies();
        if (cookies.length > 0) await videoCtx.addCookies(cookies);
      }
      activePage = await videoCtx.newPage();
    }

    try {
      const meta = await navigateAndCapture(activePage, target.url, pageDir, {
        types,
        networkFilter: values["network-filter"],
        downloadAssets: values["download-assets"],
        sharedAssetsDir,
      });

      if (meta.errors) {
        console.log(`  ⚠ partial: ${Object.keys(meta.errors).join(", ")}`);
      } else {
        console.log(`  ✓ ${Object.keys(meta.captures).length} files`);
      }
      captured++;

      // Crawl: extract links and enqueue new ones
      if (crawl && target.depth < maxDepth && totalEnqueued < maxPages) {
        const links = await extractLinks(activePage);
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

    // Close video context per-page to finalize the recording
    if (videoCtx) {
      const videoPath = await activePage.video()?.path();
      await activePage.close();
      await videoCtx.close();
      // Rename the video file to a consistent name
      if (videoPath) {
        const { rename } = await import("node:fs/promises");
        const destPath = join(pageDir, "video.webm");
        try {
          await rename(videoPath, destPath);
        } catch {
          // video file may not exist if page failed
        }
      }
    }
  }

  if (page && !values["session-video"]) await page.close();
}

// Launch workers up to concurrency limit (or target count if fewer)
const workerCount = Math.min(concurrency, queue.length);
const workers = [];
for (let i = 0; i < workerCount; i++) {
  workers.push(worker());
}
await Promise.all(workers);

// Build site-level asset manifest for multi-page captures
if (sharedAssetsDir) {
  const { readFile: rf } = await import("node:fs/promises");
  const siteManifest = { files: {}, stats: { totalFiles: 0, totalSize: 0, savedBytes: 0 } };
  // Scan per-page manifest files
  for (const target of queue.slice(0, captured + failed)) {
    const pageManifestPath = join(outDir, target.slug, "assets", "manifest.json");
    try {
      const raw = JSON.parse(await rf(pageManifestPath, "utf-8"));
      const pageManifest = raw.deduped ? raw.assets : raw;
      for (const [url, info] of Object.entries(pageManifest)) {
        if (!siteManifest.files[info.file]) {
          siteManifest.files[info.file] = { contentType: info.contentType, size: info.size, urls: [], pages: [] };
          siteManifest.stats.totalFiles++;
          siteManifest.stats.totalSize += info.size;
        }
        const entry = siteManifest.files[info.file];
        if (!entry.urls.includes(url)) entry.urls.push(url);
        if (!entry.pages.includes(target.slug)) {
          // Each additional page referencing this file saves its size
          if (entry.pages.length > 0) siteManifest.stats.savedBytes += info.size;
          entry.pages.push(target.slug);
        }
      }
    } catch { /* page may have failed */ }
  }
  await writeFile(join(sharedAssetsDir, "manifest.json"), JSON.stringify(siteManifest, null, 2));
}

// Finalize session video — get video path before closing context
let sessionVideoSrc = null;
if (values["session-video"]) {
  const pages = context.pages();
  if (pages.length > 0 && pages[0].video()) {
    sessionVideoSrc = await pages[0].video().path();
  }
}

// Cleanup
if (profileContext) {
  if (values["close-after"]) {
    await shutdownChrome(profileContext);
    console.log("Chrome closed.");
  } else {
    await shutdownChrome(profileContext);
    console.log("Chrome closed (persistent contexts cannot stay open after Playwright exits).");
  }
} else if (browser) {
  await browser.close();
}

// Rename session video after context/browser close (video file is finalized)
if (sessionVideoSrc) {
  const destPath = join(outDir, "session-video.webm");
  try {
    await rename(sessionVideoSrc, destPath);
    console.log(`Session video: ${destPath}`);
  } catch {
    // video file may not exist if all pages failed
  }
}

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
