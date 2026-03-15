import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

/**
 * Diff two capture directories and return a structured report.
 *
 * @param {string} dirA - Path to first capture directory
 * @param {string} dirB - Path to second capture directory
 * @param {object} [opts]
 * @param {number} [opts.threshold] - Screenshot diff threshold as % (default: 0.1)
 * @param {string[]} [opts.types] - Which capture types to diff
 * @returns {Promise<object>} Diff report
 */
export async function diffCaptures(dirA, dirB, opts = {}) {
  const threshold = opts.threshold ?? 0.1;
  const types = new Set(
    opts.types ?? ["screenshot", "accessibility", "console", "network", "storage"]
  );

  const diffs = {};

  if (types.has("screenshot")) {
    diffs.screenshot = await diffScreenshots(dirA, dirB, threshold);
  }
  if (types.has("accessibility")) {
    diffs.accessibility = await diffText(dirA, dirB, "accessibility.txt");
  }
  if (types.has("console")) {
    diffs.console = await diffConsole(dirA, dirB);
  }
  if (types.has("network")) {
    diffs.network = await diffNetwork(dirA, dirB);
  }
  if (types.has("storage")) {
    diffs.storage = await diffStorage(dirA, dirB);
  }

  const changedCount = Object.values(diffs).filter((d) => d.changed).length;
  const identicalCount = Object.values(diffs).filter((d) => !d.changed && !d.error).length;

  return {
    dirA,
    dirB,
    identical: changedCount === 0,
    changed: changedCount,
    identicalCount,
    diffs,
  };
}

async function readFileOrNull(path) {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

async function diffScreenshots(dirA, dirB, threshold) {
  const fileA = join(dirA, "screenshot.png");
  const fileB = join(dirB, "screenshot.png");

  const [bufA, bufB] = await Promise.all([readFileOrNull(fileA), readFileOrNull(fileB)]);

  if (!bufA && !bufB) return { changed: false, note: "no screenshots in either directory" };
  if (!bufA) return { changed: true, error: "screenshot missing in dir A" };
  if (!bufB) return { changed: true, error: "screenshot missing in dir B" };

  const imgA = PNG.sync.read(bufA);
  const imgB = PNG.sync.read(bufB);

  if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
    return {
      changed: true,
      reason: "dimensions differ",
      dimA: `${imgA.width}x${imgA.height}`,
      dimB: `${imgB.width}x${imgB.height}`,
    };
  }

  const { width, height } = imgA;
  const diff = new PNG({ width, height });
  const numDiffPixels = pixelmatch(imgA.data, imgB.data, diff.data, width, height, {
    threshold: 0.1,
  });
  const diffPercent = (numDiffPixels / (width * height)) * 100;
  const changed = diffPercent > threshold;

  if (changed) {
    const diffPath = join(dirA, "screenshot-diff.png");
    await writeFile(diffPath, PNG.sync.write(diff));
    return { changed: true, diffPercent: +diffPercent.toFixed(3), threshold, diffImage: diffPath };
  }

  return { changed: false, diffPercent: +diffPercent.toFixed(3) };
}

async function diffText(dirA, dirB, filename) {
  const [textA, textB] = await Promise.all([
    readFileOrNull(join(dirA, filename)),
    readFileOrNull(join(dirB, filename)),
  ]);

  if (!textA && !textB) return { changed: false };
  if (!textA) return { changed: true, error: `${filename} missing in dir A` };
  if (!textB) return { changed: true, error: `${filename} missing in dir B` };

  const linesA = textA.toString().split("\n");
  const linesB = textB.toString().split("\n");
  const setA = new Set(linesA);
  const setB = new Set(linesB);

  const added = linesB.filter((l) => !setA.has(l) && l.trim());
  const removed = linesA.filter((l) => !setB.has(l) && l.trim());

  return {
    changed: added.length > 0 || removed.length > 0,
    added: added.length > 0 ? added : undefined,
    removed: removed.length > 0 ? removed : undefined,
  };
}

async function diffConsole(dirA, dirB) {
  const [bufA, bufB] = await Promise.all([
    readFileOrNull(join(dirA, "console.json")),
    readFileOrNull(join(dirB, "console.json")),
  ]);

  if (!bufA && !bufB) return { changed: false };
  if (!bufA) return { changed: true, error: "console.json missing in dir A" };
  if (!bufB) return { changed: true, error: "console.json missing in dir B" };

  const consoleA = JSON.parse(bufA.toString());
  const consoleB = JSON.parse(bufB.toString());

  // Only diff error-type messages
  const errorsA = new Set(consoleA.filter((e) => e.type === "error").map((e) => e.text));
  const errorsB = new Set(consoleB.filter((e) => e.type === "error").map((e) => e.text));

  const added = [...errorsB].filter((e) => !errorsA.has(e));
  const removed = [...errorsA].filter((e) => !errorsB.has(e));

  return {
    changed: added.length > 0 || removed.length > 0,
    added: added.length > 0 ? added : undefined,
    removed: removed.length > 0 ? removed : undefined,
  };
}

async function diffNetwork(dirA, dirB) {
  const [bufA, bufB] = await Promise.all([
    readFileOrNull(join(dirA, "network.json")),
    readFileOrNull(join(dirB, "network.json")),
  ]);

  if (!bufA && !bufB) return { changed: false };
  if (!bufA) return { changed: true, error: "network.json missing in dir A" };
  if (!bufB) return { changed: true, error: "network.json missing in dir B" };

  const netA = JSON.parse(bufA.toString());
  const netB = JSON.parse(bufB.toString());

  // Key by method + URL, value is status
  const mapA = new Map(netA.map((e) => [`${e.method} ${e.url}`, e.status]));
  const mapB = new Map(netB.map((e) => [`${e.method} ${e.url}`, e.status]));

  const added = [];
  const removed = [];
  const statusChanged = [];

  for (const [key, status] of mapB) {
    if (!mapA.has(key)) {
      added.push({ request: key, status });
    } else if (mapA.get(key) !== status) {
      statusChanged.push({ request: key, was: mapA.get(key), now: status });
    }
  }
  for (const [key, status] of mapA) {
    if (!mapB.has(key)) {
      removed.push({ request: key, status });
    }
  }

  return {
    changed: added.length > 0 || removed.length > 0 || statusChanged.length > 0,
    added: added.length > 0 ? added : undefined,
    removed: removed.length > 0 ? removed : undefined,
    statusChanged: statusChanged.length > 0 ? statusChanged : undefined,
  };
}

async function diffStorage(dirA, dirB) {
  const [bufA, bufB] = await Promise.all([
    readFileOrNull(join(dirA, "storage.json")),
    readFileOrNull(join(dirB, "storage.json")),
  ]);

  if (!bufA && !bufB) return { changed: false };
  if (!bufA) return { changed: true, error: "storage.json missing in dir A" };
  if (!bufB) return { changed: true, error: "storage.json missing in dir B" };

  const storA = JSON.parse(bufA.toString());
  const storB = JSON.parse(bufB.toString());

  const result = { changed: false };

  // Diff cookies by name
  const cookieNamesA = new Set((storA.cookies || []).map((c) => c.name));
  const cookieNamesB = new Set((storB.cookies || []).map((c) => c.name));
  const cookiesAdded = [...cookieNamesB].filter((n) => !cookieNamesA.has(n));
  const cookiesRemoved = [...cookieNamesA].filter((n) => !cookieNamesB.has(n));

  if (cookiesAdded.length || cookiesRemoved.length) {
    result.changed = true;
    result.cookies = {
      added: cookiesAdded.length > 0 ? cookiesAdded : undefined,
      removed: cookiesRemoved.length > 0 ? cookiesRemoved : undefined,
    };
  }

  // Diff localStorage keys
  const lsKeysA = new Set(Object.keys(storA.localStorage || {}));
  const lsKeysB = new Set(Object.keys(storB.localStorage || {}));
  const lsAdded = [...lsKeysB].filter((k) => !lsKeysA.has(k));
  const lsRemoved = [...lsKeysA].filter((k) => !lsKeysB.has(k));

  if (lsAdded.length || lsRemoved.length) {
    result.changed = true;
    result.localStorage = {
      added: lsAdded.length > 0 ? lsAdded : undefined,
      removed: lsRemoved.length > 0 ? lsRemoved : undefined,
    };
  }

  return result;
}

/**
 * Format diff report for terminal output.
 */
export function formatDiffReport(report) {
  const lines = [`sitecap diff ${report.dirA} ${report.dirB}`, ""];

  for (const [type, diff] of Object.entries(report.diffs)) {
    if (diff.error) {
      lines.push(`  ${type.padEnd(15)} ⚠ ${diff.error}`);
    } else if (!diff.changed) {
      lines.push(`  ${type.padEnd(15)} ✓ identical`);
    } else if (type === "screenshot") {
      if (diff.reason === "dimensions differ") {
        lines.push(`  ${type.padEnd(15)} ✗ dimensions differ: ${diff.dimA} vs ${diff.dimB}`);
      } else {
        lines.push(`  ${type.padEnd(15)} ✗ ${diff.diffPercent}% pixels changed (threshold: ${diff.threshold}%)`);
        if (diff.diffImage) lines.push(`  ${"".padEnd(15)}   → ${diff.diffImage}`);
      }
    } else {
      const parts = [];
      if (diff.added) parts.push(`${diff.added.length} added`);
      if (diff.removed) parts.push(`${diff.removed.length} removed`);
      if (diff.statusChanged) parts.push(`${diff.statusChanged.length} status changed`);
      if (diff.cookies) {
        if (diff.cookies.added) parts.push(`${diff.cookies.added.length} cookies added`);
        if (diff.cookies.removed) parts.push(`${diff.cookies.removed.length} cookies removed`);
      }
      if (diff.localStorage) {
        if (diff.localStorage.added) parts.push(`${diff.localStorage.added.length} localStorage keys added`);
        if (diff.localStorage.removed) parts.push(`${diff.localStorage.removed.length} localStorage keys removed`);
      }
      lines.push(`  ${type.padEnd(15)} ✗ ${parts.join(", ")}`);
    }
  }

  lines.push("");
  lines.push(`  ${report.changed} changed, ${report.identicalCount} identical`);
  return lines.join("\n");
}
