import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, resolve } from "node:path";
import { Decimal } from "decimal.js";
import { z } from "zod";
import type { RowDataPacket } from "mysql2/promise";
import { pool, withTransaction } from "./db.js";
import type { AuthUser } from "./auth.js";
import { HttpError } from "./errors.js";

export const branchSchema = z.object({
  name: z.string().trim().min(2).max(120),
  code: z.string().trim().min(2).max(30).regex(/^[A-Za-z0-9_-]+$/),
  address: z.string().trim().max(500).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.email().max(254).nullable().optional(),
  timezone: z.string().trim().min(1).max(64).default("Africa/Nairobi"),
  isActive: z.boolean().default(true),
  allowNegativeStock: z.boolean().default(false),
}).strict();
export const updateBranchSchema = branchSchema.partial();
export const branchAssignmentSchema = z.object({
  branchId: z.number().int().positive(),
  isPrimary: z.boolean().default(false),
}).strict();
export const priceHistorySchema = z.object({
  q: z.string().trim().max(100).optional(),
  branchId: z.coerce.number().int().positive().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
}).strict();
export const offlineSyncSchema = z.object({
  offlineId: z.string().trim().min(16).max(100),
  items: z.array(z.object({
    productId: z.number().int().positive(),
    quantity: z.string().regex(/^\d{1,9}(\.\d{1,3})?$/),
  }).strict()).min(1).max(100),
  discount: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/).default("0"),
  payments: z.array(z.object({
    method: z.enum(["cash", "mpesa", "card", "bank_transfer", "credit"]),
    amount: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/),
    providerReference: z.string().trim().max(100).nullable().optional(),
  }).strict()).min(1).max(5),
  cashReceived: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/).nullable().optional(),
  recordedAt: z.string().datetime(),
}).strict();
export const backupSettingsSchema = z.object({
  frequency: z.enum(["daily", "weekly", "monthly"]),
  retentionCount: z.number().int().min(1).max(365),
  enabled: z.boolean(),
  encrypted: z.boolean(),
  destination: z.string().trim().min(1).max(500).nullable().optional(),
}).strict();
export const notificationSettingsSchema = z.object({
  enabled: z.boolean(),
  dailySummaryEnabled: z.boolean(),
  lowStockEnabled: z.boolean(),
  receiptEnabled: z.boolean(),
}).strict();
export const notificationSendSchema = z.object({
  recipient: z.string().trim().min(7).max(100),
  message: z.string().trim().min(1).max(4000),
  templateKey: z.string().trim().max(80).nullable().optional(),
  saleId: z.number().int().positive().nullable().optional(),
  customerId: z.number().int().positive().nullable().optional(),
}).strict();
export const dailyEvaluationQuerySchema = z.object({
  date: z.iso.date(),
  branchId: z.coerce.number().int().positive().optional(),
}).strict();

function requireAdmin(user: AuthUser) {
  if (!user.roles.includes("admin")) throw new HttpError(403, "Administrator permission required.");
}

export async function listBranches(user: AuthUser) {
  const admin = user.roles.includes("admin");
  const [rows] = await pool.execute<Array<RowDataPacket & {
    id: number; name: string; code: string; address: string | null; phone: string | null;
    email: string | null; timezone: string; is_active: number; allow_negative_stock: number; created_at: Date;
  }>>(
    admin
      ? `SELECT id, name, code, address, phone, email, timezone, is_active, allow_negative_stock, created_at
         FROM branches ORDER BY name`
      : `SELECT b.id, b.name, b.code, b.address, b.phone, b.email, b.timezone, b.is_active,
                b.allow_negative_stock, b.created_at
         FROM branches b JOIN branch_assignments ba ON ba.branch_id=b.id
         WHERE ba.user_id=? OR b.id=? ORDER BY b.name`,
    admin ? [] : [user.id, user.branchId],
  );
  return rows.map((row) => ({
    id: row.id, name: row.name, code: row.code, address: row.address, phone: row.phone,
    email: row.email, timezone: row.timezone, isActive: Boolean(row.is_active),
    allowNegativeStock: Boolean(row.allow_negative_stock), createdAt: row.created_at.toISOString(),
  }));
}

export async function createBranch(input: z.infer<typeof branchSchema>, user: AuthUser) {
  requireAdmin(user);
  try {
    const [result] = await pool.execute(
      `INSERT INTO branches (name, code, address, phone, email, timezone, is_active, allow_negative_stock)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.name, input.code, input.address ?? null, input.phone ?? null, input.email ?? null,
        input.timezone, input.isActive, input.allowNegativeStock],
    );
    const id = (result as { insertId: number }).insertId;
    await pool.execute(
      "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES (?, 'branch.created', 'branch', ?, ?)",
      [user.id, String(id), JSON.stringify(input)],
    );
    return { id, ...input };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ER_DUP_ENTRY") {
      throw new HttpError(409, "That branch code or email is already in use.");
    }
    throw error;
  }
}

export async function updateBranch(id: number, input: z.infer<typeof updateBranchSchema>, user: AuthUser) {
  requireAdmin(user);
  return withTransaction(async (connection) => {
    const [rows] = await connection.execute<Array<RowDataPacket & { id: number }>>(
      "SELECT id FROM branches WHERE id=? FOR UPDATE",
      [id],
    );
    if (!rows[0]) throw new HttpError(404, "Branch not found.");
    const columns: Record<string, string> = {
      name: "name", code: "code", address: "address", phone: "phone", email: "email",
      timezone: "timezone", isActive: "is_active", allowNegativeStock: "allow_negative_stock",
    };
    const sets: string[] = [];
    const values: Array<string | boolean | null> = [];
    for (const [key, column] of Object.entries(columns)) {
      const value = input[key as keyof typeof input];
      if (value !== undefined) {
        sets.push(`${column}=?`);
        values.push(value as string | boolean | null);
      }
    }
    if (sets.length) await connection.execute(`UPDATE branches SET ${sets.join(",")} WHERE id=?`, [...values, id]);
    await connection.execute(
      "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES (?, 'branch.updated', 'branch', ?, ?)",
      [user.id, String(id), JSON.stringify(input)],
    );
  }).then(() => ({ id, updated: true }));
}

export async function assignBranchUser(userId: number, input: z.infer<typeof branchAssignmentSchema>, user: AuthUser) {
  requireAdmin(user);
  await pool.execute(
    `INSERT INTO branch_assignments (user_id, branch_id, is_primary)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE is_primary=VALUES(is_primary)`,
    [userId, input.branchId, input.isPrimary],
  );
  if (input.isPrimary) await pool.execute("UPDATE users SET branch_id=? WHERE id=?", [input.branchId, userId]);
  await pool.execute(
    "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES (?, 'branch.assignment_updated', 'user', ?, ?)",
    [user.id, String(userId), JSON.stringify(input)],
  );
  return { userId, ...input };
}

export async function listPriceHistory(input: z.infer<typeof priceHistorySchema>, user: AuthUser) {
  if (!user.roles.includes("admin") && !user.roles.includes("manager") && !user.roles.includes("inventory_manager")) {
    throw new HttpError(403, "Price history permission required.");
  }
  const conditions = ["1=1"];
  const values: Array<string | number> = [];
  if (input.q) { conditions.push("(p.name LIKE CONCAT('%', ?, '%') OR p.sku LIKE CONCAT('%', ?, '%'))"); values.push(input.q, input.q); }
  if (input.branchId) { conditions.push("h.branch_id=?"); values.push(input.branchId); }
  if (input.from) { conditions.push("h.created_at>=?"); values.push(`${input.from} 00:00:00`); }
  if (input.to) { conditions.push("h.created_at<DATE_ADD(?, INTERVAL 1 DAY)"); values.push(input.to); }
  if (!user.roles.includes("admin")) { conditions.push("(h.branch_id IS NULL OR h.branch_id=?)"); values.push(user.branchId); }
  const [rows] = await pool.execute<Array<RowDataPacket & {
    id: number; product_id: number; sku: string; product_name: string; branch_name: string | null;
    changed_by_name: string | null; previous_buying_price: string | null; new_buying_price: string | null;
    previous_selling_price: string | null; new_selling_price: string | null; reason: string | null; created_at: Date;
  }>>(
    `SELECT h.id, h.product_id, p.sku, p.name AS product_name, b.name AS branch_name,
            u.name AS changed_by_name, h.previous_buying_price, h.new_buying_price,
            h.previous_selling_price, h.new_selling_price, h.reason, h.created_at
     FROM product_price_history h JOIN products p ON p.id=h.product_id
     LEFT JOIN branches b ON b.id=h.branch_id LEFT JOIN users u ON u.id=h.changed_by
     WHERE ${conditions.join(" AND ")} ORDER BY h.created_at DESC LIMIT 500`,
    values,
  );
  return rows.map((row) => ({
    id: row.id, productId: row.product_id, sku: row.sku, productName: row.product_name,
    branch: row.branch_name, changedBy: row.changed_by_name,
    previousBuyingPrice: row.previous_buying_price, newBuyingPrice: row.new_buying_price,
    previousSellingPrice: row.previous_selling_price, newSellingPrice: row.new_selling_price,
    reason: row.reason, createdAt: row.created_at.toISOString(),
  }));
}

export async function recordPriceChange(
  connection: import("mysql2/promise").PoolConnection,
  input: { productId: number; branchId: number; changedBy: number; previousBuying: string | null; newBuying: string | null; previousSelling: string | null; newSelling: string | null; reason: string },
) {
  await connection.execute(
    `INSERT INTO product_price_history
       (product_id, branch_id, changed_by, previous_buying_price, new_buying_price,
        previous_selling_price, new_selling_price, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.productId, input.branchId, input.changedBy, input.previousBuying, input.newBuying,
      input.previousSelling, input.newSelling, input.reason],
  );
}

export async function listOfflineSync(user: AuthUser) {
  requireAdmin(user);
  const [rows] = await pool.execute<Array<RowDataPacket & {
    id: number; offline_id: string; branch_id: number; branch_name: string; cashier: string;
    status: string; sale_id: number | null; receipt_number: string | null; error_message: string | null;
    attempts: number; created_at: Date; synced_at: Date | null;
  }>>(
    `SELECT s.id, s.offline_id, s.branch_id, b.name AS branch_name, u.name AS cashier,
            s.status, s.sale_id, s.receipt_number, s.error_message, s.attempts, s.created_at, s.synced_at
     FROM offline_sale_sync s JOIN branches b ON b.id=s.branch_id JOIN users u ON u.id=s.cashier_id
     ORDER BY s.created_at DESC LIMIT 500`,
  );
  return rows.map((row) => ({
    id: row.id, offlineId: row.offline_id, branchId: row.branch_id, branch: row.branch_name,
    cashier: row.cashier, status: row.status, saleId: row.sale_id, receiptNumber: row.receipt_number,
    error: row.error_message, attempts: row.attempts, createdAt: row.created_at.toISOString(),
    syncedAt: row.synced_at?.toISOString() ?? null,
  }));
}

export async function getBackupSettings(user: AuthUser) {
  requireAdmin(user);
  const [rows] = await pool.execute<Array<RowDataPacket & {
    frequency: "daily" | "weekly" | "monthly"; retention_count: number; enabled: number;
    encrypted: number; destination: string | null; updated_at: Date;
  }>>("SELECT frequency, retention_count, enabled, encrypted, destination, updated_at FROM backup_settings WHERE id=1");
  const row = rows[0];
  return row ? {
    frequency: row.frequency, retentionCount: row.retention_count, enabled: Boolean(row.enabled),
    encrypted: Boolean(row.encrypted), destination: row.destination,
  } : null;
}

export async function updateBackupSettings(input: z.infer<typeof backupSettingsSchema>, user: AuthUser) {
  requireAdmin(user);
  await pool.execute(
    `INSERT INTO backup_settings (id, frequency, retention_count, enabled, encrypted, destination, updated_by)
     VALUES (1, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE frequency=VALUES(frequency), retention_count=VALUES(retention_count),
       enabled=VALUES(enabled), encrypted=VALUES(encrypted), destination=VALUES(destination), updated_by=VALUES(updated_by)`,
    [input.frequency, input.retentionCount, input.enabled, input.encrypted, input.destination ?? null, user.id],
  );
  await pool.execute(
    "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES (?, 'backup.settings_updated', 'backup_settings', '1', ?)",
    [user.id, JSON.stringify(input)],
  );
  return input;
}

async function encryptBackup(source: Buffer): Promise<Buffer> {
  const keyValue = process.env.BACKUP_ENCRYPTION_KEY;
  if (!keyValue) throw new Error("BACKUP_ENCRYPTION_KEY must be configured for encrypted backups.");
  const key = createHash("sha256").update(keyValue).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(source), cipher.final()]);
  return Buffer.concat([Buffer.from("SPB1"), iv, cipher.getAuthTag(), ciphertext]);
}

async function createDatabaseBackupRecord(createdBy: number | null) {
  const destination = process.env.BACKUP_STORAGE_DIR?.trim();
  if (!destination) throw new HttpError(503, "BACKUP_STORAGE_DIR is not configured.");
  const storageRoot = resolve(destination);
  await mkdir(storageRoot, { recursive: true });
  const [settings] = await pool.execute<Array<RowDataPacket & { encrypted: number }>>(
    "SELECT encrypted FROM backup_settings WHERE id=1",
  );
  const encrypted = Boolean(settings[0]?.encrypted);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not configured.");
  const url = new URL(databaseUrl);
  const filename = `smart-pos-${new Date().toISOString().replace(/[:.]/g, "-")}.sql${encrypted ? ".enc" : ""}`;
  const path = resolve(storageRoot, filename);
  const database = url.pathname.replace(/^\/+/, "");
  const dump = await new Promise<Buffer>((resolveDump, rejectDump) => {
    const args = [
      "-h", url.hostname, ...(url.port ? ["-P", url.port] : []),
      "-u", decodeURIComponent(url.username), `--databases`, database,
      "--single-transaction", "--routines", "--triggers",
    ];
    if (url.password) process.env.MYSQL_PWD = decodeURIComponent(url.password);
    const child = spawn("mysqldump", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.on("error", rejectDump);
    child.on("close", (code) => code === 0
      ? resolveDump(Buffer.concat(chunks))
      : rejectDump(new Error(Buffer.concat(errors).toString("utf8").slice(0, 500) || "mysqldump failed")));
  });
  const data = encrypted ? await encryptBackup(dump) : dump;
  await writeFile(path, data, { mode: 0o600 });
  const checksum = createHash("sha256").update(data).digest("hex");
  const fileStat = await stat(path);
  const [result] = await pool.execute(
    `INSERT INTO database_backups
       (filename, storage_location, checksum_sha256, encrypted, status, size_bytes, created_by, verified_at)
     VALUES (?, ?, ?, ?, 'verified', ?, ?, CURRENT_TIMESTAMP)`,
    [basename(path), path, checksum, encrypted, fileStat.size, createdBy],
  );
  await pool.execute(
    "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES (?, 'backup.created', 'database_backup', ?, ?)",
    [createdBy, String((result as { insertId: number }).insertId), JSON.stringify({ filename, encrypted, checksum, automated: createdBy === null })],
  );
  return { id: (result as { insertId: number }).insertId, filename, checksum, sizeBytes: fileStat.size, status: "verified" };
}

export async function createDatabaseBackup(user: AuthUser) {
  requireAdmin(user);
  return createDatabaseBackupRecord(user.id);
}

export async function runScheduledDatabaseBackup(): Promise<{ created: boolean; reason: string }> {
  const [settings] = await pool.execute<Array<RowDataPacket & {
    enabled: number; frequency: "daily" | "weekly" | "monthly";
  }>>("SELECT enabled, frequency FROM backup_settings WHERE id=1");
  if (!settings[0]?.enabled) return { created: false, reason: "Automatic backups are disabled." };
  const [latest] = await pool.execute<Array<RowDataPacket & { created_at: Date }>>(
    "SELECT created_at FROM database_backups WHERE status='verified' ORDER BY created_at DESC LIMIT 1",
  );
  const now = Date.now();
  if (latest[0]) {
    const elapsedDays = (now - new Date(latest[0].created_at).getTime()) / 86_400_000;
    const intervalDays = settings[0].frequency === "daily" ? 1 : settings[0].frequency === "weekly" ? 7 : 30;
    if (elapsedDays < intervalDays) return { created: false, reason: "Backup frequency interval has not elapsed." };
  }
  await createDatabaseBackupRecord(null);
  return { created: true, reason: "Scheduled backup created." };
}

export async function listBackups(user: AuthUser) {
  requireAdmin(user);
  const [rows] = await pool.execute<Array<RowDataPacket & {
    id: number; filename: string; checksum_sha256: string; encrypted: number; status: string;
    size_bytes: number | null; error_message: string | null; created_at: Date; verified_at: Date | null;
  }>>("SELECT id, filename, checksum_sha256, encrypted, status, size_bytes, error_message, created_at, verified_at FROM database_backups ORDER BY created_at DESC LIMIT 100");
  return rows.map((row) => ({
    id: row.id, filename: row.filename, checksum: row.checksum_sha256, encrypted: Boolean(row.encrypted),
    status: row.status, sizeBytes: row.size_bytes, error: row.error_message,
    createdAt: row.created_at.toISOString(), verifiedAt: row.verified_at?.toISOString() ?? null,
  }));
}

export async function verifyBackup(id: number, user: AuthUser) {
  requireAdmin(user);
  const [rows] = await pool.execute<Array<RowDataPacket & { id: number; storage_location: string; checksum_sha256: string; encrypted: number }>>(
    "SELECT id, storage_location, checksum_sha256, encrypted FROM database_backups WHERE id=?",
    [id],
  );
  const backup = rows[0];
  if (!backup) throw new HttpError(404, "Backup not found.");
  const data = await readFile(backup.storage_location);
  const checksum = createHash("sha256").update(data).digest("hex");
  if (checksum !== backup.checksum_sha256) throw new HttpError(409, "Backup checksum verification failed.");
  await pool.execute(
    "UPDATE database_backups SET status='verified', verified_at=CURRENT_TIMESTAMP WHERE id=?",
    [id],
  );
  await pool.execute(
    "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES (?, 'backup.verified', 'database_backup', ?, ?)",
    [user.id, String(id), JSON.stringify({ checksum })],
  );
  return { id, verified: true, checksum };
}

export async function getNotificationSettings(user: AuthUser) {
  requireAdmin(user);
  const [rows] = await pool.execute<Array<RowDataPacket & {
    enabled: number; daily_summary_enabled: number; low_stock_enabled: number; receipt_enabled: number;
  }>>("SELECT enabled, daily_summary_enabled, low_stock_enabled, receipt_enabled FROM notification_settings WHERE id=1");
  const row = rows[0];
  return row ? {
    enabled: Boolean(row.enabled),
    dailySummaryEnabled: Boolean(row.daily_summary_enabled),
    lowStockEnabled: Boolean(row.low_stock_enabled),
    receiptEnabled: Boolean(row.receipt_enabled),
  } : null;
}

export async function updateNotificationSettings(input: z.infer<typeof notificationSettingsSchema>, user: AuthUser) {
  requireAdmin(user);
  await pool.execute(
    `UPDATE notification_settings SET enabled=?, daily_summary_enabled=?, low_stock_enabled=?,
       receipt_enabled=?, updated_by=? WHERE id=1`,
    [input.enabled, input.dailySummaryEnabled, input.lowStockEnabled, input.receiptEnabled, user.id],
  );
  await pool.execute(
    "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES (?, 'notification.settings_updated', 'notification_settings', '1', ?)",
    [user.id, JSON.stringify(input)],
  );
  return input;
}

export async function sendAutomaticSaleReceipt(
  saleId: number,
  branchId: number,
  customerId: number | null,
  receiptNumber: string,
  total: string,
  cashierName: string,
) {
  if (!customerId) return { sent: false, reason: "No customer was attached to the sale." };
  const [settings] = await pool.execute<Array<RowDataPacket & { enabled: number; receipt_enabled: number }>>(
    "SELECT enabled, receipt_enabled FROM notification_settings WHERE id=1",
  );
  if (!settings[0]?.enabled || !settings[0].receipt_enabled) {
    return { sent: false, reason: "Automatic receipt notifications are disabled." };
  }
  const [customers] = await pool.execute<Array<RowDataPacket & { phone: string | null }>>(
    "SELECT phone FROM customers WHERE id=?",
    [customerId],
  );
  const recipient = customers[0]?.phone?.replace(/[^\d+]/g, "");
  if (!recipient) return { sent: false, reason: "The customer does not have a phone number." };
  const [existing] = await pool.execute<Array<RowDataPacket & { id: number }>>(
    `SELECT id FROM notifications
     WHERE sale_id=? AND template_key='digital_receipt'
       AND status IN ('queued','sent','delivered') LIMIT 1`,
    [saleId],
  );
  if (existing[0]) return { sent: false, reason: "A digital receipt notification was already queued." };
  const [branches] = await pool.execute<Array<RowDataPacket & { name: string }>>(
    "SELECT name FROM branches WHERE id=?",
    [branchId],
  );
  const branchName = branches[0]?.name ?? "Smart POS";
  const message = `Thank you for shopping at ${branchName}. Receipt ${receiptNumber}. Total paid: KES ${total}. Served by ${cashierName}.`;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const apiBase = process.env.WHATSAPP_API_BASE_URL?.trim() || "https://graph.facebook.com/v21.0";

  const [result] = await pool.execute(
    `INSERT INTO notifications
       (branch_id, customer_id, sale_id, provider, recipient, template_key, status, payload)
     VALUES (?, ?, ?, 'whatsapp', ?, 'digital_receipt', 'queued', ?)`,
    [branchId, customerId, saleId, recipient, JSON.stringify({ message, receiptNumber })],
  );
  const notificationId = (result as { insertId: number }).insertId;
  const templateName = process.env.WHATSAPP_RECEIPT_TEMPLATE_NAME?.trim();
  const templateLanguage = process.env.WHATSAPP_RECEIPT_TEMPLATE_LANGUAGE?.trim() || "en";
  if (!token || !phoneNumberId || !templateName) {
    const reason = "WhatsApp credentials or the approved receipt template are not configured.";
    await pool.execute(
      "UPDATE notifications SET status='failed', error_message=? WHERE id=?",
      [reason, notificationId],
    );
    return { sent: false, reason };
  }
  try {
    const response = await fetch(`${apiBase}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient.replace(/\D/g, ""),
        type: "template",
        template: {
          name: templateName,
          language: { code: templateLanguage },
          components: [{
            type: "body",
            parameters: [
              { type: "text", text: branchName },
              { type: "text", text: receiptNumber },
              { type: "text", text: total },
              { type: "text", text: cashierName },
            ],
          }],
        },
      }),
    });
    const providerResult = await response.json().catch(() => null) as {
      messages?: Array<{ id?: string }>;
      error?: { message?: string };
    } | null;
    if (!response.ok) {
      await pool.execute(
        "UPDATE notifications SET status='failed', error_message=?, attempts=attempts+1 WHERE id=?",
        [providerResult?.error?.message?.slice(0, 1000) ?? "WhatsApp provider rejected the message.", notificationId],
      );
      return { sent: false, reason: "WhatsApp provider rejected the notification." };
    }
    const providerMessageId = providerResult?.messages?.[0]?.id ?? null;
    if (!providerMessageId) {
      await pool.execute(
        "UPDATE notifications SET status='failed', error_message=?, attempts=attempts+1 WHERE id=?",
        ["WhatsApp provider returned no message identifier.", notificationId],
      );
      return { sent: false, reason: "WhatsApp provider did not confirm accepting the notification." };
    }
    await pool.execute(
      "UPDATE notifications SET status='sent', provider_message_id=?, attempts=1 WHERE id=?",
      [providerMessageId, notificationId],
    );
    return { sent: true, notificationId, providerMessageId };
  } catch (error) {
    await pool.execute(
      "UPDATE notifications SET status='failed', error_message=?, attempts=attempts+1 WHERE id=?",
      [error instanceof Error ? error.message.slice(0, 1000) : "Network delivery failure.", notificationId],
    );
    return { sent: false, reason: "WhatsApp network delivery failed." };
  }
}

export async function sendWhatsAppNotification(input: z.infer<typeof notificationSendSchema>, user: AuthUser) {
  requireAdmin(user);
  const [settings] = await pool.execute<Array<RowDataPacket & { enabled: number }>>(
    "SELECT enabled FROM notification_settings WHERE id=1",
  );
  if (!settings[0]?.enabled) throw new HttpError(503, "WhatsApp notifications are disabled.");
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const apiBase = process.env.WHATSAPP_API_BASE_URL?.trim() || "https://graph.facebook.com/v21.0";
  if (!token || !phoneNumberId) throw new HttpError(503, "WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID must be configured.");
  const [result] = await pool.execute(
    `INSERT INTO notifications
       (branch_id, customer_id, sale_id, provider, recipient, template_key, status, payload)
     VALUES (?, ?, ?, 'whatsapp', ?, ?, 'queued', ?)`,
    [user.branchId, input.customerId ?? null, input.saleId ?? null, input.recipient,
      input.templateKey ?? null, JSON.stringify({ message: input.message })],
  );
  const id = (result as { insertId: number }).insertId;
  const response = await fetch(`${apiBase}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.recipient.replace(/\D/g, ""),
      type: "text",
      text: { preview_url: false, body: input.message },
    }),
  });
  const providerResult = await response.json().catch(() => null) as { messages?: Array<{ id?: string }>; error?: { message?: string } } | null;
  if (!response.ok) {
    await pool.execute(
      "UPDATE notifications SET status='failed', error_message=?, attempts=attempts+1, provider_message_id=NULL WHERE id=?",
      [providerResult?.error?.message?.slice(0, 1000) ?? "WhatsApp provider rejected the message.", id],
    );
    throw new HttpError(502, "WhatsApp delivery failed. The failure is recorded in the notification centre.");
  }
  const providerMessageId = providerResult?.messages?.[0]?.id ?? null;
  await pool.execute(
    "UPDATE notifications SET status='sent', provider_message_id=?, attempts=1 WHERE id=?",
    [providerMessageId, id],
  );
  return { id, status: "sent", providerMessageId };
}

export async function listNotifications(user: AuthUser) {
  if (!user.roles.includes("admin") && !user.roles.includes("manager")) throw new HttpError(403, "Notification permission required.");
  const conditions = user.roles.includes("admin") ? ["1=1"] : ["n.branch_id=?"];
  const values: Array<number> = user.roles.includes("admin") ? [] : [user.branchId];
  const [rows] = await pool.execute<Array<RowDataPacket & {
    id: number; recipient: string; template_key: string | null; provider_message_id: string | null;
    status: string; error_message: string | null; attempts: number; created_at: Date;
  }>>(
    `SELECT id, recipient, template_key, provider_message_id, status, error_message, attempts, created_at
     FROM notifications n WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT 200`,
    values,
  );
  return rows.map((row) => ({
    id: row.id, recipient: row.recipient, templateKey: row.template_key,
    providerMessageId: row.provider_message_id, status: row.status, error: row.error_message,
    attempts: row.attempts, createdAt: row.created_at.toISOString(),
  }));
}

export async function listElectronicReceipts(user: AuthUser, q = "", branchId?: number, from = "", to = "") {
  if (!user.roles.includes("admin") && !user.roles.includes("manager") && !user.roles.includes("cashier")) {
    throw new HttpError(403, "Receipt permission required.");
  }
  const conditions = ["s.status='completed'"];
  const values: Array<string | number> = [];
  if (!user.roles.includes("admin")) {
    conditions.push("er.branch_id=?");
    values.push(user.branchId);
  } else if (branchId) {
    conditions.push("er.branch_id=?");
    values.push(branchId);
  }
  if (q) { conditions.push("(er.receipt_number LIKE CONCAT('%', ?, '%') OR u.name LIKE CONCAT('%', ?, '%'))"); values.push(q, q); }
  if (from) { conditions.push("er.created_at>=?"); values.push(`${from} 00:00:00`); }
  if (to) { conditions.push("er.created_at<DATE_ADD(?, INTERVAL 1 DAY)"); values.push(to); }
  const [rows] = await pool.execute<Array<RowDataPacket & {
    id: number; sale_id: number; receipt_number: string; total: string; cashier: string;
    branch_name: string; created_at: Date;
  }>>(
    `SELECT er.id, er.sale_id, er.receipt_number, s.total, u.name AS cashier,
            b.name AS branch_name, er.created_at
     FROM electronic_receipts er JOIN sales s ON s.id=er.sale_id
     JOIN users u ON u.id=s.cashier_id JOIN branches b ON b.id=er.branch_id
     WHERE ${conditions.join(" AND ")} ORDER BY er.created_at DESC LIMIT 500`,
    values,
  );
  return rows.map((row) => ({
    id: row.id, saleId: row.sale_id, receiptNumber: row.receipt_number, total: row.total,
    cashier: row.cashier, branch: row.branch_name, createdAt: row.created_at.toISOString(),
  }));
}

export async function getDailyEvaluation(user: AuthUser, date: string, branchId?: number) {
  if (!user.roles.includes("admin") && !user.roles.includes("manager") && !user.roles.includes("accountant")) {
    throw new HttpError(403, "Daily transaction evaluation permission required.");
  }
  const parsedDate = new Date(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsedDate.getTime())
    || parsedDate.toISOString().slice(0, 10) !== date) {
    throw new HttpError(400, "A valid evaluation date is required.");
  }

  const isAdmin = user.roles.includes("admin");
  let accessibleBranchIds: number[] = [];
  if (!isAdmin) {
    const [assignments] = await pool.execute<Array<RowDataPacket & { branch_id: number }>>(
      `SELECT branch_id FROM branch_assignments WHERE user_id=?
       UNION SELECT ? AS branch_id`,
      [user.id, user.branchId],
    );
    accessibleBranchIds = assignments.map((row) => Number(row.branch_id));
    if (branchId && !accessibleBranchIds.includes(branchId)) {
      throw new HttpError(403, "You do not have access to evaluate this branch.");
    }
  }

  const branchScope = (alias: string) => {
    if (branchId) return { sql: `AND ${alias}.branch_id=?`, values: [branchId] };
    if (!isAdmin) {
      return {
        sql: `AND ${alias}.branch_id IN (${accessibleBranchIds.map(() => "?").join(",")})`,
        values: accessibleBranchIds,
      };
    }
    return { sql: "", values: [] as number[] };
  };
  const start = `${date} 00:00:00`;
  const salesScope = branchScope("s");
  const refundScope = branchScope("r");
  const expenseScope = branchScope("e");
  const [summaryRows, paymentRows, sales, refunds, expenses] = await Promise.all([
    pool.execute<Array<RowDataPacket & {
      gross_sales: string; transactions: number; average_transaction: string;
    }>>(
      `SELECT COALESCE(SUM(s.total),0) AS gross_sales, COUNT(*) AS transactions,
              COALESCE(AVG(s.total),0) AS average_transaction
       FROM sales s
       WHERE s.status='completed' AND s.created_at>=?
         AND s.created_at<DATE_ADD(?, INTERVAL 1 DAY) ${salesScope.sql}`,
      [start, start, ...salesScope.values],
    ),
    pool.execute<Array<RowDataPacket & { method: string; amount: string; transactions: number }>>(
      `SELECT sp.method, COALESCE(SUM(sp.amount),0) AS amount,
              COUNT(DISTINCT s.id) AS transactions
       FROM sale_payments sp JOIN sales s ON s.id=sp.sale_id
       WHERE s.status='completed' AND sp.status='completed'
         AND s.created_at>=? AND s.created_at<DATE_ADD(?, INTERVAL 1 DAY) ${salesScope.sql}
       GROUP BY sp.method ORDER BY amount DESC`,
      [start, start, ...salesScope.values],
    ),
    pool.execute<Array<RowDataPacket & {
      id: number; receipt_number: string; total: string; status: string; created_at: Date;
      cashier: string; customer: string | null; item_count: number; payment_methods: string | null; branch: string;
    }>>(
      `SELECT s.id, s.receipt_number, s.total, s.status, s.created_at, u.name AS cashier,
              c.name AS customer, b.name AS branch,
              (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id=s.id) AS item_count,
              (SELECT GROUP_CONCAT(DISTINCT CONCAT(sp.method,
                CASE WHEN sp.status='completed' THEN '' ELSE CONCAT(' (',sp.status,')') END)
                ORDER BY sp.method SEPARATOR ', ')
               FROM sale_payments sp WHERE sp.sale_id=s.id) AS payment_methods
       FROM sales s JOIN users u ON u.id=s.cashier_id JOIN branches b ON b.id=s.branch_id
       LEFT JOIN customers c ON c.id=s.customer_id
       WHERE s.created_at>=? AND s.created_at<DATE_ADD(?, INTERVAL 1 DAY) ${salesScope.sql}
       ORDER BY s.created_at DESC`,
      [start, start, ...salesScope.values],
    ),
    pool.execute<Array<RowDataPacket & {
      id: number; refund_number: string; total: string; status: string; created_at: Date;
      actor: string; customer: string | null; reason: string; branch: string;
    }>>(
      `SELECT r.id, r.refund_number, r.total, r.status, r.created_at, u.name AS actor,
              c.name AS customer, r.reason, b.name AS branch
       FROM refunds r JOIN users u ON u.id=r.created_by JOIN branches b ON b.id=r.branch_id
       JOIN sales s ON s.id=r.sale_id LEFT JOIN customers c ON c.id=s.customer_id
       WHERE r.created_at>=? AND r.created_at<DATE_ADD(?, INTERVAL 1 DAY) ${refundScope.sql}
       ORDER BY r.created_at DESC`,
      [start, start, ...refundScope.values],
    ),
    pool.execute<Array<RowDataPacket & {
      id: number; amount: string; status: string; created_at: Date; actor: string;
      payment_method: string; description: string; branch: string;
    }>>(
      `SELECT e.id, e.amount, e.status, e.created_at, u.name AS actor,
              e.payment_method, e.description, b.name AS branch
       FROM expenses e JOIN users u ON u.id=e.created_by JOIN branches b ON b.id=e.branch_id
       WHERE e.created_at>=? AND e.created_at<DATE_ADD(?, INTERVAL 1 DAY) ${expenseScope.sql}
       ORDER BY e.created_at DESC`,
      [start, start, ...expenseScope.values],
    ),
  ]);
  const summary = summaryRows[0][0];
  const [refundTotals] = await pool.execute<Array<RowDataPacket & { refunds: string }>>(
    `SELECT COALESCE(SUM(r.total),0) AS refunds FROM refunds r
     WHERE r.status='completed' AND r.created_at>=?
       AND r.created_at<DATE_ADD(?, INTERVAL 1 DAY) ${refundScope.sql}`,
    [start, start, ...refundScope.values],
  );
  const [expenseTotals] = await pool.execute<Array<RowDataPacket & { expenses: string }>>(
    `SELECT COALESCE(SUM(e.amount),0) AS expenses FROM expenses e
     WHERE e.status='approved' AND e.created_at>=?
       AND e.created_at<DATE_ADD(?, INTERVAL 1 DAY) ${expenseScope.sql}`,
    [start, start, ...expenseScope.values],
  );
  const [paymentRowsData] = paymentRows;
  const [salesData] = sales;
  const [refundData] = refunds;
  const [expenseData] = expenses;
  const grossSales = new Decimal(summary.gross_sales);
  const completedRefunds = new Decimal(refundTotals[0]?.refunds ?? 0);
  const approvedExpenses = new Decimal(expenseTotals[0]?.expenses ?? 0);
  const transactions = [
    ...salesData.map((row) => ({
      id: `sale-${row.id}`, kind: "sale" as const, reference: row.receipt_number,
      amount: row.total, status: row.status, actor: row.cashier, customer: row.customer,
      description: `${Number(row.item_count)} item lines`, paymentMethod: row.payment_methods,
      branch: row.branch, createdAt: row.created_at.toISOString(),
    })),
    ...refundData.map((row) => ({
      id: `refund-${row.id}`, kind: "refund" as const, reference: row.refund_number,
      amount: `-${row.total}`, status: row.status, actor: row.actor, customer: row.customer,
      description: row.reason, paymentMethod: "cash", branch: row.branch,
      createdAt: row.created_at.toISOString(),
    })),
    ...expenseData.map((row) => ({
      id: `expense-${row.id}`, kind: "expense" as const, reference: `EXP-${row.id}`,
      amount: `-${row.amount}`, status: row.status, actor: row.actor, customer: null,
      description: row.description, paymentMethod: row.payment_method, branch: row.branch,
      createdAt: row.created_at.toISOString(),
    })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return {
    date,
    summary: {
      grossSales: String(summary.gross_sales),
      completedTransactions: Number(summary.transactions),
      averageTransaction: String(summary.average_transaction),
      refunds: String(refundTotals[0]?.refunds ?? "0"),
      salesAfterRefunds: grossSales.minus(completedRefunds).toFixed(2),
      approvedExpenses: String(expenseTotals[0]?.expenses ?? "0"),
      salesAfterRefundsAndExpenses: grossSales.minus(completedRefunds).minus(approvedExpenses).toFixed(2),
    },
    payments: paymentRowsData.map((row) => ({
      method: row.method, amount: row.amount, transactions: Number(row.transactions),
    })),
    transactions,
  };
}
