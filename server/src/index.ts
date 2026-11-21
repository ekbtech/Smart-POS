import "./env.js";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { z, ZodError } from "zod";
import {
  authenticate, authenticatePos, changePassword, currentUser, login, logout, posLogin, posLogout, requireRoles, requireModule,
} from "./auth.js";
import { pool, query } from "./db.js";
import {
  bankTransferDecisionSchema, bankTransferVerificationRequestSchema, createSale, decideBankTransferVerification,
  getBankTransferVerification, listPendingBankTransferVerifications, saleSchema, heldSaleSchema,
  holdSale, listHeldSales, requestBankTransferVerification, retrieveHeldSale,
} from "./sales.js";
import { HttpError } from "./errors.js";
import {
  canAssignStaffRole, createStaff, createStaffSchema, listBranches, listDepartments, listRolePermissions,
  listStaff, listStaffActivity, manageableModuleIds, modulePermissionOverridesSchema, modulePermissionsSchema,
  resetStaffPassword, resetStaffPasswordSchema,
  setStaffStatus, staffStatusSchema, updateRolePermissions, updateStaff, updateStaffSchema,
} from "./staff.js";
import { productSchema, registerProduct, updateProduct, updateProductSchema } from "./products.js";
import {
  fetchOpenFoodFactsImage, lookupRegistrationBarcode, productBarcodeLookupSchema, productImageImportSchema,
} from "./product-lookup.js";
import { getBranchReport, parseReportRange } from "./reports.js";
import {
  addCashMovement, adjustmentSchema, approvePurchaseOrder, cashMovementSchema, closeShift, closeShiftSchema,
  createCustomer, createExpense, createPurchaseOrder, createRefund, createSupplier, customerSchema,
  decideExpense, expenseDecisionSchema, expenseSchema, getActiveShift, getInventorySummary, getShiftCloseSummary, listCustomers, listExpenses,
  getPurchaseOrder, getStockMovements, listInventory, listPurchaseOrders, listRefunds, listSuppliers, openShift,
  openShiftSchema, purchaseOrderSchema, receivePurchaseOrder, receiveSchema, refundSchema, adjustInventory,
  supplierSchema, completeStockTake, createStockTake, getStockTake, listExpiryBatches, listStockTakes,
  stockTakeCompletionSchema, stockTakeSchema, createInventoryTransfer, dispatchInventoryTransfer,
  getInventoryTransfer, inventoryTransferReceiptSchema, inventoryTransferSchema, listInventoryTransfers,
  listTransferBranches, receiveInventoryTransfer,
} from "./operations.js";
import {
  acknowledgeRegistrationScannerScan, acknowledgeScannerScan, createRegistrationScannerPairing,
  createScannerPairing, disconnectPhoneScanner, exchangeScannerPairing, getScannerStatus,
  lookupPosBarcode, pollRegistrationScannerScans, pollScannerScans, reconnectScanner,
  revokeRegistrationScannerPairing, revokeScannerPairing,
  scannerAckSchema, scannerPairSchema, scannerScanSchema, submitScannerBarcode,
} from "./mobile-scanner.js";

const app = express();
const port = Number(process.env.PORT ?? 4000);
const configuredOrigins = (process.env.CLIENT_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOrigins = new Set([
  ...configuredOrigins,
]);
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;
  try {
    const url = new URL(origin);
    return (url.hostname === "localhost" || url.hostname === "127.0.0.1")
      && (/^\d+$/.test(url.port));
  } catch {
    return false;
  }
}

app.disable("x-powered-by");
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) callback(null, true);
    else callback(new Error("Request origin is not allowed."));
  },
  credentials: true,
}));
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());
app.use((req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)
    && req.headers.origin
    && !isAllowedOrigin(req.headers.origin)) {
    res.status(403).json({ error: "Request origin is not allowed." });
    return;
  }
  next();
});

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false });
const productLookupLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });

function positiveId(value: string | string[] | undefined): number | undefined {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function scannerPairingId(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && z.uuid().safeParse(value).success ? value : undefined;
}

function scannerBearerToken(req: express.Request): string {
  const authorization = req.header("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{40,100})$/.exec(authorization);
  if (!match?.[1]) throw new HttpError(401, "Phone scanner authentication is required.");
  return match[1];
}

function positiveQueryInteger(value: unknown, fallback: number, maximum: number): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : undefined;
}

function requireAnyModule(...moduleIds: string[]): express.RequestHandler {
  return (req, res, next) => {
    if (!moduleIds.some((moduleId) => req.user?.modules?.includes(moduleId))) {
      res.status(403).json({ error: "You do not have permission to access this module." });
      return;
    }
    next();
  };
}

function matchesImageSignature(data: Buffer, mimeType: string): boolean {
  if (mimeType === "image/png") return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === "image/jpeg") return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  return mimeType === "image/webp"
    && data.length >= 12
    && data.toString("ascii", 0, 4) === "RIFF"
    && data.toString("ascii", 8, 12) === "WEBP";
}

function handleOperation(
  work: () => Promise<unknown>,
  res: express.Response,
  next: express.NextFunction,
  status = 200,
) {
  void work().then((result) => res.status(status).json(result), next);
}

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
app.post("/api/auth/login", loginLimiter, (req, res, next) => void login(req, res).catch(next));
app.post("/api/auth/logout", authenticate, (req, res, next) => void logout(req, res).catch(next));
app.get("/api/auth/me", authenticate, currentUser);
app.post("/api/auth/change-password", authenticate, (req, res, next) => void changePassword(req, res).catch(next));
app.post("/api/pos/login", loginLimiter, (req, res, next) => void posLogin(req, res).catch(next));
app.get("/api/pos/session", authenticate, authenticatePos, (req, res) => {
  res.json({ cashier: { ...req.posUser, username: req.posUser?.posUsername } });
});
app.post("/api/pos/logout", authenticate, authenticatePos, (req, res, next) => void posLogout(req, res).catch(next));
app.post(
  "/api/products/scanner/pairing",
  authenticate,
  requireModule("products"),
  requireRoles("admin", "manager", "inventory_manager"),
  (req, res, next) => {
    try {
      if (!req.user || !req.sessionId) throw new HttpError(401, "Product registration session required.");
      void createRegistrationScannerPairing(req.user, req.sessionId).then(
        (pairing) => res.status(201).json(pairing),
        next,
      );
    } catch (error) {
      next(error);
    }
  },
);
app.get(
  "/api/products/scanner/pairing/:id/poll",
  authenticate,
  requireModule("products"),
  requireRoles("admin", "manager", "inventory_manager"),
  (req, res, next) => {
    const id = scannerPairingId(req.params.id);
    if (!id) { res.status(400).json({ error: "Invalid scanner pairing ID." }); return; }
    if (!req.user) { res.status(401).json({ error: "Product registration session required." }); return; }
    void pollRegistrationScannerScans(id, req.user.id).then((result) => res.json(result), next);
  },
);
app.post(
  "/api/products/scanner/pairing/:id/ack",
  authenticate,
  requireModule("products"),
  requireRoles("admin", "manager", "inventory_manager"),
  (req, res, next) => {
    const id = scannerPairingId(req.params.id);
    if (!id) { res.status(400).json({ error: "Invalid scanner pairing ID." }); return; }
    if (!req.user) { res.status(401).json({ error: "Product registration session required." }); return; }
    try {
      const input = scannerAckSchema.parse(req.body);
      void acknowledgeRegistrationScannerScan(id, req.user.id, input).then((result) => res.json(result), next);
    } catch (error) {
      next(error);
    }
  },
);
app.delete(
  "/api/products/scanner/pairing/:id",
  authenticate,
  requireModule("products"),
  requireRoles("admin", "manager", "inventory_manager"),
  (req, res, next) => {
    const id = scannerPairingId(req.params.id);
    if (!id) { res.status(400).json({ error: "Invalid scanner pairing ID." }); return; }
    if (!req.user) { res.status(401).json({ error: "Product registration session required." }); return; }
    void revokeRegistrationScannerPairing(id, req.user.id).then(() => res.status(204).end(), next);
  },
);
app.post("/api/pos/scanner/pairing", authenticate, authenticatePos, requireModule("pos"), (req, res, next) => {
  try {
    if (!req.posSessionId || !req.posUser) throw new HttpError(401, "POS authentication required.");
    void createScannerPairing(req.posUser, req.posSessionId).then(
      (pairing) => res.status(201).json(pairing),
      next,
    );
  } catch (error) {
    next(error);
  }
});
app.post("/api/pos/scanner/pair/:id", (req, res, next) => {
  const id = scannerPairingId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid scanner pairing ID." }); return; }
  try {
    const input = scannerPairSchema.parse(req.body);
    void exchangeScannerPairing(id, input.token).then((result) => res.json(result), next);
  } catch (error) {
    next(error);
  }
});
app.post("/api/pos/scanner/:id/reconnect", (req, res, next) => {
  const id = scannerPairingId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid scanner pairing ID." }); return; }
  try {
    void reconnectScanner(id, scannerBearerToken(req)).then((result) => res.json(result), next);
  } catch (error) {
    next(error);
  }
});
app.post("/api/pos/scanner/:id/disconnect", (req, res, next) => {
  const id = scannerPairingId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid scanner pairing ID." }); return; }
  try {
    void disconnectPhoneScanner(id, scannerBearerToken(req)).then(() => res.status(204).end(), next);
  } catch (error) {
    next(error);
  }
});
app.get("/api/pos/scanner/:id/status", (req, res, next) => {
  const id = scannerPairingId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid scanner pairing ID." }); return; }
  try {
    void getScannerStatus(id, scannerBearerToken(req)).then((result) => res.json(result), next);
  } catch (error) {
    next(error);
  }
});
app.post("/api/pos/scanner/:id/scans", (req, res, next) => {
  const id = scannerPairingId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid scanner pairing ID." }); return; }
  try {
    const input = scannerScanSchema.parse(req.body);
    void submitScannerBarcode(id, scannerBearerToken(req), input.barcode).then(
      (result) => res.status(202).json(result),
      next,
    );
  } catch (error) {
    next(error);
  }
});
app.get("/api/pos/scanner/pairing/:id/poll", authenticate, authenticatePos, requireModule("pos"), (req, res, next) => {
  const id = scannerPairingId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid scanner pairing ID." }); return; }
  try {
    if (!req.posSessionId) throw new HttpError(401, "POS authentication required.");
    void pollScannerScans(id, req.posSessionId).then((result) => res.json(result), next);
  } catch (error) {
    next(error);
  }
});
app.post("/api/pos/scanner/pairing/:id/ack", authenticate, authenticatePos, requireModule("pos"), (req, res, next) => {
  const id = scannerPairingId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid scanner pairing ID." }); return; }
  try {
    const input = scannerAckSchema.parse(req.body);
    if (!req.posSessionId) throw new HttpError(401, "POS authentication required.");
    void acknowledgeScannerScan(id, req.posSessionId, input).then((result) => res.json(result), next);
  } catch (error) {
    next(error);
  }
});
app.delete("/api/pos/scanner/pairing/:id", authenticate, authenticatePos, requireModule("pos"), (req, res, next) => {
  const id = scannerPairingId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid scanner pairing ID." }); return; }
  try {
    if (!req.posSessionId) throw new HttpError(401, "POS authentication required.");
    void revokeScannerPairing(id, req.posSessionId).then(() => res.status(204).end(), next);
  } catch (error) {
    next(error);
  }
});
app.get("/api/pos/scanner/product", authenticate, authenticatePos, requireModule("pos"), async (req, res, next) => {
  const barcode = typeof req.query.barcode === "string" ? req.query.barcode.trim() : "";
  const parsed = scannerScanSchema.safeParse({ barcode });
  if (!parsed.success) { res.status(400).json({ error: "Enter a valid product barcode." }); return; }
  try {
    const product = await lookupPosBarcode(parsed.data.barcode, req.posUser!.branchId);
    res.json({ product });
  } catch (error) {
    next(error);
  }
});

app.get("/api/access/modules", authenticate, requireRoles("admin"), async (_req, res, next) => {
  try {
    res.json({ modules: await query<Array<{ id: string; name: string; route: string; sort_order: number } & import("mysql2").RowDataPacket>>(
      `SELECT id, name, route, sort_order FROM modules
       WHERE id IN (${[...manageableModuleIds].map(() => "?").join(",")}) ORDER BY sort_order`,
      [...manageableModuleIds],
    ).then((rows) => rows.map((row) => ({
      id: row.id, name: row.name, route: row.route, sortOrder: row.sort_order,
    }))) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/access/roles", authenticate, requireRoles("admin"), async (_req, res, next) => {
  try {
    res.json({ roles: await listRolePermissions() });
  } catch (error) {
    next(error);
  }
});

app.put("/api/access/roles/:role", authenticate, requireRoles("admin"), (req, res, next) => {
  const permissions = modulePermissionsSchema.safeParse(req.body.permissions);
  if (!permissions.success) { res.status(400).json({ error: "Provide valid role module permissions." }); return; }
  const roleName = Array.isArray(req.params.role) ? req.params.role[0] ?? "" : req.params.role ?? "";
  void updateRolePermissions(roleName, permissions.data, req.user!).then(
    (result) => res.json(result),
    next,
  );
});

app.get("/api/staff/branches", authenticate, requireRoles("admin"), async (_req, res, next) => {
  try {
    const branches = await listBranches();
    res.json({ branches: branches.map(({ id, name, code }) => ({ id, name, code })) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/access/users/:id", authenticate, requireRoles("admin"), async (req, res, next) => {
  const id = positiveId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid user ID." }); return; }
  try {
    const [users, overrides] = await Promise.all([
      query<Array<{ id: number; default_landing: string | null; branch_id: number; username: string; email: string; name: string; is_active: number } & import("mysql2").RowDataPacket>>(
        "SELECT id, name, email, username, branch_id, is_active, default_landing FROM users WHERE id=? LIMIT 1",
        [id],
      ),
      query<Array<{ module_id: string; allowed: number } & import("mysql2").RowDataPacket>>(
        "SELECT module_id, allowed FROM user_permissions WHERE user_id=?",
        [id],
      ),
    ]);
    if (!users[0]) { res.status(404).json({ error: "User not found." }); return; }
    const roles = await query<Array<{ name: string } & import("mysql2").RowDataPacket>>(
      "SELECT r.name FROM roles r JOIN user_roles ur ON ur.role_id=r.id WHERE ur.user_id=?",
      [id],
    );
    res.json({
      user: {
        id: users[0].id, name: users[0].name, email: users[0].email, username: users[0].username,
        branchId: users[0].branch_id, isActive: Boolean(users[0].is_active), roles: roles.map((role) => role.name),
      },
      defaultLanding: users[0].default_landing,
      permissions: overrides.map((item) => ({ moduleId: item.module_id, allowed: Boolean(item.allowed) })),
    });
  } catch (error) {
    next(error);
  }
});

app.put("/api/access/users/:id", authenticate, requireRoles("admin"), async (req, res, next) => {
  const id = positiveId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid user ID." }); return; }
  const defaultLanding = req.body.defaultLanding === null
    ? null
    : typeof req.body.defaultLanding === "string" ? req.body.defaultLanding : undefined;
  const permissions = modulePermissionOverridesSchema.safeParse(req.body.permissions);
  if (defaultLanding === undefined || !permissions.success) {
    res.status(400).json({ error: "Provide a default landing page and valid module permission overrides." });
    return;
  }
  try {
    const result = await updateStaff(id, { defaultLanding, modulePermissions: permissions.data }, req.user!);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/staff/departments", authenticate, requireRoles("admin"), async (_req, res, next) => {
  try {
    res.json({ departments: await listDepartments() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/staff", authenticate, requireRoles("admin"), async (req, res, next) => {
  try {
    const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 100) : "";
    const branchId = positiveQueryInteger(req.query.branchId, req.user!.branchId, Number.MAX_SAFE_INTEGER);
    if (!branchId) { res.status(400).json({ error: "Invalid branch ID." }); return; }
    const users = await listStaff(branchId, search);
    res.json({ staff: users.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      isActive: Boolean(user.is_active),
      createdAt: user.created_at.toISOString(),
      department: user.department,
      jobTitle: user.job_title,
      phone: user.phone,
      hiredAt: user.hired_at?.toISOString().slice(0, 10) ?? null,
      roles: user.roles ? user.roles.split(",") : [],
      lastLogin: user.last_login?.toISOString() ?? null,
      username: user.username,
      defaultLanding: user.default_landing,
      branchId: user.branch_id,
      branch: user.branch_name,
      employeeNumber: user.employee_number,
      permissionOverrides: user.permission_overrides
        ? user.permission_overrides.split(",").map((entry) => {
          const [moduleId, allowed] = entry.split(":");
          return { moduleId, allowed: allowed === "1" };
        })
        : [],
    })) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/staff", authenticate, requireRoles("admin"), (req, res, next) => {
  try {
    const input = createStaffSchema.parse(req.body);
    if (!canAssignStaffRole(req.user!, input.role)) {
      res.status(403).json({ error: "You cannot assign this role." });
      return;
    }
    void createStaff(input, req.user!).then(
      (staff) => res.status(201).json({ staff }),
      next,
    );
  } catch (error) {
    next(error);
  }
});

app.patch("/api/staff/:id/status", authenticate, requireRoles("admin"), (req, res, next) => {
  const id = positiveId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid staff account ID." }); return; }
  try {
    const input = staffStatusSchema.parse(req.body);
    void setStaffStatus(id, input.isActive, req.user!).then(
      (staff) => res.json({ staff }),
      next,
    );
  } catch (error) {
    next(error);
  }
});

app.put("/api/staff/:id", authenticate, requireRoles("admin"), (req, res, next) => {
  const id = positiveId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid staff account ID." }); return; }
  try {
    const input = updateStaffSchema.parse(req.body);
    void updateStaff(id, input, req.user!).then((staff) => res.json({ staff }), next);
  } catch (error) {
    next(error);
  }
});

app.post("/api/staff/:id/password-reset", authenticate, requireRoles("admin"), (req, res, next) => {
  const id = positiveId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid staff account ID." }); return; }
  try {
    const input = resetStaffPasswordSchema.parse(req.body);
    void resetStaffPassword(id, input.password, req.user!).then((result) => res.json(result), next);
  } catch (error) {
    next(error);
  }
});

app.get("/api/staff/:id/activity", authenticate, requireRoles("admin"), async (req, res, next) => {
  const id = positiveId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid staff account ID." }); return; }
  try {
    const [users] = await pool.execute<Array<import("mysql2").RowDataPacket & { id: number }>>(
      "SELECT id FROM users WHERE id=? LIMIT 1",
      [id],
    );
    if (!users[0]) { res.status(404).json({ error: "Staff account not found." }); return; }
    res.json(await listStaffActivity(id));
  } catch (error) {
    next(error);
  }
});

app.get("/api/products", authenticate, requireAnyModule("products", "pos"), async (req, res, next) => {
  try {
    const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 100) : "";
    const category = typeof req.query.category === "string" ? req.query.category.trim().slice(0, 100) : "";
    const page = positiveQueryInteger(req.query.page, 1, 1_000_000);
    const pageSize = positiveQueryInteger(req.query.pageSize, 100, 100);
    const sort = typeof req.query.sort === "string" ? req.query.sort : "name";
    const direction = typeof req.query.direction === "string" ? req.query.direction : "asc";
    const stockStatus = typeof req.query.stockStatus === "string" ? req.query.stockStatus : "";
    if (!page || !pageSize || !["name", "price", "stock"].includes(sort)
      || !["asc", "desc"].includes(direction)
      || !["", "in_stock", "low_stock", "out_of_stock"].includes(stockStatus)) {
      res.status(400).json({ error: "Invalid product list filters." });
      return;
    }
    const baseSql = `SELECT p.id, p.sku, p.name, p.brand, p.package_size, p.description, COALESCE(c.name, 'Uncategorised') AS category_name,
              p.unit, p.selling_price, p.purchase_price, p.tax_rate, p.reorder_level,
              GREATEST(COALESCE(i.on_hand - i.reserved, 0) - COALESCE(expired.quantity, 0), 0) AS stock,
              p.barcode, (p.image_mime_type IS NOT NULL) AS has_image
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN inventory i ON i.product_id = p.id AND i.branch_id = ?
       LEFT JOIN (
         SELECT product_id, SUM(quantity_remaining) AS quantity
         FROM inventory_batches
         WHERE branch_id = ? AND expiry_date < CURDATE() AND quantity_remaining > 0
         GROUP BY product_id
       ) expired ON expired.product_id = p.id
       WHERE p.is_active = TRUE`;
    const filters = [
      "(? = '' OR catalogue.name LIKE CONCAT('%', ?, '%') OR catalogue.sku LIKE CONCAT('%', ?, '%') OR catalogue.barcode LIKE CONCAT('%', ?, '%'))",
      "(? = '' OR catalogue.category_name = ?)",
    ];
    const filterValues: Array<string | number> = [search, search, search, search, category, category];
    if (stockStatus === "in_stock") filters.push("catalogue.stock > catalogue.reorder_level");
    if (stockStatus === "low_stock") filters.push("catalogue.stock > 0 AND catalogue.stock <= catalogue.reorder_level");
    if (stockStatus === "out_of_stock") filters.push("catalogue.stock <= 0");
    const where = filters.join(" AND ");
    const baseValues = [req.user!.branchId, req.user!.branchId];
    const [countRows] = await pool.execute<Array<{ total: number } & import("mysql2").RowDataPacket>>(
      `SELECT COUNT(*) AS total FROM (${baseSql}) catalogue WHERE ${where}`,
      [...baseValues, ...filterValues],
    );
    const orderBy = sort === "price" ? "catalogue.selling_price"
      : sort === "stock" ? "catalogue.stock" : "catalogue.name";
    const products = await query<Array<{
      id: number; sku: string; name: string; brand: string | null; package_size: string | null; description: string | null;
      category_name: string | null; unit: string; tax_rate: string; reorder_level: string;
      selling_price: string; purchase_price: string | null; stock: string; barcode: string | null; has_image: number;
    } & import("mysql2").RowDataPacket>>(
      `SELECT * FROM (${baseSql}) catalogue
       WHERE ${where}
       ORDER BY ${orderBy} ${direction.toUpperCase()}, catalogue.name ASC
       LIMIT ? OFFSET ?`,
      [...baseValues, ...filterValues, pageSize, (page - 1) * pageSize],
    );
    res.json({
      products: products.map((product) => ({
        id: product.id,
        sku: product.sku,
        name: product.name,
        brand: product.brand,
        packageSize: product.package_size,
        description: product.description,
        category: product.category_name,
        unit: product.unit,
        sellingPrice: product.selling_price,
        purchasePrice: req.user!.modules?.includes("products") ? product.purchase_price : null,
        taxRate: product.tax_rate,
        reorderLevel: product.reorder_level,
        stock: String(product.stock),
        barcode: product.barcode,
        hasImage: Boolean(product.has_image),
      })),
      pagination: {
        page,
        pageSize,
        total: Number(countRows[0]?.total ?? 0),
        totalPages: Math.ceil(Number(countRows[0]?.total ?? 0) / pageSize),
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/products/categories", authenticate, requireModule("products"), async (_req, res, next) => {
  try {
    const categories = await query<Array<{ name: string } & import("mysql2").RowDataPacket>>(
      `SELECT DISTINCT c.name FROM categories c
       JOIN products p ON p.category_id = c.id
       WHERE p.is_active = TRUE ORDER BY c.name`,
    );
    res.json({ categories: categories.map((item) => item.name) });
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/products/lookup/barcode",
  authenticate,
  requireModule("products"),
  requireRoles("admin", "manager", "inventory_manager"),
  productLookupLimiter,
  async (req, res, next) => {
    try {
      const { barcode } = productBarcodeLookupSchema.parse(req.body);
      const result = await lookupRegistrationBarcode(barcode, async (value) => {
        const products = await query<Array<{
          id: number; sku: string; name: string; is_active: number;
        } & import("mysql2").RowDataPacket>>(
          "SELECT id, sku, name, is_active FROM products WHERE barcode = ? LIMIT 1",
          [value],
        );
        const product = products[0];
        return product ? {
          id: product.id,
          sku: product.sku,
          name: product.name,
          isActive: Boolean(product.is_active),
        } : null;
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

app.get("/api/products/:id/image", authenticate, requireAnyModule("products", "inventory"), async (req, res, next) => {
  const id = positiveId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid product ID." }); return; }
  try {
    const [rows] = await pool.execute<Array<{ image_data: Buffer; image_mime_type: string } & import("mysql2").RowDataPacket>>(
      "SELECT image_data, image_mime_type FROM products WHERE id = ? AND is_active = TRUE",
      [id],
    );
    if (!rows[0]?.image_data || !rows[0].image_mime_type) {
      res.status(404).json({ error: "Product image not found." });
      return;
    }
    res.setHeader("Content-Type", rows[0].image_mime_type);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(rows[0].image_data);
  } catch (error) {
    next(error);
  }
});

app.post("/api/products", authenticate, requireModule("products"), requireRoles("admin", "manager", "inventory_manager"), (req, res, next) => {
  try {
    const input = productSchema.parse(req.body);
    void registerProduct(input, req.user!).then(
      (product) => res.status(201).json({ product }),
      next,
    );
  } catch (error) {
    next(error);
  }
});

app.patch("/api/products/:id", authenticate, requireModule("products"), requireRoles("admin", "manager", "inventory_manager"), (req, res, next) => {
  const id = positiveId(req.params.id ?? "");
  if (!id) { res.status(400).json({ error: "Invalid product ID." }); return; }
  try {
    const input = updateProductSchema.parse(req.body);
    handleOperation(() => updateProduct(id, input, req.user!), res, next);
  } catch (error) {
    next(error);
  }
});

app.put(
  "/api/products/:id/image",
  authenticate,
  requireAnyModule("products", "inventory"),
  requireRoles("admin", "manager", "inventory_manager"),
  express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "5mb" }),
  async (req, res, next) => {
    const id = positiveId(req.params.id);
    if (!id) { res.status(400).json({ error: "Invalid product ID." }); return; }
    const mimeType = req.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
    if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType)
      || !Buffer.isBuffer(req.body)
      || !req.body.length
      || !matchesImageSignature(req.body, mimeType)) {
      res.status(415).json({ error: "Upload a valid JPEG, PNG, or WebP image." });
      return;
    }
    try {
      const [products] = await pool.execute<Array<{ id: number } & import("mysql2").RowDataPacket>>(
        "SELECT id FROM products WHERE id = ? LIMIT 1",
        [id],
      );
      if (!products[0]) { res.status(404).json({ error: "Product not found." }); return; }
      await pool.execute(
        "UPDATE products SET image_data = ?, image_mime_type = ? WHERE id = ?",
        [req.body, mimeType, id],
      );
      await pool.execute(
        "INSERT INTO audit_logs (user_id, action, entity_type, entity_id) VALUES (?, 'product.image_updated', 'product', ?)",
        [req.user!.id, String(id)],
      );
      res.json({ hasImage: true });
    } catch (error) {
      next(error);
    }
  },
);

app.post("/api/products/:id/image/import", authenticate, requireAnyModule("products", "inventory"), requireRoles("admin", "manager", "inventory_manager"), async (req, res, next) => {
  const id = positiveId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid product ID." }); return; }
  try {
    const { imageUrl } = productImageImportSchema.parse(req.body);
    const [products] = await pool.execute<Array<{ id: number } & import("mysql2").RowDataPacket>>(
      "SELECT id FROM products WHERE id = ? LIMIT 1",
      [id],
    );
    if (!products[0]) { res.status(404).json({ error: "Product not found." }); return; }
    const image = await fetchOpenFoodFactsImage(imageUrl);
    await pool.execute(
      "UPDATE products SET image_data = ?, image_mime_type = ? WHERE id = ?",
      [image.data, image.mimeType, id],
    );
    await pool.execute(
      "INSERT INTO audit_logs (user_id, action, entity_type, entity_id) VALUES (?, 'product.image_updated', 'product', ?)",
      [req.user!.id, String(id)],
    );
    res.json({ hasImage: true });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/products/:id/image", authenticate, requireAnyModule("products", "inventory"), requireRoles("admin", "manager", "inventory_manager"), async (req, res, next) => {
  const id = positiveId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid product ID." }); return; }
  try {
    const [result] = await pool.execute(
      "UPDATE products SET image_data = NULL, image_mime_type = NULL WHERE id = ?",
      [id],
    );
    if ((result as import("mysql2").ResultSetHeader).affectedRows === 0) {
      const [products] = await pool.execute<Array<{ id: number } & import("mysql2").RowDataPacket>>(
        "SELECT id FROM products WHERE id = ? LIMIT 1",
        [id],
      );
      if (!products[0]) { res.status(404).json({ error: "Product not found." }); return; }
    }
    await pool.execute(
      "INSERT INTO audit_logs (user_id, action, entity_type, entity_id) VALUES (?, 'product.image_removed', 'product', ?)",
      [req.user!.id, String(id)],
    );
    res.json({ hasImage: false });
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory", authenticate, requireModule("inventory"), async (req, res, next) => {
  try {
    const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 100) : "";
    const [items, movements] = await Promise.all([
      listInventory(req.user!.branchId, search),
      getStockMovements(req.user!.branchId),
    ]);
    res.json({
      items: items.map((item) => ({
        id: item.id, sku: item.sku, name: item.name, category: item.category ?? "Uncategorised",
        unit: item.unit, onHand: item.on_hand, reserved: item.reserved, available: item.available,
        reorderLevel: item.reorder_level, updatedAt: item.updated_at.toISOString(),
        cost: item.cost, hasImage: Boolean(item.has_image),
      })),
      movements: movements.map((movement) => ({
        id: movement.id, product: movement.product_name, sku: movement.sku, type: movement.movement_type,
        quantity: movement.quantity, reference: movement.reference, createdBy: movement.user_name,
        createdAt: movement.created_at.toISOString(),
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/summary", authenticate, requireModule("inventory"), async (req, res, next) => {
  try {
    res.json({ summary: await getInventorySummary(req.user!.branchId) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/expiry", authenticate, requireModule("inventory"), requireRoles("admin", "manager", "inventory_manager"), async (req, res, next) => {
  const rawDays = req.query.days;
  const days = rawDays === undefined ? 90 : typeof rawDays === "string" && /^\d{1,3}$/.test(rawDays) ? Number(rawDays) : NaN;
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    res.status(400).json({ error: "Expiry window must be between 1 and 365 days." });
    return;
  }
  try {
    const batches = await listExpiryBatches(req.user!.branchId, days);
    res.json({ batches: batches.map((batch) => ({
      id: batch.id, productId: batch.product_id, name: batch.name, sku: batch.sku, batchCode: batch.batch_code,
      expiryDate: batch.expiry_date,
      quantity: batch.quantity_remaining, unit: batch.unit,
    })) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/transfer-branches", authenticate, requireModule("inventory"), requireRoles("admin", "manager", "inventory_manager"), async (req, res, next) => {
  try {
    const branches = await listTransferBranches(req.user!.branchId);
    res.json({ branches });
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/transfers", authenticate, requireModule("inventory"), requireRoles("admin", "manager", "inventory_manager"), async (req, res, next) => {
  try {
    const transfers = await listInventoryTransfers(req.user!.branchId);
    res.json({ transfers: transfers.map((transfer) => ({
      id: transfer.id, reference: transfer.reference, sourceBranchId: transfer.source_branch_id,
      sourceBranch: transfer.source_branch, destinationBranchId: transfer.destination_branch_id,
      destinationBranch: transfer.destination_branch, status: transfer.status, notes: transfer.notes,
      createdAt: transfer.created_at.toISOString(), dispatchedAt: transfer.dispatched_at?.toISOString() ?? null,
      receivedAt: transfer.received_at?.toISOString() ?? null, itemCount: Number(transfer.total_items),
      quantityDispatched: transfer.quantity_dispatched, quantityReceived: transfer.quantity_received,
    })) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/inventory/transfers", authenticate, requireModule("inventory"), requireRoles("admin", "manager", "inventory_manager"), (req, res, next) => {
  try {
    const input = inventoryTransferSchema.parse(req.body);
    handleOperation(() => createInventoryTransfer(input, req.user!), res, next, 201);
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/transfers/:id", authenticate, requireModule("inventory"), requireRoles("admin", "manager", "inventory_manager"), (req, res, next) => {
  const id = positiveId(req.params.id ?? "");
  if (!id) { res.status(400).json({ error: "Invalid transfer ID." }); return; }
  handleOperation(async () => {
    const transfer = await getInventoryTransfer(id, req.user!.branchId);
    return {
      transfer: {
        id: transfer.id, reference: transfer.reference, sourceBranchId: transfer.source_branch_id,
        sourceBranch: transfer.source_branch, destinationBranchId: transfer.destination_branch_id,
        destinationBranch: transfer.destination_branch, status: transfer.status, notes: transfer.notes,
        createdAt: transfer.created_at.toISOString(), dispatchedAt: transfer.dispatched_at?.toISOString() ?? null,
        receivedAt: transfer.received_at?.toISOString() ?? null,
        items: transfer.items.map((item) => ({
          productId: item.product_id, sku: item.sku, name: item.name, unit: item.unit,
          quantityRequested: item.quantity_requested, quantityDispatched: item.quantity_dispatched,
          quantityReceived: item.quantity_received, quantityVariance: item.quantity_variance,
        })),
      },
    };
  }, res, next);
});

app.post("/api/inventory/transfers/:id/dispatch", authenticate, requireModule("inventory"), requireRoles("admin", "manager", "inventory_manager"), (req, res, next) => {
  const id = positiveId(req.params.id ?? "");
  if (!id) { res.status(400).json({ error: "Invalid transfer ID." }); return; }
  handleOperation(() => dispatchInventoryTransfer(id, req.user!), res, next);
});

app.post("/api/inventory/transfers/:id/receive", authenticate, requireModule("inventory"), requireRoles("admin", "manager", "inventory_manager"), (req, res, next) => {
  const id = positiveId(req.params.id ?? "");
  if (!id) { res.status(400).json({ error: "Invalid transfer ID." }); return; }
  try {
    const input = inventoryTransferReceiptSchema.parse(req.body);
    handleOperation(() => receiveInventoryTransfer(id, input, req.user!), res, next);
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/stock-takes", authenticate, requireModule("inventory"), requireRoles("admin", "manager", "inventory_manager"), async (req, res, next) => {
  try {
    const stockTakes = await listStockTakes(req.user!.branchId);
    res.json({ stockTakes: stockTakes.map((take) => ({
      id: take.id, reference: take.reference, title: take.title, status: take.status, createdBy: take.created_by,
      createdAt: take.created_at.toISOString(), completedAt: take.completed_at?.toISOString() ?? null,
      countedItems: Number(take.counted_items), totalItems: Number(take.total_items),
    })) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/inventory/stock-takes", authenticate, requireModule("inventory"), requireRoles("admin", "manager", "inventory_manager"), (req, res, next) => {
  try {
    const input = stockTakeSchema.parse(req.body);
    handleOperation(() => createStockTake(input, req.user!), res, next, 201);
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/stock-takes/:id", authenticate, requireModule("inventory"), requireRoles("admin", "manager", "inventory_manager"), (req, res, next) => {
  const id = positiveId(req.params.id ?? "");
  if (!id) { res.status(400).json({ error: "Invalid stock take ID." }); return; }
  handleOperation(async () => {
    const take = await getStockTake(id, req.user!.branchId);
    return {
      stockTake: {
        id: take.id, reference: take.reference, title: take.title, status: take.status,
        createdAt: take.created_at.toISOString(),
        items: take.items.map((item) => ({
          productId: item.product_id, sku: item.sku, name: item.name, unit: item.unit,
          expectedQuantity: item.expected_quantity, countedQuantity: item.counted_quantity, variance: item.variance,
        })),
      },
    };
  }, res, next);
});

app.post("/api/inventory/stock-takes/:id/complete", authenticate, requireModule("inventory"), requireRoles("admin", "manager", "inventory_manager"), (req, res, next) => {
  const id = positiveId(req.params.id ?? "");
  if (!id) { res.status(400).json({ error: "Invalid stock take ID." }); return; }
  try {
    const input = stockTakeCompletionSchema.parse(req.body);
    handleOperation(() => completeStockTake(id, input, req.user!), res, next);
  } catch (error) {
    next(error);
  }
});

app.post("/api/inventory/adjustments", authenticate, requireModule("inventory"), requireRoles("admin", "manager", "inventory_manager"), (req, res, next) => {
  try {
    const input = adjustmentSchema.parse(req.body);
    handleOperation(() => adjustInventory(input, req.user!), res, next, 201);
  } catch (error) {
    next(error);
  }
});

app.get("/api/suppliers", authenticate, requireModule("suppliers"), async (_req, res, next) => {
  try {
    const suppliers = await listSuppliers();
    res.json({ suppliers: suppliers.map((supplier) => ({
      id: supplier.id, name: supplier.name, contactName: supplier.contact_name, email: supplier.email,
      phone: supplier.phone, taxPin: supplier.tax_pin,
    })) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/suppliers", authenticate, requireModule("suppliers"), requireRoles("admin", "manager", "procurement_officer"), (req, res, next) => {
  try {
    const input = supplierSchema.parse(req.body);
    handleOperation(() => createSupplier(input, req.user!), res, next, 201);
  } catch (error) {
    next(error);
  }
});

app.get("/api/purchase-orders", authenticate, requireModule("purchases"), async (req, res, next) => {
  try {
    const orders = await listPurchaseOrders(req.user!.branchId);
    res.json({ orders: orders.map((order) => ({
      id: order.id, orderNumber: order.order_number, status: order.status,
      supplier: order.supplier_name, createdAt: order.created_at.toISOString(),
      itemCount: Number(order.item_count), orderedQuantity: order.ordered_quantity,
      receivedQuantity: order.received_quantity,
    })) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/purchase-orders/:id", authenticate, requireModule("purchases"), (req, res, next) => {
  const id = positiveId(req.params.id ?? "");
  if (!id) { res.status(400).json({ error: "Invalid purchase order ID." }); return; }
  handleOperation(() => getPurchaseOrder(id, req.user!.branchId), res, next);
});

app.post("/api/purchase-orders", authenticate, requireModule("purchases"), requireRoles("admin", "manager", "procurement_officer"), (req, res, next) => {
  try {
    const input = purchaseOrderSchema.parse(req.body);
    handleOperation(() => createPurchaseOrder(input, req.user!), res, next, 201);
  } catch (error) {
    next(error);
  }
});

app.post("/api/purchase-orders/:id/approve", authenticate, requireModule("purchases"), requireRoles("admin", "manager"), (req, res, next) => {
  const id = positiveId(req.params.id ?? "");
  if (!id) { res.status(400).json({ error: "Invalid purchase order ID." }); return; }
  handleOperation(() => approvePurchaseOrder(id, req.user!), res, next);
});

app.post("/api/purchase-orders/:id/receive", authenticate, requireModule("purchases"), requireRoles("admin", "manager", "procurement_officer", "inventory_manager"), (req, res, next) => {
  const id = positiveId(req.params.id ?? "");
  if (!id) { res.status(400).json({ error: "Invalid purchase order ID." }); return; }
  try {
    const input = receiveSchema.parse(req.body);
    handleOperation(() => receivePurchaseOrder(id, input, req.user!), res, next, 201);
  } catch (error) {
    next(error);
  }
});

app.get("/api/customers", authenticate, requireModule("customers"), async (req, res, next) => {
  try {
    const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 100) : "";
    const customers = await listCustomers(search);
    res.json({ customers: customers.map((customer) => ({
      id: customer.id, name: customer.name, phone: customer.phone, email: customer.email,
      createdAt: customer.created_at.toISOString(), salesCount: Number(customer.sales_count),
      lifetimeValue: customer.lifetime_value,
    })) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/customers", authenticate, requireModule("customers"), requireRoles("admin", "manager", "cashier", "accountant"), (req, res, next) => {
  try {
    const input = customerSchema.parse(req.body);
    handleOperation(() => createCustomer(input, req.user!), res, next, 201);
  } catch (error) {
    next(error);
  }
});

app.get("/api/shifts/active", authenticate, requireModule("shifts"), (req, res, next) => {
  handleOperation(async () => ({ shift: await getActiveShift(req.user!) }), res, next);
});

app.get("/api/shifts/close-summary", authenticate, requireModule("shifts"), requireRoles("admin", "manager", "cashier"), (req, res, next) => {
  handleOperation(async () => ({ summary: await getShiftCloseSummary(req.user!) }), res, next);
});

app.post("/api/shifts/open", authenticate, requireModule("shifts"), requireRoles("admin", "manager", "cashier"), (req, res, next) => {
  try {
    const input = openShiftSchema.parse(req.body);
    handleOperation(() => openShift(input, req.user!), res, next, 201);
  } catch (error) {
    next(error);
  }
});

app.post("/api/shifts/cash-movements", authenticate, requireModule("shifts"), requireRoles("admin", "manager", "cashier"), (req, res, next) => {
  try {
    const input = cashMovementSchema.parse(req.body);
    handleOperation(() => addCashMovement(input, req.user!), res, next, 201);
  } catch (error) {
    next(error);
  }
});

app.post("/api/shifts/close", authenticate, requireModule("shifts"), requireRoles("admin", "manager", "cashier"), (req, res, next) => {
  try {
    const input = closeShiftSchema.parse(req.body);
    handleOperation(() => closeShift(input, req.user!), res, next);
  } catch (error) {
    next(error);
  }
});

app.get("/api/expenses", authenticate, requireModule("expenses"), async (req, res, next) => {
  try {
    const expenses = await listExpenses(req.user!.branchId);
    res.json({ expenses: expenses.map((expense) => ({
      id: expense.id, amount: expense.amount, description: expense.description,
      paymentMethod: expense.payment_method, status: expense.status, category: expense.category,
      createdAt: expense.created_at.toISOString(), createdBy: expense.created_by_name, shiftId: expense.shift_id,
    })) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/expenses", authenticate, requireModule("expenses"), requireRoles("admin", "manager", "accountant", "cashier"), (req, res, next) => {
  try {
    const input = expenseSchema.parse(req.body);
    handleOperation(() => createExpense(input, req.user!), res, next, 201);
  } catch (error) {
    next(error);
  }
});

app.post("/api/expenses/:id/decision", authenticate, requireModule("expenses"), requireRoles("admin", "manager", "accountant"), (req, res, next) => {
  const id = positiveId(req.params.id ?? "");
  if (!id) { res.status(400).json({ error: "Invalid expense ID." }); return; }
  try {
    const input = expenseDecisionSchema.parse(req.body);
    handleOperation(() => decideExpense(id, input.decision, req.user!), res, next);
  } catch (error) {
    next(error);
  }
});

app.get("/api/refunds", authenticate, requireModule("sales"), async (req, res, next) => {
  try {
    const refunds = await listRefunds(req.user!.branchId);
    res.json({ refunds: refunds.map((refund) => ({
      id: refund.id, saleId: refund.sale_id, refundNumber: refund.refund_number, reason: refund.reason,
      total: refund.total, createdAt: refund.created_at.toISOString(), receiptNumber: refund.receipt_number,
      createdBy: refund.created_by_name,
    })) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/reports/summary", authenticate, requireModule("reports"), requireRoles("admin", "manager", "accountant"), (req, res, next) => {
  try {
    const range = parseReportRange(req.query);
    handleOperation(() => getBranchReport(req.user!.branchId, range), res, next);
  } catch (error) {
    next(error);
  }
});

app.get("/api/sales", authenticate, requireModule("sales"), async (req, res, next) => {
  try {
    const search = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
    const from = typeof req.query.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : "";
    const to = typeof req.query.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : "";
    const conditions = ["s.branch_id = ?"];
    const parameters: Array<string | number> = [req.user!.branchId];
    if (search) {
      conditions.push("(s.receipt_number LIKE ? OR CAST(s.id AS CHAR) LIKE ? OR u.name LIKE ?)");
      const like = `%${search}%`;
      parameters.push(like, like, like);
    }
    if (from) { conditions.push("s.created_at >= ?"); parameters.push(`${from} 00:00:00`); }
    if (to) { conditions.push("s.created_at < DATE_ADD(?, INTERVAL 1 DAY)"); parameters.push(`${to} 00:00:00`); }
    const sales = await query<Array<{
      id: number; receipt_number: string; total: string; status: string; created_at: Date; cashier: string;
      customer_name: string | null; item_count: number;
    } & import("mysql2").RowDataPacket>>(
      `SELECT s.id, s.receipt_number, s.total, s.status, s.created_at, u.name AS cashier,
              c.name AS customer_name, COUNT(si.id) AS item_count
       FROM sales s JOIN users u ON u.id = s.cashier_id
       LEFT JOIN customers c ON c.id = s.customer_id
       LEFT JOIN sale_items si ON si.sale_id = s.id
       WHERE ${conditions.join(" AND ")} GROUP BY s.id ORDER BY s.created_at DESC LIMIT 100`,
      parameters,
    );
    res.json({ sales: sales.map((sale) => ({
      id: sale.id, receiptNumber: sale.receipt_number, total: sale.total, status: sale.status,
      createdAt: sale.created_at.toISOString(), cashier: sale.cashier, customer: sale.customer_name,
      itemCount: Number(sale.item_count),
    })) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/sales/held", authenticate, authenticatePos, requireModule("pos"), requireRoles("admin", "manager", "cashier"), (req, res, next) => {
  void listHeldSales(req.user!).then((sales) => res.json({ sales }), next);
});

app.post("/api/sales/held", authenticate, authenticatePos, requireModule("pos"), requireRoles("admin", "manager", "cashier"), (req, res, next) => {
  try {
    const input = heldSaleSchema.parse(req.body);
    void holdSale(input, req.user!).then((sale) => res.status(201).json({ sale }), next);
  } catch (error) {
    next(error);
  }
});

app.post("/api/sales/held/:id/retrieve", authenticate, authenticatePos, requireModule("pos"), requireRoles("admin", "manager", "cashier"), (req, res, next) => {
  const id = positiveId(req.params.id ?? "");
  if (!id) { res.status(400).json({ error: "Invalid held sale ID." }); return; }
  void retrieveHeldSale(id, req.user!).then((sale) => res.json({ sale }), next);
});

app.post("/api/bank-transfer-verifications", authenticate, authenticatePos, requireModule("pos"), requireRoles("admin", "manager", "cashier"), (req, res, next) => {
  try {
    const input = bankTransferVerificationRequestSchema.parse(req.body);
    void requestBankTransferVerification(input, req.user!).then(
      (verification) => res.status(201).json({ verification }),
      next,
    );
  } catch (error) {
    next(error);
  }
});

app.get("/api/bank-transfer-verifications/status", authenticate, authenticatePos, requireModule("pos"), requireRoles("admin", "manager", "cashier"), (req, res, next) => {
  const reference = typeof req.query.reference === "string" ? req.query.reference.trim() : "";
  if (!reference || reference.length > 100) { res.status(400).json({ error: "A valid bank transfer reference is required." }); return; }
  void getBankTransferVerification(reference, req.user!).then((verification) => res.json({ verification }), next);
});

app.get("/api/bank-transfer-verifications", authenticate, requireRoles("admin"), (req, res, next) => {
  void listPendingBankTransferVerifications(req.user!).then((verifications) => res.json({ verifications }), next);
});

app.post("/api/bank-transfer-verifications/:id/decision", authenticate, requireRoles("admin"), (req, res, next) => {
  const id = positiveId(req.params.id ?? "");
  if (!id) { res.status(400).json({ error: "Invalid bank transfer verification ID." }); return; }
  try {
    const decision = bankTransferDecisionSchema.parse(req.body);
    void decideBankTransferVerification(id, decision, req.user!).then(
      (verification) => res.json({ verification }),
      next,
    );
  } catch (error) {
    next(error);
  }
});

app.get("/api/sales/:id", authenticate, requireModule("sales"), async (req, res, next) => {
  const id = positiveId(req.params.id ?? "");
  if (!id) { res.status(400).json({ error: "Invalid sale ID." }); return; }
  try {
    const [sales, items, payments] = await Promise.all([
      query<Array<{
        id: number; receipt_number: string; subtotal: string; discount: string; tax: string;
        total: string; status: string; created_at: Date; cashier: string; customer_name: string | null;
        branch_name: string; cash_received: string | null; change_due: string;
      } & import("mysql2").RowDataPacket>>(
        `SELECT s.id, s.receipt_number, s.subtotal, s.discount, s.tax, s.total, s.status, s.created_at,
                s.cash_received, s.change_due, u.name AS cashier, c.name AS customer_name, b.name AS branch_name
         FROM sales s JOIN users u ON u.id = s.cashier_id JOIN branches b ON b.id = s.branch_id
         LEFT JOIN customers c ON c.id = s.customer_id
         WHERE s.id = ? AND s.branch_id = ? LIMIT 1`,
        [id, req.user!.branchId],
      ),
      query<Array<{
        id: number; product_id: number; sku_snapshot: string; name_snapshot: string; quantity: string;
        unit_price: string; tax_rate: string; line_total: string; refunded: string;
      } & import("mysql2").RowDataPacket>>(
        `SELECT si.id, si.product_id, si.sku_snapshot, si.name_snapshot, si.quantity, si.unit_price, si.tax_rate, si.line_total,
                COALESCE((SELECT SUM(ri.quantity) FROM refund_items ri WHERE ri.sale_item_id = si.id), 0) AS refunded
         FROM sale_items si WHERE si.sale_id = ? ORDER BY si.id`,
        [id],
      ),
      query<Array<{
        method: string; amount: string; status: string; provider_reference: string | null;
      } & import("mysql2").RowDataPacket>>(
        "SELECT method, amount, status, provider_reference FROM sale_payments WHERE sale_id = ? ORDER BY id",
        [id],
      ),
    ]);
    if (!sales[0]) { res.status(404).json({ error: "Sale not found." }); return; }
    res.json({
      sale: {
        id: sales[0].id, receiptNumber: sales[0].receipt_number, subtotal: sales[0].subtotal,
        discount: sales[0].discount, tax: sales[0].tax, total: sales[0].total,
        status: sales[0].status, createdAt: sales[0].created_at.toISOString(),
        cashier: sales[0].cashier, customer: sales[0].customer_name, branch: sales[0].branch_name,
        cashReceived: sales[0].cash_received, changeDue: sales[0].change_due,
      },
      items: items.map((item) => ({
        id: item.id, productId: item.product_id, sku: item.sku_snapshot, name: item.name_snapshot,
        quantity: item.quantity, refunded: item.refunded, unitPrice: item.unit_price,
        taxRate: item.tax_rate, lineTotal: item.line_total,
      })),
      payments: payments.map((payment) => ({
        method: payment.method, amount: payment.amount, status: payment.status,
        reference: payment.provider_reference,
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/sales/:id/refunds", authenticate, requireModule("sales"), requireRoles("admin", "manager"), (req, res, next) => {
  const id = positiveId(req.params.id ?? "");
  if (!id) { res.status(400).json({ error: "Invalid sale ID." }); return; }
  try {
    const input = refundSchema.parse(req.body);
    handleOperation(() => createRefund(id, input, req.user!), res, next, 201);
  } catch (error) {
    next(error);
  }
});

app.get("/api/dashboard/summary", authenticate, requireModule("dashboard"), async (req, res, next) => {
  try {
    const branchId = req.user!.branchId;
    const [summary, recentSales, lowStockProducts, lowStockCounts, productCounts] = await Promise.all([
      query<Array<{ total: string | null; transactions: number } & import("mysql2").RowDataPacket>>(
        `SELECT COALESCE(SUM(total), 0) AS total, COUNT(*) AS transactions
         FROM sales WHERE branch_id = ? AND status = 'completed' AND created_at >= CURDATE()`,
        [branchId],
      ),
      query<Array<{ id: number; receipt_number: string; total: string; created_at: Date; cashier: string; status: string } & import("mysql2").RowDataPacket>>(
        `SELECT s.id, s.receipt_number, s.total, s.created_at, s.status, u.name AS cashier
         FROM sales s JOIN users u ON u.id = s.cashier_id WHERE s.branch_id = ?
         ORDER BY s.created_at DESC LIMIT 5`,
        [branchId],
      ),
      query<Array<{ id: number; name: string; stock: string; reorder_level: string } & import("mysql2").RowDataPacket>>(
        `SELECT p.id, p.name,
                GREATEST(COALESCE(i.on_hand - i.reserved, 0) - COALESCE(expired.quantity, 0), 0) AS stock,
                p.reorder_level
         FROM products p LEFT JOIN inventory i ON i.product_id = p.id AND i.branch_id = ?
         LEFT JOIN (
           SELECT product_id, SUM(quantity_remaining) AS quantity FROM inventory_batches
           WHERE branch_id = ? AND expiry_date < CURDATE() AND quantity_remaining > 0 GROUP BY product_id
         ) expired ON expired.product_id = p.id
         WHERE p.is_active = TRUE
           AND GREATEST(COALESCE(i.on_hand - i.reserved, 0) - COALESCE(expired.quantity, 0), 0) <= p.reorder_level
         ORDER BY stock ASC LIMIT 5`,
        [branchId, branchId],
      ),
      query<Array<{ count: number } & import("mysql2").RowDataPacket>>(
        `SELECT COUNT(*) AS count FROM products p
         LEFT JOIN inventory i ON i.product_id = p.id AND i.branch_id = ?
         LEFT JOIN (
           SELECT product_id, SUM(quantity_remaining) AS quantity FROM inventory_batches
           WHERE branch_id = ? AND expiry_date < CURDATE() AND quantity_remaining > 0 GROUP BY product_id
         ) expired ON expired.product_id = p.id
         WHERE p.is_active = TRUE
           AND GREATEST(COALESCE(i.on_hand - i.reserved, 0) - COALESCE(expired.quantity, 0), 0) <= p.reorder_level`,
        [branchId, branchId],
      ),
      query<Array<{ count: number } & import("mysql2").RowDataPacket>>("SELECT COUNT(*) AS count FROM products WHERE is_active = TRUE"),
    ]);
    res.json({
      summary: {
        todaySales: String(summary[0]?.total ?? "0.00"),
        todayTransactions: Number(summary[0]?.transactions ?? 0),
        productCount: Number(productCounts[0]?.count ?? 0),
        lowStockCount: Number(lowStockCounts[0]?.count ?? 0),
        recentSales: recentSales.map((sale) => ({
          id: sale.id, receiptNumber: sale.receipt_number, total: sale.total,
          createdAt: sale.created_at.toISOString(), cashier: sale.cashier, status: sale.status,
        })),
        lowStockProducts: lowStockProducts.map((product) => ({
          id: product.id, name: product.name, stock: String(product.stock), reorderLevel: product.reorder_level,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/sales", authenticate, authenticatePos, requireModule("pos"), requireRoles("admin", "manager", "cashier"), (req, res, next) => {
  const idempotencyKey = req.header("Idempotency-Key");
  if (!idempotencyKey || idempotencyKey.length > 100) {
    res.status(400).json({ error: "A valid Idempotency-Key header is required." });
    return;
  }
  try {
    const input = saleSchema.parse(req.body);
    void createSale(input, idempotencyKey, req.user!).then(
      (sale) => res.status(sale.replayed ? 200 : 201).json({ sale }),
      next,
    );
  } catch (error) {
    next(error);
  }
});

app.use((_req, res) => res.status(404).json({ error: "Not found." }));
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof ZodError) {
    res.status(400).json({ error: "Invalid request.", issues: error.issues });
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error("Request failed", error);
  res.status(500).json({ error: "The request could not be completed." });
});

const server = app.listen(port, () => console.info(`Smart POS API listening on port ${port}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => void pool.end().then(() => process.exit(0)));
  });
}
