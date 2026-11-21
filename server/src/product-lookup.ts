import { z } from "zod";
import { HttpError } from "./errors.js";

const imageHost = "images.openfoodfacts.org";
const imagePrefix = "/images/products/";
const maximumImageBytes = 5 * 1024 * 1024;
const openFoodFactsUserAgent = "SmartPOS/1.0 (product catalogue lookup)";

export const productBarcodeLookupSchema = z.object({
  barcode: z.string().trim().min(1).max(64).regex(/^[\x21-\x7E]+$/, "Enter a valid printable barcode."),
}).strict();
export const productImageImportSchema = z.object({
  imageUrl: z.string().url().max(2_000),
}).strict();

type OpenFoodFactsProduct = {
  product_name?: unknown;
  product_name_en?: unknown;
  generic_name?: unknown;
  generic_name_en?: unknown;
  brands?: unknown;
  categories?: unknown;
  quantity?: unknown;
  image_front_url?: unknown;
  image_url?: unknown;
};

type OpenFoodFactsResponse = { status?: unknown; product?: OpenFoodFactsProduct };
export type ExistingBarcodeProduct = { id: number; sku: string; name: string; isActive: boolean };
type RegistrationLookupResult =
  | { found: true; name?: string; description?: string; brand?: string; category?: string; packageSize?: string; imageUrl?: string }
  | { found: false; duplicate?: ExistingBarcodeProduct; externalLookupSkipped?: boolean };

function cleanText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.split(",")[0]?.trim().slice(0, maximum);
  return cleaned || undefined;
}

function cleanDescription(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim().slice(0, 500);
  return cleaned || undefined;
}

export function isOpenFoodFactsImageUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === imageHost
      && url.pathname.startsWith(imagePrefix)
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

export function mapOpenFoodFactsProduct(payload: OpenFoodFactsResponse) {
  if (payload.status !== 1 || !payload.product) return null;
  const source = payload.product;
  const image = isOpenFoodFactsImageUrl(source.image_front_url)
    ? source.image_front_url
    : isOpenFoodFactsImageUrl(source.image_url) ? source.image_url : undefined;
  return {
    found: true as const,
    name: cleanText(source.product_name_en, 180) ?? cleanText(source.product_name, 180),
    description: cleanDescription(source.generic_name_en) ?? cleanDescription(source.generic_name),
    brand: cleanText(source.brands, 120),
    category: cleanText(source.categories, 100),
    packageSize: cleanText(source.quantity, 80),
    imageUrl: image,
  };
}

export async function lookupOpenFoodFactsProduct(barcode: string) {
  let response: Response;
  try {
    response = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=product_name,product_name_en,generic_name,generic_name_en,brands,categories,quantity,image_front_url,image_url`,
      {
        headers: { Accept: "application/json", "User-Agent": openFoodFactsUserAgent },
        signal: AbortSignal.timeout(8_000),
      },
    );
  } catch {
    throw new HttpError(502, "Open Food Facts is unavailable right now. The barcode was kept; enter product details manually.");
  }
  if (!response.ok) {
    throw new HttpError(502, "Open Food Facts could not complete the lookup. The barcode was kept; enter product details manually.");
  }

  let payload: OpenFoodFactsResponse;
  try {
    payload = await response.json() as OpenFoodFactsResponse;
  } catch {
    throw new HttpError(502, "Open Food Facts returned an unreadable response. The barcode was kept; enter product details manually.");
  }
  return mapOpenFoodFactsProduct(payload) ?? { found: false as const };
}

export async function lookupRegistrationBarcode(
  barcode: string,
  findExisting: (value: string) => Promise<ExistingBarcodeProduct | null>,
  lookupExternal: (value: string) => Promise<RegistrationLookupResult> = lookupOpenFoodFactsProduct,
): Promise<RegistrationLookupResult> {
  const existing = await findExisting(barcode);
  if (existing) return { found: false, duplicate: existing };
  if (!/^(?:\d{8}|\d{12}|\d{13})$/.test(barcode)) {
    return { found: false, externalLookupSkipped: true };
  }
  return lookupExternal(barcode);
}

function imageSignatureMatches(data: Buffer, mimeType: string): boolean {
  if (mimeType === "image/png") {
    return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (mimeType === "image/jpeg") {
    return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  }
  return mimeType === "image/webp"
    && data.length >= 12
    && data.toString("ascii", 0, 4) === "RIFF"
    && data.toString("ascii", 8, 12) === "WEBP";
}

export async function fetchOpenFoodFactsImage(imageUrl: string): Promise<{ data: Buffer; mimeType: string }> {
  if (!isOpenFoodFactsImageUrl(imageUrl)) {
    throw new HttpError(400, "Only product images hosted by Open Food Facts can be imported.");
  }

  let response: Response;
  try {
    response = await fetch(imageUrl, {
      headers: { Accept: "image/jpeg,image/png,image/webp", "User-Agent": openFoodFactsUserAgent },
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new HttpError(502, "The Open Food Facts product image could not be downloaded.");
  }
  if (!response.ok || !response.body) {
    throw new HttpError(502, "The Open Food Facts product image could not be downloaded.");
  }

  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType)) {
    await response.body.cancel();
    throw new HttpError(415, "Open Food Facts did not provide a supported product image.");
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumImageBytes) {
    await response.body.cancel();
    throw new HttpError(413, "The product image is larger than 5 MB.");
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumImageBytes) {
        await reader.cancel();
        throw new HttpError(413, "The product image is larger than 5 MB.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  const data = Buffer.concat(chunks, total);
  if (!imageSignatureMatches(data, mimeType)) {
    throw new HttpError(415, "The Open Food Facts product image is not a valid JPEG, PNG, or WebP image.");
  }
  return { data, mimeType };
}
