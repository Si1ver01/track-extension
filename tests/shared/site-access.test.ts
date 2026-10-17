import { describe, expect, it } from "vitest";
import { getSiteScope, isExactSitePattern } from "../../src/shared/site-access";

describe("site scope", () => {
  it("requests only the current scheme and host, without credentials or page data", () => {
    expect(
      getSiteScope(
        "https://user:secret@sub.example.com:8443/path?q=secret#private",
      ),
    ).toEqual({
      pattern: "https://sub.example.com/*",
      label: "https://sub.example.com",
    });
    expect(getSiteScope("http://sub.example.com/")?.pattern).toBe(
      "http://sub.example.com/*",
    );
  });
  it.each([
    undefined,
    "invalid",
    "about:blank",
    "chrome://settings",
    "file:///tmp/test",
    "moz-extension://id/popup.html",
    "https://addons.mozilla.org/en-US/firefox/",
    "https://chromewebstore.google.com/detail/id",
  ])("rejects unsupported or protected pages: %s", (url) => {
    expect(getSiteScope(url)).toBeNull();
  });
  it("normalizes IDN, IPv6 and loopback hosts", () => {
    expect(getSiteScope("https://пример.рф/")?.pattern).toBe(
      "https://xn--e1afmkfd.xn--p1ai/*",
    );
    expect(getSiteScope("http://[::1]:4173/")?.pattern).toBe("http://[::1]/*");
    expect(getSiteScope("http://localhost:4173/")?.pattern).toBe(
      "http://localhost/*",
    );
  });
  it("does not accept broad patterns or pretend ports are separate permissions", () => {
    for (const pattern of [
      "<all_urls>",
      "*://example.com/*",
      "https://*.example.com/*",
      "https://example.com:8443/*",
      "https://example.com/private/*",
    ]) {
      expect(isExactSitePattern(pattern)).toBe(false);
    }
    expect(isExactSitePattern("https://example.com/*")).toBe(true);
    expect(getSiteScope("http://localhost:4173/")).toEqual(
      getSiteScope("http://localhost:4174/"),
    );
  });
});
