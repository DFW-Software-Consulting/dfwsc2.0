import { describe, expect, it } from "vitest";
import { isAllowedRedirectUrl, normalizeRedirectOrigin } from "../../lib/connect-redirect";

describe("normalizeRedirectOrigin", () => {
  it.each([
    ["https://App.Example.com", "https://app.example.com"],
    ["https://app.example.com/", "https://app.example.com"],
    ["https://app.example.com:8443", "https://app.example.com:8443"],
    ["http://localhost:3000", "http://localhost:3000"],
  ])("accepts %s", (input, expected) => {
    expect(normalizeRedirectOrigin(input)).toBe(expected);
  });

  it.each([
    "http://app.example.com",
    "https://app.example.com/path",
    "https://app.example.com?x=1",
    "https://user:pw@app.example.com",
    "javascript:alert(1)",
    "app.example.com",
  ])("rejects %s", (input) => {
    expect(normalizeRedirectOrigin(input)).toBeNull();
  });
});

describe("isAllowedRedirectUrl", () => {
  const allowed = ["https://app.example.com"];
  it("accepts a URL on an allowed origin, with path and query", () => {
    expect(isAllowedRedirectUrl("https://app.example.com/settings?a=1#x", allowed)).toBe(true);
  });
  it.each([
    "https://evil.com/",
    "https://app.example.com.evil.com/",
    "https://app.example.com@evil.com/",
    "http://app.example.com/",
    "//app.example.com/",
    "/settings",
  ])("rejects %s", (url) => {
    expect(isAllowedRedirectUrl(url, allowed)).toBe(false);
  });
  it("rejects everything for an empty allowlist", () => {
    expect(isAllowedRedirectUrl("https://app.example.com/", [])).toBe(false);
  });
});
