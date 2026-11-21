import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  hashScannerToken, scannerPairSchema, scannerScanSchema, scannerTokenMatches,
} from "./mobile-scanner.js";

describe("mobile POS scanner security and validation", () => {
  it("stores tokens as one-way hashes and compares them without timing-sensitive equality", () => {
    const token = randomBytes(32).toString("base64url");
    const hashedToken = hashScannerToken(token);

    expect(hashedToken).not.toContain(token);
    expect(hashedToken).toMatch(/^[a-f0-9]{64}$/);
    expect(scannerTokenMatches(token, hashedToken)).toBe(true);
    expect(scannerTokenMatches(`${token}x`, hashedToken)).toBe(false);
    expect(scannerTokenMatches(token, null)).toBe(false);
  });

  it("requires a sufficiently strong one-time QR pairing token", () => {
    expect(scannerPairSchema.safeParse({ token: randomBytes(32).toString("base64url") }).success).toBe(true);
    expect(scannerPairSchema.safeParse({ token: "short" }).success).toBe(false);
  });

  it("accepts retail numeric and Code 128 barcode text while rejecting control characters", () => {
    expect(scannerScanSchema.safeParse({ barcode: "4006381333931" }).success).toBe(true);
    expect(scannerScanSchema.safeParse({ barcode: "SKU-128/AB" }).success).toBe(true);
    expect(scannerScanSchema.safeParse({ barcode: "invalid\nbarcode" }).success).toBe(false);
    expect(scannerScanSchema.safeParse({ barcode: "x".repeat(65) }).success).toBe(false);
  });
});
