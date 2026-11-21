import { describe, expect, it, vi } from "vitest";
import {
  isOpenFoodFactsImageUrl, lookupRegistrationBarcode, mapOpenFoodFactsProduct, productBarcodeLookupSchema,
} from "./product-lookup.js";

describe("product barcode lookup", () => {
  it("accepts EAN-8, UPC-A, UPC-E and EAN-13 numeric barcodes", () => {
    for (const barcode of ["96385074", "012345678905", "04210005", "4006381333931"]) {
      expect(productBarcodeLookupSchema.safeParse({ barcode }).success).toBe(true);
    }
    expect(productBarcodeLookupSchema.safeParse({ barcode: "SKU-123" }).success).toBe(true);
    expect(productBarcodeLookupSchema.safeParse({ barcode: " " }).success).toBe(false);
  });

  it("maps only fields actually returned by Open Food Facts", () => {
    expect(mapOpenFoodFactsProduct({
      status: 1,
      product: {
        product_name: "Oat drink",
        generic_name: "Oat-based beverage",
        brands: "Example Brand, Other Brand",
        categories: "Beverages, Plant-based beverages",
        quantity: "1 L",
        image_front_url: "https://images.openfoodfacts.org/images/products/123/front_en.400.jpg",
      },
    })).toEqual({
      found: true,
      name: "Oat drink",
      description: "Oat-based beverage",
      brand: "Example Brand",
      category: "Beverages",
      packageSize: "1 L",
      imageUrl: "https://images.openfoodfacts.org/images/products/123/front_en.400.jpg",
    });
    expect(mapOpenFoodFactsProduct({ status: 0 })).toBeNull();
    expect(mapOpenFoodFactsProduct({ status: 1, product: { product_name: "Tea" } })).toEqual({
      found: true,
      name: "Tea",
      description: undefined,
      brand: undefined,
      category: undefined,
      packageSize: undefined,
      imageUrl: undefined,
    });
  });

  it("checks the local catalogue before using the external catalogue", async () => {
    const externalLookup = vi.fn(async () => ({ found: true as const, name: "Online result" }));
    const duplicate = { id: 8, sku: "TEA-8", name: "Existing tea", isActive: true };
    const result = await lookupRegistrationBarcode(
      "4006381333931",
      async () => duplicate,
      externalLookup,
    );
    expect(result).toEqual({ found: false, duplicate });
    expect(externalLookup).not.toHaveBeenCalled();
  });

  it("uses the external catalogue only when the local barcode is absent", async () => {
    const externalLookup = vi.fn(async () => ({ found: true as const, name: "Online result" }));
    const result = await lookupRegistrationBarcode("4006381333931", async () => null, externalLookup);
    expect(result).toEqual({ found: true, name: "Online result" });
    expect(externalLookup).toHaveBeenCalledOnce();
    expect(externalLookup).toHaveBeenCalledWith("4006381333931");
  });

  it("keeps other barcode formats local-only when the external catalogue cannot identify them", async () => {
    const externalLookup = vi.fn(async () => ({ found: true as const, name: "Online result" }));
    const result = await lookupRegistrationBarcode("SKU-128", async () => null, externalLookup);
    expect(result).toEqual({ found: false, externalLookupSkipped: true });
    expect(externalLookup).not.toHaveBeenCalled();
  });

  it("allows images only from the HTTPS Open Food Facts product image path", () => {
    expect(isOpenFoodFactsImageUrl("https://images.openfoodfacts.org/images/products/123/front.jpg")).toBe(true);
    expect(isOpenFoodFactsImageUrl("https://example.com/image.jpg")).toBe(false);
    expect(isOpenFoodFactsImageUrl("http://images.openfoodfacts.org/images/products/123/front.jpg")).toBe(false);
    expect(isOpenFoodFactsImageUrl("https://images.openfoodfacts.org/redirect")).toBe(false);
  });
});
