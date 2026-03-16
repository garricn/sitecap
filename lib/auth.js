import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { findUserDataDir } from "./chrome.js";

/**
 * Registry of auto-auth providers.
 */
const providers = {
  google: autoAuthGoogle,
};

/**
 * Run auto-auth for a named provider.
 *
 * @param {string} provider - Provider name (e.g., "google")
 * @param {import('playwright').Page} page
 * @param {import('playwright').BrowserContext} context
 * @param {object} [opts]
 * @param {string} [opts.profileDir] - Chrome profile directory name
 * @param {string} [opts.userDataDir] - Chrome user data directory
 * @returns {Promise<boolean>} Whether auth was performed
 */
export async function autoAuth(provider, page, context, opts = {}) {
  const fn = providers[provider];
  if (!fn) {
    throw new Error(
      `Unknown auth provider: "${provider}". Available: ${Object.keys(providers).join(", ")}`
    );
  }
  return fn(page, context, opts);
}

/**
 * Automate Google OAuth sign-in flow.
 *
 * @param {import('playwright').Page} page - Main page (already navigated to login)
 * @param {import('playwright').BrowserContext} context
 * @param {object} [opts]
 * @returns {Promise<boolean>} Whether auth was performed
 */
async function autoAuthGoogle(page, context, opts = {}) {
  const currentUrl = page.url();

  // Try to restore saved Google cookies from a previous --wait-for-auth session
  const cookiePath = getGoogleAuthPath(opts.profileDir);
  try {
    const saved = JSON.parse(await readFile(cookiePath, "utf-8"));
    if (saved.length > 0) {
      await context.addCookies(saved);
      console.log(`  Restored ${saved.length} Google cookies from ${cookiePath}`);
      // Reload so FedCM iframe picks up the session
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => {});
    }
  } catch {
    // No saved cookies — first run, will need --wait-for-auth
  }

  // Try to find Google sign-in button using multiple selectors
  const selectors = [
    // Google FedCM iframe button
    { type: "frame", frameUrl: "accounts.google.com/gsi", selector: "[role=button]" },
    // Common data attributes
    { type: "page", selector: "[data-provider='google']" },
    // Text-based buttons
    { type: "page", selector: "button:has-text('Sign in with Google')" },
    { type: "page", selector: "a:has-text('Sign in with Google')" },
    { type: "page", selector: "button:has-text('Continue with Google')" },
    { type: "page", selector: "a:has-text('Continue with Google')" },
    // OAuth links
    { type: "page", selector: "a[href*='accounts.google.com/o/oauth2']" },
    // GHL-style "Sign in as" buttons
    { type: "page", selector: "button:has-text('Sign in as')" },
    { type: "page", selector: "[data-testid*='google']" },
  ];

  let clicked = false;

  // Wait for page to settle before scanning for auth buttons
  // (FedCM iframes and OAuth buttons may load after DOMContentLoaded)
  await page.waitForLoadState("networkidle").catch(() => {});

  // Race all selectors — first one to appear wins
  const racePromises = selectors.map(async (sel) => {
    try {
      if (sel.type === "frame") {
        // Watch for Google iframe to appear
        await page.waitForFunction(
          (frameUrl) => Array.from(document.querySelectorAll("iframe")).some(
            (f) => f.src && f.src.includes(frameUrl)
          ),
          sel.frameUrl,
          { timeout: 10_000 }
        );
        const frame = page.frames().find((f) => f.url().includes(sel.frameUrl));
        if (frame) {
          const btn = frame.locator(sel.selector).first();
          await btn.waitFor({ state: "visible", timeout: 5000 });
          return { sel, element: btn, type: "frame" };
        }
      } else {
        const el = page.locator(sel.selector).first();
        await el.waitFor({ state: "visible", timeout: 10_000 });
        return { sel, element: el, type: "page" };
      }
    } catch {
      // This selector didn't appear in time
    }
    return null;
  });

  const results = await Promise.allSettled(racePromises);
  const winner = results
    .map((r) => r.status === "fulfilled" ? r.value : null)
    .find((r) => r !== null);

  if (winner) {
    try {
      await winner.element.click();
      clicked = true;
    } catch {
      // Click failed
    }
  }

  if (!clicked) {
    // Check if already authenticated (URL changed from login)
    if (page.url() !== currentUrl) {
      console.log("  Already authenticated (URL changed).");
      return true;
    }
    console.log("  No Google sign-in button found, skipping auto-auth.");
    return false;
  }

  console.log("  Clicked Google sign-in button, waiting for account chooser...");

  // Wait for popup (account chooser opens in new tab/window)
  let popup;
  try {
    popup = await context.waitForEvent("page", { timeout: 10_000 });
    await popup.waitForLoadState("domcontentloaded");
  } catch {
    // No popup — might be a redirect-based flow instead
    // Wait for the main page to redirect
    try {
      await page.waitForURL((url) => url.href !== currentUrl, { timeout: 15_000 });
      console.log("  Auth redirect completed (no popup flow).");
      return true;
    } catch {
      console.log("  No popup or redirect detected after clicking sign-in.");
      return false;
    }
  }

  console.log("  Account chooser opened, selecting account...");

  // Find the right account in the popup
  const profileEmail = await getProfileEmail(opts.profileDir, opts.userDataDir);

  if (profileEmail) {
    // Try to find and click the matching account
    try {
      const accountEl = popup.locator(`[data-identifier="${profileEmail}"]`).first();
      if (await accountEl.isVisible({ timeout: 3000 })) {
        await accountEl.click();
      } else {
        // Try text match
        const textEl = popup.locator(`text="${profileEmail}"`).first();
        if (await textEl.isVisible({ timeout: 2000 })) {
          await textEl.click();
        } else {
          // Click first account as fallback
          console.log(`  Could not find account "${profileEmail}", selecting first account.`);
          const firstAccount = popup.locator("[data-identifier]").first();
          await firstAccount.click({ timeout: 3000 });
        }
      }
    } catch {
      // Try clicking first account
      try {
        const firstAccount = popup.locator("[data-identifier]").first();
        await firstAccount.click({ timeout: 3000 });
      } catch {
        console.log("  Could not select account in chooser.");
        return false;
      }
    }
  } else {
    // No profile email found, click first account
    console.log("  No profile email found, selecting first account.");
    try {
      const firstAccount = popup.locator("[data-identifier]").first();
      await firstAccount.click({ timeout: 5000 });
    } catch {
      console.log("  Could not select account in chooser.");
      return false;
    }
  }

  // Handle consent screen if it appears
  try {
    // Wait briefly for consent screen
    const continueBtn = popup.locator("button:has-text('Continue'), button:has-text('Allow')").first();
    if (await continueBtn.isVisible({ timeout: 3000 })) {
      await continueBtn.click();
      console.log("  Approved OAuth consent.");
    }
  } catch {
    // No consent screen, popup closed directly
  }

  // Wait for popup to close and main page to redirect
  try {
    await page.waitForURL((url) => url.href !== currentUrl, { timeout: 15_000 });
    console.log("  Google auth completed, redirected to authenticated page.");
    return true;
  } catch {
    // Check if URL actually changed
    if (page.url() !== currentUrl) {
      console.log("  Google auth completed.");
      return true;
    }
    console.log("  Auth may have failed — URL did not change after account selection.");
    return false;
  }
}

/**
 * Save Google auth cookies after a successful login.
 * Call this after --wait-for-auth completes successfully.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {string} [profileDir] - Chrome profile dir name for cache key
 */
export async function saveGoogleAuthCookies(context, profileDir) {
  const cookies = await context.cookies("https://accounts.google.com");
  if (cookies.length === 0) return;

  const cachePath = getGoogleAuthPath(profileDir);
  const cacheDir = join(homedir(), ".sitecap");
  await mkdir(cacheDir, { recursive: true });
  await writeFile(cachePath, JSON.stringify(cookies, null, 2));
  console.log(`  Saved ${cookies.length} Google cookies to ${cachePath}`);
}

/**
 * Get the file path for cached Google auth cookies.
 */
function getGoogleAuthPath(profileDir) {
  const key = profileDir ? profileDir.replace(/\s+/g, "-").toLowerCase() : "default";
  return join(homedir(), ".sitecap", `google-auth-${key}.json`);
}

/**
 * Get the Google email associated with a Chrome profile.
 */
async function getProfileEmail(profileDir, userDataDir) {
  if (!profileDir) return null;

  const dataDir = userDataDir || findUserDataDir();
  const localStatePath = join(dataDir, "Local State");

  try {
    const raw = await readFile(localStatePath, "utf-8");
    const localState = JSON.parse(raw);
    const info = localState?.profile?.info_cache?.[profileDir];
    if (info) {
      // Try gaia_name (Google account email) or user_name
      return info.user_name || info.gaia_name || null;
    }
  } catch {
    // Can't read profile info
  }
  return null;
}
