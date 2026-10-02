import { chromium, expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("T-RELEASE-001 captures fixture registrations in the Chromium extension popup", async () => {
  const extensionPath = path.resolve(".output/chrome-mv3");
  const profilePath = await mkdtemp(
    path.join(tmpdir(), "listener-lens-chromium-"),
  );
  const context = await chromium.launchPersistentContext(profilePath, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  try {
    const serviceWorker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(serviceWorker.url()).host;
    console.debug(
      JSON.stringify({
        level: "DEBUG",
        scope: "chromium-extension-smoke",
        message: "extension service worker ready",
        browser: "chromium",
        entrypoint: "background",
      }),
    );

    const fixturePage = await context.newPage();
    await fixturePage.goto("/basic.html");
    await expect(fixturePage.locator("body")).toHaveAttribute(
      "data-fixture-ready",
      "true",
    );
    await fixturePage.evaluate(() => {
      window.addEventListener("click", () => undefined);
    });

    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popupPage.getByText("Статус: ready")).toBeVisible();
    await expect(popupPage.getByText("События не найдены.")).toBeVisible();
  } finally {
    await context.close();
    await rm(profilePath, { recursive: true, force: true });
  }
});
