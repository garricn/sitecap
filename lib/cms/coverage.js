/**
 * CMS media coverage report — cross-references file-type field refs
 * against downloaded media assets.
 *
 * Pure function, no I/O. Receives parsed JSON objects, returns report object.
 */

const IMAGE_FILE_TV_TYPES = ["image", "file", "migx"];

/**
 * Collect file-type field references from MODX CMS structure.
 * Uses TV type definitions to identify image/file/migx TVs,
 * then scans resource fields for those TV names.
 *
 * @param {object} cmsStructure
 * @returns {Array<{ref: string, url: string}>}
 */
function collectModxRefs(cmsStructure, mediaManifest) {
  const fileTvNames = new Set();
  for (const tv of (cmsStructure.tvs || [])) {
    if (tv.type && IMAGE_FILE_TV_TYPES.includes(tv.type.toLowerCase())) {
      fileTvNames.add(tv.name);
    }
  }

  // Collect source baseUrls for fallback detection
  const sourceBaseUrls = (mediaManifest.sources || [])
    .map(s => s.baseUrl)
    .filter(Boolean);

  const refs = [];
  for (const resource of (cmsStructure.resources || [])) {
    if (!resource.fields) continue;
    for (const [tvName, tvValue] of Object.entries(resource.fields)) {
      if (typeof tvValue !== "string" || !tvValue) continue;
      // Primary: TV type is image/file/migx
      // Fallback: value starts with a known media source baseUrl
      const isFileTv = fileTvNames.has(tvName);
      const matchesSource = !isFileTv && sourceBaseUrls.some(base => tvValue.startsWith(base));
      if (!isFileTv && !matchesSource) continue;
      refs.push({
        ref: `resource:${resource.id}:${tvName}`,
        url: tvValue,
      });
    }
  }

  return refs;
}

/**
 * Collect file-type field references from WordPress CMS structure.
 * Any field value that is an object with `id` and `url` properties
 * is a resolved media reference.
 *
 * @param {object} cmsStructure
 * @returns {Array<{ref: string, url: string}>}
 */
function collectWpRefs(cmsStructure) {
  const refs = [];

  function walkFields(fields, contentType, contentId, prefix = "") {
    if (!fields || typeof fields !== "object") return;
    const entries = Array.isArray(fields)
      ? fields.map((v, i) => [String(i), v])
      : Object.entries(fields);
    for (const [key, val] of entries) {
      const fieldPath = prefix ? `${prefix}.${key}` : key;
      if (val && typeof val === "object" && !Array.isArray(val) &&
          typeof val.id === "number" && typeof val.url === "string") {
        refs.push({
          ref: `${contentType}:${contentId}:${fieldPath}`,
          url: val.url,
        });
      } else if (val && typeof val === "object") {
        // Recurse into nested objects/arrays (ACF groups, repeaters)
        walkFields(val, contentType, contentId, fieldPath);
      }
    }
  }

  for (const post of (cmsStructure.posts || [])) {
    const type = post.type || "post";
    walkFields(post.fields, type, post.id);
  }

  for (const pg of (cmsStructure.pages || [])) {
    walkFields(pg.fields, "page", pg.id);
  }

  return refs;
}

/**
 * Generate a media coverage report by cross-referencing CMS file-type
 * field values against the downloaded media manifest.
 *
 * @param {object} cmsStructure - Parsed CMS structure (from cms.json)
 * @param {object} mediaManifest - Parsed media manifest (from cms-media.json)
 * @returns {object} Coverage report
 */
export function generateMediaCoverage(cmsStructure, mediaManifest) {
  const cms = cmsStructure.cms;

  // Collect all file-type field references based on CMS type
  const fileRefs = cms === "modx"
    ? collectModxRefs(cmsStructure, mediaManifest)
    : cms === "wordpress"
      ? collectWpRefs(cmsStructure)
      : [];

  // Build URL lookup from manifest files
  const filesByUrl = new Map();
  for (const file of (mediaManifest.files || [])) {
    filesByUrl.set(file.url, file);
  }

  // Cross-reference each field ref against manifest
  const items = [];
  let withLocalCopy = 0;
  let withError = 0;
  let missing = 0;

  for (const { ref, url } of fileRefs) {
    const manifestEntry = filesByUrl.get(url);

    if (!manifestEntry) {
      items.push({ ref, url, status: "missing", reason: "no matching download" });
      missing++;
    } else if (manifestEntry.error) {
      items.push({ ref, url, status: "error", error: manifestEntry.error });
      withError++;
    } else if (manifestEntry.localPath && !manifestEntry.skipped) {
      items.push({ ref, url, status: "downloaded", localPath: manifestEntry.localPath });
      withLocalCopy++;
    } else if (manifestEntry.skipped) {
      items.push({ ref, url, status: "skipped", reason: manifestEntry.skipped });
      missing++; // skipped counts as not having a local copy
    } else {
      items.push({ ref, url, status: "missing", reason: "no matching download" });
      missing++;
    }
  }

  const totalFileFields = fileRefs.length;
  const coveragePercent = totalFileFields === 0
    ? 100
    : Math.round((withLocalCopy / totalFileFields) * 1000) / 10;

  return {
    cms,
    timestamp: new Date().toISOString(),
    summary: {
      totalFileFields,
      withLocalCopy,
      withError,
      missing,
      coveragePercent,
    },
    items,
  };
}
