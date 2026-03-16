/**
 * Shared browser lifecycle — extracted from bin/mcp-server.js and bin/api-server.js.
 */

import { chromium } from "playwright";

export async function createBrowser() {
  return chromium.launch({ headless: true });
}

export async function createCaptureContext(browser, viewport) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  return { context, page };
}

export async function cleanupPage(page, context) {
  await page.close();
  await context.close();
}

export function parseViewport(str) {
  const m = str.match(/^(\d+)x(\d+)$/);
  if (!m) return { width: 1280, height: 720 };
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}
