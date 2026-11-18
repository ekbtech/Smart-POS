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
  payments: z.array(z.object({
    method: z.enum(["cash", "mpesa", "card", "bank_transfer", "credit"]),
    amount: positiveMoney,
  }).strict()).min(1).max(5),
}).strict();

type SaleInput = z.infer<typeof saleSchema>;
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

export async function createSale(input: SaleInput, idempotencyKey: string, user: AuthUser): Promise<SavedSale> {
  if (input.payments.some((payment) => payment.method !== "cash")) {
    throw new HttpError(501, "Only cash checkout is enabled. Online and credit payment workflows are not connected yet.");
  }

  try {
    return await withTransaction(async (connection) => {
      const replay = await findExistingSale(connection, user.branchId, idempotencyKey);
      if (replay) return replay;

      const [shifts] = await connection.execute<Array<RowDataPacket & { id: number }>>(
        "SELECT id FROM cashier_shifts WHERE branch_id = ? AND cashier_id = ? AND status = 'open' FOR UPDATE",
        [user.branchId, user.id],
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
        productById.set(productId, rows[0]);
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
        const available = new Decimal(product.on_hand).minus(product.reserved);
        const canOversell = allowNegativeStock && new Decimal(product.reserved).isZero();
        if (count.greaterThan(available) && !canOversell) {
          throw new HttpError(409, `Insufficient stock for ${product.name}; ${available.toFixed(3)} available.`);
        }
        const batchAllocation = allocateSaleBatches(batchesByProduct.get(product.id) ?? [], item.quantity);
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

      const receiptNumber = `SP-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`;
      const [saleResult] = await connection.execute(
        `INSERT INTO sales (branch_id, cashier_id, customer_id, shift_id, receipt_number, idempotency_key, subtotal, discount, tax, total, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          user.branchId, user.id, input.customerId ?? null, shiftId, receiptNumber, idempotencyKey,
          subtotal.toFixed(2), discount.toFixed(2), taxTotal.toFixed(2), total.toFixed(2),
          "completed",
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
          await connection.execute(
            "UPDATE inventory_batches SET quantity_remaining = quantity_remaining - ? WHERE id = ?",
            [allocation.quantity.toFixed(3), allocation.batchId],
          );
          await connection.execute(
            "INSERT INTO sale_item_batches (sale_item_id, inventory_batch_id, quantity) VALUES (?, ?, ?)",
            [saleItemId, allocation.batchId, allocation.quantity.toFixed(3)],
          );
        }
        await connection.execute(
          "UPDATE inventory SET on_hand = on_hand - ? WHERE branch_id = ? AND product_id = ?",
          [line.item.quantity, user.branchId, line.product.id],
        );
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
          "INSERT INTO sale_payments (sale_id, method, amount, status) VALUES (?, ?, ?, ?)",
          [saleId, payment.method, payment.amount, "completed"],
        );
      }

      await connection.execute(
        "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES (?, 'sale.created', 'sale', ?, ?)",
        [user.id, String(saleId), JSON.stringify({ receiptNumber, total: total.toFixed(2), status: "completed" })],
      );
      return {
        id: saleId, receiptNumber, subtotal: subtotal.toFixed(2), discount: discount.toFixed(2),
        tax: taxTotal.toFixed(2), total: total.toFixed(2), status: "completed",
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
