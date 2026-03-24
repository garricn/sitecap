/**
 * SPA Discover — analyze a page for repeating interactive patterns
 * and generate explore YAML.
 */

/**
 * Analyze a page for repeating interactive element patterns.
 * Two-pass: fast scan for candidates, then detailed selector building.
 *
 * @param {object} page - Playwright Page or ExtensionPage
 * @param {object} [opts]
 * @param {number} [opts.minElements] - Minimum children to consider a pattern (default: 3)
 * @returns {Promise<Array>} Scored pattern candidates
 */
export async function discoverPatterns(page, opts = {}) {
  const minElements = opts.minElements || 3;

  // Pass 1: Fast scan — find containers with repeated children
  let rawCandidates;
  try {
    rawCandidates = await page.evaluate((minEls) => {
      try {
      const results = [];
      const seen = new Set();
      const allElements = document.querySelectorAll("*");
      let checked = 0;

      for (const el of allElements) {
        if (++checked > 3000) break;
        const children = Array.from(el.children).filter((c) => {
          const r = c.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && c.tagName !== "SCRIPT" && c.tagName !== "STYLE" && c.tagName !== "BR" && c.tagName !== "HR";
        });
        if (children.length < minEls) continue;

        const tags = children.map((c) => c.tagName);
        const counts = {};
        for (const t of tags) counts[t] = (counts[t] || 0) + 1;
        const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        if (!dominant || dominant[1] < minEls) continue;
        const sameTag = children.filter((c) => c.tagName === dominant[0]);

        const key = sameTag.slice(0, 3).map((c) => c.tagName + String(c.className || "").slice(0, 30)).join("|");
        if (seen.has(key)) continue;
        seen.add(key);

        // Score
        let score = Math.min(sameTag.length, 50);
        const containerTag = el.tagName.toLowerCase();
        let cls = "";
        try { cls = typeof el.className === "string" ? el.className : (el.className.baseVal || ""); } catch { /* SVG or unusual element */ }
        if (containerTag === "nav") score += 15;
        if (el.getAttribute && el.getAttribute("role") === "tablist") score += 15;
        if (/sidebar|menu|nav|step|wizard|tab/i.test(cls)) score += 10;
        if (/list|items|cards|grid/i.test(cls)) score += 5;
        const clickable = sameTag.some((c) =>
          c.tagName === "A" || c.tagName === "BUTTON" ||
          (c.getAttribute && c.getAttribute("role") === "button") ||
          c.classList.contains("pointer") ||
          c.querySelector("a, button")
        );
        if (clickable) score += sameTag.length;
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) score += 5;

        // Collect info for selector building
        const sampleClasses = sameTag.slice(0, 1).map((c) => c.classList ? Array.from(c.classList) : []);
        const parentClasses = el.classList ? Array.from(el.classList) : [];
        const sampleTexts = sameTag.slice(0, 5).map((c) => c.textContent.trim().slice(0, 50));

        results.push({
          count: sameTag.length,
          childTag: dominant[0].toLowerCase(),
          score,
          clickable,
          sampleTexts,
          parentId: el.id || null,
          parentClasses,
          sampleChildClasses: sampleClasses[0] || [],
        });
      }

      return results.sort((a, b) => b.score - a.score).slice(0, 10);
      } catch (e) { return [{ _error: e.message || String(e) }]; }
    }, minElements);
  } catch (e) {
    console.error(`  discover: DOM scan failed (${e.message})`);
    return [];
  }

  // Check for in-browser error
  if (rawCandidates.length === 1 && rawCandidates[0]._error) {
    console.error(`  discover: browser error: ${rawCandidates[0]._error}`);
    return [];
  }

  if (rawCandidates.length === 0) return [];

  // Pass 2: Build selectors for top candidates
  const results = [];
  for (const candidate of rawCandidates.slice(0, 5)) {
    try {
      const selector = await page.evaluate((c) => {
        // Build parent selector
        let parentSel = "";
        if (c.parentId) {
          parentSel = "#" + c.parentId;
        } else {
          const meaningful = c.parentClasses.filter((cls) =>
            !cls.match(/^(flex|w-|h-|p-|m-|text-|bg-|border-|rounded-|shadow-|overflow-|items-|justify-|gap-|grid-|col-|row-)/)
          );
          if (meaningful.length > 0) {
            parentSel = "." + meaningful[0];
          }
        }

        // Build child selector
        const childMeaningful = c.sampleChildClasses.filter((cls) =>
          !cls.match(/^(flex|w-|h-|p-|m-|text-|bg-|border-|rounded-|shadow-|overflow-|items-|justify-|gap-|grid-|col-|row-)/)
        );

        if (childMeaningful.length > 0) {
          const childSel = "." + childMeaningful[0];
          // Verify uniqueness
          const full = parentSel ? parentSel + " " + childSel : childSel;
          const count = document.querySelectorAll(full).length;
          if (count === c.count) return full;
          // Try tag + class
          const tagCls = c.childTag + "." + childMeaningful[0];
          const full2 = parentSel ? parentSel + " " + tagCls : tagCls;
          if (document.querySelectorAll(full2).length === c.count) return full2;
        }

        // Fallback: parent > childTag
        if (parentSel) {
          const fallback = parentSel + " > " + c.childTag;
          if (document.querySelectorAll(fallback).length === c.count) return fallback;
          return parentSel + " " + c.childTag;
        }

        return c.childTag;
      }, candidate);

      results.push({
        ...candidate,
        selector,
      });
    } catch {
      // Skip candidates that fail selector building
    }
  }

  return results;
}

/**
 * Generate explore YAML from discovered patterns.
 *
 * @param {Array} patterns - From discoverPatterns()
 * @param {object} opts
 * @param {string} opts.url - Source URL
 * @param {number} [opts.waitMs] - Wait time between click and capture (default: 2000)
 * @returns {string} YAML content
 */
export function generateExploreYAML(patterns, opts = {}) {
  const url = opts.url || "unknown";
  const waitMs = opts.waitMs || 2000;

  if (patterns.length === 0) {
    return `# sitecap discover — no repeating patterns detected\n# URL: ${url}\n# Try a different page or check that the SPA has fully rendered\n`;
  }

  const lines = [
    "# Auto-generated by sitecap discover",
    `# Source: ${url}`,
    "# Edit before running: sitecap <url> --explore <this-file> --extension -o ./output",
    "",
  ];

  for (let i = 0; i < patterns.length; i++) {
    const p = patterns[i];
    if (p.score < 10) continue;

    lines.push(`# Pattern ${i + 1}: ${p.count} elements matching "${p.selector}" (score: ${p.score})`);
    if (p.sampleTexts.length > 0) {
      lines.push(`# Sample: ${p.sampleTexts.slice(0, 3).join(", ")}`);
    }
    lines.push(`# ${p.clickable ? "Clickable" : "Not clickable"}`);
    if (!p.clickable) {
      lines.push("# Warning: elements may not be interactive — review before running");
    }
    lines.push("");
  }

  // Generate steps for the top pattern
  const top = patterns[0];
  lines.push(`name: explore-${slugify(url)}`);
  lines.push("steps:");
  lines.push("  - wait:");
  lines.push("      ms: 2000");
  lines.push("  - capture: initial");
  lines.push("  - foreach:");
  lines.push(`      selector: "${top.selector}"`);
  lines.push("      steps:");
  lines.push("        - click: $element");
  lines.push("        - wait:");
  lines.push(`            ms: ${waitMs}`);
  lines.push("        - capture: step-{index}");

  // Additional high-scoring patterns as comments
  for (let i = 1; i < patterns.length; i++) {
    const p = patterns[i];
    if (p.score < 10) continue;
    lines.push("");
    lines.push(`# --- Alternative pattern ${i + 1} (uncomment to use) ---`);
    lines.push(`#  - foreach:`);
    lines.push(`#      selector: "${p.selector}"`);
    lines.push("#      steps:");
    lines.push("#        - click: $element");
    lines.push("#        - wait:");
    lines.push(`#            ms: ${waitMs}`);
    lines.push(`#        - capture: alt${i}-{index}`);
  }

  return lines.join("\n") + "\n";
}

function slugify(str) {
  return str
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}
