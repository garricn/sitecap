import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import { capturePage } from "./capture.js";

/**
 * Run an auth flow from a YAML file.
 *
 * @param {string} flowPath - Path to auth flow YAML file
 * @param {import('playwright').Page} page - Page (already navigated to target)
 * @param {import('playwright').BrowserContext} context
 * @returns {Promise<boolean>} Whether auth completed
 */
/**
 * Run a flow from a YAML file (auth or exploration).
 *
 * @param {string} flowPath - Path to flow YAML file
 * @param {import('playwright').Page} page
 * @param {import('playwright').BrowserContext} context
 * @param {object} [opts]
 * @param {string} [opts.outDir] - Output directory for capture steps
 * @param {string[]} [opts.types] - Capture types for capture steps
 * @returns {Promise<boolean>}
 */
export async function runAuthFlow(flowPath, page, context, opts = {}) {
  const raw = await readFile(flowPath, "utf-8");
  const flow = yaml.load(raw);

  if (!flow.steps || !Array.isArray(flow.steps)) {
    throw new Error(`Auth flow ${flowPath} must have a "steps" array`);
  }

  console.log(`  Running flow: ${flow.name || flowPath}`);
  return executeSteps(flow.steps, page, context, flowPath, opts);
}

/**
 * Execute a list of steps. Recursive for foreach.
 */
async function executeSteps(steps, page, context, flowPath, opts, vars = {}) {
  const startUrl = page.url();

  for (let i = 0; i < steps.length; i++) {
    let step = steps[i];
    const stepNum = i + 1;

    try {
      // foreach — iterate over elements
      if (step.foreach) {
        const selector = resolveVars(step.foreach.selector, vars);
        const elements = await page.locator(selector).all();
        console.log(`    [${stepNum}] foreach: ${elements.length} elements matching "${selector}"`);

        // Parallel foreach: distribute iterations across multiple tabs
        if (step.foreach.parallel && opts.extensionBridge && elements.length > 1) {
          const parallelLimit = opts.parallel || 2;
          const tabCount = Math.min(parallelLimit, elements.length);
          console.log(`    [parallel] ${tabCount} tabs for ${elements.length} elements`);

          const { createExtensionPage } = await import("../lib/extension-page.js");
          const baseUrl = page.url();
          let nextIdx = 0;

          async function parallelWorker(workerId) {
            const tabPage = await createExtensionPage(opts.extensionBridge, {});
            try {
              while (nextIdx < elements.length) {
                const idx = nextIdx++;
                console.log(`    [tab ${workerId + 1}] foreach ${idx + 1}/${elements.length}`);
                // Navigate to base URL fresh for each iteration
                await tabPage.goto(baseUrl);
                await tabPage.waitForLoadState().catch(() => {});
                // Wait for elements to render
                const waitMs = opts.parallelSettleMs || 3000;
                await new Promise((r) => setTimeout(r, waitMs));

                const innerVars = { ...vars, index: idx, element: `${selector} >> nth=${idx}` };
                const ok = await executeSteps(step.foreach.steps || [], tabPage, context, flowPath, opts, innerVars);
                if (!ok && !step.optional) {
                  console.log(`    [tab ${workerId + 1}] step failed at index ${idx}`);
                }
              }
            } catch (e) {
              console.log(`    [tab ${workerId + 1}] error: ${e.message}`);
            } finally {
              await tabPage.close().catch(() => {});
            }
          }

          const workers = [];
          for (let w = 0; w < tabCount; w++) {
            workers.push(parallelWorker(w));
          }
          await Promise.all(workers);
          continue;
        }

        for (let idx = 0; idx < elements.length; idx++) {
          console.log(`    [foreach ${idx + 1}/${elements.length}]`);
          const innerVars = { ...vars, index: idx, element: `${selector} >> nth=${idx}` };
          const ok = await executeSteps(step.foreach.steps || [], page, context, flowPath, opts, innerVars);
          if (!ok && !step.optional) return false;
        }
        continue;
      }

      // capture — trigger a full sitecap capture to a subdirectory
      if (step.capture) {
        const rawName = typeof step.capture === "object" ? (step.capture.slug || step.capture.name || "capture") : step.capture;
        const name = resolveVars(String(rawName), vars);
        const captureDir = join(opts.outDir || "/tmp/sitecap-flow", name);
        await capturePage(page, captureDir, { types: opts.types });
        console.log(`    [${stepNum}] ✓ capture → ${captureDir}`);
        continue;
      }

      if (step.click) {
        const rawTarget = typeof step.click === "string" ? step.click : step.click.selector;
        const target = resolveVars(rawTarget, vars);
        if (step.click.frame) {
          // Click inside an iframe
          const frame = page.frames().find((f) => f.url().includes(step.click.frame));
          if (!frame) {
            console.log(`    [${stepNum}] ⚠ frame "${step.click.frame}" not found, skipping`);
            continue;
          }
          const el = frame.locator(target).first();
          await el.waitFor({ state: "visible", timeout: step.timeout || 10_000 });
          await el.click();
        } else {
          const el = page.locator(target).first();
          await el.waitFor({ state: "visible", timeout: step.timeout || 10_000 });
          await el.click();
        }
        console.log(`    [${stepNum}] ✓ click ${target}`);

      } else if (step.wait === "popup") {
        const popup = await context.waitForEvent("page", { timeout: step.timeout || 10_000 });
        await popup.waitForLoadState("domcontentloaded");
        // Switch to popup as active page for subsequent steps
        page = popup;
        console.log(`    [${stepNum}] ✓ popup opened`);

      } else if (step.wait === "redirect") {
        await page.waitForURL((url) => url.href !== startUrl, { timeout: step.timeout || 15_000 });
        console.log(`    [${stepNum}] ✓ redirected to ${page.url()}`);

      } else if (step.wait === "settle") {
        await page.waitForLoadState("networkidle").catch(() => {});
        console.log(`    [${stepNum}] ✓ settled`);

      } else if (typeof step.wait === "object" && step.wait.url) {
        await page.waitForURL(step.wait.url, { timeout: step.timeout || 15_000 });
        console.log(`    [${stepNum}] ✓ URL matches ${step.wait.url}`);

      } else if (typeof step.wait === "object" && step.wait.ms) {
        await page.waitForTimeout(step.wait.ms);
        console.log(`    [${stepNum}] ✓ waited ${step.wait.ms}ms`);

      } else if (typeof step.wait === "object" && step.wait.selector) {
        await page.locator(step.wait.selector).first().waitFor({
          state: "visible",
          timeout: step.timeout || 10_000,
        });
        console.log(`    [${stepNum}] ✓ element visible: ${step.wait.selector}`);

      } else if (step.fill) {
        const selector = step.fill.selector;
        const value = resolveEnvVars(step.fill.value);
        await page.locator(selector).first().fill(value);
        console.log(`    [${stepNum}] ✓ fill ${selector}`);

      } else if (step.goto) {
        const url = step.goto;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        console.log(`    [${stepNum}] ✓ goto ${url}`);

      } else if (step.cookies === "save") {
        // Save all cookies for future runs
        const domain = step.domain || undefined;
        await saveAuthCookies(context, flowPath, domain);
        console.log(`    [${stepNum}] ✓ cookies saved`);

      } else if (step.cookies === "restore") {
        const restored = await restoreAuthCookies(context, flowPath);
        if (restored) {
          await page.reload({ waitUntil: "domcontentloaded" });
          await page.waitForLoadState("networkidle").catch(() => {});
          console.log(`    [${stepNum}] ✓ cookies restored and page reloaded`);
        } else {
          console.log(`    [${stepNum}] ⚠ no saved cookies found`);
        }

      } else {
        console.log(`    [${stepNum}] ⚠ unknown step: ${JSON.stringify(step)}`);
      }
    } catch (e) {
      console.log(`    [${stepNum}] ✗ ${e.message}`);
      if (step.optional) continue;
      return false;
    }
  }

  return true;
}

/**
 * Resolve {index} and $element references from foreach vars.
 */
function resolveVars(str, vars) {
  if (!str || typeof str !== "string") return str;
  let result = str;
  if (vars.index !== undefined) {
    result = result.replace(/\{index\}/g, String(vars.index));
  }
  if (vars.element) {
    result = result.replace(/\$element/g, vars.element);
  }
  return result;
}

/**
 * Resolve $VAR references in a string from environment variables.
 */
function resolveEnvVars(str) {
  if (!str || typeof str !== "string") return str;
  return str.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, name) => {
    const val = process.env[name];
    if (val === undefined) {
      throw new Error(`Environment variable $${name} is not set`);
    }
    return val;
  });
}

/**
 * Save cookies from the context for a given auth flow.
 */
export async function saveAuthCookies(context, flowPath, domain) {
  const cookies = domain
    ? await context.cookies(domain)
    : await context.cookies();
  if (cookies.length === 0) return;

  const cachePath = getAuthCachePath(flowPath);
  const cacheDir = join(homedir(), ".sitecap", "auth");
  await mkdir(cacheDir, { recursive: true });
  await writeFile(cachePath, JSON.stringify(cookies, null, 2));
  console.log(`  Saved ${cookies.length} cookies to ${cachePath}`);
}

/**
 * Restore saved cookies for a given auth flow.
 * @returns {Promise<boolean>} Whether cookies were restored
 */
async function restoreAuthCookies(context, flowPath) {
  const cachePath = getAuthCachePath(flowPath);
  try {
    const saved = JSON.parse(await readFile(cachePath, "utf-8"));
    if (saved.length > 0) {
      await context.addCookies(saved);
      return true;
    }
  } catch {
    // No saved cookies
  }
  return false;
}

/**
 * Get cache path for auth flow cookies.
 */
function getAuthCachePath(flowPath) {
  const key = flowPath
    .replace(/.*\//, "")
    .replace(/\.(ya?ml|json)$/, "")
    .replace(/[^a-zA-Z0-9-_]/g, "-");
  return join(homedir(), ".sitecap", "auth", `${key}.json`);
}

/**
 * Save Google auth cookies (convenience for --wait-for-auth).
 */
export async function saveGoogleAuthCookies(context, profileDir) {
  const cookies = await context.cookies("https://accounts.google.com");
  if (cookies.length === 0) return;

  const cacheDir = join(homedir(), ".sitecap", "auth");
  await mkdir(cacheDir, { recursive: true });
  const key = profileDir ? profileDir.replace(/\s+/g, "-").toLowerCase() : "default";
  const cachePath = join(cacheDir, `google-${key}.json`);
  await writeFile(cachePath, JSON.stringify(cookies, null, 2));
  console.log(`  Saved ${cookies.length} Google cookies to ${cachePath}`);
}
