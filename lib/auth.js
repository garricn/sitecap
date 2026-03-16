import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";

/**
 * Run an auth flow from a YAML file.
 *
 * @param {string} flowPath - Path to auth flow YAML file
 * @param {import('playwright').Page} page - Page (already navigated to target)
 * @param {import('playwright').BrowserContext} context
 * @returns {Promise<boolean>} Whether auth completed
 */
export async function runAuthFlow(flowPath, page, context) {
  const raw = await readFile(flowPath, "utf-8");
  const flow = yaml.load(raw);

  if (!flow.steps || !Array.isArray(flow.steps)) {
    throw new Error(`Auth flow ${flowPath} must have a "steps" array`);
  }

  const startUrl = page.url();
  console.log(`  Running auth flow: ${flow.name || flowPath}`);

  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    const stepNum = i + 1;

    try {
      if (step.click) {
        const target = typeof step.click === "string" ? step.click : step.click.selector;
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
