import { z } from "zod";
import { withTransaction } from "./db.js";
import type { AuthUser } from "./auth.js";
import { HttpError } from "./errors.js";

const decimal = (maxIntegerDigits: number, maxFractionDigits: number) =>
  new RegExp(`^\\d{1,${maxIntegerDigits}}(\\.\\d{1,${maxFractionDigits}})?$`);
const productMoney = z.string().regex(decimal(10, 2)).refine((value) => Number(value) > 0, "Price must be greater than zero.");
const productQuantity = z.string().regex(decimal(9, 3)).refine((value) => Number(value) >= 0, "Quantity cannot be negative.");

export const productSchema = z.object({
  sku: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  barcode: z.string().trim().max(64).optional().transform((value) => value || null),
  name: z.string().trim().min(2).max(180),
  brand: z.string().trim().max(120).optional().transform((value) => value || null),
  packageSize: z.string().trim().max(80).optional().transform((value) => value || null),
  description: z.string().trim().max(2000).optional().transform((value) => value || null),
  category: z.string().trim().min(2).max(100),
  unit: z.enum(["piece", "packet", "carton", "kg", "g", "litre", "ml"]),
  sellingPrice: productMoney,
  purchasePrice: z.union([z.string().regex(decimal(10, 2)), z.literal("")]).optional(),
  taxRate: z.string().regex(decimal(3, 2)).refine((value) => Number(value) <= 100, "Tax rate must be between 0 and 100."),
  reorderLevel: productQuantity,
  openingStock: productQuantity.default("0"),
}).strict();

export type NewProduct = z.infer<typeof productSchema>;

export const updateProductSchema = z.object({
  sku: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/).optional(),
  barcode: z.union([z.string().trim().max(64), z.null()]).optional(),
  name: z.string().trim().min(2).max(180).optional(),
  brand: z.union([z.string().trim().max(120), z.null()]).optional(),
  packageSize: z.union([z.string().trim().max(80), z.null()]).optional(),
  description: z.union([z.string().trim().max(2000), z.null()]).optional(),
  category: z.string().trim().min(2).max(100).optional(),
  unit: z.enum(["piece", "packet", "carton", "kg", "g", "litre", "ml"]).optional(),
  sellingPrice: productMoney.optional(),
  purchasePrice: z.union([z.string().regex(decimal(10, 2)), z.null()]).optional(),
  taxRate: z.string().regex(decimal(3, 2)).refine((value) => Number(value) <= 100).optional(),
  reorderLevel: productQuantity.optional(),
  isActive: z.boolean().optional(),
  priceChangeReason: z.string().trim().min(2).max(500).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Provide at least one product field to update.");

export async function registerProduct(input: NewProduct, user: AuthUser) {
  try {
    return await withTransaction(async (connection) => {
      await connection.execute("INSERT IGNORE INTO categories (name) VALUES (?)", [input.category]);
      const [categoryRows] = await connection.execute<Array<{ id: number } & import("mysql2").RowDataPacket>>(
        "SELECT id FROM categories WHERE name = ?",
        [input.category],
      );
      if (!categoryRows[0]) throw new Error("The requested product category could not be created.");
      const [result] = await connection.execute(
        `INSERT INTO products
         (category_id, sku, barcode, name, brand, package_size, description, unit, selling_price, purchase_price, tax_rate, reorder_level)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          categoryRows[0].id, input.sku, input.barcode, input.name, input.brand, input.packageSize, input.description, input.unit,
          input.sellingPrice, input.purchasePrice || null, input.taxRate, input.reorderLevel,
        ],
      );
      const productId = (result as { insertId: number }).insertId;
      const openingStock = Number(input.openingStock);
      await connection.execute(
        "INSERT INTO inventory (branch_id, product_id, on_hand, reserved) VALUES (?, ?, ?, 0)",
        [user.branchId, productId, input.openingStock],
      );
      if (openingStock > 0) {
        await connection.execute(
          "INSERT INTO inventory_batches (branch_id, product_id, batch_code, quantity_received, quantity_remaining) VALUES (?, ?, ?, ?, ?)",
          [user.branchId, productId, `OPEN-${input.sku}`, input.openingStock, input.openingStock],
        );
        if (input.purchasePrice) {
          await connection.execute(
            "UPDATE inventory_batches SET unit_cost = ? WHERE branch_id = ? AND product_id = ? AND batch_code = ?",
            [input.purchasePrice, user.branchId, productId, `OPEN-${input.sku}`],
          );
        }
        await connection.execute(
          `INSERT INTO stock_movements (branch_id, product_id, movement_type, quantity, reference, created_by)
           VALUES (?, ?, 'opening', ?, ?, ?)`,
          [user.branchId, productId, input.openingStock, `OPEN:${input.sku}`, user.id],
        );
      }
      await connection.execute(
        "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES (?, 'product.created', 'product', ?, ?)",
        [user.id, String(productId), JSON.stringify({ sku: input.sku, name: input.name, openingStock: input.openingStock })],
      );
      return { id: productId, sku: input.sku, name: input.name, openingStock: input.openingStock };
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ER_DUP_ENTRY") {
      throw new HttpError(409, "That SKU or barcode is already assigned to a product.");
    }
    throw error;
  }
}

export async function updateProduct(id: number, input: z.infer<typeof updateProductSchema>, user: AuthUser) {
  try {
    return await withTransaction(async (connection) => {
      const [products] = await connection.execute<Array<{
        id: number; is_active: number; purchase_price: string | null; selling_price: string;
      } & import("mysql2").RowDataPacket>>(
        "SELECT id, is_active, purchase_price, selling_price FROM products WHERE id = ? FOR UPDATE",
        [id],
      );
      if (!products[0]) throw new HttpError(404, "Product not found.");
      if (input.isActive === false && products[0].is_active) {
        const [inventory] = await connection.execute<Array<{ on_hand: string; reserved: string } & import("mysql2").RowDataPacket>>(
          "SELECT COALESCE(on_hand, 0) AS on_hand, COALESCE(reserved, 0) AS reserved FROM inventory WHERE product_id = ? FOR UPDATE",
          [id],
        );
        if (inventory.some((row) => Number(row.on_hand) > 0 || Number(row.reserved) > 0)) {
          throw new HttpError(409, "A product with on-hand or reserved stock cannot be archived.");
        }
        const [orders] = await connection.execute<Array<{ id: number } & import("mysql2").RowDataPacket>>(
          `SELECT poi.id FROM purchase_order_items poi
           JOIN purchase_orders po ON po.id = poi.purchase_order_id
           WHERE poi.product_id = ? AND po.status IN ('draft', 'ordered', 'partially_received')
           LIMIT 1`,
          [id],
        );
        if (orders[0]) throw new HttpError(409, "A product on an open purchase order cannot be archived.");
      }

      let categoryId: number | undefined;
      if (input.category !== undefined) {
        await connection.execute("INSERT IGNORE INTO categories (name) VALUES (?)", [input.category]);
        const [categories] = await connection.execute<Array<{ id: number } & import("mysql2").RowDataPacket>>(
          "SELECT id FROM categories WHERE name = ?",
          [input.category],
        );
        if (!categories[0]) throw new Error("The requested product category could not be saved.");
        categoryId = categories[0].id;
      }
      const columns: Record<string, string> = {
        sku: "sku", barcode: "barcode", name: "name", brand: "brand", packageSize: "package_size", description: "description",
        unit: "unit", sellingPrice: "selling_price",
        purchasePrice: "purchase_price", taxRate: "tax_rate", reorderLevel: "reorder_level", isActive: "is_active",
      };
      const values: Array<string | number | boolean | null> = [];
      const sets: string[] = [];
      for (const [key, column] of Object.entries(columns)) {
        const value = input[key as keyof typeof input];
        if (value !== undefined) {
          sets.push(`${column} = ?`);
          values.push(key === "isActive" ? value as boolean : value as string | null);
        }
      }
      if (categoryId !== undefined) {
        sets.push("category_id = ?");
        values.push(categoryId);
      }
      const priceChanged = (input.sellingPrice !== undefined && input.sellingPrice !== products[0].selling_price)
        || (input.purchasePrice !== undefined && (input.purchasePrice ?? null) !== (products[0].purchase_price ?? null));
      if (priceChanged) {
        await connection.execute(
          `INSERT INTO product_price_history
             (product_id, branch_id, changed_by, previous_buying_price, new_buying_price,
              previous_selling_price, new_selling_price, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id, user.branchId, user.id,
            products[0].purchase_price, input.purchasePrice ?? products[0].purchase_price,
            products[0].selling_price, input.sellingPrice ?? products[0].selling_price,
            input.priceChangeReason ?? "Product price updated",
          ],
        );
      }
      if (sets.length) {
        await connection.execute(`UPDATE products SET ${sets.join(", ")} WHERE id = ?`, [...values, id]);
      }
      await connection.execute(
        "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES (?, ?, 'product', ?, ?)",
        [user.id, input.isActive === false ? "product.archived" : "product.updated", String(id), JSON.stringify(input)],
      );
      return { id, updated: true, isActive: input.isActive ?? Boolean(products[0].is_active) };
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ER_DUP_ENTRY") {
      throw new HttpError(409, "That SKU or barcode is already assigned to a product.");
    }
    throw error;
  }
}
