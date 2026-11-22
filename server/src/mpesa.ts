import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { Decimal } from "decimal.js";
import { z } from "zod";
import type { RowDataPacket } from "mysql2/promise";
import { pool, withTransaction } from "./db.js";
import type { AuthUser } from "./auth.js";
import { HttpError } from "./errors.js";
import {
  allocateSaleBatches, calculateSaleAmounts, createSale, saleSchema,
  type SaleInput, type VerifiedMpesaPayment,
} from "./sales.js";

type MpesaStatus = "created" | "requesting" | "pending" | "verifying" | "succeeded" | "failed" | "unknown" | "cancelled";
type MpesaConfig = {
  environment: "sandbox" | "production";
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  passkey: string;
  callbackUrl: string;
  transactionType: string;
  baseUrl: string;
};
type IntentRow = RowDataPacket & {
  id: string;
  branch_id: number;
  cashier_id: number;
  shift_id: number;
  idempotency_key: string;
  status: MpesaStatus;
  phone: string;
  description: string;
  amount: string;
  sale_input: string | PaymentIntentInput;
  price_snapshots: string | Array<VerifiedMpesaPayment["priceSnapshots"][number]>;
  reservations: string | VerifiedMpesaPayment["reservations"];
  merchant_request_id: string | null;
  checkout_request_id: string | null;
  mpesa_receipt_number: string | null;
  sale_id: number | null;
  error_message: string | null;
  last_checked_at: Date | null;
  updated_at: Date;
};
type PaymentIntentInput = {
  customerId?: number | null;
  items: Array<{ productId: number; quantity: string }>;
  discount: string;
};
type CallbackMetadataItem = { Name: string; Value?: string | number };
type StkCallback = {
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResultCode: string | number;
  ResultDesc?: string;
  CallbackMetadata?: { Item: CallbackMetadataItem[] };
};
type PaymentReservation = VerifiedMpesaPayment["reservations"][number];

const money = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/);
const paymentIntentSchema = z.object({
  customerId: z.number().int().positive().nullable().optional(),
  items: z.array(z.object({
    productId: z.number().int().positive(),
    quantity: z.string().regex(/^\d{1,9}(\.\d{1,3})?$/).refine((value) => new Decimal(value).greaterThan(0)),
  }).strict()).min(1).max(100),
  discount: money.default("0"),
  phone: z.string().trim().regex(/^(?:07\d{8}|2547\d{8})$/, "Enter a Kenyan mobile number as 07XXXXXXXX or 2547XXXXXXXX."),
  description: z.string().trim().min(1).max(13),
}).strict().superRefine((input, context) => {
  if (new Set(input.items.map((item) => item.productId)).size !== input.items.length) {
    context.addIssue({ code: "custom", path: ["items"], message: "Combine duplicate products into one cart line." });
  }
});
export const mpesaPaymentRequestSchema = paymentIntentSchema;
export const mpesaCallbackSchema = z.object({
  Body: z.object({
    stkCallback: z.object({
      MerchantRequestID: z.string().min(1).max(100),
      CheckoutRequestID: z.string().min(1).max(100),
      ResultCode: z.union([z.number().int(), z.string().regex(/^\d{1,5}$/)]),
      ResultDesc: z.string().max(255).optional(),
      CallbackMetadata: z.object({
        Item: z.array(z.object({
          Name: z.string().max(64),
          Value: z.union([z.string().max(255), z.number()]).optional(),
        }).passthrough()).max(32),
      }).optional(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

export function normalizeKenyanPhone(phone: string): string | null {
  if (/^07\d{8}$/.test(phone)) return `254${phone.slice(1)}`;
  if (/^2547\d{8}$/.test(phone)) return phone;
  return null;
}

function getMpesaConfig(): MpesaConfig | null {
  const environment = process.env.MPESA_ENVIRONMENT;
  const consumerKey = process.env.MPESA_CONSUMER_KEY?.trim();
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET?.trim();
  const shortcode = process.env.MPESA_SHORTCODE?.trim();
  const passkey = process.env.MPESA_PASSKEY?.trim();
  const callbackValue = process.env.MPESA_CALLBACK_URL?.trim();
  if (
    (environment !== "sandbox" && environment !== "production")
    || !consumerKey || !consumerSecret || !shortcode || !passkey || !callbackValue
  ) return null;

  let callback: URL;
  try {
    callback = new URL(callbackValue);
  } catch {
    return null;
  }
  const callbackHost = callback.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    callback.protocol !== "https:"
    || callback.username
    || callback.password
    || isIP(callbackHost) !== 0
    || ["localhost", "local", "internal", "lan"].some((suffix) =>
      callbackHost === suffix || callbackHost.endsWith(`.${suffix}`))
    || !callback.pathname.endsWith("/api/mpesa/callback")
  ) return null;

  return {
    environment,
    consumerKey,
    consumerSecret,
    shortcode,
    passkey,
    callbackUrl: callback.toString(),
    transactionType: process.env.MPESA_TRANSACTION_TYPE?.trim() || "CustomerPayBillOnline",
    baseUrl: environment === "production"
      ? "https://api.safaricom.co.ke"
      : "https://sandbox.safaricom.co.ke",
  };
}

export function getMpesaAvailability() {
  return {
    configured: getMpesaConfig() !== null,
    reason: getMpesaConfig() ? null : "Daraja credentials and a public HTTPS callback URL are not configured.",
    requiresWholeShillings: true,
  };
}

function parseJson<T>(value: string | T): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function formatDarajaTimestamp(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}${part("month")}${part("day")}${part("hour")}${part("minute")}${part("second")}`;
}

class MpesaRequestError extends Error {
  constructor(message: string, readonly definitelyNotSubmitted: boolean) {
    super(message);
    this.name = "MpesaRequestError";
  }
}

async function getAccessToken(config: MpesaConfig): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString("base64")}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new MpesaRequestError("Daraja authentication could not be reached.", true);
  }
  if (!response.ok) throw new MpesaRequestError("Daraja authentication was rejected.", true);
  const payload: unknown = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object" || !("access_token" in payload)
    || typeof payload.access_token !== "string" || !payload.access_token) {
    throw new MpesaRequestError("Daraja did not return an access token.", true);
  }
  return payload.access_token;
}

async function requestStkPush(
  config: MpesaConfig,
  intent: Pick<IntentRow, "id" | "phone" | "amount" | "description">,
) {
  const accessToken = await getAccessToken(config);
  const timestamp = formatDarajaTimestamp();
  const password = Buffer.from(`${config.shortcode}${config.passkey}${timestamp}`).toString("base64");
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: config.shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: config.transactionType,
        Amount: new Decimal(intent.amount).toNumber(),
        PartyA: intent.phone,
        PartyB: config.shortcode,
        PhoneNumber: intent.phone,
        CallBackURL: config.callbackUrl,
        AccountReference: intent.id.replaceAll("-", "").slice(0, 12).toUpperCase(),
        TransactionDesc: intent.description,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new MpesaRequestError("The STK Push outcome is unknown. Check payment status before retrying.", false);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new MpesaRequestError(
      response.status >= 500
        ? "The STK Push outcome is unknown. Check payment status before retrying."
        : "Daraja rejected the STK Push request.",
      response.status < 500,
    );
  }
  if (!payload || typeof payload !== "object") {
    throw new MpesaRequestError("Daraja returned an invalid STK Push response. Check payment status before retrying.", false);
  }
  const responseBody = payload as Record<string, unknown>;
  if (String(responseBody.ResponseCode ?? "") !== "0") {
    throw new MpesaRequestError(
      typeof responseBody.ResponseDescription === "string"
        ? responseBody.ResponseDescription.slice(0, 255)
        : "Daraja did not accept the STK Push request.",
      true,
    );
  }
  if (
    typeof responseBody.CheckoutRequestID !== "string"
    || !responseBody.CheckoutRequestID
    || responseBody.CheckoutRequestID.length > 100
    || typeof responseBody.MerchantRequestID !== "string"
    || !responseBody.MerchantRequestID
    || responseBody.MerchantRequestID.length > 100
  ) {
    throw new MpesaRequestError("Daraja accepted the request without usable identifiers. Check payment status before retrying.", false);
  }
  return {
    checkoutRequestId: responseBody.CheckoutRequestID,
    merchantRequestId: responseBody.MerchantRequestID,
  };
}

async function queryStkPayment(config: MpesaConfig, checkoutRequestId: string) {
  const accessToken = await getAccessToken(config);
  const timestamp = formatDarajaTimestamp();
  const password = Buffer.from(`${config.shortcode}${config.passkey}${timestamp}`).toString("base64");
  const response = await fetch(`${config.baseUrl}/mpesa/stkpushquery/v1/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      BusinessShortCode: config.shortcode,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Daraja payment verification could not be completed.");
  const payload: unknown = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object") throw new Error("Daraja returned an invalid payment verification response.");
  return payload as Record<string, unknown>;
}

type ProductRow = RowDataPacket & {
  id: number;
  sku: string;
  name: string;
  selling_price: string;
  purchase_price: string | null;
  tax_rate: string;
  on_hand: string;
  reserved: string;
};
type BatchRow = RowDataPacket & { id: number; quantity_remaining: string; expiry_date: string | null };
type PriceSnapshot = VerifiedMpesaPayment["priceSnapshots"][number];

async function createPaymentIntent(input: z.infer<typeof paymentIntentSchema>, idempotencyKey: string, user: AuthUser) {
  const normalizedPhone = normalizeKenyanPhone(input.phone);
  if (!normalizedPhone) throw new HttpError(400, "Enter a Kenyan mobile number as 07XXXXXXXX or 2547XXXXXXXX.");
  const id = randomUUID();
  const saleInput: PaymentIntentInput = {
    ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
    items: input.items,
    discount: input.discount,
  };
  return withTransaction(async (connection) => {
    const [existingRows] = await connection.execute<Array<RowDataPacket & {
      id: string; status: MpesaStatus; phone: string; description: string; sale_input: string | PaymentIntentInput;
    }>>(
      "SELECT id, status, phone, description, sale_input FROM mpesa_payment_requests WHERE branch_id = ? AND idempotency_key = ? FOR UPDATE",
      [user.branchId, idempotencyKey],
    );
    if (existingRows[0]) {
      const savedInput = parseJson<PaymentIntentInput>(existingRows[0].sale_input);
      if (
        existingRows[0].phone !== normalizedPhone
        || existingRows[0].description !== input.description
        || canonicalJson(savedInput) !== canonicalJson(saleInput)
      ) throw new HttpError(409, "This idempotency key was already used for a different M-Pesa request.");
      return { id: existingRows[0].id, shouldSend: existingRows[0].status === "created" };
    }

    const [shifts] = await connection.execute<Array<RowDataPacket & { id: number }>>(
      "SELECT id FROM cashier_shifts WHERE branch_id = ? AND cashier_id = ? AND status = 'open' FOR UPDATE",
      [user.branchId, user.id],
    );
    const shiftId = shifts[0]?.id;
    if (!shiftId) throw new HttpError(409, "Open a cashier shift before requesting an M-Pesa payment.");
    if (input.customerId) {
      const [customers] = await connection.execute<Array<RowDataPacket & { id: number }>>(
        "SELECT id FROM customers WHERE id = ?",
        [input.customerId],
      );
      if (!customers[0]) throw new HttpError(404, "Customer not found.");
    }

    const [branchRows] = await connection.execute<Array<RowDataPacket & { allow_negative_stock: number }>>(
      "SELECT allow_negative_stock FROM branches WHERE id = ?",
      [user.branchId],
    );
    if (!branchRows[0]) throw new HttpError(403, "Your assigned branch is unavailable.");
    const allowNegativeStock = Boolean(branchRows[0].allow_negative_stock);
    const productById = new Map<number, ProductRow>();
    const batchesByProduct = new Map<number, BatchRow[]>();
    for (const productId of input.items.map((item) => item.productId).sort((a, b) => a - b)) {
      const [activeProducts] = await connection.execute<Array<RowDataPacket & { id: number }>>(
        "SELECT id FROM products WHERE id = ? AND is_active = TRUE",
        [productId],
      );
      if (!activeProducts[0]) throw new HttpError(404, `Product ${productId} is unavailable.`);
      await connection.execute(
        "INSERT INTO inventory (branch_id, product_id, on_hand, reserved) VALUES (?, ?, 0, 0) ON DUPLICATE KEY UPDATE product_id = VALUES(product_id)",
        [user.branchId, productId],
      );
      const [products] = await connection.execute<ProductRow[]>(
        `SELECT p.id, p.sku, p.name, p.selling_price, p.purchase_price, p.tax_rate, i.on_hand, i.reserved
         FROM products p JOIN inventory i ON i.product_id = p.id AND i.branch_id = ?
         WHERE p.id = ? AND p.is_active = TRUE FOR UPDATE`,
        [user.branchId, productId],
      );
      if (!products[0]) throw new HttpError(404, `Product ${productId} is unavailable.`);
      productById.set(productId, products[0]);
      const [batches] = await connection.execute<BatchRow[]>(
        `SELECT id, quantity_remaining, DATE_FORMAT(expiry_date, '%Y-%m-%d') AS expiry_date
         FROM inventory_batches
         WHERE branch_id = ? AND product_id = ? AND quantity_remaining > 0
         ORDER BY expiry_date IS NULL, expiry_date, id FOR UPDATE`,
        [user.branchId, productId],
      );
      batchesByProduct.set(productId, batches);
    }

    const amounts = calculateSaleAmounts(input.items.map((item) => {
      const product = productById.get(item.productId)!;
      return { price: product.selling_price, quantity: item.quantity, taxRate: product.tax_rate };
    }), input.discount);
    if (!amounts.total.greaterThan(0)) throw new HttpError(400, "The M-Pesa total must be greater than zero.");
    if (!amounts.total.isInteger()) {
      throw new HttpError(400, "Daraja STK Push accepts whole Kenyan shillings. Use cash or an approved split for totals with cents.");
    }

    const reservations: PaymentReservation[] = [];
    const priceSnapshots: PriceSnapshot[] = [];
    for (const item of input.items) {
      const product = productById.get(item.productId)!;
      const quantity = new Decimal(item.quantity);
      const available = new Decimal(product.on_hand).minus(product.reserved);
      const canOversell = allowNegativeStock && new Decimal(product.reserved).isZero();
      if (quantity.greaterThan(available) && !canOversell) {
        throw new HttpError(409, `Insufficient stock for ${product.name}; ${available.toFixed(3)} available.`);
      }
      const batchAllocation = allocateSaleBatches(batchesByProduct.get(product.id) ?? [], item.quantity);
      if (batchAllocation.unallocated.greaterThan(0) && !canOversell) {
        const eligible = quantity.minus(batchAllocation.unallocated);
        throw new HttpError(409, `Only ${eligible.toFixed(3)} unexpired batch units are available for ${product.name}.`);
      }
      const reservedQuantity = Decimal.min(quantity, Decimal.max(available, 0)).toDecimalPlaces(3);
      const allocations: PaymentReservation["allocations"] = [];
      let batchReservationRemaining = reservedQuantity;
      for (const allocation of batchAllocation.allocations) {
        if (batchReservationRemaining.isZero()) break;
        const reservedBatchQuantity = Decimal.min(allocation.quantity, batchReservationRemaining);
        if (reservedBatchQuantity.greaterThan(0)) {
          allocations.push({ batchId: allocation.batchId, quantity: reservedBatchQuantity.toFixed(3) });
          batchReservationRemaining = batchReservationRemaining.minus(reservedBatchQuantity);
        }
      }
      if (reservedQuantity.greaterThan(0)) {
        await connection.execute(
          "UPDATE inventory SET reserved = reserved + ? WHERE branch_id = ? AND product_id = ?",
          [reservedQuantity.toFixed(3), user.branchId, product.id],
        );
      }
      for (const allocation of allocations) {
        await connection.execute(
          "UPDATE inventory_batches SET quantity_remaining = quantity_remaining - ? WHERE id = ?",
          [allocation.quantity, allocation.batchId],
        );
      }
      reservations.push({ productId: product.id, quantity: reservedQuantity.toFixed(3), allocations });
      priceSnapshots.push({
        productId: product.id,
        unitPrice: product.selling_price,
        taxRate: product.tax_rate,
        unitCost: product.purchase_price,
      });
    }

    await connection.execute(
      `INSERT INTO mpesa_payment_requests
         (id, branch_id, cashier_id, shift_id, idempotency_key, phone, description, amount, sale_input, price_snapshots, reservations)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, user.branchId, user.id, shiftId, idempotencyKey, normalizedPhone, input.description,
        amounts.total.toFixed(2), JSON.stringify(saleInput), JSON.stringify(priceSnapshots), JSON.stringify(reservations),
      ],
    );
    return { id, shouldSend: true };
  });
}

async function claimStkRequest(id: string): Promise<IntentRow | null> {
  return withTransaction(async (connection) => {
    const [rows] = await connection.execute<IntentRow[]>(
      "SELECT * FROM mpesa_payment_requests WHERE id = ? FOR UPDATE",
      [id],
    );
    const intent = rows[0];
    if (!intent || intent.status !== "created") return null;
    await connection.execute(
      "UPDATE mpesa_payment_requests SET status = 'requesting', last_checked_at = NULL WHERE id = ?",
      [id],
    );
    return { ...intent, status: "requesting" };
  });
}

async function releaseReservation(id: string, status: "failed" | "cancelled", message: string) {
  await withTransaction(async (connection) => {
    const [rows] = await connection.execute<IntentRow[]>(
      "SELECT * FROM mpesa_payment_requests WHERE id = ? FOR UPDATE",
      [id],
    );
    const intent = rows[0];
    if (!intent || intent.status === "succeeded" || intent.status === "failed" || intent.status === "cancelled") return;
    const reservations = parseJson<VerifiedMpesaPayment["reservations"]>(intent.reservations);
    for (const reservation of reservations) {
      const quantity = new Decimal(reservation.quantity);
      if (quantity.greaterThan(0)) {
        const [updated] = await connection.execute(
          `UPDATE inventory SET reserved = reserved - ?
           WHERE branch_id = ? AND product_id = ? AND reserved >= ?`,
          [quantity.toFixed(3), intent.branch_id, reservation.productId, quantity.toFixed(3)],
        );
        if ((updated as { affectedRows: number }).affectedRows !== 1) {
          throw new HttpError(409, "The M-Pesa stock reservation could not be safely released.");
        }
      }
      for (const allocation of reservation.allocations) {
        await connection.execute(
          "UPDATE inventory_batches SET quantity_remaining = quantity_remaining + ? WHERE id = ?",
          [allocation.quantity, allocation.batchId],
        );
      }
    }
    await connection.execute(
      "UPDATE mpesa_payment_requests SET status = ?, error_message = ? WHERE id = ?",
      [status, message.slice(0, 255), id],
    );
  });
}

async function sendStkRequest(id: string) {
  const config = getMpesaConfig();
  if (!config) throw new HttpError(503, "Daraja credentials and a public HTTPS callback URL are not configured.");
  const intent = await claimStkRequest(id);
  if (!intent) return;
  try {
    const response = await requestStkPush(config, intent);
    await pool.execute(
      `UPDATE mpesa_payment_requests
       SET status = 'pending', merchant_request_id = ?, checkout_request_id = ?, error_message = NULL, last_checked_at = NULL
       WHERE id = ? AND status = 'requesting'`,
      [response.merchantRequestId, response.checkoutRequestId, id],
    );
    void processMpesaCallback(response.checkoutRequestId).catch((error: unknown) => {
      console.error("M-Pesa callback verification failed.", error instanceof Error ? error.message : "unknown error");
    });
  } catch (error) {
    if (error instanceof MpesaRequestError && error.definitelyNotSubmitted) {
      await releaseReservation(id, "failed", error.message);
    } else {
      await pool.execute(
        `UPDATE mpesa_payment_requests SET status = 'unknown', error_message = ?
         WHERE id = ? AND status = 'requesting'`,
        ["The request outcome is unknown. Check payment status before retrying.", id],
      );
    }
  }
}

export async function startMpesaPayment(
  input: z.infer<typeof paymentIntentSchema>,
  idempotencyKey: string,
  user: AuthUser,
) {
  if (!getMpesaConfig()) {
    throw new HttpError(503, "Daraja credentials and a public HTTPS callback URL are not configured.");
  }
  const normalizedInput = paymentIntentSchema.parse(input);
  const intent = await createPaymentIntent(normalizedInput, idempotencyKey, user);
  if (intent.shouldSend) await sendStkRequest(intent.id);
  return getMpesaPaymentStatus(intent.id, user);
}

function callbackMetadata(callback: StkCallback) {
  return callback.CallbackMetadata?.Item.reduce<Record<string, string | number>>((result, item) => {
    if (item.Value !== undefined) result[item.Name] = item.Value;
    return result;
  }, {}) ?? {};
}

export async function receiveMpesaCallback(body: unknown) {
  const parsed = mpesaCallbackSchema.parse(body).Body.stkCallback;
  const metadata = callbackMetadata(parsed);
  await pool.execute(
    `INSERT INTO mpesa_callback_events
       (checkout_request_id, merchant_request_id, result_code, result_description, metadata)
     VALUES (?, ?, ?, ?, ?)`,
    [
      parsed.CheckoutRequestID, parsed.MerchantRequestID, Number(parsed.ResultCode),
      parsed.ResultDesc ?? "", JSON.stringify(metadata),
    ],
  );
  void processMpesaCallback(parsed.CheckoutRequestID).catch((error: unknown) => {
    console.error("M-Pesa callback verification failed.", error instanceof Error ? error.message : "unknown error");
  });
}

async function processMpesaCallback(checkoutRequestId: string) {
  const config = getMpesaConfig();
  if (!config) return;
  const [rows] = await pool.execute<IntentRow[]>(
    `SELECT p.*, e.result_code AS callback_result_code, e.merchant_request_id AS callback_merchant_request_id,
            e.metadata AS callback_metadata, e.result_description AS callback_result_description
     FROM mpesa_payment_requests p
     LEFT JOIN mpesa_callback_events e ON e.checkout_request_id = p.checkout_request_id
     WHERE p.checkout_request_id = ?
       AND (e.merchant_request_id = p.merchant_request_id OR e.merchant_request_id IS NULL)
     ORDER BY CASE WHEN e.result_code = 0 THEN 0 ELSE 1 END, e.received_at DESC
     LIMIT 1`,
    [checkoutRequestId],
  );
  const intent = rows[0] as (IntentRow & {
    callback_result_code: number | null;
    callback_merchant_request_id: string | null;
    callback_metadata: string | Record<string, string | number> | null;
    callback_result_description: string;
  }) | undefined;
  if (!intent || ["succeeded", "failed", "cancelled"].includes(intent.status)) return;

  if (intent.callback_result_code !== null
    && intent.callback_merchant_request_id !== intent.merchant_request_id) return;
  const [claimed] = await pool.execute(
    `UPDATE mpesa_payment_requests SET status = 'verifying', last_checked_at = NOW()
     WHERE id = ? AND status NOT IN ('succeeded', 'failed', 'cancelled')
     AND (last_checked_at IS NULL OR last_checked_at < DATE_SUB(NOW(), INTERVAL 10 SECOND))`,
    [intent.id],
  );
  if ((claimed as { affectedRows: number }).affectedRows !== 1) return;

  try {
    const verification = await queryStkPayment(config, checkoutRequestId);
    const responseCode = String(verification.ResponseCode ?? "");
    if (responseCode !== "0") throw new Error("Daraja has not confirmed the payment yet.");
    if (
      String(verification.CheckoutRequestID ?? "") !== checkoutRequestId
      || String(verification.MerchantRequestID ?? "") !== intent.merchant_request_id
    ) throw new Error("Daraja verification identifiers do not match the request.");
    const rawResultCode = verification.ResultCode;
    if (
      (typeof rawResultCode !== "number" && (typeof rawResultCode !== "string" || !/^\d{1,5}$/.test(rawResultCode)))
      || !Number.isInteger(Number(rawResultCode))
    ) throw new Error("Daraja did not return a definitive payment result.");
    const resultCode = Number(rawResultCode);
    if (resultCode !== 0) {
      await releaseReservation(
        intent.id,
        "failed",
        typeof verification.ResultDesc === "string" ? verification.ResultDesc : "Daraja confirmed that the payment failed.",
      );
      await pool.execute(
        "UPDATE mpesa_callback_events SET processed_at = NOW() WHERE checkout_request_id = ?",
        [checkoutRequestId],
      );
      return;
    }

    if (intent.callback_result_code === null || Number(intent.callback_result_code) !== 0) {
      await pool.execute(
        `UPDATE mpesa_payment_requests SET error_message = ?
         WHERE id = ? AND status = 'verifying'`,
        ["Daraja is being checked; a successful callback with payment details is still required.", intent.id],
      );
      return;
    }

    const callbackMetadataValues = parseJson<Record<string, string | number>>(intent.callback_metadata ?? {});
    const callbackPhone = normalizeKenyanPhone(String(callbackMetadataValues.PhoneNumber ?? ""));
    const receiptCode = String(callbackMetadataValues.MpesaReceiptNumber ?? "").trim();
    const callbackAmount = callbackMetadataValues.Amount;
    let callbackAmountMatches = false;
    if (callbackAmount !== undefined) {
      try {
        callbackAmountMatches = new Decimal(String(callbackAmount)).equals(intent.amount);
      } catch {
        callbackAmountMatches = false;
      }
    }
    if (
      !callbackPhone
      || callbackPhone !== intent.phone
      || !receiptCode
      || receiptCode.length > 32
      || !callbackAmountMatches
      || (intent.mpesa_receipt_number !== null && intent.mpesa_receipt_number !== receiptCode)
    ) {
      await pool.execute(
        `UPDATE mpesa_payment_requests SET status = 'verifying', last_checked_at = NOW(),
         error_message = 'Callback details do not match the requested payment.'
         WHERE id = ? AND status NOT IN ('succeeded', 'failed', 'cancelled')`,
        [intent.id],
      );
      return;
    }

    try {
      const [claimedReceipt] = await pool.execute(
        `UPDATE mpesa_payment_requests SET mpesa_receipt_number = ?
         WHERE id = ? AND status = 'verifying'
           AND (mpesa_receipt_number IS NULL OR mpesa_receipt_number = ?)`,
        [receiptCode, intent.id, receiptCode],
      );
      if ((claimedReceipt as { affectedRows: number }).affectedRows !== 1) {
        const [receiptRows] = await pool.execute<Array<RowDataPacket & { mpesa_receipt_number: string | null }>>(
          "SELECT mpesa_receipt_number FROM mpesa_payment_requests WHERE id = ?",
          [intent.id],
        );
        if (receiptRows[0]?.mpesa_receipt_number !== receiptCode) {
          throw new Error("The M-Pesa transaction code could not be reserved for this request.");
        }
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ER_DUP_ENTRY") {
        throw new Error("This M-Pesa transaction code is already assigned to another payment.");
      }
      throw error;
    }

    const saleInput = parseJson<PaymentIntentInput>(intent.sale_input);
    const input: SaleInput = saleSchema.parse({
      ...saleInput,
      payments: [{ method: "mpesa", amount: intent.amount, providerReference: receiptCode }],
    });
    const verified: VerifiedMpesaPayment = {
      reference: receiptCode,
      amount: intent.amount,
      shiftId: intent.shift_id,
      priceSnapshots: parseJson<VerifiedMpesaPayment["priceSnapshots"]>(intent.price_snapshots),
      reservations: parseJson<VerifiedMpesaPayment["reservations"]>(intent.reservations),
    };
    const sale = await createSale(input, intent.idempotency_key, {
      id: intent.cashier_id,
      name: "",
      email: "",
      branchId: intent.branch_id,
      roles: [],
    }, verified);
    await withTransaction(async (connection) => {
      const [currentRows] = await connection.execute<IntentRow[]>(
        "SELECT * FROM mpesa_payment_requests WHERE id = ? FOR UPDATE",
        [intent.id],
      );
      if (!currentRows[0] || currentRows[0].status === "succeeded") return;
      await connection.execute(
        `UPDATE mpesa_payment_requests SET status = 'succeeded', sale_id = ?, mpesa_receipt_number = ?,
         error_message = NULL WHERE id = ?`,
        [sale.id, receiptCode, intent.id],
      );
      await connection.execute(
        "UPDATE mpesa_callback_events SET processed_at = NOW() WHERE checkout_request_id = ?",
        [checkoutRequestId],
      );
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The confirmed payment could not be finalized.";
    await pool.execute(
      `UPDATE mpesa_payment_requests SET status = 'verifying', error_message = ?
       WHERE id = ? AND status NOT IN ('succeeded', 'failed', 'cancelled')`,
      [message.slice(0, 255), intent.id],
    );
  }
}

export async function getMpesaPaymentStatus(id: string, user: AuthUser) {
  if (!z.uuid().safeParse(id).success) throw new HttpError(400, "Invalid M-Pesa payment request ID.");
  const [rows] = await pool.execute<IntentRow[]>(
    `SELECT * FROM mpesa_payment_requests
     WHERE id = ? AND branch_id = ? AND cashier_id = ? LIMIT 1`,
    [id, user.branchId, user.id],
  );
  const intent = rows[0];
  if (!intent) throw new HttpError(404, "M-Pesa payment request not found.");
  if (intent.checkout_request_id && !["succeeded", "failed", "cancelled"].includes(intent.status)) {
    void processMpesaCallback(intent.checkout_request_id).catch((error: unknown) => {
      console.error("M-Pesa payment status verification failed.", error instanceof Error ? error.message : "unknown error");
    });
  }
  return {
    id: intent.id,
    status: intent.status,
    amount: intent.amount,
    description: intent.description,
    saleId: intent.sale_id,
    receiptNumber: intent.mpesa_receipt_number,
    error: intent.error_message,
  };
}

export async function cancelFailedMpesaPayment(id: string, user: AuthUser) {
  if (!z.uuid().safeParse(id).success) throw new HttpError(400, "Invalid M-Pesa payment request ID.");
  const [result] = await pool.execute(
    `UPDATE mpesa_payment_requests SET status = 'cancelled'
     WHERE id = ? AND branch_id = ? AND cashier_id = ? AND status = 'failed'`,
    [id, user.branchId, user.id],
  );
  if ((result as { affectedRows: number }).affectedRows !== 1) {
    throw new HttpError(409, "Only a failed M-Pesa request can be cancelled.");
  }
  return { id, status: "cancelled" as const };
}
