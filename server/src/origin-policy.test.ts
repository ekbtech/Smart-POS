import { describe, expect, it } from "vitest";
import { isAllowedClientOrigin } from "./origin-policy.js";

describe("client origin policy", () => {
  const configuredOrigins = ["http://pos.example.test:5173"];

  it("allows Vite's adjacent fallback port for a configured client host", () => {
    expect(isAllowedClientOrigin("http://pos.example.test:5174", configuredOrigins)).toBe(true);
    expect(isAllowedClientOrigin("http://pos.example.test:5175", configuredOrigins)).toBe(false);
  });

  it("does not allow a different host or protocol on the fallback port", () => {
    expect(isAllowedClientOrigin("http://other.example.test:5174", configuredOrigins)).toBe(false);
    expect(isAllowedClientOrigin("https://pos.example.test:5174", configuredOrigins)).toBe(false);
  });

  it("continues allowing localhost development ports and requests without an origin", () => {
    expect(isAllowedClientOrigin("http://localhost:5174", configuredOrigins)).toBe(true);
    expect(isAllowedClientOrigin(undefined, configuredOrigins)).toBe(true);
  });
});
