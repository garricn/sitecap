import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { chromium } from "playwright";

/**
 * Returns the path to the Chrome executable for the current platform.
 * @returns {string}
 */
export function findChromeExecutable() {
  const plat = platform();

  if (plat === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }

  if (plat === "linux") {
    const candidates = [
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
    ];
    for (const c of candidates) {
      return c;
    }
  }

  if (plat === "win32") {
    const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
    const programFilesX86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    const candidates = [
      join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    ];
    return candidates[0];
  }

  throw new Error(`Unsupported platform: ${plat}`);
}

/**
 * Returns the default Chrome user data directory for the current platform.
 * @returns {string}
 */
export function findUserDataDir() {
  const plat = platform();
  const home = homedir();

  if (plat === "darwin") {
    return join(home, "Library", "Application Support", "Google", "Chrome");
  }
  if (plat === "linux") {
    return join(home, ".config", "google-chrome");
  }
  if (plat === "win32") {
    const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    return join(localAppData, "Google", "Chrome", "User Data");
  }

  throw new Error(`Unsupported platform: ${plat}`);
}

/**
 * Resolve a profile name (display name or directory name) to the actual
 * profile directory name used by Chrome.
 *
 * @param {string} userDataDir
 * @param {string} profileName
 * @returns {Promise<string>} The profile directory name (e.g., "Profile 1")
 */
export async function resolveProfileDir(userDataDir, profileName) {
  if (profileName === "Default" || /^Profile \d+$/.test(profileName)) {
    return profileName;
  }

  const localStatePath = join(userDataDir, "Local State");
  let localState;
  try {
    const raw = await readFile(localStatePath, "utf-8");
    localState = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `Could not read Chrome Local State at ${localStatePath}: ${e.message}\n` +
        `If "${profileName}" is a directory name, use the exact directory name (e.g., "Default", "Profile 1").`,
      { cause: e }
    );
  }

  const infoCache = localState?.profile?.info_cache;
  if (!infoCache) {
    throw new Error(
      `No profile info found in Local State. Use the exact profile directory name (e.g., "Default", "Profile 1").`
    );
  }

  const lower = profileName.toLowerCase();
  for (const [dirName, info] of Object.entries(infoCache)) {
    if (info.name && info.name.toLowerCase() === lower) {
      return dirName;
    }
  }

  const available = Object.entries(infoCache)
    .map(([dir, info]) => `  ${dir} → "${info.name || "(unnamed)"}"`)
    .join("\n");

  throw new Error(
    `No Chrome profile found with name "${profileName}".\nAvailable profiles:\n${available}`
  );
}

/**
 * Check if Chrome is already running.
 * @returns {Promise<boolean>}
 */
async function isChromeRunning() {
  const plat = platform();

  if (plat === "darwin") {
    return new Promise((resolve) => {
      const proc = spawn("pgrep", ["-f", "Google Chrome"], { stdio: ["ignore", "pipe", "ignore"] });
      let output = "";
      proc.stdout.on("data", (data) => { output += data.toString(); });
      proc.on("close", (code) => {
        resolve(code === 0 && output.trim().length > 0);
      });
      proc.on("error", () => resolve(false));
    });
  }

  if (plat === "linux") {
    return new Promise((resolve) => {
      const proc = spawn("pgrep", ["-f", "google-chrome|chromium"], { stdio: ["ignore", "pipe", "ignore"] });
      let output = "";
      proc.stdout.on("data", (data) => { output += data.toString(); });
      proc.on("close", (code) => {
        resolve(code === 0 && output.trim().length > 0);
      });
      proc.on("error", () => resolve(false));
    });
  }

  if (plat === "win32") {
    return new Promise((resolve) => {
      const proc = spawn("tasklist", ["/FI", "IMAGENAME eq chrome.exe", "/FO", "LIST"], { stdio: ["ignore", "pipe", "ignore"] });
      let output = "";
      proc.stdout.on("data", (data) => { output += data.toString(); });
      proc.on("close", () => {
        resolve(output.toLowerCase().includes("chrome.exe"));
      });
      proc.on("error", () => resolve(false));
    });
  }

  return false;
}

/**
 * Launch Chrome with a specific profile using Playwright's persistent context.
 * Returns a BrowserContext (not a raw process) — pages are created from this.
 *
 * Uses Playwright's launchPersistentContext which correctly binds the debug
 * port on macOS (child_process.spawn does not reliably do this).
 *
 * @param {object} opts
 * @param {string} opts.profileDir - Profile directory name (e.g., "Default", "Profile 1")
 * @param {string} [opts.userDataDir] - Chrome user data dir (uses platform default if omitted)
 * @param {object} [opts.viewport] - Viewport size {width, height} or null for default
 * @returns {Promise<{context: import('playwright').BrowserContext, profilePath: string}>}
 */
export async function launchChromeWithProfile(opts) {
  const { profileDir, userDataDir, port = 9222 } = opts;
  const dataDir = userDataDir || findUserDataDir();
  const chromePath = findChromeExecutable();

  const running = await isChromeRunning();
  if (running) {
    throw new Error(
      `Chrome is already running. Close all Chrome windows first, then retry.\n` +
        `Chrome cannot share its user data directory between two instances.`
    );
  }

  // Launch real Chrome with remote debugging — preserves full FedCM/Google identity
  const chromeProcess = spawn(chromePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dataDir}`,
    `--profile-directory=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ], {
    stdio: "ignore",
    detached: true,
  });
  chromeProcess.unref();

  // Wait for CDP to become available
  let browser;
  for (let i = 0; i < 30; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  if (!browser) {
    throw new Error(`Chrome launched but CDP connection failed on port ${port} after 15s.`);
  }

  return { browser, chromeProcess };
}

/**
 * Close Chrome — disconnects CDP and kills the process.
 * @param {import('playwright').Browser} browser
 * @param {import('child_process').ChildProcess} [chromeProcess]
 */
export async function shutdownChrome(browser, chromeProcess) {
  if (browser) {
    await browser.close();
  }
  if (chromeProcess) {
    try {
      process.kill(chromeProcess.pid);
    } catch {
      // already exited
    }
  }
}
