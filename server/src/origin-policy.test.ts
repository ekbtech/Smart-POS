import { describe, expect, it } from "vitest";
import { isAllowedClientOrigin } from "./origin-policy.js";

describe("client origin policy", () => {
  const configuredOrigins = ["http://pos.example.test:5173"];

  it("allows Vite's selected development port for a configured client host", () => {
    expect(isAllowedClientOrigin("http://pos.example.test:5174", configuredOrigins, true)).toBe(true);
    expect(isAllowedClientOrigin("http://pos.example.test:5182", configuredOrigins, true)).toBe(true);
    expect(isAllowedClientOrigin("http://pos.example.test:5172", configuredOrigins, true)).toBe(false);
  });

  it("does not allow a different host or protocol on the fallback port", () => {
    expect(isAllowedClientOrigin("http://other.example.test:5174", configuredOrigins, true)).toBe(false);
    expect(isAllowedClientOrigin("https://pos.example.test:5174", configuredOrigins, true)).toBe(false);
  });

  it("allows exact configured origins in production but not dynamic development ports", () => {
    expect(isAllowedClientOrigin("http://pos.example.test:5173", configuredOrigins, false)).toBe(true);
    expect(isAllowedClientOrigin("http://pos.example.test:5174", configuredOrigins, false)).toBe(false);
    expect(isAllowedClientOrigin("http://localhost:5174", configuredOrigins, false)).toBe(false);
  });

  it("allows localhost and private-LAN development ports, but not public hosts", () => {
    expect(isAllowedClientOrigin("http://localhost:5182", configuredOrigins, true)).toBe(true);
    expect(isAllowedClientOrigin("http://10.50.70.75:5175", configuredOrigins, true)).toBe(true);
    expect(isAllowedClientOrigin("http://172.25.208.1:5182", configuredOrigins, true)).toBe(true);
    expect(isAllowedClientOrigin("http://192.168.1.4:5173", configuredOrigins, true)).toBe(true);
    expect(isAllowedClientOrigin("http://8.8.8.8:5175", configuredOrigins, true)).toBe(false);
    expect(isAllowedClientOrigin("http://10.50.70.75:4000", configuredOrigins, true)).toBe(false);
    expect(isAllowedClientOrigin(undefined, configuredOrigins, true)).toBe(true);
  });
});
