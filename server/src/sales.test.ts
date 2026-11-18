import { describe, expect, it } from "vitest";
import { allocateSaleBatches, calculateSaleAmounts, createSale, saleSchema } from "./sales.js";

describe("sale validation", () => {
  it("accepts a sale with a split payment", () => {
    const result = saleSchema.safeParse({
      items: [{ productId: 3, quantity: "1.25" }],
      discount: "0.00",
      payments: [{ method: "cash", amount: "50.00" }, { method: "mpesa", amount: "10.00" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects duplicate product lines and floating-point money", () => {
    expect(saleSchema.safeParse({
      items: [{ productId: 3, quantity: "1" }, { productId: 3, quantity: "2" }],
      payments: [{ method: "cash", amount: "50.001" }],
    }).success).toBe(false);
  });

  it("rejects zero quantities", () => {
    expect(saleSchema.safeParse({
      items: [{ productId: 3, quantity: "0" }],
      payments: [{ method: "cash", amount: "0.00" }],
    }).success).toBe(false);
  });

  it("rejects zero-value payments", () => {
    expect(saleSchema.safeParse({
      items: [{ productId: 3, quantity: "1" }],
      payments: [{ method: "cash", amount: "0.00" }],
    }).success).toBe(false);
  });

  it("does not create unconfirmed online payments before a provider is configured", async () => {
    const input = saleSchema.parse({
      items: [{ productId: 3, quantity: "1" }],
      payments: [{ method: "mpesa", amount: "50.00" }],
    });
    await expect(createSale(input, "test-key", {
      id: 1, name: "Cashier", email: "cashier@example.com", branchId: 1, roles: ["cashier"],
    })).rejects.toMatchObject({ status: 501 });
  });
});

describe("sale amount calculation", () => {
  it("allocates oldest unexpired batches first and excludes expired lots", () => {
    const result = allocateSaleBatches([
      { id: 4, quantity_remaining: "9.000", expiry_date: "2026-11-17" },
      { id: 5, quantity_remaining: "3.000", expiry_date: "2026-11-20" },
      { id: 6, quantity_remaining: "2.000", expiry_date: null },
    ], "4.000", "2026-11-18");

    expect(result.allocations.map((item) => [item.batchId, item.quantity.toFixed(3)])).toEqual([
      [5, "3.000"], [6, "1.000"],
    ]);
    expect(result.unallocated.toFixed(3)).toBe("0.000");
  });

  it("allocates discounts proportionally and calculates tax using decimal arithmetic", () => {
    const result = calculateSaleAmounts([
      { price: "100.00", quantity: "1", taxRate: "16.00" },
      { price: "50.00", quantity: "1", taxRate: "0.00" },
    ], "15.00");

    expect(result.subtotal.toFixed(2)).toBe("150.00");
    expect(result.discount.toFixed(2)).toBe("15.00");
    expect(result.tax.toFixed(2)).toBe("14.40");
    expect(result.total.toFixed(2)).toBe("149.40");
  });

  it("rejects a discount larger than the subtotal", () => {
    expect(() => calculateSaleAmounts([{ price: "10.00", quantity: "1", taxRate: "0" }], "10.01"))
      .toThrow("Discount cannot be greater than the subtotal.");
  });
});
