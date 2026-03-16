export {
  capturePage,
  navigateAndCapture,
  extractLinks,
  waitForPageSettle,
  setupNetworkCapture,
  setupConsoleCapture,
} from "./lib/capture.js";

export { diffCaptures, formatDiffReport } from "./lib/diff.js";

export {
  createBrowser,
  createCaptureSession,
  closeCaptureSession,
  parseViewport,
} from "./lib/browser.js";
