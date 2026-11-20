import "./env.js";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { ZodError } from "zod";
import {
  authenticate, authenticatePos, currentUser, login, logout, posLogin, posLogout, requireRoles, requireModule,
} from "./auth.js";
import { pool, query } from "./db.js";
import { createSale, saleSchema, heldSaleSchema, holdSale, listHeldSales, retrieveHeldSale } from "./sales.js";
import { HttpError } from "./errors.js";
import {
  canAssignStaffRole, createStaff, createStaffSchema, listDepartments, listStaff,
  setStaffStatus, staffStatusSchema,
} from "./staff.js";
import { productSchema, registerProduct, updateProduct, updateProductSchema } from "./products.js";
import { getBranchReport, parseReportRange } from "./reports.js";
import {
  addCashMovement, adjustmentSchema, approvePurchaseOrder, cashMovementSchema, closeShift, closeShiftSchema,
  createCustomer, createExpense, createPurchaseOrder, createRefund, createSupplier, customerSchema,
  decideExpense, expenseDecisionSchema, expenseSchema,   getActiveShift, getShiftCloseSummary, listCustomers, listExpenses,
  getPurchaseOrder, getStockMovements, listInventory, listPurchaseOrders, listRefunds, listSuppliers, openShift,
  openShiftSchema, purchaseOrderSchema, receivePurchaseOrder, receiveSchema, refundSchema, adjustInventory,
  supplierSchema, completeStockTake, createStockTake, getStockTake, listExpiryBatches, listStockTakes,
  stockTakeCompletionSchema, stockTakeSchema, createInventoryTransfer, dispatchInventoryTransfer,
  getInventoryTransfer, inventoryTransferReceiptSchema, inventoryTransferSchema, listInventoryTransfers,
  listTransferBranches, receiveInventoryTransfer,
} from "./operations.js";

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

function positiveId(value: string | string[] | undefined): number | undefined {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
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
app.post("/api/pos/login", loginLimiter, (req, res, next) => void posLogin(req, res).catch(next));
app.get("/api/pos/session", authenticate, authenticatePos, (req, res) => {
  res.json({ cashier: { ...req.posUser, username: req.posUser?.posUsername } });
});
app.post("/api/pos/logout", authenticate, authenticatePos, (req, res, next) => void posLogout(req, res).catch(next));

app.get("/api/access/modules", authenticate, requireRoles("admin"), async (_req, res, next) => {
  try {
    res.json({ modules: await query<Array<{ id: string; name: string; route: string; sort_order: number } & import("mysql2").RowDataPacket>>(
      "SELECT id, name, route, sort_order FROM modules ORDER BY sort_order",
    ).then((rows) => rows.map((row) => ({
      id: row.id, name: row.name, route: row.route, sortOrder: row.sort_order,
    }))) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/access/users/:id", authenticate, requireRoles("admin"), async (req, res, next) => {
  const id = positiveId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid user ID." }); return; }
  try {
    const [users, overrides] = await Promise.all([
      query<Array<{ id: number; default_landing: string | null } & import("mysql2").RowDataPacket>>(
        "SELECT id, default_landing FROM users WHERE id=? LIMIT 1",
        [id],
      ),
      query<Array<{ module_id: string; allowed: number } & import("mysql2").RowDataPacket>>(
        "SELECT module_id, allowed FROM user_permissions WHERE user_id=?",
        [id],
      ),
    ]);
    if (!users[0]) { res.status(404).json({ error: "User not found." }); return; }
    res.json({ defaultLanding: users[0].default_landing, permissions: overrides.map((item) => ({ moduleId: item.module_id, allowed: Boolean(item.allowed) })) });
  } catch (error) {
    next(error);
  }
});

app.put("/api/access/users/:id", authenticate, requireRoles("admin"), async (req, res, next) => {
  const id = positiveId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid user ID." }); return; }
  const defaultLanding = typeof req.body.defaultLanding === "string" ? req.body.defaultLanding.trim().slice(0, 80) : null;
  const permissions = Array.isArray(req.body.permissions) ? req.body.permissions : null;
  if (!permissions || !permissions.every((item: unknown) =>
    typeof item === "object" && item !== null
      && typeof (item as { moduleId?: unknown }).moduleId === "string"
      && typeof (item as { allowed?: unknown }).allowed === "boolean")) {
    res.status(400).json({ error: "Provide module permission overrides." });
    return;
  }
  try {
    await pool.execute("UPDATE users SET default_landing=? WHERE id=?", [defaultLanding, id]);
    await pool.execute("DELETE FROM user_permissions WHERE user_id=?", [id]);
    for (const item of permissions as Array<{ moduleId: string; allowed: boolean }>) {
      const [modules] = await pool.execute<Array<import("mysql2").RowDataPacket & { id: string }>>(
        "SELECT id FROM modules WHERE id=? LIMIT 1",
        [item.moduleId],
      );
      if (modules[0]) {
        await pool.execute(
          "INSERT INTO user_permissions (user_id,module_id,allowed) VALUES (?,?,?)",
          [id, item.moduleId, item.allowed],
        );
      }
    }
    await pool.execute(
      "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES (?, 'permissions.updated', 'user', ?, ?)",
      [req.user!.id, String(id), JSON.stringify({ defaultLanding, permissions })],
    );
    res.json({ updated: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/staff/departments", authenticate, requireRoles("admin", "manager"), async (_req, res, next) => {
  try {
    res.json({ departments: await listDepartments() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/staff", authenticate, requireModule("employees"), requireRoles("admin", "manager"), async (req, res, next) => {
  try {
    const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 100) : "";
    const users = await listStaff(req.user!.branchId, search);
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
      permissions: user.permissions ? user.permissions.split(",").filter(Boolean) : [],
    })) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/staff", authenticate, requireModule("employees"), requireRoles("admin", "manager"), (req, res, next) => {
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

app.get("/api/products", authenticate, requireModule("products"), async (req, res, next) => {
  try {
    const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 100) : "";
    const products = await query<Array<{
      id: number; sku: string; name: string; category_name: string | null; unit: string; tax_rate: string; reorder_level: string;
      selling_price: string; purchase_price: string | null; stock: string; barcode: string | null;
    } & import("mysql2").RowDataPacket>>(
    `SELECT p.id, p.sku, p.name, c.name AS category_name, p.unit, p.selling_price, p.purchase_price, p.tax_rate, p.reorder_level,
              GREATEST(COALESCE(i.on_hand - i.reserved, 0) - COALESCE(expired.quantity, 0), 0) AS stock, p.barcode
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN inventory i ON i.product_id = p.id AND i.branch_id = ?
       LEFT JOIN (
         SELECT product_id, SUM(quantity_remaining) AS quantity
         FROM inventory_batches
         WHERE branch_id = ? AND expiry_date < CURDATE() AND quantity_remaining > 0
         GROUP BY product_id
       ) expired ON expired.product_id = p.id
       WHERE p.is_active = TRUE AND (? = '' OR p.name LIKE CONCAT('%', ?, '%') OR p.sku = ? OR p.barcode = ?)
       ORDER BY p.name LIMIT 100`,
      [req.user!.branchId, req.user!.branchId, search, search, search, search],
    );
    res.json({
      products: products.map((product) => ({
        id: product.id,
        sku: product.sku,
        name: product.name,
        category: product.category_name ?? "Uncategorised",
        unit: product.unit,
        sellingPrice: product.selling_price,
        purchasePrice: product.purchase_price,
        taxRate: product.tax_rate,
        reorderLevel: product.reorder_level,
        stock: String(product.stock),
        barcode: product.barcode,
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/products", authenticate, requireRoles("admin", "manager", "inventory_manager"), (req, res, next) => {
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

app.patch("/api/products/:id", authenticate, requireRoles("admin", "manager", "inventory_manager"), (req, res, next) => {
  const id = positiveId(req.params.id ?? "");
  if (!id) { res.status(400).json({ error: "Invalid product ID." }); return; }
  try {
    const input = updateProductSchema.parse(req.body);
    handleOperation(() => updateProduct(id, input, req.user!), res, next);
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

app.get("/api/inventory/expiry", authenticate, requireRoles("admin", "manager", "inventory_manager"), async (req, res, next) => {
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

app.get("/api/inventory/transfer-branches", authenticate, requireRoles("admin", "manager", "inventory_manager"), async (req, res, next) => {
  try {
    const branches = await listTransferBranches(req.user!.branchId);
    res.json({ branches });
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/transfers", authenticate, requireRoles("admin", "manager", "inventory_manager"), async (req, res, next) => {
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

app.post("/api/inventory/transfers", authenticate, requireRoles("admin", "manager", "inventory_manager"), (req, res, next) => {
  try {
    const input = inventoryTransferSchema.parse(req.body);
    handleOperation(() => createInventoryTransfer(input, req.user!), res, next, 201);
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/transfers/:id", authenticate, requireRoles("admin", "manager", "inventory_manager"), (req, res, next) => {
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

app.post("/api/inventory/transfers/:id/dispatch", authenticate, requireRoles("admin", "manager", "inventory_manager"), (req, res, next) => {
  const id = positiveId(req.params.id ?? "");
  if (!id) { res.status(400).json({ error: "Invalid transfer ID." }); return; }
  handleOperation(() => dispatchInventoryTransfer(id, req.user!), res, next);
});

app.post("/api/inventory/transfers/:id/receive", authenticate, requireRoles("admin", "manager", "inventory_manager"), (req, res, next) => {
  const id = positiveId(req.params.id ?? "");
  if (!id) { res.status(400).json({ error: "Invalid transfer ID." }); return; }
  try {
    const input = inventoryTransferReceiptSchema.parse(req.body);
    handleOperation(() => receiveInventoryTransfer(id, input, req.user!), res, next);
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/stock-takes", authenticate, requireRoles("admin", "manager", "inventory_manager"), async (req, res, next) => {
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

app.post("/api/inventory/stock-takes", authenticate, requireRoles("admin", "manager", "inventory_manager"), (req, res, next) => {
  try {
    const input = stockTakeSchema.parse(req.body);
    handleOperation(() => createStockTake(input, req.user!), res, next, 201);
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/stock-takes/:id", authenticate, requireRoles("admin", "manager", "inventory_manager"), (req, res, next) => {
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

app.post("/api/inventory/stock-takes/:id/complete", authenticate, requireRoles("admin", "manager", "inventory_manager"), (req, res, next) => {
  const id = positiveId(req.params.id ?? "");
  if (!id) { res.status(400).json({ error: "Invalid stock take ID." }); return; }
  try {
    const input = stockTakeCompletionSchema.parse(req.body);
    handleOperation(() => completeStockTake(id, input, req.user!), res, next);
  } catch (error) {
    next(error);
  }
});

app.post("/api/inventory/adjustments", authenticate, requireRoles("admin", "manager", "inventory_manager"), (req, res, next) => {
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

app.post("/api/suppliers", authenticate, requireRoles("admin", "manager", "procurement_officer"), (req, res, next) => {
  try {
    const input = supplierSchema.parse(req.body);
    handleOperation(() => createSupplier(input, req.user!), res, next, 201);
  } catch (error) {
    next(error);
  }
});

app.get("/api/purchase-orders", authenticate, async (req, res, next) => {
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

app.get("/api/purchase-orders/:id", authenticate, (req, res, next) => {
  const id = positiveId(req.params.id ?? "");
  if (!id) { res.status(400).json({ error: "Invalid purchase order ID." }); return; }
  handleOperation(() => getPurchaseOrder(id, req.user!.branchId), res, next);
});

app.post("/api/purchase-orders", authenticate, requireRoles("admin", "manager", "procurement_officer"), (req, res, next) => {
  try {
    const input = purchaseOrderSchema.parse(req.body);
    handleOperation(() => createPurchaseOrder(input, req.user!), res, next, 201);
  } catch (error) {
    next(error);
  }
});

app.post("/api/purchase-orders/:id/approve", authenticate, requireRoles("admin", "manager"), (req, res, next) => {
  const id = positiveId(req.params.id ?? "");
  if (!id) { res.status(400).json({ error: "Invalid purchase order ID." }); return; }
  handleOperation(() => approvePurchaseOrder(id, req.user!), res, next);
});

app.post("/api/purchase-orders/:id/receive", authenticate, requireRoles("admin", "manager", "procurement_officer", "inventory_manager"), (req, res, next) => {
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

app.post("/api/customers", authenticate, requireRoles("admin", "manager", "cashier", "accountant"), (req, res, next) => {
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

app.get("/api/shifts/close-summary", authenticate, requireRoles("admin", "manager", "cashier"), (req, res, next) => {
  handleOperation(async () => ({ summary: await getShiftCloseSummary(req.user!) }), res, next);
});

app.post("/api/shifts/open", authenticate, requireRoles("admin", "manager", "cashier"), (req, res, next) => {
  try {
    const input = openShiftSchema.parse(req.body);
    handleOperation(() => openShift(input, req.user!), res, next, 201);
  } catch (error) {
    next(error);
  }
});

app.post("/api/shifts/cash-movements", authenticate, requireRoles("admin", "manager", "cashier"), (req, res, next) => {
  try {
    const input = cashMovementSchema.parse(req.body);
    handleOperation(() => addCashMovement(input, req.user!), res, next, 201);
  } catch (error) {
    next(error);
  }
});

app.post("/api/shifts/close", authenticate, requireRoles("admin", "manager", "cashier"), (req, res, next) => {
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

app.post("/api/expenses", authenticate, requireRoles("admin", "manager", "accountant", "cashier"), (req, res, next) => {
  try {
    const input = expenseSchema.parse(req.body);
    handleOperation(() => createExpense(input, req.user!), res, next, 201);
  } catch (error) {
    next(error);
  }
});

app.post("/api/expenses/:id/decision", authenticate, requireRoles("admin", "manager", "accountant"), (req, res, next) => {
  const id = positiveId(req.params.id ?? "");
  if (!id) { res.status(400).json({ error: "Invalid expense ID." }); return; }
  try {
    const input = expenseDecisionSchema.parse(req.body);
    handleOperation(() => decideExpense(id, input.decision, req.user!), res, next);
  } catch (error) {
    next(error);
  }
});

app.get("/api/refunds", authenticate, async (req, res, next) => {
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
    const sales = await query<Array<{
      id: number; receipt_number: string; total: string; status: string; created_at: Date; cashier: string;
      customer_name: string | null; item_count: number;
    } & import("mysql2").RowDataPacket>>(
      `SELECT s.id, s.receipt_number, s.total, s.status, s.created_at, u.name AS cashier,
              c.name AS customer_name, COUNT(si.id) AS item_count
       FROM sales s JOIN users u ON u.id = s.cashier_id
       LEFT JOIN customers c ON c.id = s.customer_id
       LEFT JOIN sale_items si ON si.sale_id = s.id
       WHERE s.branch_id = ? GROUP BY s.id ORDER BY s.created_at DESC LIMIT 100`,
      [req.user!.branchId],
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

app.get("/api/sales/held", authenticate, authenticatePos, requireRoles("admin", "manager", "cashier"), (req, res, next) => {
  void listHeldSales(req.user!).then((sales) => res.json({ sales }), next);
});

app.post("/api/sales/held", authenticate, authenticatePos, requireRoles("admin", "manager", "cashier"), (req, res, next) => {
  try {
    const input = heldSaleSchema.parse(req.body);
    void holdSale(input, req.user!).then((sale) => res.status(201).json({ sale }), next);
  } catch (error) {
    next(error);
  }
});

app.post("/api/sales/held/:id/retrieve", authenticate, authenticatePos, requireRoles("admin", "manager", "cashier"), (req, res, next) => {
  const id = positiveId(req.params.id ?? "");
  if (!id) { res.status(400).json({ error: "Invalid held sale ID." }); return; }
  void retrieveHeldSale(id, req.user!).then((sale) => res.json({ sale }), next);
});

app.get("/api/sales/:id", authenticate, async (req, res, next) => {
  const id = positiveId(req.params.id ?? "");
  if (!id) { res.status(400).json({ error: "Invalid sale ID." }); return; }
  try {
    const [sales, items] = await Promise.all([
      query<Array<{
        id: number; receipt_number: string; total: string; status: string; created_at: Date;
        cashier: string; customer_name: string | null;
      } & import("mysql2").RowDataPacket>>(
        `SELECT s.id, s.receipt_number, s.total, s.status, s.created_at, u.name AS cashier, c.name AS customer_name
         FROM sales s JOIN users u ON u.id = s.cashier_id LEFT JOIN customers c ON c.id = s.customer_id
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
    ]);
    if (!sales[0]) { res.status(404).json({ error: "Sale not found." }); return; }
    res.json({
      sale: {
        id: sales[0].id, receiptNumber: sales[0].receipt_number, total: sales[0].total,
        status: sales[0].status, createdAt: sales[0].created_at.toISOString(),
        cashier: sales[0].cashier, customer: sales[0].customer_name,
      },
      items: items.map((item) => ({
        id: item.id, productId: item.product_id, sku: item.sku_snapshot, name: item.name_snapshot,
        quantity: item.quantity, refunded: item.refunded, unitPrice: item.unit_price,
        taxRate: item.tax_rate, lineTotal: item.line_total,
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/sales/:id/refunds", authenticate, requireRoles("admin", "manager"), (req, res, next) => {
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

app.post("/api/sales", authenticate, authenticatePos, requireRoles("admin", "manager", "cashier"), (req, res, next) => {
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
