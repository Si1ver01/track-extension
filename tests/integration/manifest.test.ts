import { describe, expect, it } from "vitest";
import { createManifest } from "../../src/manifest";

describe("cross-browser manifest metadata", () => {
  it.each(["chrome", "firefox"] as const)(
    "uses the least-privilege prototype baseline for %s",
    (browser) => {
      const manifest = createManifest(browser);

      expect(manifest.permissions).toEqual(["activeTab", "scripting"]);
      expect(manifest.permissions).not.toContain("tabs");
      expect(manifest.permissions).not.toContain("storage");
      expect(manifest.optional_host_permissions).toEqual([
        "http://*/*",
        "https://*/*",
      ]);
    },
  );

  it("declares Firefox no-transmission metadata only for Firefox", () => {
    const firefoxManifest = createManifest("firefox");
    const chromeManifest = createManifest("chrome");

    expect(firefoxManifest.browser_specific_settings?.gecko).toMatchObject({
      id: "listener-lens@example.invalid",
      data_collection_permissions: { required: ["none"] },
    });
    expect(chromeManifest).not.toHaveProperty("browser_specific_settings");
  });
});
