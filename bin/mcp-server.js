#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve, join } from "node:path";
import { chromium } from "playwright";
import { navigateAndCapture, extractLinks } from "../lib/capture.js";
import { diffCaptures, formatDiffReport } from "../lib/diff.js";
import { readFile } from "node:fs/promises";

const server = new McpServer({
  name: "sitecap",
  version: "0.6.0",
});

server.tool(
  "capture",
  "Capture a web page — screenshot, accessibility tree, HTML, network, console, storage, performance",
  {
    url: z.string().describe("URL to capture"),
    output: z.string().optional().describe("Output directory (default: /tmp/sitecap-mcp)"),
    types: z.string().optional().describe("Comma-separated capture types"),
    viewport: z.string().optional().describe("Viewport WxH (default: 1280x720)"),
  },
  async ({ url, output, types, viewport }) => {
    const outDir = resolve(output || "/tmp/sitecap-mcp");
    const slug = slugify(url);
    const pageDir = join(outDir, slug);

    const vp = parseViewport(viewport || "1280x720");
    const typeList = types ? types.split(",").map((s) => s.trim()) : undefined;

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setViewportSize(vp);

    const meta = await navigateAndCapture(page, url, pageDir, { types: typeList });

    await page.close();
    await browser.close();

    const summary = [`Captured ${url} → ${pageDir}`];
    summary.push(`Files: ${Object.keys(meta.captures).join(", ")}`);
    if (meta.errors) {
      summary.push(`Errors: ${Object.keys(meta.errors).join(", ")}`);
    }

    return { content: [{ type: "text", text: summary.join("\n") }] };
  }
);

server.tool(
  "diff",
  "Compare two sitecap capture directories",
  {
    dirA: z.string().describe("Path to first capture directory"),
    dirB: z.string().describe("Path to second capture directory"),
    threshold: z.number().optional().describe("Screenshot diff threshold % (default: 0.1)"),
  },
  async ({ dirA, dirB, threshold }) => {
    const report = await diffCaptures(resolve(dirA), resolve(dirB), { threshold });
    return { content: [{ type: "text", text: formatDiffReport(report) }] };
  }
);

server.tool(
  "crawl",
  "Crawl a site and capture all same-origin pages",
  {
    url: z.string().describe("Seed URL to crawl from"),
    output: z.string().optional().describe("Output directory (default: /tmp/sitecap-mcp)"),
    maxDepth: z.number().optional().describe("Max crawl depth (default: 3)"),
    maxPages: z.number().optional().describe("Max pages to capture (default: 50)"),
    filter: z.string().optional().describe("Regex to include URLs"),
    exclude: z.string().optional().describe("Regex to exclude URLs"),
  },
  async ({ url, output, maxDepth = 3, maxPages = 50, filter, exclude }) => {
    const outDir = resolve(output || "/tmp/sitecap-mcp");
    const filterRe = filter ? new RegExp(filter) : null;
    const excludeRe = exclude ? new RegExp(exclude) : null;

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();

    const queue = [{ url, slug: slugify(url), depth: 0 }];
    const visited = new Set([normalizeUrl(url)]);
    let captured = 0;
    let failed = 0;

    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 720 });

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

    await page.close();
    await browser.close();

    return {
      content: [{
        type: "text",
        text: `Crawled ${url}: ${captured} captured, ${failed} failed, ${queue.length} total pages found`,
      }],
    };
  }
);

server.tool(
  "read-capture",
  "Read a specific file from a sitecap capture directory",
  {
    path: z.string().describe("Path to the capture file (e.g., /tmp/sitecap-mcp/example.com/accessibility.txt)"),
  },
  async ({ path }) => {
    const content = await readFile(resolve(path), "utf-8");
    return { content: [{ type: "text", text: content }] };
  }
);

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

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href.replace(/\/+$/, "");
  } catch {
    return url;
  }
}

function parseViewport(str) {
  const m = str.match(/^(\d+)x(\d+)$/);
  if (!m) return { width: 1280, height: 720 };
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

const transport = new StdioServerTransport();
await server.connect(transport);
