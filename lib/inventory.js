/**
 * SPA-Aware Recursive Inventory — combines crawl + discover into a
 * recursive exploration engine for SPA dashboards.
 */

import { discoverPatterns } from "./discover.js";
import { extractLinks, waitForPageSettle } from "./capture.js";
import { normalizeUrl } from "./url.js";

/**
 * Recursively inventory a site starting from a root URL.
 *
 * @param {object} page - Playwright Page or ExtensionPage
 * @param {string} rootUrl - Starting URL
 * @param {object} [opts]
 * @param {number} [opts.maxDepth] - Max recursion depth (default: 2)
 * @param {number} [opts.maxPages] - Max pages to visit (default: 100)
 * @param {number} [opts.minElements] - Min elements for pattern detection (default: 3)
 * @param {number} [opts.settleTimeout] - Max settle wait ms
 * @param {string} [opts.waitForText] - Wait for text before analyzing
 * @param {Function} [opts.log] - Log function (default: console.error)
 * @returns {Promise<object>} Inventory JSON
 */
export async function buildInventory(page, rootUrl, opts = {}) {
  const maxDepth = opts.maxDepth ?? 2;
  const maxPages = opts.maxPages ?? 100;
  const log = opts.log || ((...a) => console.error(...a));

  const visited = new Set();
  const pages = [];

  async function settlePage() {
    if (opts.waitForText) {
      await page.waitForFunction(
        (text) => document.body && document.body.innerText.includes(text),
        opts.waitForText,
        { timeout: opts.settleTimeout || 10_000 },
      ).catch(() => {});
    }
    await waitForPageSettle(page, { maxTimeout: opts.settleTimeout }).catch(() => {});
  }

  async function inventoryPage(url, depth) {
    const norm = normalizeUrl(url);
    if (visited.has(norm)) return;
    if (visited.size >= maxPages) return;
    if (depth > maxDepth) return;
    visited.add(norm);

    log(`  [depth ${depth}] ${url}`);

    // Navigate
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() =>
        page.goto(url)
      );
    } catch (e) {
      log(`    ✗ navigation failed: ${e.message}`);
      return;
    }

    await settlePage();

    // Get current URL (may have redirected)
    let currentUrl;
    try {
      currentUrl = await page.evaluate(() => window.location.href);
    } catch {
      currentUrl = url;
    }

    // Discover DOM patterns
    const patterns = await discoverPatterns(page, { minElements: opts.minElements });

    // Extract traditional links
    let links = [];
    try {
      links = await extractLinks(page);
    } catch { /* extension mode may not support all link extraction */ }

    // Classify patterns: click first element, check if URL changes
    const classifiedPatterns = [];
    for (const pattern of patterns.slice(0, 5)) {
      if (pattern.score < 10) continue;

      let type = "panel"; // default: assume content swap
      let children = [];

      if (pattern.clickable && pattern.count > 0) {
        try {
          // Click first element to probe
          const loc = page.locator(pattern.selector).first();
          await loc.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
          await loc.click();
          await new Promise((r) => setTimeout(r, 2000));

          const newUrl = await page.evaluate(() => window.location.href);
          if (newUrl !== currentUrl && !newUrl.includes("#")) {
            type = "navigation";
            children.push(newUrl);

            // Click a second element to get another child URL
            await page.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() =>
              page.goto(currentUrl)
            );
            await settlePage();

            if (pattern.count > 1) {
              try {
                const second = page.locator(pattern.selector);
                const all = await second.all();
                if (all.length > 1) {
                  await all[1].waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
                  await all[1].click();
                  await new Promise((r) => setTimeout(r, 2000));
                  const secondUrl = await page.evaluate(() => window.location.href);
                  if (secondUrl !== currentUrl && secondUrl !== children[0]) {
                    children.push(secondUrl);
                  }
                }
              } catch { /* second probe failed */ }

              // Navigate back for next pattern
              await page.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() =>
                page.goto(currentUrl)
              );
              await settlePage();
            }
          } else {
            // URL didn't change — panel swap, navigate back
            await page.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() =>
              page.goto(currentUrl)
            );
            await settlePage();
          }
        } catch {
          // Probe failed — classify as panel
        }
      }

      classifiedPatterns.push({
        selector: pattern.selector,
        count: pattern.count,
        type,
        score: pattern.score,
        clickable: pattern.clickable,
        sample: pattern.sampleTexts.slice(0, 3),
        children,
      });
    }

    // Capture estimate: 1 base + sum of foreach counts for panel patterns
    let captureEstimate = 1; // base page capture
    for (const p of classifiedPatterns) {
      if (p.type === "panel") captureEstimate += p.count;
    }

    const pageEntry = {
      url: currentUrl,
      depth,
      patterns: classifiedPatterns,
      links: links.slice(0, 50),
      captureEstimate,
    };
    pages.push(pageEntry);

    log(`    ${classifiedPatterns.length} patterns, ${links.length} links, ~${captureEstimate} captures`);

    // Recurse into navigation pattern children
    for (const pattern of classifiedPatterns) {
      if (pattern.type === "navigation") {
        for (const childUrl of pattern.children) {
          await inventoryPage(childUrl, depth + 1);
        }
      }
    }

    // Recurse into same-origin links (limited)
    const rootOrigin = new URL(rootUrl).origin;
    for (const link of links.slice(0, 10)) {
      try {
        if (new URL(link).origin === rootOrigin) {
          await inventoryPage(link, depth + 1);
        }
      } catch { /* invalid URL */ }
    }
  }

  await inventoryPage(rootUrl, 0);

  // Build summary
  const totalPatterns = pages.reduce((sum, p) => sum + p.patterns.length, 0);
  const estimatedCaptures = pages.reduce((sum, p) => sum + p.captureEstimate, 0);

  return {
    root: rootUrl,
    discovered: new Date().toISOString(),
    pages,
    summary: {
      totalPages: pages.length,
      totalPatterns,
      estimatedCaptures,
      estimatedFiles: estimatedCaptures * 8,
      maxDepth,
    },
  };
}

/**
 * Generate a combined explore YAML from an inventory.
 *
 * @param {object} inventory - From buildInventory()
 * @returns {string} YAML content
 */
export function generateInventoryYAML(inventory) {
  const lines = [
    "# Auto-generated by sitecap inventory",
    `# Root: ${inventory.root}`,
    `# Pages: ${inventory.summary.totalPages}, Patterns: ${inventory.summary.totalPatterns}`,
    `# Estimated: ${inventory.summary.estimatedCaptures} captures, ${inventory.summary.estimatedFiles} files`,
    "",
    `name: inventory-${inventory.root.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 40)}`,
    "steps:",
  ];

  for (const page of inventory.pages) {
    const slug = page.url.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 50);
    lines.push(`  # --- ${page.url} (depth ${page.depth}) ---`);
    lines.push(`  - goto: ${page.url}`);
    lines.push("  - wait:");
    lines.push("      ms: 3000");
    lines.push(`  - capture: ${slug}`);

    for (const pattern of page.patterns) {
      if (pattern.type === "panel" && pattern.score >= 10) {
        lines.push(`  # ${pattern.count} elements: "${pattern.selector}"`);
        lines.push("  - foreach:");
        lines.push(`      selector: "${pattern.selector}"`);
        if (pattern.count > 5) {
          lines.push("      parallel: true");
        }
        lines.push("      steps:");
        lines.push("        - click: $element");
        lines.push("        - wait:");
        lines.push("            ms: 2000");
        lines.push(`        - capture: ${slug}-{index}`);
      }
    }

    lines.push("");
  }

  return lines.join("\n") + "\n";
}
