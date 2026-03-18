/**
 * CMS media source discovery and file download.
 * Orchestrator for MODX and WordPress media adapters.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { Buffer } from "node:buffer";
import { listModxMediaSources } from "./modx.js";
import { collectWpMediaUrls } from "./wordpress.js";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const DOWNLOAD_TIMEOUT = 30_000; // 30 seconds

/**
 * Download a file via authenticated page.evaluate fetch.
 * Returns a Buffer of the file content.
 *
 * @param {import('playwright').Page} page
 * @param {string} url - URL to fetch
 * @returns {Promise<Buffer>}
 */
async function downloadFile(page, url) {
  const result = await page.evaluate(async ({ url: fetchUrl, timeout }) => {
    /* global AbortController */
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const r = await fetch(fetchUrl, { credentials: "include", signal: controller.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const contentType = (r.headers.get("content-type") || "").split(";")[0].trim();
      const b = await r.arrayBuffer();
      return { bytes: [...new Uint8Array(b)], contentType };
    } finally {
      clearTimeout(timer);
    }
  }, { url, timeout: DOWNLOAD_TIMEOUT });
  return { buf: Buffer.from(result.bytes), contentType: result.contentType };
}

/**
 * Collect MODX file references from resource TV fields.
 * Returns array of {url, sourceId, pathname, referencedBy}
 */
function collectModxFileRefs(cmsStructure, sources) {
  const refs = new Map(); // url -> {url, sourceId, pathname, referencedBy[]}
  // Sort by baseUrl length descending for longest-prefix matching
  const sortedSources = [...sources].sort((a, b) => (b.baseUrl || "").length - (a.baseUrl || "").length);

  for (const resource of (cmsStructure.resources || [])) {
    if (!resource.fields) continue;
    for (const [tvName, tvValue] of Object.entries(resource.fields)) {
      if (typeof tvValue !== "string" || !tvValue) continue;
      // Find the longest matching media source baseUrl
      for (const src of sortedSources) {
        if (src.baseUrl && tvValue.startsWith(src.baseUrl)) {
          const pathname = tvValue.slice(src.baseUrl.length);
          const refKey = tvValue;
          const refBy = `resource:${resource.id}:${tvName}`;
          if (refs.has(refKey)) {
            refs.get(refKey).referencedBy.push(refBy);
          } else {
            refs.set(refKey, {
              url: tvValue,
              sourceId: src.id,
              pathname,
              referencedBy: [refBy],
            });
          }
          break;
        }
      }
    }
  }

  return [...refs.values()];
}

/**
 * Download CMS media files and write manifest.
 *
 * @param {import('playwright').Page} page
 * @param {object} cmsStructure - Extracted CMS structure (from extractCmsStructure)
 * @param {object} cmsDetection - CMS detection result (from detectCms)
 * @param {string} outDir - Output directory for the capture
 * @param {object} opts
 * @param {boolean} [opts.downloadMedia] - Enable media download
 * @param {boolean} [opts.downloadAllMedia] - Download all media (not just referenced)
 */
export async function downloadCmsMedia(page, cmsStructure, cmsDetection, outDir, opts = {}) {
  if (!opts.downloadMedia) return;

  const cms = cmsDetection.cms || cmsStructure.cms;
  const manifest = {
    cms,
    timestamp: new Date().toISOString(),
    scope: opts.downloadAllMedia ? "all" : "referenced",
    sources: [],
    files: [],
    stats: { total: 0, downloaded: 0, errors: 0, totalBytes: 0 },
  };

  await mkdir(outDir, { recursive: true });

  if (cms === "modx") {
    await downloadModxMedia(page, cmsStructure, cmsDetection, outDir, opts, manifest);
  } else if (cms === "wordpress") {
    await downloadWpMedia(page, cmsStructure, outDir, manifest);
  }

  // Write manifest
  await writeFile(join(outDir, "cms-media.json"), JSON.stringify(manifest, null, 2));
}

/**
 * MODX media download implementation.
 */
async function downloadModxMedia(page, cmsStructure, cmsDetection, outDir, opts, manifest) {
  const context = cmsDetection.context || {};
  const { siteId, connectorsUrl } = context;
  if (!siteId || !connectorsUrl) {
    manifest.error = "Missing siteId or connectorsUrl — cannot discover MODX media sources";
    return;
  }

  // Resolve connectorsUrl to absolute URL for page.evaluate
  const pageUrl = page.url();
  const resolvedConnectorsUrl = new URL(connectorsUrl, pageUrl).href;

  // Discover media sources
  const sources = await listModxMediaSources(page, resolvedConnectorsUrl, siteId);
  manifest.sources = sources.map(s => ({ id: s.id, name: s.name, basePath: s.basePath, baseUrl: s.baseUrl, fileCount: 0 }));

  // Collect file refs from TV values
  const fileRefs = collectModxFileRefs(cmsStructure, sources);
  manifest.stats.total = fileRefs.length;

  // Download each file
  for (const ref of fileRefs) {
    const localPath = join("cms-media", "modx", String(ref.sourceId), ref.pathname);
    const fullPath = join(outDir, localPath);
    try {
      // Resolve the URL relative to page origin
      const downloadUrl = new URL(ref.url, pageUrl).href;
      const { buf, contentType } = await downloadFile(page, downloadUrl);

      if (buf.length > MAX_FILE_SIZE) {
        manifest.files.push({
          url: ref.url, localPath, mime: contentType, size: buf.length,
          sourceId: ref.sourceId, referencedBy: ref.referencedBy, skipped: "size_limit",
        });
        manifest.stats.errors++;
        continue;
      }

      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, buf);

      manifest.files.push({
        url: ref.url, localPath, mime: contentType, size: buf.length,
        sourceId: ref.sourceId, referencedBy: ref.referencedBy,
      });
      manifest.stats.downloaded++;
      manifest.stats.totalBytes += buf.length;

      // Update source file count
      const srcEntry = manifest.sources.find(s => s.id === ref.sourceId);
      if (srcEntry) srcEntry.fileCount++;
    } catch (e) {
      manifest.files.push({
        url: ref.url, localPath, mime: "", size: 0, error: e.message,
        sourceId: ref.sourceId, referencedBy: ref.referencedBy,
      });
      manifest.stats.errors++;
    }
  }
}

/**
 * WordPress media download implementation.
 */
async function downloadWpMedia(page, cmsStructure, outDir, manifest) {
  const mediaMap = collectWpMediaUrls(cmsStructure);
  manifest.stats.total = mediaMap.size;

  for (const [id, media] of mediaMap) {
    const filename = basename(new URL(media.url).pathname);
    const localFilename = `${id}-${filename}`;
    const localPath = join("cms-media", "wp", localFilename);
    const fullPath = join(outDir, localPath);

    try {
      const { buf } = await downloadFile(page, media.url);

      if (buf.length > MAX_FILE_SIZE) {
        manifest.files.push({
          url: media.url, localPath, mime: media.mime, size: buf.length,
          referencedBy: media.referencedBy, skipped: "size_limit",
        });
        manifest.stats.errors++;
        continue;
      }

      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, buf);

      manifest.files.push({
        url: media.url, localPath, mime: media.mime, size: buf.length,
        referencedBy: media.referencedBy,
      });
      manifest.stats.downloaded++;
      manifest.stats.totalBytes += buf.length;
    } catch (e) {
      manifest.files.push({
        url: media.url, localPath, mime: media.mime, size: 0,
        referencedBy: media.referencedBy, error: e.message,
      });
      manifest.stats.errors++;
    }
  }
}
