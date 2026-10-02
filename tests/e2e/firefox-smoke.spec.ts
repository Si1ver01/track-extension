import { expect, test } from "@playwright/test";
import { access } from "node:fs/promises";
import path from "node:path";

test("Firefox harness opens the fixture alongside a Firefox MV3 build", async ({
  page,
}) => {
  await access(path.resolve(".output/firefox-mv3/manifest.json"));
  console.debug(
    JSON.stringify({
      level: "DEBUG",
      scope: "firefox-smoke",
      message: "Firefox build and browser harness available",
      browser: "firefox",
      entrypoint: "fixture",
    }),
  );

  await page.goto("/basic.html");
  await expect(page.locator("body")).toHaveAttribute(
    "data-fixture-ready",
    "true",
  );
  await expect(
    page.getByRole("button", { name: "Copy fixture" }),
  ).toBeVisible();
});
