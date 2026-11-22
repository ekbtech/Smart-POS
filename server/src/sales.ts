import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import { z } from "zod";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { pool, withTransaction } from "./db.js";
import type { AuthUser } from "./auth.js";
import { HttpError } from "./errors.js";

Decimal.set({ precision: 24, rounding: Decimal.ROUND_HALF_UP });

const money = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, "Enter a non-negative amount with at most two decimals.");
const positiveMoney = money.refine((value) => new Decimal(value).greaterThan(0), "Payment amount must be greater than zero.");
const paymentReference = z.string().trim().min(1).max(100);
const quantity = z.string().regex(/^\d{1,9}(\.\d{1,3})?$/, "Enter a positive quantity with at most three decimals.")
  .refine((value) => new Decimal(value).greaterThan(0), "Quantity must be greater than zero.");

export const saleSchema = z.object({
  customerId: z.number().int().positive().nullable().optional(),
  items: z.array(z.object({ productId: z.number().int().positive(), quantity }).strict()).min(1).max(100)
    .superRefine((items, context) => {
      if (new Set(items.map((item) => item.productId)).size !== items.length) {
        context.addIssue({ code: "custom", message: "Combine duplicate products into one cart line." });
      }
    }),
  discount: money.default("0"),
  cashReceived: money.optional(),
  payments: z.array(z.object({
    method: z.enum(["cash", "mpesa", "card", "bank_transfer", "credit"]),
    amount: positiveMoney,
    providerReference: paymentReference.optional(),
  }).strict()).min(1).max(5),
}).strict().superRefine((sale, context) => {
  if (sale.cashReceived !== undefined) {
    const allocated = sale.payments
      .filter((payment) => payment.method === "cash")
      .reduce((sum, payment) => sum.plus(payment.amount), new Decimal(0));
    if (new Decimal(sale.cashReceived).lessThan(allocated)) {
      context.addIssue({ code: "custom", path: ["cashReceived"], message: "Amount received cannot be less than the cash payment." });
    }
    if (new Decimal(sale.cashReceived).greaterThan(allocated) && allocated.isZero()) {
      context.addIssue({ code: "custom", path: ["cashReceived"], message: "Change can only be issued for cash payments." });
    }
  }
  for (const payment of sale.payments) {
    if (payment.method === "bank_transfer" && !payment.providerReference) {
      context.addIssue({ code: "custom", path: ["payments"], message: "A bank transfer reference is required." });
    }
    if (payment.method !== "bank_transfer" && payment.method !== "mpesa" && payment.providerReference) {
      context.addIssue({ code: "custom", path: ["payments"], message: "Payment references are only accepted for verified provider payments." });
    }
  }
});

export type SaleInput = z.infer<typeof saleSchema>;
export type VerifiedMpesaPayment = {
  reference: string;
  amount: string;
  shiftId: number;
  priceSnapshots: Array<{
    productId: number;
    unitPrice: string;
    taxRate: string;
    unitCost: string | null;
  }>;
  reservations: Array<{
    productId: number;
    quantity: string;
    allocations: Array<{ batchId: number; quantity: string }>;
  }>;
};
export const bankTransferVerificationRequestSchema = z.object({
  reference: paymentReference,
  amount: positiveMoney,
}).strict();
export const bankTransferDecisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
}).strict();

export async function requestBankTransferVerification(
  input: z.infer<typeof bankTransferVerificationRequestSchema>,
  user: AuthUser,
) {
  try {
    const [result] = await pool.execute(
      `INSERT INTO bank_transfer_verifications (branch_id, cashier_id, reference, amount)
       VALUES (?, ?, ?, ?)`,
      [user.branchId, user.id, input.reference, input.amount],
    );
    return { id: (result as { insertId: number }).insertId, reference: input.reference, amount: input.amount, status: "pending" as const };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ER_DUP_ENTRY") {
      throw new HttpError(409, "This bank transfer reference has already been submitted for this branch.");
    }
    throw error;
  }
}

export async function getBankTransferVerification(reference: string, user: AuthUser) {
  const [rows] = await pool.execute<Array<RowDataPacket & {
    id: number; amount: string; status: "pending" | "verified" | "rejected" | "used";
  }>>(
    `SELECT id, amount, status FROM bank_transfer_verifications
     WHERE branch_id = ? AND cashier_id = ? AND reference = ? LIMIT 1`,
    [user.branchId, user.id, reference],
  );
  if (!rows[0]) throw new HttpError(404, "Bank transfer verification request not found.");
  return { id: rows[0].id, amount: rows[0].amount, status: rows[0].status };
}

export async function listPendingBankTransferVerifications(user: AuthUser) {
  const [rows] = await pool.execute<Array<RowDataPacket & {
    id: number; cashier_id: number; cashier: string; reference: string; amount: string; created_at: Date;
  }>>(
    `SELECT v.id, v.cashier_id, u.name AS cashier, v.reference, v.amount, v.created_at
     FROM bank_transfer_verifications v JOIN users u ON u.id = v.cashier_id
     WHERE v.branch_id = ? AND v.status = 'pending'
     ORDER BY v.created_at ASC LIMIT 100`,
    [user.branchId],
  );
  return rows.map((row) => ({
    id: row.id, cashierId: row.cashier_id, cashier: row.cashier, reference: row.reference,
    amount: row.amount, createdAt: row.created_at.toISOString(),
  }));
}

export async function decideBankTransferVerification(
  id: number,
  decision: z.infer<typeof bankTransferDecisionSchema>,
  user: AuthUser,
) {
  return withTransaction(async (connection) => {
    const [rows] = await connection.execute<Array<RowDataPacket & {
      id: number; reference: string; amount: string; status: string;
    }>>(
      `SELECT id, reference, amount, status FROM bank_transfer_verifications
       WHERE id = ? AND branch_id = ? FOR UPDATE`,
      [id, user.branchId],
    );
    const request = rows[0];
    if (!request) throw new HttpError(404, "Bank transfer verification request not found.");
    if (request.status !== "pending") throw new HttpError(409, "This transfer has already been reviewed.");
    const status = decision.decision === "approved" ? "verified" : "rejected";
    await connection.execute(
      `UPDATE bank_transfer_verifications SET status = ?, reviewed_by = ?, verified_at = NOW()
       WHERE id = ? AND status = 'pending'`,
      [status, user.id, id],
    );
    await connection.execute(
      "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES (?, ?, 'bank_transfer_verification', ?, ?)",
      [
        user.id, `bank_transfer.${status}`, String(id),
        JSON.stringify({ reference: request.reference, amount: request.amount }),
      ],
    );
    return { id, status };
  });
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
type ProductBatch = RowDataPacket & { id: number; quantity_remaining: string; expiry_date: string | null };
export type SaleBatchAllocation = { batchId: number; quantity: Decimal };
type SavedSale = {
  id: number;
  receiptNumber: string;
  subtotal: string;
  discount: string;
  tax: string;
  total: string;
  status: "completed" | "pending_payment";
  replayed: boolean;
};
export const heldSaleSchema = z.object({
  customerId: z.number().int().positive().nullable().optional(),
  discount: money.default("0"),
  items: z.array(z.object({
    productId: z.number().int().positive(),
    quantity,
  }).strict()).min(1).max(100)
    .superRefine((items, context) => {
      if (new Set(items.map((item) => item.productId)).size !== items.length) {
        context.addIssue({ code: "custom", message: "Combine duplicate products into one cart line." });
      }
    }),
}).strict();

export function calculateSaleAmounts(
  items: Array<{ price: string; quantity: string; taxRate: string }>,
  discountText: string,
) {
  const subtotal = items.reduce(
    (sum, item) => sum.plus(new Decimal(item.price).times(item.quantity)),
    new Decimal(0),
  ).toDecimalPlaces(2);
  const discount = new Decimal(discountText).toDecimalPlaces(2);
  if (discount.greaterThan(subtotal)) throw new HttpError(400, "Discount cannot be greater than the subtotal.");
  const factor = subtotal.isZero() ? new Decimal(1) : subtotal.minus(discount).dividedBy(subtotal);
  const lines = items.map((item) => {
    const gross = new Decimal(item.price).times(item.quantity);
    const taxable = gross.times(factor).toDecimalPlaces(2);
    const tax = taxable.times(item.taxRate).dividedBy(100).toDecimalPlaces(2);
    return { taxable, tax, total: taxable.plus(tax).toDecimalPlaces(2) };
  });
  const tax = lines.reduce((sum, line) => sum.plus(line.tax), new Decimal(0)).toDecimalPlaces(2);
  return { subtotal, discount, tax, total: subtotal.minus(discount).plus(tax).toDecimalPlaces(2), lines };
}

export function allocateSaleBatches(
  batches: Array<{ id: number; quantity_remaining: string; expiry_date: string | null }>,
  requestedQuantity: string,
  today = new Date().toISOString().slice(0, 10),
) {
  let remaining = new Decimal(requestedQuantity);
  const allocations: SaleBatchAllocation[] = [];
  for (const batch of batches) {
    if (batch.expiry_date && batch.expiry_date < today) continue;
    if (remaining.isZero()) break;
    const quantity = Decimal.min(remaining, new Decimal(batch.quantity_remaining));
    if (quantity.greaterThan(0)) allocations.push({ batchId: batch.id, quantity });
    remaining = remaining.minus(quantity);
  }
  return { allocations, unallocated: remaining };
}

export async function holdSale(input: z.infer<typeof heldSaleSchema>, user: AuthUser) {
  return withTransaction(async (connection) => {
    const holdNumber = `HOLD-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 6).toUpperCase()}`;
    const [result] = await connection.execute(
      `INSERT INTO held_sales (branch_id, cashier_id, hold_number, customer_id, discount, cart)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [user.branchId, user.id, holdNumber, input.customerId ?? null, input.discount, JSON.stringify(input.items)],
    );
    const id = (result as { insertId: number }).insertId;
    await connection.execute(
      "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES (?, 'sale.held', 'held_sale', ?, ?)",
      [user.id, String(id), JSON.stringify({ holdNumber, itemCount: input.items.length })],
    );
    return { id, holdNumber, status: "held" };
  });
}

export async function listHeldSales(user: AuthUser) {
  const [rows] = await pool.execute<Array<RowDataPacket & {
    id: number; hold_number: string; discount: string; cart: string;
    created_at: Date; cashier_name: string;
  }>>(
    `SELECT h.id, h.hold_number, h.discount, h.cart, h.created_at, u.name AS cashier_name
     FROM held_sales h JOIN users u ON u.id = h.cashier_id
     WHERE h.branch_id = ? AND h.cashier_id = ? ORDER BY h.created_at DESC LIMIT 100`,
    [user.branchId, user.id],
  );
  return rows.map((row) => ({
    id: row.id,
    holdNumber: row.hold_number,
    discount: row.discount,
    items: typeof row.cart === "string" ? JSON.parse(row.cart) : row.cart,
    createdAt: row.created_at,
    cashierName: row.cashier_name,
  }));
}

export async function retrieveHeldSale(id: number, user: AuthUser) {
  return withTransaction(async (connection) => {
    const [rows] = await connection.execute<Array<RowDataPacket & {
      id: number; hold_number: string; discount: string; cart: string;
    }>>(
      "SELECT id, hold_number, discount, cart FROM held_sales WHERE id = ? AND branch_id = ? AND cashier_id = ? FOR UPDATE",
      [id, user.branchId, user.id],
    );
    if (!rows[0]) throw new HttpError(404, "Held sale not found.");
    await connection.execute("DELETE FROM held_sales WHERE id = ?", [id]);
    await connection.execute(
      "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES (?, 'sale.retrieved', 'held_sale', ?, ?)",
      [user.id, String(id), JSON.stringify({ holdNumber: rows[0].hold_number })],
    );
    return {
      id: rows[0].id,
      holdNumber: rows[0].hold_number,
      discount: rows[0].discount,
      items: typeof rows[0].cart === "string" ? JSON.parse(rows[0].cart) : rows[0].cart,
    };
  });
}

async function findExistingSale(connection: PoolConnection, branchId: number, key: string): Promise<SavedSale | undefined> {
  const [rows] = await connection.execute<Array<RowDataPacket & {
    id: number; receipt_number: string; subtotal: string; discount: string; tax: string; total: string; status: SavedSale["status"];
  }>>(
    "SELECT id, receipt_number, subtotal, discount, tax, total, status FROM sales WHERE branch_id = ? AND idempotency_key = ?",
    [branchId, key],
  );
  const sale = rows[0];
  return sale ? {
    id: sale.id, receiptNumber: sale.receipt_number, subtotal: sale.subtotal, discount: sale.discount,
    tax: sale.tax, total: sale.total, status: sale.status, replayed: true,
  } : undefined;
}

export async function createSale(
  input: SaleInput,
  idempotencyKey: string,
  user: AuthUser,
  verifiedMpesa?: VerifiedMpesaPayment,
): Promise<SavedSale> {
  const bankTransferPayments = input.payments.filter((payment) => payment.method === "bank_transfer");
  const mpesaPayments = input.payments.filter((payment) => payment.method === "mpesa");
  if (mpesaPayments.length && !verifiedMpesa) {
    throw new HttpError(501, "M-Pesa payments require a verified Safaricom callback.");
  }
  if (verifiedMpesa && (
    mpesaPayments.length !== 1
    || input.payments.some((payment) => payment.method !== "cash" && payment.method !== "mpesa")
    || mpesaPayments[0]?.providerReference !== verifiedMpesa.reference
    || !new Decimal(mpesaPayments[0]?.amount ?? "0").equals(verifiedMpesa.amount)
  )) {
    throw new HttpError(400, "The verified M-Pesa payment does not match this sale.");
  }
  if (input.payments.some((payment) => payment.method !== "cash" && payment.method !== "bank_transfer" && payment.method !== "mpesa")) {
    throw new HttpError(501, "This payment method is not enabled until its provider verification workflow is configured.");
  }
  if (bankTransferPayments.length > 1 || (bankTransferPayments.length && mpesaPayments.length)) {
    throw new HttpError(400, "Only one non-cash payment can be combined with cash.");
  }

  try {
    return await withTransaction(async (connection) => {
      const replay = await findExistingSale(connection, user.branchId, idempotencyKey);
      if (replay) return replay;

      const [shifts] = await connection.execute<Array<RowDataPacket & { id: number }>>(
        verifiedMpesa
          ? "SELECT id FROM cashier_shifts WHERE id = ? AND branch_id = ? AND cashier_id = ? AND status = 'open' FOR UPDATE"
          : "SELECT id FROM cashier_shifts WHERE branch_id = ? AND cashier_id = ? AND status = 'open' FOR UPDATE",
        verifiedMpesa ? [verifiedMpesa.shiftId, user.branchId, user.id] : [user.branchId, user.id],
      );
      const shiftId = shifts[0]?.id;
      if (!shiftId) throw new HttpError(409, "Open a cashier shift before completing a sale.");
      if (input.customerId) {
        const [customers] = await connection.execute<Array<RowDataPacket & { id: number }>>(
          "SELECT id FROM customers WHERE id = ?",
          [input.customerId],
        );
        if (!customers[0]) throw new HttpError(404, "Customer not found.");
      }

      const [branches] = await connection.execute<Array<RowDataPacket & { allow_negative_stock: number }>>(
        "SELECT allow_negative_stock FROM branches WHERE id = ?",
        [user.branchId],
      );
      if (!branches[0]) throw new HttpError(403, "Your assigned branch is unavailable.");
      const allowNegativeStock = Boolean(branches[0].allow_negative_stock);

      const requestedIds = input.items.map((item) => item.productId).sort((a, b) => a - b);
      const productById = new Map<number, ProductRow>();
      const batchesByProduct = new Map<number, ProductBatch[]>();
      const priceSnapshots = new Map(verifiedMpesa?.priceSnapshots.map((snapshot) => [snapshot.productId, snapshot]) ?? []);
      for (const productId of requestedIds) {
        const [activeProducts] = await connection.execute<Array<RowDataPacket & { id: number }>>(
          "SELECT id FROM products WHERE id = ? AND is_active = TRUE",
          [productId],
        );
        if (!activeProducts[0]) throw new HttpError(404, `Product ${productId} is unavailable.`);
        await connection.execute(
          "INSERT INTO inventory (branch_id, product_id, on_hand, reserved) VALUES (?, ?, 0, 0) ON DUPLICATE KEY UPDATE product_id = VALUES(product_id)",
          [user.branchId, productId],
        );
        const [rows] = await connection.execute<ProductRow[]>(
          `SELECT p.id, p.sku, p.name, p.selling_price, p.purchase_price, p.tax_rate, i.on_hand, i.reserved
           FROM products p JOIN inventory i ON i.product_id = p.id AND i.branch_id = ?
           WHERE p.id = ? AND p.is_active = TRUE FOR UPDATE`,
          [user.branchId, productId],
        );
        if (!rows[0]) throw new HttpError(404, `Product ${productId} is unavailable.`);
        const priceSnapshot = priceSnapshots.get(productId);
        productById.set(productId, priceSnapshot ? {
          ...rows[0],
          selling_price: priceSnapshot.unitPrice,
          tax_rate: priceSnapshot.taxRate,
          purchase_price: priceSnapshot.unitCost,
        } : rows[0]);
        const [batches] = await connection.execute<ProductBatch[]>(
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
      const lines = input.items.map((item, index) => {
        const product = productById.get(item.productId)!;
        const count = new Decimal(item.quantity);
        const reservation = verifiedMpesa?.reservations.find((entry) => entry.productId === product.id);
        const reservedQuantity = new Decimal(reservation?.quantity ?? "0");
        const available = new Decimal(product.on_hand).minus(product.reserved).plus(reservedQuantity);
        const canOversell = allowNegativeStock
          && new Decimal(product.reserved).minus(reservedQuantity).isZero();
        if (count.greaterThan(available) && !canOversell) {
          throw new HttpError(409, `Insufficient stock for ${product.name}; ${available.toFixed(3)} available.`);
        }
        const batchAllocation = reservation
          ? {
            allocations: reservation.allocations.map((allocation) => ({
              batchId: allocation.batchId,
              quantity: new Decimal(allocation.quantity),
            })),
            unallocated: count.minus(reservation.allocations.reduce(
              (sum, allocation) => sum.plus(allocation.quantity),
              new Decimal(0),
            )),
          }
          : allocateSaleBatches(batchesByProduct.get(product.id) ?? [], item.quantity);
        if (batchAllocation.unallocated.greaterThan(0) && !canOversell) {
          const eligible = count.minus(batchAllocation.unallocated);
          throw new HttpError(409, `Only ${eligible.toFixed(3)} unexpired batch units are available for ${product.name}.`);
        }
        return { item, product, amounts: amounts.lines[index]!, allocations: batchAllocation.allocations };
      });

      const { subtotal, discount, tax: taxTotal, total } = amounts;
      const paymentTotal = input.payments.reduce(
        (sum, payment) => sum.plus(new Decimal(payment.amount)),
        new Decimal(0),
      ).toDecimalPlaces(2);
      if (!paymentTotal.equals(total)) throw new HttpError(400, `Payments must equal the total of KES ${total.toFixed(2)}.`);
      if (verifiedMpesa && !paymentTotal.equals(verifiedMpesa.amount)) {
        throw new HttpError(400, "The verified M-Pesa amount does not match the sale total.");
      }
      let bankTransferVerificationId: number | null = null;
      const bankTransfer = bankTransferPayments[0];
      if (bankTransfer) {
        const bankReference = bankTransfer.providerReference;
        if (!bankReference) throw new HttpError(400, "A bank transfer reference is required.");
        const [verifications] = await connection.execute<Array<RowDataPacket & {
          id: number; amount: string; status: string;
        }>>(
          `SELECT id, amount, status FROM bank_transfer_verifications
           WHERE branch_id = ? AND cashier_id = ? AND reference = ? FOR UPDATE`,
          [user.branchId, user.id, bankReference],
        );
        const verification = verifications[0];
        if (!verification || verification.status !== "verified") {
          throw new HttpError(409, "The bank transfer must be approved by an administrator before checkout.");
        }
        if (!new Decimal(verification.amount).equals(new Decimal(bankTransfer.amount))) {
          throw new HttpError(409, "The verified bank transfer amount does not match this sale.");
        }
        bankTransferVerificationId = verification.id;
      }
      const cashPayments = input.payments.filter((payment) => payment.method === "cash");
      const cashApplied = cashPayments.reduce(
        (sum, payment) => sum.plus(new Decimal(payment.amount)),
        new Decimal(0),
      ).toDecimalPlaces(2);
      const cashReceived = input.cashReceived === undefined
        ? cashApplied
        : new Decimal(input.cashReceived).toDecimalPlaces(2);
      if (cashReceived.lessThan(cashApplied)) {
        throw new HttpError(400, "Amount received cannot be less than the cash payment.");
      }
      if (cashReceived.greaterThan(cashApplied) && cashApplied.isZero()) {
        throw new HttpError(400, "Change can only be issued for cash payments.");
      }
      const changeDue = cashReceived.minus(cashApplied).toDecimalPlaces(2);

      const receiptNumber = `SP-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`;
      const [saleResult] = await connection.execute(
        `INSERT INTO sales (branch_id, cashier_id, customer_id, shift_id, receipt_number, idempotency_key, subtotal, discount, tax, total, status, cash_received, change_due)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          user.branchId, user.id, input.customerId ?? null, shiftId, receiptNumber, idempotencyKey,
          subtotal.toFixed(2), discount.toFixed(2), taxTotal.toFixed(2), total.toFixed(2),
          "completed", cashPayments.length ? cashReceived.toFixed(2) : null, changeDue.toFixed(2),
        ],
      );
      const saleId = (saleResult as { insertId: number }).insertId;

      for (const line of lines) {
        const [itemResult] = await connection.execute(
          `INSERT INTO sale_items
             (sale_id, product_id, sku_snapshot, name_snapshot, quantity, unit_price, tax_rate,
              line_total, net_total, tax_amount, unit_cost_snapshot)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            saleId, line.product.id, line.product.sku, line.product.name, line.item.quantity,
            line.product.selling_price, line.product.tax_rate, line.amounts.total.toFixed(2),
            line.amounts.taxable.toFixed(2), line.amounts.tax.toFixed(2), line.product.purchase_price,
          ],
        );
        const saleItemId = (itemResult as { insertId: number }).insertId;
        for (const allocation of line.allocations) {
          if (!verifiedMpesa) {
            await connection.execute(
              "UPDATE inventory_batches SET quantity_remaining = quantity_remaining - ? WHERE id = ?",
              [allocation.quantity.toFixed(3), allocation.batchId],
            );
          }
          await connection.execute(
            "INSERT INTO sale_item_batches (sale_item_id, inventory_batch_id, quantity) VALUES (?, ?, ?)",
            [saleItemId, allocation.batchId, allocation.quantity.toFixed(3)],
          );
        }
        if (verifiedMpesa) {
          const reservation = verifiedMpesa.reservations.find((entry) => entry.productId === line.product.id);
          const reservedQuantity = new Decimal(reservation?.quantity ?? "0");
          const [updated] = await connection.execute(
            `UPDATE inventory SET on_hand = on_hand - ?, reserved = reserved - ?
             WHERE branch_id = ? AND product_id = ? AND reserved >= ?`,
            [line.item.quantity, reservedQuantity.toFixed(3), user.branchId, line.product.id, reservedQuantity.toFixed(3)],
          );
          if ((updated as { affectedRows: number }).affectedRows !== 1) {
            throw new HttpError(409, `The stock reservation for ${line.product.name} is no longer available.`);
          }
        } else {
          await connection.execute(
            "UPDATE inventory SET on_hand = on_hand - ? WHERE branch_id = ? AND product_id = ?",
            [line.item.quantity, user.branchId, line.product.id],
          );
        }
        await connection.execute(
          `INSERT INTO stock_movements (branch_id, product_id, sale_id, movement_type, quantity, reference, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            user.branchId, line.product.id, saleId, "sale",
            new Decimal(line.item.quantity).negated().toString(),
            receiptNumber, user.id,
          ],
        );
      }

      for (const payment of input.payments) {
        await connection.execute(
          "INSERT INTO sale_payments (sale_id, method, amount, status, provider_reference) VALUES (?, ?, ?, ?, ?)",
          [saleId, payment.method, payment.amount, "completed", payment.providerReference ?? null],
        );
      }
      if (bankTransferVerificationId !== null) {
        const [updated] = await connection.execute(
          `UPDATE bank_transfer_verifications SET status = 'used', sale_id = ?
           WHERE id = ? AND status = 'verified'`,
          [saleId, bankTransferVerificationId],
        );
        if ((updated as { affectedRows: number }).affectedRows !== 1) {
          throw new HttpError(409, "The bank transfer authorization was already used.");
        }
      }

      await connection.execute(
        "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES (?, 'sale.created', 'sale', ?, ?)",
        [user.id, String(saleId), JSON.stringify({ receiptNumber, total: total.toFixed(2), status: "completed" })],
      );
      await connection.execute(
        "INSERT INTO electronic_receipts (sale_id, branch_id, receipt_number) VALUES (?, ?, ?)",
        [saleId, user.branchId, receiptNumber],
      );
      return {
        id: saleId, receiptNumber, subtotal: subtotal.toFixed(2), discount: discount.toFixed(2),
        tax: taxTotal.toFixed(2), total: total.toFixed(2), cashReceived: cashPayments.length ? cashReceived.toFixed(2) : null,
        changeDue: changeDue.toFixed(2), status: "completed",
        replayed: false,
      };
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ER_DUP_ENTRY") {
      const connection = await pool.getConnection();
      try {
        const replay = await findExistingSale(connection, user.branchId, idempotencyKey);
        if (replay) return replay;
      } finally {
        connection.release();
      }
    }
    throw error;
  }
}
