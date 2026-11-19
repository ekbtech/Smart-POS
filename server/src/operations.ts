import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import { query, withTransaction } from "./db.js";
import { HttpError } from "./errors.js";
import type { AuthUser } from "./auth.js";

Decimal.set({ precision: 24, rounding: Decimal.ROUND_HALF_UP });

const quantity = z.string().regex(/^\d{1,9}(\.\d{1,3})?$/)
  .refine((value) => new Decimal(value).greaterThan(0), "Quantity must be greater than zero.");
const amount = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/)
  .refine((value) => new Decimal(value).greaterThan(0), "Amount must be greater than zero.");

export const adjustmentSchema = z.object({
  productId: z.number().int().positive(),
  direction: z.enum(["in", "out"]),
  quantity,
  reason: z.string().trim().min(3).max(500),
  reference: z.string().trim().max(100).optional(),
  batchCode: z.string().trim().max(80).optional(),
  expiryDate: z.iso.date().nullable().optional(),
}).strict();

export function calculateRefundAmount(
  lineTotal: string,
  soldQuantity: string,
  refundedQuantity: string,
  refundedAmount: string,
  requestedQuantity: string,
): Decimal {
  const remainingQuantity = new Decimal(soldQuantity).minus(refundedQuantity);
  const returnQuantity = new Decimal(requestedQuantity);
  if (!returnQuantity.greaterThan(0) || returnQuantity.greaterThan(remainingQuantity)) {
    throw new HttpError(409, "Return quantity exceeds the remaining quantity.");
  }
  const remainingAmount = new Decimal(lineTotal).minus(refundedAmount);
  return returnQuantity.equals(remainingQuantity)
    ? remainingAmount
    : new Decimal(lineTotal).times(returnQuantity).dividedBy(soldQuantity).toDecimalPlaces(2, Decimal.ROUND_DOWN);
}

export const supplierSchema = z.object({
  name: z.string().trim().min(2).max(180),
  contactName: z.string().trim().max(150).optional(),
  email: z.union([z.email().max(254), z.literal("")]).optional(),
  phone: z.string().trim().max(40).optional(),
  address: z.string().trim().max(500).optional(),
  taxPin: z.string().trim().max(30).optional(),
}).strict();

export const purchaseOrderSchema = z.object({
  supplierId: z.number().int().positive(),
  notes: z.string().trim().max(1000).optional(),
  items: z.array(z.object({
    productId: z.number().int().positive(),
    quantity,
    unitCost: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/),
  }).strict()).min(1).max(100)
    .superRefine((items, context) => {
      if (new Set(items.map((item) => item.productId)).size !== items.length) {
        context.addIssue({ code: "custom", message: "A product may only appear once per order." });
      }
    }),
}).strict();

export const receiveSchema = z.object({
  reference: z.string().trim().max(80).optional(),
  items: z.array(z.object({
    purchaseOrderItemId: z.number().int().positive(),
    quantity,
    batchCode: z.string().trim().max(80).optional(),
    expiryDate: z.iso.date().nullable().optional(),
  }).strict()).min(1).max(100),
}).strict();
export const stockTakeSchema = z.object({
  title: z.string().trim().min(3).max(180),
}).strict();
export const stockTakeCompletionSchema = z.object({
  items: z.array(z.object({
    productId: z.number().int().positive(),
    countedQuantity: z.string().regex(/^\d{1,9}(\.\d{1,3})?$/),
  }).strict()).min(1).max(5000)
    .superRefine((items, context) => {
      if (new Set(items.map((item) => item.productId)).size !== items.length) {
        context.addIssue({ code: "custom", message: "Each product may only be counted once." });
      }
    }),
}).strict();
export const inventoryTransferSchema = z.object({
  destinationBranchId: z.number().int().positive(),
  notes: z.string().trim().max(500).optional(),
  items: z.array(z.object({ productId: z.number().int().positive(), quantity }).strict()).min(1).max(100)
    .superRefine((items, context) => {
      if (new Set(items.map((item) => item.productId)).size !== items.length) {
        context.addIssue({ code: "custom", message: "A product may only appear once per transfer." });
      }
    }),
}).strict();
export const inventoryTransferReceiptSchema = z.object({
  items: z.array(z.object({
    productId: z.number().int().positive(),
    receivedQuantity: z.string().regex(/^\d{1,9}(\.\d{1,3})?$/),
  }).strict()).min(1).max(100)
    .superRefine((items, context) => {
      if (new Set(items.map((item) => item.productId)).size !== items.length) {
        context.addIssue({ code: "custom", message: "Each transfer product may only be received once." });
      }
    }),
}).strict();

export const customerSchema = z.object({
  name: z.string().trim().min(2).max(180),
  phone: z.string().trim().max(40).optional(),
  email: z.union([z.email().max(254), z.literal("")]).optional(),
  address: z.string().trim().max(500).optional(),
}).strict();

export const openShiftSchema = z.object({ openingCash: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/) }).strict();
export const closeShiftSchema = z.object({ actualCash: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/) }).strict();
export const cashMovementSchema = z.object({
  type: z.enum(["deposit", "withdrawal"]),
  amount,
  description: z.string().trim().min(3).max(500),
}).strict();

export const expenseSchema = z.object({
  category: z.string().trim().min(2).max(100),
  amount,
  description: z.string().trim().min(3).max(500),
  paymentMethod: z.enum(["cash", "mpesa", "card", "bank_transfer"]),
}).strict();

export const expenseDecisionSchema = z.object({ decision: z.enum(["approved", "rejected"]) }).strict();
export const refundSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  items: z.array(z.object({
    saleItemId: z.number().int().positive(),
    quantity,
  }).strict()).min(1).max(100)
    .superRefine((items, context) => {
      if (new Set(items.map((item) => item.saleItemId)).size !== items.length) {
        context.addIssue({ code: "custom", message: "Each sale item can only appear once in a return." });
      }
    }),
}).strict();

type OperationUser = AuthUser;
type InventoryRow = RowDataPacket & { product_id: number; on_hand: string; reserved: string };

async function writeAudit(
  connection: PoolConnection,
  userId: number,
  action: string,
  entity: string,
  id: string | number,
  details: Record<string, unknown>,
) {
  await connection.execute(
    "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)",
    [userId, action, entity, String(id), JSON.stringify(details)],
  );
}

export async function listInventory(branchId: number, search: string) {
  return query<Array<{
    id: number; sku: string; name: string; category: string | null; unit: string; on_hand: string;
    reserved: string; available: string; reorder_level: string; cost: string | null; updated_at: Date;
  } & RowDataPacket>>(
    `SELECT p.id, p.sku, p.name, c.name AS category, p.unit, COALESCE(i.on_hand, 0) AS on_hand,
            COALESCE(i.reserved, 0) AS reserved,
            GREATEST(COALESCE(i.on_hand - i.reserved, 0) - COALESCE(expired.quantity, 0), 0) AS available,
            p.reorder_level, p.purchase_price AS cost, COALESCE(i.updated_at, p.created_at) AS updated_at
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN inventory i ON i.product_id = p.id AND i.branch_id = ?
     LEFT JOIN (
       SELECT product_id, SUM(quantity_remaining) AS quantity
       FROM inventory_batches
       WHERE branch_id = ? AND expiry_date < CURDATE() AND quantity_remaining > 0
       GROUP BY product_id
     ) expired ON expired.product_id = p.id
     WHERE p.is_active = TRUE AND (? = '' OR p.name LIKE CONCAT('%', ?, '%') OR p.sku = ? OR p.barcode = ?)
     ORDER BY p.name LIMIT 250`,
    [branchId, branchId, search, search, search, search],
  );
}

export async function adjustInventory(input: z.infer<typeof adjustmentSchema>, user: OperationUser) {
  return withTransaction(async (connection) => {
    const [products] = await connection.execute<Array<RowDataPacket & { id: number; name: string }>>(
      "SELECT id, name FROM products WHERE id = ? AND is_active = TRUE",
      [input.productId],
    );
    if (!products[0]) throw new HttpError(404, "Product not found.");
    await connection.execute(
      "INSERT INTO inventory (branch_id, product_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE product_id = VALUES(product_id)",
      [user.branchId, input.productId],
    );
    const [inventory] = await connection.execute<InventoryRow[]>(
      "SELECT product_id, on_hand, reserved FROM inventory WHERE branch_id = ? AND product_id = ? FOR UPDATE",
      [user.branchId, input.productId],
    );
    const row = inventory[0];
    if (!row) throw new Error("Inventory row could not be locked.");
    const delta = new Decimal(input.quantity).times(input.direction === "in" ? 1 : -1);
    const next = new Decimal(row.on_hand).plus(delta);
    if (next.lessThan(row.reserved)) {
      throw new HttpError(409, `Cannot remove that quantity. ${row.reserved} units are reserved.`);
    }
    if (delta.isNegative()) {
      await consumeInventoryBatches(connection, user.branchId, input.productId, delta.abs(), true);
    } else {
      await addInventoryBatch(connection, user.branchId, input.productId, delta, {
        batchCode: input.batchCode || input.reference || null,
        expiryDate: input.expiryDate ?? null,
      });
    }
    await connection.execute(
      "UPDATE inventory SET on_hand = ? WHERE branch_id = ? AND product_id = ?",
      [next.toFixed(3), user.branchId, input.productId],
    );
    const reference = input.reference || `ADJ-${randomUUID().slice(0, 8).toUpperCase()}`;
    await connection.execute(
      `INSERT INTO stock_movements (branch_id, product_id, movement_type, quantity, reference, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [user.branchId, input.productId, "adjustment", delta.toFixed(3), `${reference}: ${input.reason}`, user.id],
    );
    await writeAudit(connection, user.id, "inventory.adjusted", "product", input.productId, {
      product: products[0].name, delta: delta.toFixed(3), reason: input.reason,
    });
    return { productId: input.productId, onHand: next.toFixed(3), delta: delta.toFixed(3), reference };
  });
}

export async function getStockMovements(branchId: number) {
  return query<Array<{
    id: number; product_name: string; sku: string; movement_type: string; quantity: string;
    reference: string | null; created_at: Date; user_name: string;
  } & RowDataPacket>>(
    `SELECT sm.id, p.name AS product_name, p.sku, sm.movement_type, sm.quantity,
            sm.reference, sm.created_at, u.name AS user_name
     FROM stock_movements sm JOIN products p ON p.id = sm.product_id JOIN users u ON u.id = sm.created_by
     WHERE sm.branch_id = ? ORDER BY sm.created_at DESC LIMIT 50`,
    [branchId],
  );
}

type BatchOptions = { batchCode?: string | null; expiryDate?: string | null; unitCost?: string | null };
type BatchRow = RowDataPacket & {
  id: number; quantity_remaining: string; expiry_date: string | null;
  batch_code?: string | null; unit_cost?: string | null;
};

async function addInventoryBatch(
  connection: PoolConnection,
  branchId: number,
  productId: number,
  quantityToAdd: Decimal,
  options: BatchOptions = {},
) {
  if (!quantityToAdd.greaterThan(0)) return;
  await connection.execute(
    `INSERT INTO inventory_batches
       (branch_id, product_id, batch_code, expiry_date, quantity_received, quantity_remaining, unit_cost)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      branchId, productId, options.batchCode ?? null, options.expiryDate ?? null,
      quantityToAdd.toFixed(3), quantityToAdd.toFixed(3), options.unitCost ?? null,
    ],
  );
}

async function consumeInventoryBatches(
  connection: PoolConnection,
  branchId: number,
  productId: number,
  quantityToRemove: Decimal,
  includeExpired: boolean,
) {
  const [batches] = await connection.execute<BatchRow[]>(
    `SELECT id, quantity_remaining, batch_code, DATE_FORMAT(expiry_date, '%Y-%m-%d') AS expiry_date, unit_cost
     FROM inventory_batches
     WHERE branch_id = ? AND product_id = ? AND quantity_remaining > 0
     ORDER BY expiry_date IS NULL, expiry_date, id
     FOR UPDATE`,
    [branchId, productId],
  );
  const usable = batches.filter((batch) => includeExpired
    || !batch.expiry_date
    || batch.expiry_date >= new Date().toISOString().slice(0, 10));
  const available = usable.reduce((sum, batch) => sum.plus(batch.quantity_remaining), new Decimal(0));
  if (available.lessThan(quantityToRemove)) {
    throw new HttpError(409, `Only ${available.toFixed(3)} unexpired batch units are available.`);
  }
  let remaining = quantityToRemove;
  const consumed: Array<{
    batchId: number; quantity: Decimal; batchCode: string | null;
    expiryDate: string | null; unitCost: string | null;
  }> = [];
  for (const batch of usable) {
    if (remaining.isZero()) break;
    const take = Decimal.min(remaining, new Decimal(batch.quantity_remaining));
    if (take.isZero()) continue;
    await connection.execute(
      "UPDATE inventory_batches SET quantity_remaining = quantity_remaining - ? WHERE id = ?",
      [take.toFixed(3), batch.id],
    );
    consumed.push({
      batchId: batch.id, quantity: take, batchCode: batch.batch_code ?? null,
      expiryDate: batch.expiry_date, unitCost: batch.unit_cost ?? null,
    });
    remaining = remaining.minus(take);
  }
  return consumed;
}

async function restoreSaleBatches(
  connection: PoolConnection,
  branchId: number,
  productId: number,
  saleItemId: number,
  quantityToRestore: Decimal,
) {
  const [allocations] = await connection.execute<Array<RowDataPacket & {
    inventory_batch_id: number; quantity: string;
  }>>(
    `SELECT sib.inventory_batch_id, SUM(sib.quantity) AS quantity
     FROM sale_item_batches sib JOIN inventory_batches b ON b.id = sib.inventory_batch_id
     WHERE sib.sale_item_id = ? AND b.branch_id = ? AND b.product_id = ?
     GROUP BY sib.inventory_batch_id ORDER BY sib.inventory_batch_id`,
    [saleItemId, branchId, productId],
  );
  let remaining = quantityToRestore;
  for (const allocation of allocations) {
    if (remaining.isZero()) break;
    const restore = Decimal.min(remaining, new Decimal(allocation.quantity));
    if (restore.isZero()) continue;
    await connection.execute(
      "UPDATE inventory_batches SET quantity_remaining = quantity_remaining + ? WHERE id = ?",
      [restore.toFixed(3), allocation.inventory_batch_id],
    );
    remaining = remaining.minus(restore);
  }
  if (remaining.greaterThan(0)) {
    await addInventoryBatch(connection, branchId, productId, remaining, { batchCode: "RETURN-UNTRACKED" });
  }
}

export async function listExpiryBatches(branchId: number, days: number) {
  return query<Array<{
    id: number; product_id: number; name: string; sku: string; batch_code: string | null;
    expiry_date: string | null; quantity_remaining: string; unit: string;
  } & RowDataPacket>>(
    `SELECT b.id, b.product_id, p.name, p.sku, b.batch_code,
            DATE_FORMAT(b.expiry_date, '%Y-%m-%d') AS expiry_date,
            b.quantity_remaining, p.unit
     FROM inventory_batches b JOIN products p ON p.id = b.product_id
     WHERE b.branch_id = ? AND b.quantity_remaining > 0
       AND b.expiry_date IS NOT NULL
       AND b.expiry_date < DATE_ADD(CURDATE(), INTERVAL ? DAY)
     ORDER BY b.expiry_date, p.name LIMIT 500`,
    [branchId, days],
  );
}

export async function listStockTakes(branchId: number) {
  return query<Array<{
    id: number; reference: string; title: string; status: string; created_at: Date; completed_at: Date | null;
    created_by: string; counted_items: number; total_items: number;
  } & RowDataPacket>>(
    `SELECT st.id, st.reference, st.title, st.status, st.created_at, st.completed_at, u.name AS created_by,
            SUM(sti.counted_quantity IS NOT NULL) AS counted_items, COUNT(sti.id) AS total_items
     FROM stock_takes st JOIN users u ON u.id = st.created_by
     LEFT JOIN stock_take_items sti ON sti.stock_take_id = st.id
     WHERE st.branch_id = ? GROUP BY st.id ORDER BY st.created_at DESC LIMIT 50`,
    [branchId],
  );
}

export async function getStockTake(id: number, branchId: number) {
  const [takes, items] = await Promise.all([
    query<Array<{ id: number; reference: string; title: string; status: string; created_at: Date } & RowDataPacket>>(
      "SELECT id, reference, title, status, created_at FROM stock_takes WHERE id = ? AND branch_id = ? LIMIT 1",
      [id, branchId],
    ),
    query<Array<{
      product_id: number; sku: string; name: string; unit: string;
      expected_quantity: string; counted_quantity: string | null; variance: string | null;
    } & RowDataPacket>>(
      `SELECT sti.product_id, p.sku, p.name, p.unit, sti.expected_quantity, sti.counted_quantity, sti.variance
       FROM stock_take_items sti JOIN products p ON p.id = sti.product_id
       JOIN stock_takes st ON st.id = sti.stock_take_id
       WHERE st.id = ? AND st.branch_id = ? ORDER BY p.name`,
      [id, branchId],
    ),
  ]);
  if (!takes[0]) throw new HttpError(404, "Stock take not found.");
  return {
    ...takes[0],
    created_at: takes[0].created_at,
    items,
  };
}

export async function createStockTake(input: z.infer<typeof stockTakeSchema>, user: OperationUser) {
  return withTransaction(async (connection) => {
    const [countRows] = await connection.execute<Array<RowDataPacket & { total: number }>>(
      "SELECT COUNT(*) AS total FROM products WHERE is_active = TRUE",
    );
    if (Number(countRows[0]?.total ?? 0) > 5000) {
      throw new HttpError(422, "A stock take cannot include more than 5,000 active products.");
    }
    const reference = `ST-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 6).toUpperCase()}`;
    const [result] = await connection.execute(
      "INSERT INTO stock_takes (branch_id, reference, title, created_by) VALUES (?, ?, ?, ?)",
      [user.branchId, reference, input.title, user.id],
    );
    const id = (result as { insertId: number }).insertId;
    await connection.execute(
      `INSERT INTO stock_take_items (stock_take_id, product_id, expected_quantity)
       SELECT ?, p.id, COALESCE(i.on_hand, 0)
       FROM products p LEFT JOIN inventory i ON i.product_id = p.id AND i.branch_id = ?
       WHERE p.is_active = TRUE`,
      [id, user.branchId],
    );
    await writeAudit(connection, user.id, "stock_take.created", "stock_take", id, { reference, title: input.title });
    return { id, reference, title: input.title, status: "draft" };
  });
}

export async function completeStockTake(
  id: number,
  input: z.infer<typeof stockTakeCompletionSchema>,
  user: OperationUser,
) {
  return withTransaction(async (connection) => {
    const [takes] = await connection.execute<Array<RowDataPacket & { id: number; branch_id: number; reference: string; status: string }>>(
      "SELECT id, branch_id, reference, status FROM stock_takes WHERE id = ? FOR UPDATE",
      [id],
    );
    const take = takes[0];
    if (!take || take.branch_id !== user.branchId) throw new HttpError(404, "Stock take not found.");
    if (take.status !== "draft") throw new HttpError(409, "This stock take has already been completed.");
    const [items] = await connection.execute<Array<RowDataPacket & { product_id: number; expected_quantity: string }>>(
      "SELECT product_id, expected_quantity FROM stock_take_items WHERE stock_take_id = ? ORDER BY product_id FOR UPDATE",
      [id],
    );
    if (items.length !== input.items.length
      || items.some((item) => !input.items.some((count) => count.productId === item.product_id))) {
      throw new HttpError(400, "Provide one physical count for every product in the stock take.");
    }
    const countByProduct = new Map(input.items.map((item) => [item.productId, new Decimal(item.countedQuantity)]));
    let changed = 0;
    for (const item of items) {
      const counted = countByProduct.get(item.product_id)!;
      await connection.execute(
        "INSERT INTO inventory (branch_id, product_id, on_hand, reserved) VALUES (?, ?, 0, 0) ON DUPLICATE KEY UPDATE product_id = VALUES(product_id)",
        [user.branchId, item.product_id],
      );
      const [balances] = await connection.execute<InventoryRow[]>(
        "SELECT product_id, on_hand, reserved FROM inventory WHERE branch_id = ? AND product_id = ? FOR UPDATE",
        [user.branchId, item.product_id],
      );
      const balance = balances[0];
      if (!balance) throw new Error("Stock take inventory row could not be locked.");
      if (counted.lessThan(balance.reserved)) {
        throw new HttpError(409, `The count for product ${item.product_id} is below its reserved quantity.`);
      }
      const systemQuantity = new Decimal(balance.on_hand);
      const variance = counted.minus(systemQuantity);
      if (!variance.isZero()) {
        if (variance.isPositive()) {
          await addInventoryBatch(connection, user.branchId, item.product_id, variance, { batchCode: take.reference });
        } else {
          await consumeInventoryBatches(connection, user.branchId, item.product_id, variance.abs(), true);
        }
        await connection.execute(
          "UPDATE inventory SET on_hand = ? WHERE branch_id = ? AND product_id = ?",
          [counted.toFixed(3), user.branchId, item.product_id],
        );
        await connection.execute(
          `INSERT INTO stock_movements (branch_id, product_id, movement_type, quantity, reference, created_by)
           VALUES (?, ?, 'stock_take', ?, ?, ?)`,
          [user.branchId, item.product_id, variance.toFixed(3), take.reference, user.id],
        );
        changed += 1;
      }
      await connection.execute(
        "UPDATE stock_take_items SET expected_quantity = ?, counted_quantity = ?, variance = ? WHERE stock_take_id = ? AND product_id = ?",
        [systemQuantity.toFixed(3), counted.toFixed(3), variance.toFixed(3), id, item.product_id],
      );
    }
    await connection.execute(
      "UPDATE stock_takes SET status = 'completed', completed_by = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?",
      [user.id, id],
    );
    await writeAudit(connection, user.id, "stock_take.completed", "stock_take", id, {
      reference: take.reference, productsCounted: items.length, changed,
    });
    return { id, status: "completed", productsCounted: items.length, changed };
  });
}

export async function listTransferBranches(branchId: number) {
  return query<Array<{ id: number; name: string; code: string } & RowDataPacket>>(
    "SELECT id, name, code FROM branches WHERE id <> ? ORDER BY name",
    [branchId],
  );
}

export async function listInventoryTransfers(branchId: number) {
  return query<Array<{
    id: number; reference: string; source_branch_id: number; source_branch: string;
    destination_branch_id: number; destination_branch: string; status: string; notes: string | null;
    created_at: Date; dispatched_at: Date | null; received_at: Date | null;
    total_items: number; quantity_dispatched: string | null; quantity_received: string | null;
  } & RowDataPacket>>(
    `SELECT t.id, t.reference, t.source_branch_id, source.name AS source_branch,
            t.destination_branch_id, destination.name AS destination_branch, t.status, t.notes,
            t.created_at, t.dispatched_at, t.received_at, COUNT(i.id) AS total_items,
            SUM(i.quantity_dispatched) AS quantity_dispatched, SUM(i.quantity_received) AS quantity_received
     FROM inventory_transfers t
     JOIN branches source ON source.id = t.source_branch_id
     JOIN branches destination ON destination.id = t.destination_branch_id
     LEFT JOIN inventory_transfer_items i ON i.transfer_id = t.id
     WHERE t.source_branch_id = ? OR t.destination_branch_id = ?
     GROUP BY t.id ORDER BY t.created_at DESC LIMIT 100`,
    [branchId, branchId],
  );
}

export async function getInventoryTransfer(id: number, branchId: number) {
  const [transfers, items] = await Promise.all([
    query<Array<{
      id: number; reference: string; source_branch_id: number; source_branch: string;
      destination_branch_id: number; destination_branch: string; status: string; notes: string | null;
      created_at: Date; dispatched_at: Date | null; received_at: Date | null;
    } & RowDataPacket>>(
      `SELECT t.id, t.reference, t.source_branch_id, source.name AS source_branch,
              t.destination_branch_id, destination.name AS destination_branch, t.status, t.notes,
              t.created_at, t.dispatched_at, t.received_at
       FROM inventory_transfers t
       JOIN branches source ON source.id = t.source_branch_id
       JOIN branches destination ON destination.id = t.destination_branch_id
       WHERE t.id = ? AND (t.source_branch_id = ? OR t.destination_branch_id = ?) LIMIT 1`,
      [id, branchId, branchId],
    ),
    query<Array<{
      product_id: number; sku: string; name: string; unit: string;
      quantity_requested: string; quantity_dispatched: string | null;
      quantity_received: string | null; quantity_variance: string | null;
    } & RowDataPacket>>(
      `SELECT i.product_id, p.sku, p.name, p.unit, i.quantity_requested, i.quantity_dispatched,
              i.quantity_received, i.quantity_variance
       FROM inventory_transfer_items i
       JOIN inventory_transfers t ON t.id = i.transfer_id
       JOIN products p ON p.id = i.product_id
       WHERE t.id = ? AND (t.source_branch_id = ? OR t.destination_branch_id = ?)
       ORDER BY p.name`,
      [id, branchId, branchId],
    ),
  ]);
  if (!transfers[0]) throw new HttpError(404, "Inventory transfer not found.");
  return { ...transfers[0], items };
}

export async function createInventoryTransfer(input: z.infer<typeof inventoryTransferSchema>, user: AuthUser) {
  return withTransaction(async (connection) => {
    if (input.destinationBranchId === user.branchId) {
      throw new HttpError(400, "The destination must be a different branch.");
    }
    const [branches] = await connection.execute<Array<RowDataPacket & { id: number }>>(
      "SELECT id FROM branches WHERE id = ?",
      [input.destinationBranchId],
    );
    if (!branches[0]) throw new HttpError(404, "Destination branch not found.");
    const productIds = input.items.map((item) => item.productId);
    const placeholders = productIds.map(() => "?").join(", ");
    const [products] = await connection.execute<Array<RowDataPacket & { id: number }>>(
      `SELECT id FROM products WHERE is_active = TRUE AND id IN (${placeholders})`,
      productIds,
    );
    if (products.length !== productIds.length) throw new HttpError(404, "One or more products are unavailable.");

    const reference = `TR-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 6).toUpperCase()}`;
    const [result] = await connection.execute(
      `INSERT INTO inventory_transfers
         (reference, source_branch_id, destination_branch_id, notes, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [reference, user.branchId, input.destinationBranchId, input.notes || null, user.id],
    );
    const id = (result as { insertId: number }).insertId;
    for (const item of input.items) {
      await connection.execute(
        "INSERT INTO inventory_transfer_items (transfer_id, product_id, quantity_requested) VALUES (?, ?, ?)",
        [id, item.productId, item.quantity],
      );
    }
    await writeAudit(connection, user.id, "inventory_transfer.created", "inventory_transfer", id, {
      reference, sourceBranchId: user.branchId, destinationBranchId: input.destinationBranchId,
      products: input.items.length,
    });
    return { id, reference, status: "draft" };
  });
}

export async function dispatchInventoryTransfer(id: number, user: AuthUser) {
  return withTransaction(async (connection) => {
    const [transfers] = await connection.execute<Array<RowDataPacket & {
      id: number; reference: string; source_branch_id: number; status: string;
    }>>(
      "SELECT id, reference, source_branch_id, status FROM inventory_transfers WHERE id = ? FOR UPDATE",
      [id],
    );
    const transfer = transfers[0];
    if (!transfer || transfer.source_branch_id !== user.branchId) throw new HttpError(404, "Inventory transfer not found.");
    if (transfer.status !== "draft") throw new HttpError(409, "Only draft transfers can be dispatched.");
    const [items] = await connection.execute<Array<RowDataPacket & {
      id: number; product_id: number; quantity_requested: string; name: string;
    }>>(
      `SELECT i.id, i.product_id, i.quantity_requested, p.name
       FROM inventory_transfer_items i JOIN products p ON p.id = i.product_id
       WHERE i.transfer_id = ? ORDER BY i.product_id FOR UPDATE`,
      [id],
    );
    for (const item of items) {
      await connection.execute(
        "INSERT INTO inventory (branch_id, product_id, on_hand, reserved) VALUES (?, ?, 0, 0) ON DUPLICATE KEY UPDATE product_id = VALUES(product_id)",
        [user.branchId, item.product_id],
      );
      const [balances] = await connection.execute<InventoryRow[]>(
        "SELECT product_id, on_hand, reserved FROM inventory WHERE branch_id = ? AND product_id = ? FOR UPDATE",
        [user.branchId, item.product_id],
      );
      const balance = balances[0];
      if (!balance) throw new Error("Source inventory row could not be locked.");
      const quantityToSend = new Decimal(item.quantity_requested);
      const available = new Decimal(balance.on_hand).minus(balance.reserved);
      if (available.lessThan(quantityToSend)) {
        throw new HttpError(409, `Only ${available.toFixed(3)} units are available for ${item.name}.`);
      }
      const allocations = await consumeInventoryBatches(connection, user.branchId, item.product_id, quantityToSend, true);
      for (const allocation of allocations) {
        await connection.execute(
          `INSERT INTO inventory_transfer_batches
             (transfer_item_id, source_batch_id, batch_code, expiry_date, unit_cost, quantity_dispatched)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            item.id, allocation.batchId, allocation.batchCode, allocation.expiryDate,
            allocation.unitCost, allocation.quantity.toFixed(3),
          ],
        );
      }
      await connection.execute(
        "UPDATE inventory SET on_hand = on_hand - ? WHERE branch_id = ? AND product_id = ?",
        [quantityToSend.toFixed(3), user.branchId, item.product_id],
      );
      await connection.execute(
        "UPDATE inventory_transfer_items SET quantity_dispatched = ? WHERE id = ?",
        [quantityToSend.toFixed(3), item.id],
      );
      await connection.execute(
        `INSERT INTO stock_movements (branch_id, product_id, movement_type, quantity, reference, created_by)
         VALUES (?, ?, 'transfer', ?, ?, ?)`,
        [user.branchId, item.product_id, quantityToSend.negated().toFixed(3), `${transfer.reference} dispatch`, user.id],
      );
    }
    await connection.execute(
      "UPDATE inventory_transfers SET status = 'in_transit', dispatched_by = ?, dispatched_at = CURRENT_TIMESTAMP WHERE id = ?",
      [user.id, id],
    );
    await writeAudit(connection, user.id, "inventory_transfer.dispatched", "inventory_transfer", id, {
      reference: transfer.reference, products: items.length,
    });
    return { id, status: "in_transit" };
  });
}

export async function receiveInventoryTransfer(
  id: number,
  input: z.infer<typeof inventoryTransferReceiptSchema>,
  user: AuthUser,
) {
  return withTransaction(async (connection) => {
    const [transfers] = await connection.execute<Array<RowDataPacket & {
      id: number; reference: string; destination_branch_id: number; status: string;
    }>>(
      "SELECT id, reference, destination_branch_id, status FROM inventory_transfers WHERE id = ? FOR UPDATE",
      [id],
    );
    const transfer = transfers[0];
    if (!transfer || transfer.destination_branch_id !== user.branchId) throw new HttpError(404, "Inventory transfer not found.");
    if (transfer.status !== "in_transit") throw new HttpError(409, "Only in-transit transfers can be received.");
    const [items] = await connection.execute<Array<RowDataPacket & {
      id: number; product_id: number; quantity_dispatched: string | null; name: string;
    }>>(
      `SELECT i.id, i.product_id, i.quantity_dispatched, p.name
       FROM inventory_transfer_items i JOIN products p ON p.id = i.product_id
       WHERE i.transfer_id = ? ORDER BY i.product_id FOR UPDATE`,
      [id],
    );
    if (items.length !== input.items.length
      || items.some((item) => !input.items.some((received) => received.productId === item.product_id))) {
      throw new HttpError(400, "Provide one received quantity for every product in the transfer.");
    }
    const quantityByProduct = new Map(input.items.map((item) => [item.productId, new Decimal(item.receivedQuantity)]));
    const discrepancies: Array<{ productId: number; sent: string; received: string; variance: string }> = [];
    for (const item of items) {
      const sent = item.quantity_dispatched ? new Decimal(item.quantity_dispatched) : new Decimal(0);
      const received = quantityByProduct.get(item.product_id)!;
      if (received.greaterThan(sent)) {
        throw new HttpError(400, `Received quantity cannot exceed the dispatched quantity for ${item.name}.`);
      }
      const variance = received.minus(sent);
      if (!variance.isZero()) {
        discrepancies.push({
          productId: item.product_id, sent: sent.toFixed(3),
          received: received.toFixed(3), variance: variance.toFixed(3),
        });
      }
      const [allocations] = await connection.execute<Array<RowDataPacket & {
        batch_code: string | null; expiry_date: string | null; unit_cost: string | null; quantity_dispatched: string;
      }>>(
        `SELECT batch_code, DATE_FORMAT(expiry_date, '%Y-%m-%d') AS expiry_date, unit_cost, quantity_dispatched
         FROM inventory_transfer_batches WHERE transfer_item_id = ?
         ORDER BY expiry_date IS NULL, expiry_date, source_batch_id`,
        [item.id],
      );
      if (sent.greaterThan(0) && !allocations.length) {
        throw new Error("Dispatched transfer is missing its source batch allocations.");
      }
      let remaining = received;
      for (const allocation of allocations) {
        if (remaining.isZero()) break;
        const quantityToReceive = Decimal.min(remaining, new Decimal(allocation.quantity_dispatched));
        if (!quantityToReceive.greaterThan(0)) continue;
        await addInventoryBatch(connection, user.branchId, item.product_id, quantityToReceive, {
          batchCode: allocation.batch_code, expiryDate: allocation.expiry_date, unitCost: allocation.unit_cost,
        });
        remaining = remaining.minus(quantityToReceive);
      }
      if (remaining.greaterThan(0)) throw new Error("Received quantity exceeds the dispatched batch allocation.");
      if (received.greaterThan(0)) {
        await connection.execute(
          "INSERT INTO inventory (branch_id, product_id, on_hand, reserved) VALUES (?, ?, 0, 0) ON DUPLICATE KEY UPDATE product_id = VALUES(product_id)",
          [user.branchId, item.product_id],
        );
        await connection.execute(
          "UPDATE inventory SET on_hand = on_hand + ? WHERE branch_id = ? AND product_id = ?",
          [received.toFixed(3), user.branchId, item.product_id],
        );
        await connection.execute(
          `INSERT INTO stock_movements (branch_id, product_id, movement_type, quantity, reference, created_by)
           VALUES (?, ?, 'transfer', ?, ?, ?)`,
          [user.branchId, item.product_id, received.toFixed(3), `${transfer.reference} receipt`, user.id],
        );
      }
      await connection.execute(
        "UPDATE inventory_transfer_items SET quantity_received = ?, quantity_variance = ? WHERE id = ?",
        [received.toFixed(3), variance.toFixed(3), item.id],
      );
    }
    await connection.execute(
      "UPDATE inventory_transfers SET status = 'received', received_by = ?, received_at = CURRENT_TIMESTAMP WHERE id = ?",
      [user.id, id],
    );
    await writeAudit(connection, user.id, "inventory_transfer.received", "inventory_transfer", id, {
      reference: transfer.reference, products: items.length, discrepancies,
    });
    return { id, status: "received", discrepancies };
  });
}

export async function listSuppliers() {
  return query<Array<{ id: number; name: string; contact_name: string | null; email: string | null; phone: string | null; tax_pin: string | null } & RowDataPacket>>(
    "SELECT id, name, contact_name, email, phone, tax_pin FROM suppliers WHERE is_active = TRUE ORDER BY name LIMIT 250",
  );
}

export async function createSupplier(input: z.infer<typeof supplierSchema>, user: OperationUser) {
  return withTransaction(async (connection) => {
    const [result] = await connection.execute(
      "INSERT INTO suppliers (name, contact_name, email, phone, address, tax_pin) VALUES (?, ?, ?, ?, ?, ?)",
      [input.name, input.contactName || null, input.email || null, input.phone || null, input.address || null, input.taxPin || null],
    );
    const id = (result as { insertId: number }).insertId;
    await writeAudit(connection, user.id, "supplier.created", "supplier", id, { name: input.name });
    return { id, name: input.name };
  });
}

export async function listPurchaseOrders(branchId: number) {
  return query<Array<{
    id: number; order_number: string; status: string; supplier_name: string; created_at: Date;
    item_count: number; ordered_quantity: string; received_quantity: string;
  } & RowDataPacket>>(
    `SELECT po.id, po.order_number, po.status, s.name AS supplier_name, po.created_at,
            COUNT(poi.id) AS item_count, COALESCE(SUM(poi.quantity_ordered), 0) AS ordered_quantity,
            COALESCE(SUM(poi.quantity_received), 0) AS received_quantity
     FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
     LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
     WHERE po.branch_id = ? GROUP BY po.id ORDER BY po.created_at DESC LIMIT 100`,
    [branchId],
  );
}

export async function getPurchaseOrder(id: number, branchId: number) {
  const [orders, items] = await Promise.all([
    query<Array<{
      id: number; order_number: string; status: string; supplier_name: string; created_at: Date; notes: string | null;
    } & RowDataPacket>>(
      `SELECT po.id, po.order_number, po.status, s.name AS supplier_name, po.created_at, po.notes
       FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
       WHERE po.id = ? AND po.branch_id = ? LIMIT 1`,
      [id, branchId],
    ),
    query<Array<{
      id: number; product_id: number; name: string; sku: string; quantity_ordered: string;
      quantity_received: string; unit_cost: string;
    } & RowDataPacket>>(
      `SELECT poi.id, poi.product_id, p.name, p.sku, poi.quantity_ordered, poi.quantity_received, poi.unit_cost
       FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.purchase_order_id
       JOIN products p ON p.id = poi.product_id
       WHERE po.id = ? AND po.branch_id = ? ORDER BY p.name`,
      [id, branchId],
    ),
  ]);
  if (!orders[0]) throw new HttpError(404, "Purchase order not found.");
  return {
    order: { id: orders[0].id, orderNumber: orders[0].order_number, status: orders[0].status,
      supplier: orders[0].supplier_name, notes: orders[0].notes, createdAt: orders[0].created_at.toISOString() },
    items: items.map((item) => ({
      id: item.id, productId: item.product_id, name: item.name, sku: item.sku,
      quantityOrdered: item.quantity_ordered, quantityReceived: item.quantity_received, unitCost: item.unit_cost,
    })),
  };
}

export async function createPurchaseOrder(input: z.infer<typeof purchaseOrderSchema>, user: OperationUser) {
  return withTransaction(async (connection) => {
    const [supplierRows] = await connection.execute<Array<RowDataPacket & { id: number }>>(
      "SELECT id FROM suppliers WHERE id = ? AND is_active = TRUE",
      [input.supplierId],
    );
    if (!supplierRows[0]) throw new HttpError(404, "Supplier not found.");
    const orderNumber = `PO-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 6).toUpperCase()}`;
    const [result] = await connection.execute(
      "INSERT INTO purchase_orders (branch_id, supplier_id, order_number, notes, created_by) VALUES (?, ?, ?, ?, ?)",
      [user.branchId, input.supplierId, orderNumber, input.notes || null, user.id],
    );
    const id = (result as { insertId: number }).insertId;
    for (const item of input.items) {
      const [products] = await connection.execute<Array<RowDataPacket & { id: number }>>(
        "SELECT id FROM products WHERE id = ? AND is_active = TRUE",
        [item.productId],
      );
      if (!products[0]) throw new HttpError(404, `Product ${item.productId} not found.`);
      await connection.execute(
        "INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity_ordered, unit_cost) VALUES (?, ?, ?, ?)",
        [id, item.productId, item.quantity, item.unitCost],
      );
    }
    await writeAudit(connection, user.id, "purchase_order.created", "purchase_order", id, { orderNumber, status: "draft" });
    return { id, orderNumber, status: "draft" };
  });
}

export async function approvePurchaseOrder(id: number, user: OperationUser) {
  return withTransaction(async (connection) => {
    const [orders] = await connection.execute<Array<RowDataPacket & { id: number; status: string; branch_id: number }>>(
      "SELECT id, status, branch_id FROM purchase_orders WHERE id = ? FOR UPDATE",
      [id],
    );
    const order = orders[0];
    if (!order || order.branch_id !== user.branchId) throw new HttpError(404, "Purchase order not found.");
    if (order.status !== "draft") throw new HttpError(409, "Only draft purchase orders can be approved.");
    await connection.execute("UPDATE purchase_orders SET status = 'ordered' WHERE id = ?", [id]);
    await writeAudit(connection, user.id, "purchase_order.approved", "purchase_order", id, {});
    return { id, status: "ordered" };
  });
}

export async function receivePurchaseOrder(
  orderId: number,
  input: z.infer<typeof receiveSchema>,
  user: OperationUser,
) {
  return withTransaction(async (connection) => {
    const [orders] = await connection.execute<Array<RowDataPacket & { id: number; status: string; branch_id: number }>>(
      "SELECT id, status, branch_id FROM purchase_orders WHERE id = ? FOR UPDATE",
      [orderId],
    );
    const order = orders[0];
    if (!order || order.branch_id !== user.branchId) throw new HttpError(404, "Purchase order not found.");
    if (!["ordered", "partially_received"].includes(order.status)) {
      throw new HttpError(409, "Only approved purchase orders can receive goods.");
    }
    const grnNumber = input.reference || `GRN-${randomUUID().slice(0, 8).toUpperCase()}`;
    const [result] = await connection.execute(
      "INSERT INTO goods_received_notes (purchase_order_id, received_by, reference) VALUES (?, ?, ?)",
      [orderId, user.id, grnNumber],
    );
    const grnId = (result as { insertId: number }).insertId;
    let remainingItems = 0;
    for (const received of input.items) {
      const [itemRows] = await connection.execute<Array<RowDataPacket & {
        id: number; product_id: number; quantity_ordered: string; quantity_received: string; unit_cost: string;
      }>>(
        `SELECT id, product_id, quantity_ordered, quantity_received, unit_cost
         FROM purchase_order_items WHERE id = ? AND purchase_order_id = ? FOR UPDATE`,
        [received.purchaseOrderItemId, orderId],
      );
      const item = itemRows[0];
      if (!item) throw new HttpError(404, "Purchase order line not found.");
      const newReceived = new Decimal(item.quantity_received).plus(received.quantity);
      if (newReceived.greaterThan(item.quantity_ordered)) {
        throw new HttpError(409, `Received quantity exceeds the order quantity for product ${item.product_id}.`);
      }
      await connection.execute("UPDATE purchase_order_items SET quantity_received = ? WHERE id = ?", [newReceived.toFixed(3), item.id]);
      await connection.execute(
        "INSERT INTO goods_received_items (grn_id, product_id, quantity, unit_cost) VALUES (?, ?, ?, ?)",
        [grnId, item.product_id, received.quantity, item.unit_cost],
      );
      await addInventoryBatch(connection, user.branchId, item.product_id, new Decimal(received.quantity), {
        batchCode: received.batchCode || grnNumber,
        expiryDate: received.expiryDate ?? null,
        unitCost: item.unit_cost,
      });
      await connection.execute(
        "INSERT INTO inventory (branch_id, product_id, on_hand) VALUES (?, ?, 0) ON DUPLICATE KEY UPDATE product_id = VALUES(product_id)",
        [user.branchId, item.product_id],
      );
      const [inventoryRows] = await connection.execute<InventoryRow[]>(
        "SELECT product_id, on_hand, reserved FROM inventory WHERE branch_id = ? AND product_id = ? FOR UPDATE",
        [user.branchId, item.product_id],
      );
      if (!inventoryRows[0]) throw new Error("Inventory row could not be locked.");
      const next = new Decimal(inventoryRows[0].on_hand).plus(received.quantity);
      const [productRows] = await connection.execute<Array<RowDataPacket & { purchase_price: string | null }>>(
        "SELECT purchase_price FROM products WHERE id = ? FOR UPDATE",
        [item.product_id],
      );
      if (!productRows[0]) throw new Error("Received product could not be locked.");
      const oldQuantity = new Decimal(inventoryRows[0].on_hand);
      const receivedQuantity = new Decimal(received.quantity);
      const oldCost = productRows[0].purchase_price ? new Decimal(productRows[0].purchase_price) : null;
      const weightedCost = oldCost && oldQuantity.greaterThan(0)
        ? oldQuantity.times(oldCost).plus(receivedQuantity.times(item.unit_cost))
          .dividedBy(oldQuantity.plus(receivedQuantity)).toDecimalPlaces(2)
        : new Decimal(item.unit_cost);
      await connection.execute("UPDATE products SET purchase_price = ? WHERE id = ?", [
        weightedCost.toFixed(2), item.product_id,
      ]);
      await connection.execute(
        "UPDATE inventory SET on_hand = ? WHERE branch_id = ? AND product_id = ?",
        [next.toFixed(3), user.branchId, item.product_id],
      );
      await connection.execute(
        `INSERT INTO stock_movements (branch_id, product_id, movement_type, quantity, reference, created_by)
         VALUES (?, ?, 'receipt', ?, ?, ?)`,
        [user.branchId, item.product_id, received.quantity, grnNumber, user.id],
      );
    }
    const [incompleteRows] = await connection.execute<Array<RowDataPacket & { count: number }>>(
      "SELECT COUNT(*) AS count FROM purchase_order_items WHERE purchase_order_id = ? AND quantity_received < quantity_ordered",
      [orderId],
    );
    remainingItems = Number(incompleteRows[0]?.count ?? 0);
    const nextStatus = remainingItems === 0 ? "received" : "partially_received";
    await connection.execute("UPDATE purchase_orders SET status = ? WHERE id = ?", [nextStatus, orderId]);
    await writeAudit(connection, user.id, "purchase_order.received", "purchase_order", orderId, { grnNumber, status: nextStatus });
    return { id: grnId, reference: grnNumber, orderStatus: nextStatus };
  });
}

export async function listCustomers(search: string) {
  return query<Array<{ id: number; name: string; phone: string | null; email: string | null; created_at: Date; sales_count: number; lifetime_value: string } & RowDataPacket>>(
    `SELECT c.id, c.name, c.phone, c.email, c.created_at, COUNT(s.id) AS sales_count,
            COALESCE(SUM(CASE WHEN s.status = 'completed' THEN s.total ELSE 0 END), 0) AS lifetime_value
     FROM customers c LEFT JOIN sales s ON s.customer_id = c.id
     WHERE (? = '' OR c.name LIKE CONCAT('%', ?, '%') OR c.phone = ?)
     GROUP BY c.id ORDER BY c.name LIMIT 250`,
    [search, search, search],
  );
}

export async function createCustomer(input: z.infer<typeof customerSchema>, user: OperationUser) {
  try {
    return await withTransaction(async (connection) => {
      const [result] = await connection.execute(
        "INSERT INTO customers (name, phone, email, address) VALUES (?, ?, ?, ?)",
        [input.name, input.phone || null, input.email || null, input.address || null],
      );
      const id = (result as { insertId: number }).insertId;
      await writeAudit(connection, user.id, "customer.created", "customer", id, { name: input.name });
      return { id, name: input.name };
    });
  } catch (error) {
    throw error;
  }
}

export async function getActiveShift(user: OperationUser) {
  const rows = await query<Array<{
    id: number; opening_cash: string; opened_at: Date; cashier_id: number;
  } & RowDataPacket>>(
    `SELECT id, opening_cash, opened_at, cashier_id FROM cashier_shifts
     WHERE branch_id = ? AND cashier_id = ? AND status = 'open' LIMIT 1`,
    [user.branchId, user.id],
  );
  if (!rows[0]) return null;
  return { id: rows[0].id, openingCash: rows[0].opening_cash, openedAt: rows[0].opened_at.toISOString() };
}

export async function openShift(input: z.infer<typeof openShiftSchema>, user: OperationUser) {
  try {
    return await withTransaction(async (connection) => {
    const [existing] = await connection.execute<Array<RowDataPacket & { id: number }>>(
      "SELECT id FROM cashier_shifts WHERE branch_id = ? AND cashier_id = ? AND status = 'open' FOR UPDATE",
      [user.branchId, user.id],
    );
    if (existing[0]) throw new HttpError(409, "You already have an open shift.");
    const [result] = await connection.execute(
      "INSERT INTO cashier_shifts (branch_id, cashier_id, opening_cash) VALUES (?, ?, ?)",
      [user.branchId, user.id, input.openingCash],
    );
    const id = (result as { insertId: number }).insertId;
    await writeAudit(connection, user.id, "shift.opened", "shift", id, { openingCash: input.openingCash });
      return { id, openingCash: input.openingCash };
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ER_DUP_ENTRY") {
      throw new HttpError(409, "You already have an open shift.");
    }
    throw error;
  }
}

export async function addCashMovement(input: z.infer<typeof cashMovementSchema>, user: OperationUser) {
  return withTransaction(async (connection) => {
    const [shifts] = await connection.execute<Array<RowDataPacket & { id: number }>>(
      "SELECT id FROM cashier_shifts WHERE branch_id = ? AND cashier_id = ? AND status = 'open' FOR UPDATE",
      [user.branchId, user.id],
    );
    const shiftId = shifts[0]?.id;
    if (!shiftId) throw new HttpError(409, "Open a cashier shift before recording drawer movements.");
    const [result] = await connection.execute(
      "INSERT INTO cash_movements (shift_id, movement_type, amount, description, created_by) VALUES (?, ?, ?, ?, ?)",
      [shiftId, input.type, input.amount, input.description, user.id],
    );
    const id = (result as { insertId: number }).insertId;
    await writeAudit(connection, user.id, `cash.${input.type}`, "cash_movement", id, {
      amount: input.amount, description: input.description,
    });
    return { id, shiftId };
  });
}

export async function closeShift(input: z.infer<typeof closeShiftSchema>, user: OperationUser) {
  return withTransaction(async (connection) => {
    const [shifts] = await connection.execute<Array<RowDataPacket & { id: number; opening_cash: string }>>(
      "SELECT id, opening_cash FROM cashier_shifts WHERE branch_id = ? AND cashier_id = ? AND status = 'open' FOR UPDATE",
      [user.branchId, user.id],
    );
    const shift = shifts[0];
    if (!shift) throw new HttpError(409, "There is no open cashier shift.");
    const [cashSales] = await connection.execute<Array<RowDataPacket & { amount: string }>>(
      `SELECT COALESCE(SUM(sp.amount), 0) AS amount FROM sale_payments sp
       JOIN sales s ON s.id = sp.sale_id
       WHERE s.shift_id = ? AND s.status = 'completed' AND sp.method = 'cash' AND sp.status = 'completed'`,
      [shift.id],
    );
    const [cashMovements] = await connection.execute<Array<RowDataPacket & { deposits: string; withdrawals: string }>>(
      `SELECT COALESCE(SUM(CASE WHEN movement_type = 'deposit' THEN amount ELSE 0 END), 0) AS deposits,
              COALESCE(SUM(CASE WHEN movement_type = 'withdrawal' THEN amount ELSE 0 END), 0) AS withdrawals
       FROM cash_movements WHERE shift_id = ?`,
      [shift.id],
    );
    const [cashExpenses] = await connection.execute<Array<RowDataPacket & { amount: string }>>(
      "SELECT COALESCE(SUM(amount), 0) AS amount FROM expenses WHERE shift_id = ? AND payment_method = 'cash' AND status = 'approved'",
      [shift.id],
    );
    const expected = new Decimal(shift.opening_cash)
      .plus(cashSales[0]?.amount ?? 0)
      .plus(cashMovements[0]?.deposits ?? 0)
      .minus(cashMovements[0]?.withdrawals ?? 0)
      .minus(cashExpenses[0]?.amount ?? 0)
      .toDecimalPlaces(2);
    const actual = new Decimal(input.actualCash);
    const variance = actual.minus(expected).toDecimalPlaces(2);
    await connection.execute(
      "UPDATE cashier_shifts SET closing_expected = ?, closing_actual = ?, status = 'closed', closed_at = NOW() WHERE id = ?",
      [expected.toFixed(2), actual.toFixed(2), shift.id],
    );
    await writeAudit(connection, user.id, "shift.closed", "shift", shift.id, {
      expected: expected.toFixed(2), actual: actual.toFixed(2), variance: variance.toFixed(2),
    });
    return { id: shift.id, expected: expected.toFixed(2), actual: actual.toFixed(2), variance: variance.toFixed(2) };
  });
}

export async function listExpenses(branchId: number) {
  return query<Array<{
    id: number; amount: string; description: string; payment_method: string; status: string;
    category: string; created_at: Date; created_by_name: string; shift_id: number | null;
  } & RowDataPacket>>(
    `SELECT e.id, e.amount, e.description, e.payment_method, e.status, ec.name AS category,
            e.created_at, u.name AS created_by_name, e.shift_id
     FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id JOIN users u ON u.id = e.created_by
     WHERE e.branch_id = ? ORDER BY e.created_at DESC LIMIT 100`,
    [branchId],
  );
}

export async function createExpense(input: z.infer<typeof expenseSchema>, user: OperationUser) {
  return withTransaction(async (connection) => {
    await connection.execute("INSERT IGNORE INTO expense_categories (name) VALUES (?)", [input.category]);
    const [categoryRows] = await connection.execute<Array<RowDataPacket & { id: number }>>(
      "SELECT id FROM expense_categories WHERE name = ?",
      [input.category],
    );
    if (!categoryRows[0]) throw new Error("Expense category could not be created.");
    const [shifts] = input.paymentMethod === "cash"
      ? await connection.execute<Array<RowDataPacket & { id: number }>>(
        "SELECT id FROM cashier_shifts WHERE branch_id = ? AND cashier_id = ? AND status = 'open' LIMIT 1",
        [user.branchId, user.id],
      )
      : [[] as Array<RowDataPacket & { id: number }>];
    const shiftId = shifts[0]?.id ?? null;
    if (input.paymentMethod === "cash" && !shiftId) throw new HttpError(409, "Cash expenses must be recorded during an open shift.");
    const [result] = await connection.execute(
      "INSERT INTO expenses (branch_id, category_id, shift_id, amount, description, payment_method, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [user.branchId, categoryRows[0].id, shiftId, input.amount, input.description, input.paymentMethod, user.id],
    );
    const id = (result as { insertId: number }).insertId;
    await writeAudit(connection, user.id, "expense.created", "expense", id, { amount: input.amount, status: "pending" });
    return { id, status: "pending" };
  });
}

export async function decideExpense(id: number, decision: "approved" | "rejected", user: OperationUser) {
  return withTransaction(async (connection) => {
    const [expenses] = await connection.execute<Array<RowDataPacket & {
      id: number; status: string; branch_id: number; shift_id: number | null; amount: string; payment_method: string;
    }>>(
      "SELECT id, status, branch_id, shift_id, amount, payment_method FROM expenses WHERE id = ? FOR UPDATE",
      [id],
    );
    const expense = expenses[0];
    if (!expense || expense.branch_id !== user.branchId) throw new HttpError(404, "Expense not found.");
    if (expense.status !== "pending") throw new HttpError(409, "This expense has already been reviewed.");
    if (decision === "approved" && expense.payment_method === "cash" && expense.shift_id) {
      const [shifts] = await connection.execute<Array<RowDataPacket & { status: string }>>(
        "SELECT status FROM cashier_shifts WHERE id = ? FOR UPDATE",
        [expense.shift_id],
      );
      if (shifts[0]?.status !== "open") throw new HttpError(409, "Cash expenses must be approved before the shift is closed.");
    }
    await connection.execute("UPDATE expenses SET status = ?, approved_by = ? WHERE id = ?", [decision, user.id, id]);
    await writeAudit(connection, user.id, `expense.${decision}`, "expense", id, { amount: expense.amount });
    return { id, status: decision };
  });
}

export async function createRefund(
  saleId: number,
  input: z.infer<typeof refundSchema>,
  user: OperationUser,
) {
  return withTransaction(async (connection) => {
    const [sales] = await connection.execute<Array<RowDataPacket & { id: number; branch_id: number; status: string; receipt_number: string }>>(
      "SELECT id, branch_id, status, receipt_number FROM sales WHERE id = ? FOR UPDATE",
      [saleId],
    );
    const sale = sales[0];
    if (!sale || sale.branch_id !== user.branchId) throw new HttpError(404, "Sale not found.");
    if (sale.status !== "completed") throw new HttpError(409, "Only completed sales can be returned.");

    const refundNumber = `RF-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 6).toUpperCase()}`;
    const refundLines: Array<{
      saleItemId: number; productId: number; quantity: Decimal; amount: Decimal; netAmount: Decimal; name: string;
    }> = [];
    for (const requested of input.items) {
      const [rows] = await connection.execute<Array<RowDataPacket & {
        id: number; product_id: number; name_snapshot: string; quantity: string;
        line_total: string; net_total: string; refunded: string; refunded_amount: string; refunded_net: string;
      }>>(
        `SELECT si.id, si.product_id, si.name_snapshot, si.quantity, si.line_total, si.net_total,
                COALESCE((SELECT SUM(ri.quantity) FROM refund_items ri WHERE ri.sale_item_id = si.id), 0) AS refunded,
                COALESCE((SELECT SUM(ri.amount) FROM refund_items ri WHERE ri.sale_item_id = si.id), 0) AS refunded_amount,
                COALESCE((SELECT SUM(ri.net_amount) FROM refund_items ri WHERE ri.sale_item_id = si.id), 0) AS refunded_net
         FROM sale_items si WHERE si.id = ? AND si.sale_id = ? FOR UPDATE`,
        [requested.saleItemId, saleId],
      );
      const line = rows[0];
      if (!line) throw new HttpError(404, "Sale line not found.");
      const refundQuantity = new Decimal(requested.quantity);
      const refundAmount = calculateRefundAmount(
        line.line_total, line.quantity, String(line.refunded), String(line.refunded_amount), requested.quantity,
      );
      const refundNetAmount = calculateRefundAmount(
        line.net_total, line.quantity, String(line.refunded), String(line.refunded_net), requested.quantity,
      );
      refundLines.push({
        saleItemId: line.id, productId: line.product_id, quantity: refundQuantity,
        amount: refundAmount, netAmount: refundNetAmount, name: line.name_snapshot,
      });
    }
    const total = refundLines.reduce((sum, line) => sum.plus(line.amount), new Decimal(0)).toDecimalPlaces(2);
    const [result] = await connection.execute(
      "INSERT INTO refunds (sale_id, branch_id, refund_number, reason, total, status, created_by) VALUES (?, ?, ?, ?, ?, 'completed', ?)",
      [saleId, user.branchId, refundNumber, input.reason, total.toFixed(2), user.id],
    );
    const refundId = (result as { insertId: number }).insertId;
    for (const line of refundLines) {
      await connection.execute(
        "INSERT INTO refund_items (refund_id, sale_item_id, product_id, quantity, amount, net_amount) VALUES (?, ?, ?, ?, ?, ?)",
        [refundId, line.saleItemId, line.productId, line.quantity.toFixed(3), line.amount.toFixed(2), line.netAmount.toFixed(2)],
      );
      await restoreSaleBatches(connection, user.branchId, line.productId, line.saleItemId, line.quantity);
      await connection.execute(
        "INSERT INTO inventory (branch_id, product_id, on_hand) VALUES (?, ?, 0) ON DUPLICATE KEY UPDATE product_id = VALUES(product_id)",
        [user.branchId, line.productId],
      );
      const [stockRows] = await connection.execute<InventoryRow[]>(
        "SELECT product_id, on_hand, reserved FROM inventory WHERE branch_id = ? AND product_id = ? FOR UPDATE",
        [user.branchId, line.productId],
      );
      if (!stockRows[0]) throw new Error("Inventory row could not be locked.");
      const newOnHand = new Decimal(stockRows[0].on_hand).plus(line.quantity);
      await connection.execute("UPDATE inventory SET on_hand = ? WHERE branch_id = ? AND product_id = ?", [
        newOnHand.toFixed(3), user.branchId, line.productId,
      ]);
      await connection.execute(
        `INSERT INTO stock_movements (branch_id, product_id, movement_type, quantity, reference, created_by)
         VALUES (?, ?, 'return', ?, ?, ?)`,
        [user.branchId, line.productId, line.quantity.toFixed(3), refundNumber, user.id],
      );
    }
    await writeAudit(connection, user.id, "sale.refunded", "sale", saleId, {
      refundNumber, reason: input.reason, total: total.toFixed(2), receiptNumber: sale.receipt_number,
    });
    return { id: refundId, refundNumber, total: total.toFixed(2), status: "completed" };
  });
}

export async function listRefunds(branchId: number) {
  return query<Array<{
    id: number; sale_id: number; refund_number: string; reason: string; total: string; created_at: Date;
    receipt_number: string; created_by_name: string;
  } & RowDataPacket>>(
    `SELECT r.id, r.sale_id, r.refund_number, r.reason, r.total, r.created_at,
            s.receipt_number, u.name AS created_by_name
     FROM refunds r JOIN sales s ON s.id = r.sale_id JOIN users u ON u.id = r.created_by
     WHERE r.branch_id = ? ORDER BY r.created_at DESC LIMIT 100`,
    [branchId],
  );
}
