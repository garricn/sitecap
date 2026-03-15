#!/usr/bin/env node

import { createServer } from "node:http";
import { resolve, join } from "node:path";
import { Buffer } from "node:buffer";
import { chromium } from "playwright";
import { navigateAndCapture, extractLinks } from "../lib/capture.js";
import { diffCaptures } from "../lib/diff.js";

const PORT = parseInt(process.env.SITECAP_PORT || "3100", 10);

let browser = null;

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
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

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href.replace(/\/+$/, "");
  } catch {
    return url;
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

function respond(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/capture") {
      const body = await readBody(req);
      const { url, output = "/tmp/sitecap-api", types, viewport = "1280x720" } = body;

      if (!url) return respond(res, 400, { error: "url is required" });

      const outDir = resolve(output);
      const slug = slugify(url);
      const pageDir = join(outDir, slug);

      const vpm = viewport.match(/^(\d+)x(\d+)$/);
      const vp = vpm ? { width: parseInt(vpm[1], 10), height: parseInt(vpm[2], 10) } : { width: 1280, height: 720 };
      const typeList = types ? types.split(",").map((s) => s.trim()) : undefined;

      const b = await getBrowser();
      const context = await b.newContext();
      const page = await context.newPage();
      await page.setViewportSize(vp);

      const meta = await navigateAndCapture(page, url, pageDir, { types: typeList });

      await page.close();
      await context.close();

      respond(res, 200, { ok: true, pageDir, meta });

    } else if (req.method === "POST" && req.url === "/diff") {
      const body = await readBody(req);
      const { dirA, dirB, threshold } = body;

      if (!dirA || !dirB) return respond(res, 400, { error: "dirA and dirB are required" });

      const report = await diffCaptures(resolve(dirA), resolve(dirB), { threshold });
      respond(res, 200, report);

    } else if (req.method === "POST" && req.url === "/crawl") {
      const body = await readBody(req);
      const { url, output = "/tmp/sitecap-api", maxDepth = 3, maxPages = 50, filter, exclude } = body;

      if (!url) return respond(res, 400, { error: "url is required" });

      const outDir = resolve(output);
      const filterRe = filter ? new RegExp(filter) : null;
      const excludeRe = exclude ? new RegExp(exclude) : null;

      const b = await getBrowser();
      const context = await b.newContext();
      const page = await context.newPage();
      await page.setViewportSize({ width: 1280, height: 720 });

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

      await page.close();
      await context.close();

      respond(res, 200, { ok: true, captured, failed, totalFound: queue.length, outDir });

    } else if (req.method === "GET" && req.url === "/health") {
      respond(res, 200, { ok: true, version: "0.6.0" });

    } else {
      respond(res, 404, { error: "Not found. Endpoints: POST /capture, POST /diff, POST /crawl, GET /health" });
    }
  } catch (e) {
    respond(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`sitecap API server listening on http://localhost:${PORT}`);
  console.log("Endpoints: POST /capture, POST /diff, POST /crawl, GET /health");
});

process.on("SIGINT", async () => {
  if (browser) await browser.close();
  process.exit(0);
});
