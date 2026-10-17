export type BuildBrowser = "chrome" | "firefox" | string;

const permissions = ["activeTab", "scripting"] as const;
const optionalHostPermissions = ["http://*/*", "https://*/*"] as const;

export function createManifest(browser: BuildBrowser) {
  const firefoxMetadata =
    browser === "firefox"
      ? {
          browser_specific_settings: {
            gecko: {
              id: "listener-lens@example.invalid",
              strict_min_version: "128.0",
              data_collection_permissions: { required: ["none"] },
            },
          },
        }
      : { minimum_chrome_version: "119" };

  return {
    name: "Listener Lens",
    description:
      "Inspect registered browser listeners without collecting user payloads.",
    permissions: [...permissions],
    optional_host_permissions: [...optionalHostPermissions],
    web_accessible_resources: [
      { resources: ["bridge.js"], matches: [...optionalHostPermissions] },
    ],
    ...firefoxMetadata,
  };
}
