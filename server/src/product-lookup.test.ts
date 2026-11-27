import { describe, expect, it, vi } from "vitest";
import {
  clearProductLookupCache, isAllowedProductImageUrl, isOpenFoodFactsImageUrl, lookupRegistrationBarcode,
  mapOpenFoodFactsProduct, mapUpcItemDbProduct, productBarcodeLookupSchema,
} from "./product-lookup.js";

describe("product barcode lookup", () => {
  it("accepts EAN-8, UPC-A, UPC-E and EAN-13 numeric barcodes", () => {
    for (const barcode of ["96385074", "012345678905", "04252605", "4006381333931"]) {
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
    clearProductLookupCache();
    const externalLookup = vi.fn(async () => ({ found: true as const, name: "Online result" }));
    const result = await lookupRegistrationBarcode("4006381333931", async () => null, externalLookup);
    expect(result).toEqual({ found: true, name: "Online result" });
    expect(externalLookup).toHaveBeenCalledOnce();
    expect(externalLookup).toHaveBeenCalledWith("4006381333931");
  });

  it("keeps other barcode formats local-only when the external catalogue cannot identify them", async () => {
    clearProductLookupCache();
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

  it("rejects UPC/EAN numbers with invalid check digits before an online request", async () => {
    clearProductLookupCache();
    const externalLookup = vi.fn(async () => ({ found: true as const, name: "Must not be used" }));
    const result = await lookupRegistrationBarcode("4006381333932", async () => null, externalLookup);
    expect(result).toEqual({ found: false, externalLookupSkipped: true });
    expect(externalLookup).not.toHaveBeenCalled();
  });

  it("expands valid UPC-E codes before external lookup", async () => {
    clearProductLookupCache();
    const externalLookup = vi.fn(async () => ({ found: true as const, name: "UPC-E product" }));
    const result = await lookupRegistrationBarcode("04252605", async () => null, externalLookup);
    expect(result).toEqual({ found: true, name: "UPC-E product" });
    expect(externalLookup).toHaveBeenCalledWith("042000005265");
  });

  it("checks the equivalent UPC-A value before searching for a leading-zero EAN-13", async () => {
    clearProductLookupCache();
    const duplicate = { id: 8, sku: "TEA-8", name: "Existing tea", isActive: true };
    const findExisting = vi.fn(async (value: string) => value === "012345678905" ? duplicate : null);
    const externalLookup = vi.fn(async () => ({ found: true as const, name: "Online result" }));
    const result = await lookupRegistrationBarcode("0012345678905", findExisting, externalLookup);
    expect(result).toEqual({ found: false, duplicate });
    expect(findExisting).toHaveBeenCalledWith("0012345678905");
    expect(findExisting).toHaveBeenCalledWith("012345678905");
    expect(externalLookup).not.toHaveBeenCalled();
  });

  it("accepts valid EAN-8, UPC-A, EAN-13, and GTIN-14 values for lookup", async () => {
    for (const barcode of ["96385074", "012345678905", "4006381333931", "04006381333931"]) {
      clearProductLookupCache();
      const externalLookup = vi.fn(async () => ({ found: true as const, name: "Online result" }));
      const result = await lookupRegistrationBarcode(barcode, async () => null, externalLookup);
      expect(result.found).toBe(true);
      expect(externalLookup).toHaveBeenCalledWith(barcode);
    }
  });

  it("maps UPCitemdb fields without inventing missing product information", () => {
    expect(mapUpcItemDbProduct({
      code: "OK",
      items: [{
        title: "Green tea 20 bags",
        description: "Green tea",
        brand: "Example",
        size: "20 bags",
        category: "Food, Beverages",
        images: ["http://merchant.example/image.jpg", "https://cdn.example/image.jpg"],
      }],
    })).toEqual({
      found: true,
      name: "Green tea 20 bags",
      description: "Green tea",
      brand: "Example",
      category: "Food",
      packageSize: "20 bags",
      imageUrl: "https://cdn.example/image.jpg",
    });
    expect(mapUpcItemDbProduct({ code: "OK", items: [] })).toBeNull();
  });

  it("falls back to UPCitemdb and caches successful results", async () => {
    clearProductLookupCache();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 0 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: "OK",
        total: 1,
        items: [{ title: "Green tea", brand: "Example", size: "20 bags", images: ["https://cdn.example/tea.jpg"] }],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const lookup = () => lookupRegistrationBarcode("4006381333931", async () => null);
      const result = await lookup();
      expect(result).toMatchObject({ found: true, name: "Green tea", brand: "Example", packageSize: "20 bags" });
      expect(isAllowedProductImageUrl("https://cdn.example/tea.jpg")).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const cached = await lookup();
      expect(cached).toEqual(result);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.upcitemdb.com/prod/trial/lookup");
    } finally {
      vi.unstubAllGlobals();
      clearProductLookupCache();
    }
  });

  it("shares an in-flight lookup for repeated scans of the same barcode", async () => {
    clearProductLookupCache();
    let resolveLookup: ((result: { found: true; name: string }) => void) | undefined;
    const externalLookup = vi.fn(() => new Promise<{ found: true; name: string }>((resolve) => {
      resolveLookup = resolve;
    }));
    const findExisting = async () => null;
    const first = lookupRegistrationBarcode("4006381333931", findExisting, externalLookup);
    const second = lookupRegistrationBarcode("4006381333931", findExisting, externalLookup);
    await vi.waitFor(() => expect(externalLookup).toHaveBeenCalledOnce());
    resolveLookup?.({ found: true, name: "Green tea" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { found: true, name: "Green tea" },
      { found: true, name: "Green tea" },
    ]);
    expect(externalLookup).toHaveBeenCalledOnce();
    clearProductLookupCache();
  });

  it("does not fetch an image URL until it came from a recent UPCitemdb result", () => {
    clearProductLookupCache();
    expect(isAllowedProductImageUrl("https://cdn.example/image.jpg")).toBe(false);
    expect(isAllowedProductImageUrl("https://images.openfoodfacts.org/images/products/123/front.jpg")).toBe(true);
  });
});
