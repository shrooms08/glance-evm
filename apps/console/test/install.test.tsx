/**
 * Get Glance (/install): the steps for Chrome, Brave, Arc and Edge (each browser's own extensions page to copy), the
 * download link or how to build it, and the page moving on by itself once Glance is detected.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InstallGuide } from "../app/install/page";
import { BROWSERS, detectBrowser, installSteps } from "../lib/install";
import { env } from "../lib/env";

afterEach(cleanup);

describe("which browser", () => {
  it("Edge, Arc and Brave are told apart from Chrome", () => {
    expect(detectBrowser({ userAgent: "Mozilla/5.0 Chrome/140 Safari/537.36 Edg/140" })).toBe("edge");
    expect(detectBrowser({ userAgent: "Mozilla/5.0 Chrome/140", arcPalette: "#123456" })).toBe("arc");
    expect(detectBrowser({ userAgent: "Mozilla/5.0 Chrome/140", brave: {} })).toBe("brave");
    expect(detectBrowser({ userAgent: "Mozilla/5.0 Chrome/140" })).toBe("chrome");
  });
});

describe("the steps", () => {
  it("download, unzip, the browser's own extensions page, Developer mode, Load unpacked, check the ID, pin, Set me up", () => {
    const steps = installSteps("brave", "https://example.com/glance.zip");
    expect(steps.map((s) => s.title)).toEqual([
      "Download Glance",
      "Unzip it",
      "Open Brave's extensions page",
      "Turn on Developer mode",
      "Load unpacked",
      "Check it's Glance",
      "Pin Glance",
      "Set me up",
    ]);
    expect(steps[5]!.detail).toBe("Its ID on the extensions page should be gmcdcaoneeohbacbnafjdnkkoojgnogl.");
    expect(steps[7]!.detail).toMatch(/connect a wallet and create your vault/);
    expect(steps[2]!.copy).toBe("brave://extensions");
    for (const b of ["chrome", "arc", "edge"] as const) expect(installSteps(b, "")[2]!.copy).toBe(BROWSERS[b].extensionsPage);
  });

  it("with no download link set, it says how to build Glance instead", () => {
    expect(installSteps("chrome", "")[0]!.title).toBe("Build Glance");
  });

  it("each step is shown, with a copy button for the extensions page", () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    render(<InstallGuide installed={false} browser="arc" onBrowser={() => {}} downloadUrl="https://example.com/glance.zip" />);
    expect(screen.getByRole("link", { name: "Download Glance" }).getAttribute("href")).toBe("https://example.com/glance.zip");
    expect(screen.getByText("arc://extensions")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Copy" })[0]!);
    expect(writeText).toHaveBeenCalledWith("arc://extensions");
    // Plainly: which browsers aren't supported, and the way on to Set me up.
    expect(screen.getByTestId("unsupported").textContent).toBe("Firefox and Safari aren't supported: Glance needs Chrome, Brave, Edge or Arc.");
    expect(screen.getByRole("link", { name: "Set me up" }).getAttribute("href")).toBe("/start");
  });

  it("by default the download is the zip this console serves (pnpm release:extension writes it)", () => {
    expect(env.extensionDownloadUrl).toBe("/downloads/glance-extension-latest.zip");
  });

  it("once Glance is detected: 'You're set. Open any news article.', with the shortcuts", () => {
    render(<InstallGuide installed browser="chrome" onBrowser={() => {}} downloadUrl="" />);
    expect(screen.getByRole("heading", { name: "You're set. Open any news article." })).toBeTruthy();
    expect(screen.getByText(/⌥G \(Alt\+G\) glances at the page; hold ⌥V \(Alt\+V\) to speak, and let go to send/)).toBeTruthy();
  });
});
