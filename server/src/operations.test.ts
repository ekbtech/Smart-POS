import { describe, expect, it } from "vitest";
import { calculateRefundAmount, openShiftSchema, purchaseOrderSchema, receiveSchema } from "./operations.js";

describe("purchase and stock workflows", () => {
  it("accepts fractional stock receipts and rejects duplicate products in an order", () => {
    expect(purchaseOrderSchema.safeParse({
      supplierId: 1,
      items: [{ productId: 2, quantity: "1.25", unitCost: "12.50" }],
    }).success).toBe(true);
    expect(purchaseOrderSchema.safeParse({
      supplierId: 1,
      items: [
        { productId: 2, quantity: "1", unitCost: "12.50" },
        { productId: 2, quantity: "2", unitCost: "12.50" },
      ],
    }).success).toBe(false);
  });

  it("requires a positive received quantity", () => {
    expect(receiveSchema.safeParse({
      items: [{ purchaseOrderItemId: 2, quantity: "0" }],
    }).success).toBe(false);
  });
});

describe("refund arithmetic", () => {
  it("keeps partial refunds within the original paid line total and returns the remainder on final return", () => {
    const first = calculateRefundAmount("10.00", "3", "0", "0.00", "1");
    const second = calculateRefundAmount("10.00", "3", "1", first.toFixed(2), "1");
    const final = calculateRefundAmount("10.00", "3", "2", first.plus(second).toFixed(2), "1");
    expect(first.toFixed(2)).toBe("3.33");
    expect(second.toFixed(2)).toBe("3.33");
    expect(final.toFixed(2)).toBe("3.34");
    expect(first.plus(second).plus(final).toFixed(2)).toBe("10.00");
  });

  describe("cashier shift setup", () => {
    it("accepts an optional counter number while validating the opening float", () => {
      expect(openShiftSchema.safeParse({ openingCash: "250.00", counterNumber: "Till 2" }).success).toBe(true);
      expect(openShiftSchema.safeParse({ openingCash: "250.00", counterNumber: "x".repeat(41) }).success).toBe(false);
      expect(openShiftSchema.safeParse({ openingCash: "-1" }).success).toBe(false);
    });
  });
});
