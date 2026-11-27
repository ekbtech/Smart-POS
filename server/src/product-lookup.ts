import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { z } from "zod";
import { HttpError } from "./errors.js";

const imageHost = "images.openfoodfacts.org";
const imagePrefix = "/images/products/";
const maximumImageBytes = 5 * 1024 * 1024;
const lookupTimeoutMs = 8_000;
const lookupCacheTtlMs = 6 * 60 * 60 * 1000;
const missingLookupCacheTtlMs = 10 * 60 * 1000;
const maximumLookupCacheEntries = 500;
const openFoodFactsUserAgent = "SmartPOS/1.0 (product catalogue lookup)";
const trustedUpcImages = new Map<string, number>();
const blockedImageNetworks = new BlockList();
const globalIpv6Networks = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) {
  blockedImageNetworks.addSubnet(address, prefix, "ipv4");
}
globalIpv6Networks.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["2001:db8::", 32], ["2001:20::", 28], ["2002::", 16], ["fc00::", 7],
  ["fe80::", 10], ["ff00::", 8],
] as const) {
  blockedImageNetworks.addSubnet(address, prefix, "ipv6");
}

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
type UpcItemDbProduct = {
  title?: unknown;
  description?: unknown;
  brand?: unknown;
  size?: unknown;
  category?: unknown;
  images?: unknown;
};
type UpcItemDbResponse = { code?: unknown; items?: unknown };
export type ExistingBarcodeProduct = { id: number; sku: string; name: string; isActive: boolean };
export type RegistrationLookupResult =
  | { found: true; name?: string; description?: string; brand?: string; category?: string; packageSize?: string; imageUrl?: string }
  | { found: false; duplicate?: ExistingBarcodeProduct; externalLookupSkipped?: boolean };

const lookupCache = new Map<string, { result: RegistrationLookupResult; expiresAt: number }>();
const lookupRequests = new Map<string, Promise<RegistrationLookupResult>>();

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

function isSafeHttpsImageUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.port === ""
      && !url.username
      && !url.password
      && !isIP(url.hostname);
  } catch {
    return false;
  }
}

function isUpcItemDbImageUrl(value: unknown): value is string {
  return isSafeHttpsImageUrl(value);
}

export function isAllowedProductImageUrl(value: unknown): value is string {
  if (isOpenFoodFactsImageUrl(value)) return true;
  return typeof value === "string" && isUpcItemDbImageUrl(value)
    && (trustedUpcImages.get(value) ?? 0) > Date.now();
}

function rememberTrustedUpcImage(value: string) {
  trustedUpcImages.set(value, Date.now() + lookupCacheTtlMs);
  if (trustedUpcImages.size > maximumLookupCacheEntries) {
    const first = trustedUpcImages.keys().next().value;
    if (first) trustedUpcImages.delete(first);
  }
}

function isValidGtin(value: string): boolean {
  if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(value)) return false;
  const digits = [...value].map(Number);
  const checkDigit = digits.pop();
  if (checkDigit === undefined) return false;
  const sum = digits.reduce((total, digit, index) => {
    const weight = (digits.length - index) % 2 === 1 ? 3 : 1;
    return total + digit * weight;
  }, 0);
  return (10 - (sum % 10)) % 10 === checkDigit;
}

function expandUpcE(value: string): string | undefined {
  if (!/^[01]\d{7}$/.test(value)) return undefined;
  const [numberSystem, ...rest] = value;
  const data = rest.slice(0, 6);
  const checkDigit = rest[6];
  if (!numberSystem || !checkDigit || data.length !== 6) return undefined;
  const [first, second, third, fourth, fifth, sixth] = data;
  if (!first || !second || !third || !fourth || !fifth || !sixth) return undefined;
  let manufacturer: string;
  let product: string;
  if (sixth <= "2") {
    manufacturer = `${first}${second}${sixth}00`;
    product = `00${third}${fourth}${fifth}`;
  } else if (sixth === "3") {
    manufacturer = `${first}${second}${third}00`;
    product = `000${fourth}${fifth}`;
  } else if (sixth === "4") {
    manufacturer = `${first}${second}${third}${fourth}0`;
    product = `0000${fifth}`;
  } else {
    manufacturer = `${first}${second}${third}${fourth}${fifth}`;
    product = `0000${sixth}`;
  }
  const expanded = `${numberSystem}${manufacturer}${product}${checkDigit}`;
  return isValidGtin(expanded) ? expanded : undefined;
}

function barcodeLookupCandidates(barcode: string): string[] {
  if (isValidGtin(barcode)) {
    if (barcode.length === 12) return [barcode, `0${barcode}`];
    if (barcode.length === 13 && barcode.startsWith("0")) return [barcode, barcode.slice(1)];
    return [barcode];
  }
  const expanded = expandUpcE(barcode);
  return expanded ? [expanded, `0${expanded}`] : [];
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

export function mapUpcItemDbProduct(payload: UpcItemDbResponse) {
  if (payload.code !== "OK" || !Array.isArray(payload.items)) return null;
  const source = payload.items.find((item): item is UpcItemDbProduct => Boolean(item && typeof item === "object"));
  if (!source) return null;
  const image = Array.isArray(source.images)
    ? source.images.find(isUpcItemDbImageUrl)
    : undefined;
  return {
    found: true as const,
    name: cleanText(source.title, 180),
    description: cleanDescription(source.description),
    brand: cleanText(source.brand, 120),
    category: cleanText(source.category, 100),
    packageSize: cleanText(source.size, 80),
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
        signal: AbortSignal.timeout(lookupTimeoutMs),
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

export async function lookupUpcItemDbProduct(barcode: string) {
  let response: Response;
  try {
    response = await fetch("https://api.upcitemdb.com/prod/trial/lookup", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ upc: barcode }),
      signal: AbortSignal.timeout(lookupTimeoutMs),
    });
  } catch {
    throw new HttpError(502, "UPCitemdb is unavailable right now.");
  }
  if (!response.ok) {
    throw new HttpError(502, "UPCitemdb could not complete the lookup.");
  }

  let payload: UpcItemDbResponse;
  try {
    payload = await response.json() as UpcItemDbResponse;
  } catch {
    throw new HttpError(502, "UPCitemdb returned an unreadable response.");
  }
  const product = mapUpcItemDbProduct(payload);
  if (!product) return { found: false as const };
  if (product.imageUrl) rememberTrustedUpcImage(product.imageUrl);
  return product;
}

async function lookupProductCatalogues(barcode: string): Promise<RegistrationLookupResult> {
  let openFoodFactsFailed = false;
  try {
    const result = await lookupOpenFoodFactsProduct(barcode);
    if (result.found) return result;
  } catch {
    openFoodFactsFailed = true;
  }

  try {
    const result = await lookupUpcItemDbProduct(barcode);
    if (result.found || !openFoodFactsFailed) return result;
  } catch {
    if (!openFoodFactsFailed) {
      throw new HttpError(502, "Product catalogues are unavailable right now. The barcode was kept; enter product details manually.");
    }
  }
  throw new HttpError(502, "Product catalogues are unavailable right now. The barcode was kept; enter product details manually.");
}

function cacheLookupResult(barcode: string, result: RegistrationLookupResult) {
  const ttl = result.found ? lookupCacheTtlMs : missingLookupCacheTtlMs;
  lookupCache.delete(barcode);
  lookupCache.set(barcode, { result, expiresAt: Date.now() + ttl });
  while (lookupCache.size > maximumLookupCacheEntries) {
    const first = lookupCache.keys().next().value;
    if (first) lookupCache.delete(first);
  }
}

export function clearProductLookupCache() {
  lookupCache.clear();
  lookupRequests.clear();
  trustedUpcImages.clear();
}

export async function lookupRegistrationBarcode(
  barcode: string,
  findExisting: (value: string) => Promise<ExistingBarcodeProduct | null>,
  lookupExternal: (value: string) => Promise<RegistrationLookupResult> = lookupProductCatalogues,
): Promise<RegistrationLookupResult> {
  const candidates = barcodeLookupCandidates(barcode);
  const localCandidates = [...new Set([barcode, ...candidates])];
  for (const candidate of localCandidates) {
    const existing = await findExisting(candidate);
    if (existing) return { found: false, duplicate: existing };
  }
  if (!candidates.length) {
    return { found: false, externalLookupSkipped: true };
  }
  const cached = lookupCache.get(barcode);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  if (cached) lookupCache.delete(barcode);
  const pending = lookupRequests.get(barcode);
  if (pending) return pending;
  const request = lookupExternal(candidates[0]!);
  lookupRequests.set(barcode, request);
  try {
    const result = await request;
    cacheLookupResult(barcode, result);
    return result;
  } finally {
    lookupRequests.delete(barcode);
  }
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

function isPublicAddress(address: string, family: number): boolean {
  if (family === 4) return !blockedImageNetworks.check(address, "ipv4");
  return family === 6
    && globalIpv6Networks.check(address, "ipv6")
    && !blockedImageNetworks.check(address, "ipv6");
}

async function isPublicHttpsHost(url: URL): Promise<boolean> {
  try {
    const addresses = await dnsLookup(url.hostname, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every(({ address, family }) => isPublicAddress(address, family));
  } catch {
    return false;
  }
}

export async function fetchProductImage(imageUrl: string): Promise<{ data: Buffer; mimeType: string }> {
  if (!isAllowedProductImageUrl(imageUrl)) {
    throw new HttpError(400, "This product image source is not trusted or has expired. Look up the barcode again or upload an image.");
  }
  const url = new URL(imageUrl);
  if (!isOpenFoodFactsImageUrl(imageUrl) && !(await isPublicHttpsHost(url))) {
    throw new HttpError(400, "The product image host is not a public IPv4 address.");
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "image/jpeg,image/png,image/webp", "User-Agent": openFoodFactsUserAgent },
      redirect: "error",
      signal: AbortSignal.timeout(lookupTimeoutMs),
    });
  } catch {
    throw new HttpError(502, "The product image could not be downloaded.");
  }
  if (!response.ok || !response.body) {
    throw new HttpError(502, "The product image could not be downloaded.");
  }

  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType)) {
    await response.body.cancel();
    throw new HttpError(415, "The product source did not provide a supported image.");
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
    throw new HttpError(415, "The product image is not a valid JPEG, PNG, or WebP image.");
  }
  return { data, mimeType };
}
