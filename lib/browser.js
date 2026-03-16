/**
 * Shared browser lifecycle — extracted from bin/mcp-server.js and bin/api-server.js.
 */

import { chromium } from "playwright";

export async function createBrowser() {
  return chromium.launch({ headless: true });
}


export async function createCaptureSession(browser, viewport, opts = {}) {
  const contextOpts = { viewport };
  if (opts.video && opts.videoDir) {
    contextOpts.recordVideo = { dir: opts.videoDir };
  }
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  return { context, page, hasVideo: !!(opts.video && opts.videoDir), videoDir: opts.videoDir };
}

export async function closeCaptureSession(session) {
  const { page, context, hasVideo, videoDir } = session;
  let videoPath = null;

  if (hasVideo) {
    const rawPath = await page.video()?.path();
    await page.close();
    await context.close();
    if (rawPath && videoDir) {
      const { rename } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const dest = join(videoDir, "session-video.webm");
      try {
        await rename(rawPath, dest);
        videoPath = dest;
      } catch {
        // video file may not exist if all pages failed
      }
    }
  } else {
    await page.close();
    await context.close();
  }

  return { videoPath };
}

export function parseViewport(str) {
  const m = str.match(/^(\d+)x(\d+)$/);
  if (!m) return { width: 1280, height: 720 };
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}
