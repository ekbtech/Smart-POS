import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import type { AuthUser } from "./auth.js";
import { execute, query, withTransaction } from "./db.js";
import { HttpError } from "./errors.js";

const pairingLifetimeMs = 90_000;
const duplicateWindowMs = 1_200;

type ScannerScan = { id: string; barcode: string; createdAt: number };
type ScannerResult = {
  id: string;
  barcode: string;
  status: "added" | "unknown" | "rejected" | "error";
  message: string;
  productName?: string;
};
type ScannerPairingRow = RowDataPacket & {
  id: string;
  pos_session_id: string;
  user_id: number;
  branch_id: number;
  pair_token_hash: string | null;
  scanner_token_hash: string | null;
  pair_expires_at: Date;
  expires_at: Date;
  last_scanner_seen_at: Date | null;
  last_pos_seen_at: Date;
  last_barcode: string | null;
  last_barcode_at: Date | null;
  latest_result: ScannerResult | string | null;
};

export const scannerPairSchema = z.object({ token: z.string().min(32).max(128) }).strict();
export const scannerScanSchema = z.object({
  barcode: z.string().trim().min(1).max(64).regex(/^[\x20-\x7E]+$/, "Barcode contains unsupported characters."),
}).strict();
export const scannerAckSchema = z.object({
  scanId: z.uuid(),
  status: z.enum(["added", "unknown", "rejected", "error"]),
  message: z.string().trim().min(1).max(200),
  productName: z.string().trim().min(1).max(180).optional(),
}).strict();

export function hashScannerToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function scannerTokenMatches(token: string, expected: string | null): boolean {
  if (!expected) return false;
  const actualBytes = Buffer.from(hashScannerToken(token), "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function pairingExpired(error: unknown): HttpError | undefined {
  return error && typeof error === "object" && "code" in error && error.code === "ER_NO_REFERENCED_ROW_2"
    ? new HttpError(401, "The POS session has expired. Pair the phone again from POS.")
    : undefined;
}

async function getActivePairing(id: string): Promise<ScannerPairingRow> {
  const rows = await query<ScannerPairingRow[]>(
    `SELECT p.id, p.pos_session_id, p.user_id, p.branch_id, p.pair_token_hash,
            p.scanner_token_hash, p.pair_expires_at, p.expires_at, p.last_scanner_seen_at,
            p.last_pos_seen_at, p.last_barcode, p.last_barcode_at, p.latest_result
     FROM mobile_scanner_pairings p
     JOIN pos_sessions s ON s.id = p.pos_session_id AND s.expires_at > CURRENT_TIMESTAMP(3)
     JOIN users u ON u.id = p.user_id AND u.is_active = TRUE
     WHERE p.id = ? AND p.expires_at > CURRENT_TIMESTAMP(3)
     LIMIT 1`,
    [id],
  );
  if (!rows[0]) throw new HttpError(410, "The phone scanner session has expired. Pair it again from POS.");
  return rows[0];
}

async function authenticateScanner(id: string, token: string): Promise<ScannerPairingRow> {
  const pairing = await getActivePairing(id);
  if (!scannerTokenMatches(token, pairing.scanner_token_hash)) {
    throw new HttpError(401, "Phone scanner authentication failed. Pair the phone again.");
  }
  await execute(
    "UPDATE mobile_scanner_pairings SET last_scanner_seen_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
    [id],
  );
  return pairing;
}

function assertPosSession(pairing: ScannerPairingRow, posSessionId: string): void {
  if (pairing.pos_session_id !== posSessionId) {
    throw new HttpError(403, "This scanner belongs to a different POS session.");
  }
}

function asScannerResult(value: ScannerPairingRow["latest_result"]): ScannerResult | null {
  if (!value) return null;
  return typeof value === "string" ? JSON.parse(value) as ScannerResult : value;
}

export async function createScannerPairing(user: AuthUser, posSessionId: string) {
  const id = randomUUID();
  const pairToken = randomBytes(32).toString("base64url");
  try {
    await withTransaction(async (connection) => {
      await connection.execute(
        "DELETE FROM mobile_scanner_pairings WHERE expires_at <= CURRENT_TIMESTAMP(3) OR pos_session_id = ?",
        [posSessionId],
      );
      await connection.execute(
        `INSERT INTO mobile_scanner_pairings
         (id, pos_session_id, user_id, branch_id, pair_token_hash, pair_expires_at, expires_at, last_pos_seen_at)
         VALUES (?, ?, ?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 90 SECOND),
                 DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 2 HOUR), CURRENT_TIMESTAMP(3))`,
        [id, posSessionId, user.id, user.branchId, hashScannerToken(pairToken)],
      );
    });
  } catch (error) {
    const expired = pairingExpired(error);
    if (expired) throw expired;
    throw error;
  }
  return { id, pairToken, expiresAt: new Date(Date.now() + pairingLifetimeMs).toISOString() };
}

export async function exchangeScannerPairing(id: string, pairToken: string): Promise<{ scannerToken: string }> {
  const scannerToken = randomBytes(32).toString("base64url");
  await withTransaction(async (connection) => {
    const [rows] = await connection.execute<ScannerPairingRow[]>(
      `SELECT id, pos_session_id, user_id, branch_id, pair_token_hash, scanner_token_hash,
              pair_expires_at, expires_at, last_scanner_seen_at, last_pos_seen_at,
              last_barcode, last_barcode_at, latest_result
       FROM mobile_scanner_pairings WHERE id = ? FOR UPDATE`,
      [id],
    );
    const pairing = rows[0];
    if (!pairing || new Date(pairing.expires_at).getTime() <= Date.now()) {
      throw new HttpError(410, "The phone scanner session has expired. Pair it again from POS.");
    }
    if (new Date(pairing.pair_expires_at).getTime() <= Date.now()
      || !scannerTokenMatches(pairToken, pairing.pair_token_hash)) {
      throw new HttpError(401, "This pairing QR code is invalid or expired. Create a new code in POS.");
    }
    if (pairing.scanner_token_hash) {
      throw new HttpError(409, "This POS session is already paired with a phone.");
    }
    await connection.execute(
      `UPDATE mobile_scanner_pairings
       SET scanner_token_hash = ?, pair_token_hash = NULL, last_scanner_seen_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?`,
      [hashScannerToken(scannerToken), id],
    );
  });
  return { scannerToken };
}

export async function reconnectScanner(id: string, token: string) {
  const pairing = await authenticateScanner(id, token);
  return { connected: Date.now() - new Date(pairing.last_pos_seen_at).getTime() < 6_000 };
}

export async function getScannerStatus(id: string, token: string) {
  const pairing = await authenticateScanner(id, token);
  return {
    connected: Date.now() - new Date(pairing.last_pos_seen_at).getTime() < 6_000,
    latestResult: asScannerResult(pairing.latest_result),
  };
}

export async function submitScannerBarcode(id: string, token: string, barcode: string) {
  return withTransaction(async (connection) => {
    const pairing = await selectPairingForUpdate(connection, id);
    if (!scannerTokenMatches(token, pairing.scanner_token_hash)) {
      throw new HttpError(401, "Phone scanner authentication failed. Pair the phone again.");
    }
    if (pairing.last_barcode === barcode && pairing.last_barcode_at
      && Date.now() - new Date(pairing.last_barcode_at).getTime() < duplicateWindowMs) {
      return { accepted: false, duplicate: true };
    }
    const [pendingRows] = await connection.execute<Array<RowDataPacket & { pending: number }>>(
      "SELECT COUNT(*) AS pending FROM mobile_scanner_scans WHERE pairing_id = ? AND processed_at IS NULL",
      [id],
    );
    if (Number(pendingRows[0]?.pending ?? 0) >= 50) {
      throw new HttpError(429, "The POS scanner queue is full. Wait for it to reconnect.");
    }
    const scanId = randomUUID();
    await connection.execute(
      "INSERT INTO mobile_scanner_scans (id, pairing_id, barcode) VALUES (?, ?, ?)",
      [scanId, id, barcode],
    );
    await connection.execute(
      "UPDATE mobile_scanner_pairings SET last_barcode = ?, last_barcode_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
      [barcode, id],
    );
    return { accepted: true, duplicate: false, scanId };
  });
}

async function selectPairingForUpdate(connection: PoolConnection, id: string): Promise<ScannerPairingRow> {
  const [rows] = await connection.execute<ScannerPairingRow[]>(
    `SELECT p.id, p.pos_session_id, p.user_id, p.branch_id, p.pair_token_hash,
            p.scanner_token_hash, p.pair_expires_at, p.expires_at, p.last_scanner_seen_at,
            p.last_pos_seen_at, p.last_barcode, p.last_barcode_at, p.latest_result
     FROM mobile_scanner_pairings p
     JOIN pos_sessions s ON s.id = p.pos_session_id AND s.expires_at > CURRENT_TIMESTAMP(3)
     JOIN users u ON u.id = p.user_id AND u.is_active = TRUE
     WHERE p.id = ? AND p.expires_at > CURRENT_TIMESTAMP(3)
     FOR UPDATE`,
    [id],
  );
  if (!rows[0]) throw new HttpError(410, "The phone scanner session has expired. Pair it again from POS.");
  return rows[0];
}

export async function pollScannerScans(id: string, posSessionId: string) {
  return withTransaction(async (connection) => {
    const pairing = await selectPairingForUpdate(connection, id);
    assertPosSession(pairing, posSessionId);
    await connection.execute(
      "UPDATE mobile_scanner_pairings SET last_pos_seen_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
      [id],
    );
    const [scans] = await connection.execute<Array<RowDataPacket & {
      id: string;
      barcode: string;
      created_at: Date;
    }>>(
      `SELECT id, barcode, created_at FROM mobile_scanner_scans
       WHERE pairing_id = ? AND processed_at IS NULL ORDER BY created_at ASC LIMIT 10`,
      [id],
    );
    return {
      paired: Boolean(pairing.scanner_token_hash),
      scannerConnected: Boolean(pairing.last_scanner_seen_at
        && Date.now() - new Date(pairing.last_scanner_seen_at).getTime() < 6_000),
      scans: scans.map((scan): ScannerScan => ({
        id: scan.id,
        barcode: scan.barcode,
        createdAt: new Date(scan.created_at).getTime(),
      })),
    };
  });
}

export async function acknowledgeScannerScan(
  id: string,
  posSessionId: string,
  input: z.infer<typeof scannerAckSchema>,
) {
  return withTransaction(async (connection) => {
    const pairing = await selectPairingForUpdate(connection, id);
    assertPosSession(pairing, posSessionId);
    const [rows] = await connection.execute<Array<RowDataPacket & {
      id: string;
      barcode: string;
      processed_at: Date | null;
    }>>(
      `SELECT id, barcode, processed_at FROM mobile_scanner_scans
       WHERE id = ? AND pairing_id = ? FOR UPDATE`,
      [input.scanId, id],
    );
    const scan = rows[0];
    if (!scan) throw new HttpError(404, "The pending barcode scan no longer exists.");
    if (scan.processed_at) return { acknowledged: true };
    const result: ScannerResult = {
      id: scan.id,
      barcode: scan.barcode,
      status: input.status,
      message: input.message,
      ...(input.productName ? { productName: input.productName } : {}),
    };
    await connection.execute(
      `UPDATE mobile_scanner_scans SET processed_at = CURRENT_TIMESTAMP(3), result = ?
       WHERE id = ? AND processed_at IS NULL`,
      [JSON.stringify(result), input.scanId],
    );
    await connection.execute(
      "UPDATE mobile_scanner_pairings SET latest_result = ? WHERE id = ?",
      [JSON.stringify(result), id],
    );
    return { acknowledged: true };
  });
}

export async function revokeScannerPairing(id: string, posSessionId: string): Promise<void> {
  const pairing = await getActivePairing(id);
  assertPosSession(pairing, posSessionId);
  await execute("DELETE FROM mobile_scanner_pairings WHERE id = ?", [id]);
}

export async function revokeScannerPairingsForPosSession(posSessionId: string): Promise<void> {
  await execute("DELETE FROM mobile_scanner_pairings WHERE pos_session_id = ?", [posSessionId]);
}

export async function lookupPosBarcode(barcode: string, branchId: number) {
  const products = await query<Array<{
    id: number;
    sku: string;
    name: string;
    category_name: string;
    unit: string;
    selling_price: string;
    purchase_price: string | null;
    tax_rate: string;
    reorder_level: string;
    stock: string;
    barcode: string | null;
    has_image: number;
  } & RowDataPacket>>(
    `SELECT p.id, p.sku, p.name, COALESCE(c.name, 'Uncategorised') AS category_name,
            p.unit, p.selling_price, p.purchase_price, p.tax_rate, p.reorder_level,
            GREATEST(COALESCE(i.on_hand - i.reserved, 0) - COALESCE(expired.quantity, 0), 0) AS stock,
            p.barcode, (p.image_mime_type IS NOT NULL) AS has_image
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN inventory i ON i.product_id = p.id AND i.branch_id = ?
     LEFT JOIN (
       SELECT product_id, SUM(quantity_remaining) AS quantity
       FROM inventory_batches
       WHERE branch_id = ? AND expiry_date < CURDATE() AND quantity_remaining > 0
       GROUP BY product_id
     ) expired ON expired.product_id = p.id
     WHERE p.is_active = TRUE AND p.barcode = ? LIMIT 1`,
    [branchId, branchId, barcode],
  );
  const product = products[0];
  if (!product) return null;
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    category: product.category_name,
    unit: product.unit,
    sellingPrice: product.selling_price,
    purchasePrice: product.purchase_price,
    taxRate: product.tax_rate,
    reorderLevel: product.reorder_level,
    stock: String(product.stock),
    barcode: product.barcode,
    hasImage: Boolean(product.has_image),
  };
}
