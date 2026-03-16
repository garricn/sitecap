/**
 * Schema-driven operation definitions — single source of truth for all API surfaces.
 */

import { z } from "zod";
import { resolve, join } from "node:path";
import { readFile } from "node:fs/promises";
import { navigateAndCapture, extractLinks } from "./capture.js";
import { diffCaptures, formatDiffReport } from "./diff.js";
import { slugify, normalizeUrl } from "./url.js";
import { createBrowser, createCaptureContext, cleanupPage, parseViewport } from "./browser.js";

function defineOp({ name, description, type, input, handler }) {
  return { name, description, type, input, handler };
}

export const captureOp = defineOp({
  name: "capture",
  description: "Capture a web page — screenshot, accessibility tree, HTML, network, console, storage, performance",
  type: "mutation",
  input: z.object({
    url: z.string().describe("URL to capture"),
    output: z.string().optional().default("/tmp/sitecap").describe("Output directory"),
    types: z.string().optional().describe("Comma-separated capture types"),
    viewport: z.string().optional().default("1280x720").describe("Viewport WxH"),
  }),
  handler: async ({ url, output, types, viewport }) => {
    const outDir = resolve(output);
    const slug = slugify(url);
    const pageDir = join(outDir, slug);

    const vp = parseViewport(viewport);
    const typeList = types ? types.split(",").map((s) => s.trim()) : undefined;

    const browser = await createBrowser();
    const { context, page } = await createCaptureContext(browser, vp);

    const meta = await navigateAndCapture(page, url, pageDir, { types: typeList });

    await cleanupPage(page, context);
    await browser.close();

    return { pageDir, meta };
  },
});

export const diffOp = defineOp({
  name: "diff",
  description: "Compare two sitecap capture directories",
  type: "query",
  input: z.object({
    dirA: z.string().describe("Path to first capture directory"),
    dirB: z.string().describe("Path to second capture directory"),
    threshold: z.number().optional().describe("Screenshot diff threshold % (default: 0.1)"),
  }),
  handler: async ({ dirA, dirB, threshold }) => {
    const report = await diffCaptures(resolve(dirA), resolve(dirB), { threshold });
    return { report, summary: formatDiffReport(report) };
  },
});

export const crawlOp = defineOp({
  name: "crawl",
  description: "Crawl a site and capture all same-origin pages",
  type: "mutation",
  input: z.object({
    url: z.string().describe("Seed URL to crawl from"),
    output: z.string().optional().default("/tmp/sitecap").describe("Output directory"),
    maxDepth: z.number().optional().default(3).describe("Max crawl depth"),
    maxPages: z.number().optional().default(50).describe("Max pages to capture"),
    filter: z.string().optional().describe("Regex to include URLs"),
    exclude: z.string().optional().describe("Regex to exclude URLs"),
  }),
  handler: async ({ url, output, maxDepth, maxPages, filter, exclude }) => {
    const outDir = resolve(output);
    const filterRe = filter ? new RegExp(filter) : null;
    const excludeRe = exclude ? new RegExp(exclude) : null;

    const browser = await createBrowser();
    const { context, page } = await createCaptureContext(browser, { width: 1280, height: 720 });

    const queue = [{ url, slug: slugify(url), depth: 0 }];
    const visited = new Set([normalizeUrl(url)]);
    let captured = 0;
    let failed = 0;

    let idx = 0;
    while (idx < queue.length && idx < maxPages) {
      const target = queue[idx++];
      const pageDir = join(outDir, target.slug);

      try {
        await navigateAndCapture(page, target.url, pageDir, {});
        captured++;

        if (target.depth < maxDepth && queue.length < maxPages) {
          const links = await extractLinks(page);
          for (const link of links) {
            if (queue.length >= maxPages) break;
            const norm = normalizeUrl(link);
            if (visited.has(norm)) continue;
            if (filterRe && !filterRe.test(link)) continue;
            if (excludeRe && excludeRe.test(link)) continue;
            visited.add(norm);
            queue.push({ url: link, slug: slugify(link), depth: target.depth + 1 });
          }
        }
      } catch {
        failed++;
      }
    }

    await cleanupPage(page, context);
    await browser.close();

    return { captured, failed, totalFound: queue.length, outDir };
  },
});

export const readCaptureOp = defineOp({
  name: "read_capture",
  description: "Read a specific file from a sitecap capture directory",
  type: "query",
  input: z.object({
    path: z.string().describe("Path to the capture file"),
  }),
  handler: async ({ path: filePath }) => {
    const resolved = resolve(filePath);
    if (!resolved.startsWith("/tmp/sitecap")) {
      throw new Error("Path must be under /tmp/sitecap*");
    }
    const content = await readFile(resolved, "utf-8");
    return { content };
  },
});
