import { readFile } from "node:fs/promises";
import path from "node:path";

const targets = [
  { browser: "chrome", directory: ".output/chrome-mv3" },
  { browser: "firefox", directory: ".output/firefox-mv3" },
];

const configuredLevel = process.env.LOG_LEVEL ?? "debug";

function debug(message, context) {
  if (configuredLevel !== "debug") return;
  console.debug(
    JSON.stringify({
      level: "DEBUG",
      scope: "verify-build",
      message,
      ...context,
    }),
  );
}

function requireCondition(condition, browser, message) {
  if (!condition)
    throw new Error(`[${browser}] manifest validation failed: ${message}`);
}

for (const target of targets) {
  const manifestPath = path.resolve(target.directory, "manifest.json");
  debug("manifest read started", {
    browser: target.browser,
    entrypoint: manifestPath,
  });

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const permissions = manifest.permissions ?? [];
  const optionalHostPermissions = manifest.optional_host_permissions ?? [];
  const contentScripts = manifest.content_scripts ?? [];

  requireCondition(
    manifest.manifest_version === 3,
    target.browser,
    "manifest_version must be 3",
  );
  requireCondition(
    permissions.includes("activeTab"),
    target.browser,
    "activeTab permission is missing",
  );
  requireCondition(
    permissions.includes("scripting"),
    target.browser,
    "scripting permission is missing",
  );
  requireCondition(
    !permissions.includes("tabs"),
    target.browser,
    "tabs permission is not allowed in the prototype baseline",
  );
  requireCondition(
    !permissions.includes("storage"),
    target.browser,
    "storage permission is not allowed in the prototype baseline",
  );
  requireCondition(
    optionalHostPermissions.includes("http://*/*"),
    target.browser,
    "optional HTTP origin access is missing",
  );
  requireCondition(
    optionalHostPermissions.includes("https://*/*"),
    target.browser,
    "optional HTTPS origin access is missing",
  );
  requireCondition(
    !(manifest.host_permissions ?? []).length,
    target.browser,
    "required host permissions are not allowed",
  );
  requireCondition(
    !contentScripts.some((entry) =>
      (entry.matches ?? []).some(
        (match) =>
          match === "<all_urls>" ||
          match === "http://*/*" ||
          match === "https://*/*",
      ),
    ),
    target.browser,
    "static content scripts must not match every site",
  );
  requireCondition(
    (manifest.web_accessible_resources ?? []).some((entry) =>
      entry.resources?.includes("bridge.js"),
    ),
    target.browser,
    "bridge.js web accessible resource is missing",
  );
  requireCondition(
    !("all_frames" in manifest) && !("match_about_blank" in manifest),
    target.browser,
    "invalid root content-script keys",
  );
  for (const asset of ["collector.js", "bridge.js"]) {
    requireCondition(
      (await readFile(path.resolve(target.directory, asset), "utf8")).length >
        0,
      target.browser,
      `${asset} is missing`,
    );
  }

  if (target.browser === "firefox") {
    const gecko = manifest.browser_specific_settings?.gecko;
    requireCondition(Boolean(gecko?.id), target.browser, "gecko.id is missing");
    requireCondition(
      gecko?.data_collection_permissions?.required?.includes("none"),
      target.browser,
      "Firefox data_collection_permissions must declare none",
    );
  }

  debug("manifest validation completed", {
    browser: target.browser,
    entrypoint: manifestPath,
    permissionCount: permissions.length,
    optionalHostPermissionCount: optionalHostPermissions.length,
  });
}
