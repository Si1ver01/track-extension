import type { SiteScope } from "./contracts/site-access";

const protectedHosts = new Set([
  "chromewebstore.google.com",
  "addons.mozilla.org",
  "addons.allizom.org",
  "accounts.firefox.com",
  "accounts-static.cdn.mozilla.net",
  "oauth.accounts.firefox.com",
  "profile.accounts.firefox.com",
  "support.mozilla.org",
  "sync.services.mozilla.com",
  "discovery.addons.mozilla.org",
  "install.mozilla.org",
]);

/** Host permissions cover every path and port, but not other schemes or hosts. */
export function getSiteScope(value?: string): SiteScope | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname || url.hostname.includes("*")) return null;
    if (protectedHosts.has(url.hostname)) return null;
    if (
      url.hostname === "chrome.google.com" &&
      url.pathname.startsWith("/webstore")
    )
      return null;
    return {
      pattern: `${url.protocol}//${url.hostname}/*`,
      label: `${url.protocol}//${url.hostname}`,
    };
  } catch {
    return null;
  }
}

export function isExactSitePattern(pattern: string): boolean {
  if (!pattern.endsWith("/*")) return false;
  return getSiteScope(pattern.slice(0, -1))?.pattern === pattern;
}
