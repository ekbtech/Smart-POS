import { describe, expect, it } from "vitest";
import { productSchema } from "./products.js";

describe("product registration validation", () => {
  it("accepts a weighted product with an opening balance", () => {
    const result = productSchema.safeParse({
      sku: "PROD-007",
      barcode: "",
      name: "Ripe bananas",
      brand: "Example Farm",
      packageSize: "1 kg",
      description: "Locally grown ripe bananas.",
      category: "Fresh produce",
      unit: "kg",
      sellingPrice: "180.00",
      taxRate: "0",
      reorderLevel: "5.000",
      openingStock: "12.500",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.barcode).toBeNull();
      expect(result.data.brand).toBe("Example Farm");
      expect(result.data.packageSize).toBe("1 kg");
      expect(result.data.description).toBe("Locally grown ripe bananas.");
    }
  });

  it("rejects unsafe SKUs and tax rates over 100 percent", () => {
    const result = productSchema.safeParse({
      sku: "SKU<script>",
      name: "Example item",
      category: "General",
      unit: "piece",
      sellingPrice: "20.00",
      taxRate: "100.01",
      reorderLevel: "0",
      openingStock: "0",
    });
    expect(result.success).toBe(false);
  });
});
