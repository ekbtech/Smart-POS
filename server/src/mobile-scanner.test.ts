import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { query } from "./db.js";
import {
  hashScannerToken, lookupPosBarcode, scannerPairSchema, scannerScanSchema, scannerTokenMatches,
} from "./mobile-scanner.js";

vi.mock("./db.js", () => ({
  execute: vi.fn(),
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

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

  it("resolves POS scans with an exact branch-local barcode query", async () => {
    vi.mocked(query).mockResolvedValueOnce([{
      id: 21,
      sku: "MILK-1L",
      name: "Fresh milk",
      brand: "Farm",
      package_size: "1 L",
      category_name: "Dairy",
      unit: "piece",
      selling_price: "95.00",
      purchase_price: "70.00",
      tax_rate: "0.00",
      reorder_level: "5.000",
      stock: "12.000",
      barcode: "4006381333931",
      has_image: 0,
    }] as never);

    await expect(lookupPosBarcode("4006381333931", 3)).resolves.toMatchObject({
      name: "Fresh milk",
      brand: "Farm",
      packageSize: "1 L",
      stock: "12.000",
    });
    expect(vi.mocked(query).mock.calls.at(-1)?.[0]).toContain("WHERE p.is_active = TRUE AND p.barcode = ? LIMIT 1");
    expect(vi.mocked(query).mock.calls.at(-1)?.[1]).toEqual([3, 3, "4006381333931"]);
  });
});
