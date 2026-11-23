import "./env.js";
import bcrypt from "bcryptjs";
import { pool } from "./db.js";

const products = [
  ["GROC-001", "600100100001", "Maize flour 2kg", "Grains", "packet", "185.00", "0.00", "12"],
  ["GROC-002", "600100100002", "White sugar 1kg", "Grains", "packet", "165.00", "0.00", "10"],
  ["DAIR-001", "600100100003", "Fresh milk 500ml", "Dairy", "piece", "68.00", "16.00", "15"],
  ["DAIR-002", "600100100004", "Salted butter 250g", "Dairy", "piece", "310.00", "16.00", "6"],
  ["HOME-001", "600100100005", "Dishwashing liquid 750ml", "Household", "piece", "245.00", "16.00", "5"],
  ["SNCK-001", "600100100006", "Potato crisps 100g", "Snacks", "piece", "120.00", "16.00", "8"],
  ["BVG-001", "600100100007", "Drinking water 1.5L", "Beverages", "piece", "75.00", "16.00", "20"],
  ["PROD-001", "600100100008", "Bananas", "Fresh produce", "kg", "180.00", "0.00", "5"],
  ["BAKE-001", "600100100009", "Sliced bread", "Bakery", "piece", "75.00", "0.00", "8"],
  ["PERSON-001", "600100100010", "Bathing soap 125g", "Personal care", "piece", "115.00", "16.00", "7"],
];

async function seed(): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password || password === "replace-before-seeding" || password.length < 4) {
    throw new Error("Set SEED_ADMIN_EMAIL and a unique SEED_ADMIN_PASSWORD of at least 4 characters before seeding.");
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute("INSERT IGNORE INTO branches (name, code) VALUES ('Main Branch', 'MAIN')");
    await connection.execute(
      "INSERT IGNORE INTO roles (name) VALUES ('admin'), ('manager'), ('cashier'), ('inventory_manager'), ('procurement_officer'), ('accountant')",
    );
    const [branchRows] = await connection.execute<Array<{ id: number } & import("mysql2").RowDataPacket>>(
      "SELECT id FROM branches WHERE code = 'MAIN'",
    );
    const branchId = branchRows[0]!.id;
    const [existingUsers] = await connection.execute<Array<{ id: number } & import("mysql2").RowDataPacket>>(
      "SELECT id FROM users WHERE email = ?",
      [email],
    );
    let userId: number;
    if (existingUsers[0]) {
      userId = existingUsers[0].id;
    } else {
      const passwordHash = await bcrypt.hash(password, 12);
      const [result] = await connection.execute(
        "INSERT INTO users (branch_id, name, email, password_hash) VALUES (?, ?, ?, ?)",
        [branchId, process.env.SEED_ADMIN_NAME ?? "System Administrator", email, passwordHash],
      );
      userId = (result as { insertId: number }).insertId;
    }
    await connection.execute(
      "INSERT IGNORE INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE name = 'admin'",
      [userId],
    );

    const seedSampleProducts = process.env.SEED_SAMPLE_PRODUCTS !== "false";
    if (seedSampleProducts) {
      for (const categoryName of [...new Set(products.map((product) => product[3]))]) {
        await connection.execute(
          "INSERT IGNORE INTO categories (name) VALUES (?)",
          [categoryName],
        );
      }
      for (const [sku, barcode, name, category, unit, price, tax, stock] of products) {
        await connection.execute(
          `INSERT INTO products (sku, barcode, name, category_id, unit, selling_price, tax_rate, reorder_level)
           SELECT ?, ?, ?, c.id, ?, ?, ?, ? FROM categories c WHERE c.name = ?
           ON DUPLICATE KEY UPDATE name = VALUES(name)`,
          [sku, barcode, name, unit, price, tax, stock, category],
        );
        await connection.execute(
          `INSERT INTO inventory (branch_id, product_id, on_hand)
           SELECT ?, id, ? FROM products WHERE sku = ?
           ON DUPLICATE KEY UPDATE product_id = VALUES(product_id)`,
          [branchId, Number(stock) * 2, sku],
        );
        const openingReference = `SEED:${sku}`;
        const [openingRows] = await connection.execute<Array<{ id: number } & import("mysql2").RowDataPacket>>(
          "SELECT id FROM stock_movements WHERE branch_id = ? AND movement_type = 'opening' AND reference = ? LIMIT 1",
          [branchId, openingReference],
        );
        if (!openingRows[0]) {
          await connection.execute(
            `INSERT INTO stock_movements (branch_id, product_id, movement_type, quantity, reference, created_by)
             SELECT ?, id, 'opening', ?, ?, ? FROM products WHERE sku = ?`,
            [branchId, Number(stock) * 2, openingReference, userId, sku],
          );
        }
      }
    }
    await connection.commit();
    console.info(`Seeded admin ${email}, branch MAIN, and ${seedSampleProducts ? products.length : 0} sample products.`);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

void seed().catch((error: unknown) => {
  console.error("Database seed failed.", error);
  process.exitCode = 1;
});
