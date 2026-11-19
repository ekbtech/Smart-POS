import { describe, expect, it } from "vitest";
import {
  inventoryTransferReceiptSchema, inventoryTransferSchema, receiveSchema, stockTakeCompletionSchema, stockTakeSchema,
} from "./operations.js";
import { updateProductSchema } from "./products.js";

describe("inventory control validation", () => {
  it("accepts optional receipt batch details and rejects invalid expiry dates", () => {
    expect(receiveSchema.safeParse({
      items: [{ purchaseOrderItemId: 7, quantity: "3.500", batchCode: "MILK-241", expiryDate: "2027-02-28" }],
    }).success).toBe(true);
    expect(receiveSchema.safeParse({
      items: [{ purchaseOrderItemId: 7, quantity: "3.500", expiryDate: "2027-02-30" }],
    }).success).toBe(false);
  });

  it("requires nonnegative counts for unique products", () => {
    expect(stockTakeSchema.safeParse({ title: "Morning stock count" }).success).toBe(true);
    expect(stockTakeCompletionSchema.safeParse({
      items: [{ productId: 3, countedQuantity: "0" }, { productId: 4, countedQuantity: "1.250" }],
    }).success).toBe(true);
    expect(stockTakeCompletionSchema.safeParse({
      items: [{ productId: 3, countedQuantity: "-1" }],
    }).success).toBe(false);
    expect(stockTakeCompletionSchema.safeParse({
      items: [{ productId: 3, countedQuantity: "1" }, { productId: 3, countedQuantity: "2" }],
    }).success).toBe(false);
  });

  it("accepts partial catalogue edits and explicit archive actions", () => {
    expect(updateProductSchema.safeParse({ sellingPrice: "12.50" }).success).toBe(true);
    expect(updateProductSchema.safeParse({ isActive: false }).success).toBe(true);
    expect(updateProductSchema.safeParse({}).success).toBe(false);
    expect(updateProductSchema.safeParse({ isActive: "false" }).success).toBe(false);
  });

  it("validates transfer lines and nonnegative branch receipt counts", () => {
    expect(inventoryTransferSchema.safeParse({
      destinationBranchId: 2,
      items: [{ productId: 3, quantity: "1.250" }],
    }).success).toBe(true);
    expect(inventoryTransferSchema.safeParse({
      destinationBranchId: 2,
      items: [{ productId: 3, quantity: "1" }, { productId: 3, quantity: "2" }],
    }).success).toBe(false);
    expect(inventoryTransferReceiptSchema.safeParse({
      items: [{ productId: 3, receivedQuantity: "0" }, { productId: 4, receivedQuantity: "1.250" }],
    }).success).toBe(true);
    expect(inventoryTransferReceiptSchema.safeParse({
      items: [{ productId: 3, receivedQuantity: "-1" }],
    }).success).toBe(false);
    expect(inventoryTransferReceiptSchema.safeParse({
      items: [{ productId: 3, receivedQuantity: "1" }, { productId: 3, receivedQuantity: "2" }],
    }).success).toBe(false);
  });
});
