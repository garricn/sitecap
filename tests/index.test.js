import { describe, it, expect } from "vitest";

describe("library exports", () => {
  it("exports capture functions", async () => {
    const mod = await import("../index.js");
    expect(typeof mod.capturePage).toBe("function");
    expect(typeof mod.navigateAndCapture).toBe("function");
    expect(typeof mod.extractLinks).toBe("function");
    expect(typeof mod.waitForPageSettle).toBe("function");
    expect(typeof mod.setupNetworkCapture).toBe("function");
    expect(typeof mod.setupConsoleCapture).toBe("function");
  });

  it("exports diff functions", async () => {
    const mod = await import("../index.js");
    expect(typeof mod.diffCaptures).toBe("function");
    expect(typeof mod.formatDiffReport).toBe("function");
  });

  it("exports from subpath capture", async () => {
    const mod = await import("../lib/capture.js");
    expect(typeof mod.capturePage).toBe("function");
    expect(typeof mod.navigateAndCapture).toBe("function");
  });

  it("exports from subpath diff", async () => {
    const mod = await import("../lib/diff.js");
    expect(typeof mod.diffCaptures).toBe("function");
    expect(typeof mod.formatDiffReport).toBe("function");
  });
});
