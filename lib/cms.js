/**
 * CMS auto-detection — identifies WordPress, MODX, Drupal from page context + network.
 */

const wordpressDetector = {
  name: "wordpress",
  detect: async (page, network) => {
    const indicators = [];
    let version = null;
    let admin = false;

    // JS globals
    const globals = await page.evaluate(() => ({
      wp: typeof window.wp !== "undefined",
      wpApiSettings: typeof window.wpApiSettings !== "undefined",
      heartbeat: typeof window.wp !== "undefined" && typeof window.wp.heartbeat !== "undefined",
    }));

    if (globals.wp) indicators.push({ type: "js-global", key: "window.wp", value: true });
    if (globals.wpApiSettings) indicators.push({ type: "js-global", key: "window.wpApiSettings", value: true });
    if (globals.heartbeat) admin = true;

    // Meta generator tag
    const generator = await page.evaluate(() => {
      const meta = document.querySelector('meta[name="generator"]');
      return meta ? meta.getAttribute("content") : null;
    });

    if (generator && /wordpress/i.test(generator)) {
      indicators.push({ type: "meta-tag", content: generator });
      const vMatch = generator.match(/WordPress\s+([\d.]+)/i);
      if (vMatch) version = vMatch[1];
    }

    // Network signals
    for (const req of network) {
      if (/\/wp-json\//i.test(req.url)) {
        indicators.push({ type: "network", url: req.url });
        break;
      }
    }
    for (const req of network) {
      if (/\/wp-admin\//i.test(req.url)) {
        admin = true;
        break;
      }
    }

    // HTML patterns
    const wpContent = await page.evaluate(() => {
      const el = document.querySelector('link[href*="wp-content/"], script[src*="wp-content/"]');
      return !!el;
    });
    if (wpContent) indicators.push({ type: "html-pattern", pattern: "wp-content/" });

    return { detected: indicators.length > 0, version, indicators, admin };
  },
};

const modxDetector = {
  name: "modx",
  detect: async (page, network) => {
    const indicators = [];
    let version = null;
    let admin = false;

    // JS globals
    const globals = await page.evaluate(() => ({
      MODx: typeof window.MODx !== "undefined",
      hasConfig: typeof window.MODx !== "undefined" && typeof window.MODx.config !== "undefined",
      hasAuthToken: typeof window.MODx !== "undefined" && window.MODx.config && typeof window.MODx.config.auth_token !== "undefined",
    }));

    if (globals.MODx) indicators.push({ type: "js-global", key: "window.MODx", value: true });
    if (globals.hasAuthToken) admin = true;

    // Meta generator tag
    const generator = await page.evaluate(() => {
      const meta = document.querySelector('meta[name="generator"]');
      return meta ? meta.getAttribute("content") : null;
    });

    if (generator && /modx/i.test(generator)) {
      indicators.push({ type: "meta-tag", content: generator });
      const vMatch = generator.match(/MODX\s+([\d.]+)/i);
      if (vMatch) version = vMatch[1];
    }

    // Network signals
    for (const req of network) {
      if (/\/connectors\/index\.php/i.test(req.url) || /\/manager\//i.test(req.url)) {
        indicators.push({ type: "network", url: req.url });
        if (/\/manager\//i.test(req.url)) admin = true;
        break;
      }
    }

    return { detected: indicators.length > 0, version, indicators, admin };
  },
};

const drupalDetector = {
  name: "drupal",
  detect: async (page, network) => {
    const indicators = [];
    let version = null;
    let admin = false;

    // JS globals
    const globals = await page.evaluate(() => ({
      Drupal: typeof window.Drupal !== "undefined",
      drupalSettings: typeof window.drupalSettings !== "undefined",
      uid: typeof window.drupalSettings !== "undefined" && window.drupalSettings.user ? window.drupalSettings.user.uid : 0,
    }));

    if (globals.Drupal) indicators.push({ type: "js-global", key: "window.Drupal", value: true });
    if (globals.drupalSettings) indicators.push({ type: "js-global", key: "window.drupalSettings", value: true });
    if (globals.uid > 0) admin = true;

    // Meta generator tag
    const generator = await page.evaluate(() => {
      const meta = document.querySelector('meta[name="generator"]');
      return meta ? meta.getAttribute("content") : null;
    });

    if (generator && /drupal/i.test(generator)) {
      indicators.push({ type: "meta-tag", content: generator });
      const vMatch = generator.match(/Drupal\s+([\d.]+)/i);
      if (vMatch) version = vMatch[1];
    }

    // Response headers
    for (const req of network) {
      const headers = req.responseHeaders || {};
      if (headers["x-drupal-cache"] || headers["x-generator"]?.match(/drupal/i)) {
        indicators.push({ type: "header", key: "x-drupal-cache" });
        break;
      }
    }

    // HTML patterns
    const drupalFiles = await page.evaluate(() => {
      const el = document.querySelector('[href*="sites/default/files/"], [src*="sites/default/files/"]');
      return !!el;
    });
    if (drupalFiles) indicators.push({ type: "html-pattern", pattern: "sites/default/files/" });

    return { detected: indicators.length > 0, version, indicators, admin };
  },
};

export const cmsDetectors = [wordpressDetector, modxDetector, drupalDetector];

export async function detectCms(page, network = []) {
  const results = [];

  for (const detector of cmsDetectors) {
    try {
      const result = await detector.detect(page, network);
      if (result.detected) {
        results.push({ ...result, cms: detector.name });
      }
    } catch {
      // detector failed — skip
    }
  }

  if (results.length === 0) {
    return {
      detected: false,
      cms: null,
      version: null,
      confidence: null,
      indicators: [],
      admin: false,
    };
  }

  // Pick best match: most indicators wins
  results.sort((a, b) => b.indicators.length - a.indicators.length);
  const best = results[0];
  const confidence = best.indicators.length >= 2 ? "high" : best.indicators.length === 1 ? "medium" : "low";

  return {
    detected: true,
    cms: best.cms,
    version: best.version,
    confidence,
    indicators: best.indicators,
    admin: best.admin,
  };
}
