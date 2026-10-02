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
              data_collection_permissions: { required: ["none"] },
            },
          },
        }
      : {};

  return {
    name: "Listener Lens",
    description:
      "Inspect registered browser listeners without collecting user payloads.",
    permissions: [...permissions],
    optional_host_permissions: [...optionalHostPermissions],
    ...firefoxMetadata,
  };
}
