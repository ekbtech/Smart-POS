import type { RowDataPacket } from "mysql2/promise";
import { Decimal } from "decimal.js";
import { z } from "zod";
import type { AuthUser } from "./auth.js";
import { query } from "./db.js";
import { HttpError } from "./errors.js";

const optionalPositiveInteger = z.preprocess(
  (value) => value === "" || value === undefined ? undefined : value,
  z.coerce.number().int().positive().optional(),
);

export const cashierMonitorFiltersSchema = z.object({
  scope: z.enum(["shift", "today", "custom"]).default("shift"),
  from: z.preprocess((value) => value === "" || value === undefined ? undefined : value, z.iso.date().optional()),
  to: z.preprocess((value) => value === "" || value === undefined ? undefined : value, z.iso.date().optional()),
  branchId: optionalPositiveInteger,
  cashierId: optionalPositiveInteger,
  counter: z.preprocess((value) => value === "" || value === undefined ? undefined : value, z.string().trim().max(40).optional()),
}).strict().superRefine((filters, context) => {
  if (filters.scope === "custom" && (!filters.from || !filters.to)) {
    context.addIssue({ code: "custom", message: "Choose both dates for a custom range." });
  }
  if (filters.from && filters.to && filters.from > filters.to) {
    context.addIssue({ code: "custom", path: ["to"], message: "End date must be on or after start date." });
  }
});

const onlineTimeoutSeconds = Number.parseInt(process.env.CASHIER_PRESENCE_TIMEOUT_SECONDS ?? "90", 10);
const idleTimeoutSeconds = Number.parseInt(process.env.CASHIER_IDLE_TIMEOUT_SECONDS ?? "300", 10);
if (!Number.isInteger(onlineTimeoutSeconds) || onlineTimeoutSeconds < 30 || onlineTimeoutSeconds > 900) {
  throw new Error("CASHIER_PRESENCE_TIMEOUT_SECONDS must be between 30 and 900.");
}
if (!Number.isInteger(idleTimeoutSeconds) || idleTimeoutSeconds < 60 || idleTimeoutSeconds > 3600) {
  throw new Error("CASHIER_IDLE_TIMEOUT_SECONDS must be between 60 and 3600.");
}

type MonitorFilters = z.infer<typeof cashierMonitorFiltersSchema>;
type MonitorUser = AuthUser;
type CashierRow = {
  id: number;
  name: string;
  username: string | null;
  employeeNumber: string | null;
  branchId: number;
  branch: string;
  roles: string[];
  online: boolean;
  active: boolean;
  loginAt: string | null;
  lastActivityAt: string | null;
  shiftId: number | null;
  shiftStatus: "open" | "closed" | null;
  shiftOpenedAt: string | null;
  shiftClosedAt: string | null;
  counter: string | null;
  openingCash: string;
  status: "active" | "idle" | "shift_open_offline" | "offline" | "shift_closed";
  transactions: number;
  grossSales: string;
  discounts: string;
  refunds: string;
  netSales: string;
  payments: Record<string, string>;
  expenses: string;
  expectedCash: string;
  shiftDurationSeconds: number;
};

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertCanMonitor(user: MonitorUser): void {
  if (!user.roles.some((role) => role === "admin" || role === "manager")
    || !user.modules?.includes("cashier_monitoring")) {
    throw new HttpError(403, "You do not have permission to monitor cashiers.");
  }
}

export function cashierPresenceState(input: {
  online: boolean;
  lastActivityAt: Date | string | null;
  shiftStatus: string | null;
  now?: number;
  idleSeconds?: number;
}): CashierRow["status"] {
  if (input.online) {
    const lastActivity = input.lastActivityAt ? new Date(input.lastActivityAt).getTime() : 0;
    return (input.now ?? Date.now()) - lastActivity <= (input.idleSeconds ?? idleTimeoutSeconds) * 1000 ? "active" : "idle";
  }
  if (input.shiftStatus === "open") return "shift_open_offline";
  if (input.shiftStatus === "closed") return "shift_closed";
  return "offline";
}

type RawCashier = RowDataPacket & {
  id: number;
  name: string;
  username: string | null;
  employee_number: string | null;
  branch_id: number;
  branch_name: string;
  roles: string;
  online: number;
  login_at: Date | null;
  last_activity_at: Date | null;
  shift_id: number | null;
  shift_status: "open" | "closed" | null;
  shift_opened_at: Date | null;
  shift_closed_at: Date | null;
  counter_number: string | null;
  opening_cash: string | null;
};

function rangeConditions(filters: MonitorFilters, alias: string): { sql: string; parameters: Array<string | number> } {
  if (filters.scope === "shift") return { sql: `${alias}.shift_id IS NOT NULL`, parameters: [] };
  const from = filters.scope === "today" ? undefined : filters.from;
  const to = filters.scope === "today" ? undefined : filters.to;
  const conditions = [`${alias}.created_at >= ?`, `${alias}.created_at < DATE_ADD(?, INTERVAL 1 DAY)`];
  if (filters.scope === "today") {
    return { sql: `${alias}.created_at >= CURDATE() AND ${alias}.created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)`, parameters: [] };
  }
  return { sql: conditions.join(" AND "), parameters: [from!, to!] };
}

export async function getCashierMonitoring(user: MonitorUser, filters: MonitorFilters) {
  assertCanMonitor(user);
  const conditions = ["EXISTS (SELECT 1 FROM user_roles cr JOIN roles crole ON crole.id=cr.role_id WHERE cr.user_id=u.id AND crole.name='cashier')"];
  const parameters: Array<string | number> = [onlineTimeoutSeconds];
  const scopedBranchId = user.roles.includes("admin") ? filters.branchId : user.branchId;
  if (!user.roles.includes("admin")) {
    conditions.push("u.branch_id=?");
    parameters.push(user.branchId);
  } else if (filters.branchId) {
    conditions.push("u.branch_id=?");
    parameters.push(filters.branchId);
  }
  if (filters.cashierId) {
    conditions.push("u.id=?");
    parameters.push(filters.cashierId);
  }
  if (filters.counter) {
    conditions.push("latest_shift.counter_number=?");
    parameters.push(filters.counter);
  }
  const cashiers = await query<RawCashier[]>(
    `SELECT u.id, u.name, u.pos_username AS username, e.employee_number, u.branch_id,
            b.name AS branch_name,
            COALESCE(GROUP_CONCAT(DISTINCT r.name ORDER BY r.name SEPARATOR ','), '') AS roles,
            (u.is_active=TRUE
             AND COALESCE(ps.last_seen >= DATE_SUB(NOW(), INTERVAL ? SECOND), FALSE)
             AND EXISTS (SELECT 1 FROM auth_sessions aus WHERE aus.user_id=u.id AND aus.expires_at>NOW())) AS online,
            COALESCE(ps.login_at, u.last_pos_login_at, (
              SELECT MAX(a.created_at) FROM audit_logs a
              WHERE a.user_id=u.id AND a.action='pos.login'
            )) AS login_at, COALESCE(ps.last_activity_at, u.last_pos_activity_at) AS last_activity_at,
            latest_shift.id AS shift_id, latest_shift.status AS shift_status,
            latest_shift.opened_at AS shift_opened_at, latest_shift.closed_at AS shift_closed_at,
            latest_shift.counter_number, latest_shift.opening_cash
     FROM users u
     JOIN branches b ON b.id=u.branch_id
     LEFT JOIN employees e ON e.user_id=u.id
     LEFT JOIN user_roles ur ON ur.user_id=u.id
     LEFT JOIN roles r ON r.id=ur.role_id
     LEFT JOIN (
       SELECT user_id, MAX(last_used_at) AS last_seen, MAX(last_activity_at) AS last_activity_at,
              MAX(created_at) AS login_at
       FROM pos_sessions WHERE expires_at>NOW() GROUP BY user_id
     ) ps ON ps.user_id=u.id
     LEFT JOIN (
       SELECT cs.* FROM cashier_shifts cs
       JOIN (SELECT cashier_id, branch_id, MAX(id) AS shift_id
             FROM cashier_shifts GROUP BY cashier_id, branch_id) ls
         ON ls.shift_id=cs.id
     ) latest_shift ON latest_shift.cashier_id=u.id AND latest_shift.branch_id=u.branch_id
     WHERE ${conditions.join(" AND ")}
     GROUP BY u.id, u.name, u.pos_username, e.employee_number, u.branch_id, b.name,
              ps.last_seen, ps.login_at, ps.last_activity_at, u.last_pos_login_at, u.last_pos_activity_at,
              latest_shift.id, latest_shift.status,
              latest_shift.opened_at, latest_shift.closed_at, latest_shift.counter_number, latest_shift.opening_cash
     ORDER BY online DESC, latest_shift.status='open' DESC, u.name`,
    parameters,
  );
  const cashierIds = cashiers.map((cashier) => cashier.id);
  const openShiftIds = cashiers.filter((cashier) => cashier.shift_status === "open" && cashier.shift_id)
    .map((cashier) => cashier.shift_id!);
  if (!cashierIds.length) {
    return {
      cashiers: [], updatedAt: new Date().toISOString(),
      totals: {
        online: 0, activeShifts: 0, transactions: 0, grossSales: "0.00",
        refunds: "0.00", netSales: "0.00",
        payments: { cash: "0.00", mpesa: "0.00", card: "0.00", bank_transfer: "0.00", credit: "0.00" },
      },
      thresholds: { onlineSeconds: onlineTimeoutSeconds, idleSeconds: idleTimeoutSeconds },
    };
  }

  const ids = cashierIds.map(() => "?").join(",");
  const salesRange = rangeConditions(filters, "s");
  const salesConditions = [`s.cashier_id IN (${ids})`, "s.status='completed'", salesRange.sql];
  const salesParameters: Array<string | number> = [...cashierIds, ...salesRange.parameters];
  if (scopedBranchId) {
    salesConditions.push("s.branch_id=?");
    salesParameters.push(scopedBranchId);
  }
  if (filters.scope === "shift") {
    if (!openShiftIds.length) {
      salesConditions.push("1=0");
    } else {
      salesConditions.push(`s.shift_id IN (${openShiftIds.map(() => "?").join(",")})`);
      salesParameters.push(...openShiftIds);
    }
  }
  const salesWhere = salesConditions.join(" AND ");
  const refundConditions = [
    "s.status='completed'",
    `s.cashier_id IN (${ids})`,
    "r.status='completed'",
  ];
  const refundParameters: Array<string | number> = [...cashierIds];
  if (scopedBranchId) {
    refundConditions.push("s.branch_id=?");
    refundParameters.push(scopedBranchId);
  }
  if (filters.scope === "shift") {
    if (!openShiftIds.length) refundConditions.push("1=0");
    else {
      refundConditions.push(`s.shift_id IN (${openShiftIds.map(() => "?").join(",")})`);
      refundParameters.push(...openShiftIds);
    }
  } else if (filters.scope === "today") {
    refundConditions.push("r.created_at >= CURDATE() AND r.created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)");
  } else {
    refundConditions.push("r.created_at >= ? AND r.created_at < DATE_ADD(?, INTERVAL 1 DAY)");
    refundParameters.push(filters.from!, filters.to!);
  }
  const refundsWhere = refundConditions.join(" AND ");
  const [sales, payments, refundTotals, shiftTotals] = await Promise.all([
    query<Array<RowDataPacket & {
      cashier_id: number; transactions: number; gross: string; discounts: string;
    }>>(
      `SELECT s.cashier_id, COUNT(*) AS transactions,
              COALESCE(SUM(s.total),0) AS gross, COALESCE(SUM(s.discount),0) AS discounts
       FROM sales s WHERE ${salesWhere} GROUP BY s.cashier_id`,
      salesParameters,
    ),
    query<Array<RowDataPacket & {
      cashier_id: number; method: string; amount: string;
    }>>(
      `SELECT s.cashier_id, sp.method, COALESCE(SUM(sp.amount),0) AS amount
       FROM sales s JOIN sale_payments sp ON sp.sale_id=s.id AND sp.status='completed'
       WHERE ${salesWhere} GROUP BY s.cashier_id, sp.method`,
      salesParameters,
    ),
    filters.scope === "shift" && !openShiftIds.length
      ? Promise.resolve([] as Array<RowDataPacket & { cashier_id: number; refunds: string }>)
      : query<Array<RowDataPacket & { cashier_id: number; refunds: string }>>(
        `SELECT s.cashier_id, COALESCE(SUM(r.total),0) AS refunds
         FROM sales s JOIN refunds r ON r.sale_id=s.id AND r.status='completed'
         WHERE ${refundsWhere} GROUP BY s.cashier_id`,
        refundParameters,
      ),
    query<Array<RowDataPacket & {
      shift_id: number; cash_sales: string; cash_expenses: string;
      deposits: string; withdrawals: string; approved_expenses: string;
    }>>(
      `SELECT sh.id AS shift_id,
              COALESCE(pay.cash_sales,0) AS cash_sales,
              COALESCE(mov.deposits,0) AS deposits, COALESCE(mov.withdrawals,0) AS withdrawals,
              COALESCE(exp.approved_expenses,0) AS approved_expenses,
              COALESCE(exp.cash_expenses,0) AS cash_expenses
       FROM cashier_shifts sh
       LEFT JOIN (
         SELECT s.shift_id, SUM(sp.amount) AS cash_sales FROM sales s
         JOIN sale_payments sp ON sp.sale_id=s.id AND sp.method='cash' AND sp.status='completed'
         WHERE s.status='completed' AND s.shift_id IN (${openShiftIds.length ? openShiftIds.map(() => "?").join(",") : "NULL"})
         GROUP BY s.shift_id
       ) pay ON pay.shift_id=sh.id
       LEFT JOIN (
         SELECT shift_id, SUM(CASE WHEN movement_type='deposit' THEN amount ELSE 0 END) AS deposits,
                SUM(CASE WHEN movement_type='withdrawal' THEN amount ELSE 0 END) AS withdrawals
         FROM cash_movements WHERE shift_id IN (${openShiftIds.length ? openShiftIds.map(() => "?").join(",") : "NULL"})
         GROUP BY shift_id
       ) mov ON mov.shift_id=sh.id
       LEFT JOIN (
         SELECT shift_id, SUM(CASE WHEN status='approved' THEN amount ELSE 0 END) AS approved_expenses,
                SUM(CASE WHEN status='approved' AND payment_method='cash' THEN amount ELSE 0 END) AS cash_expenses
         FROM expenses WHERE shift_id IN (${openShiftIds.length ? openShiftIds.map(() => "?").join(",") : "NULL"})
         GROUP BY shift_id
       ) exp ON exp.shift_id=sh.id
       WHERE sh.id IN (${openShiftIds.length ? openShiftIds.map(() => "?").join(",") : "NULL"})`,
      [...openShiftIds, ...openShiftIds, ...openShiftIds, ...openShiftIds],
    ),
  ]);
  const salesByCashier = new Map(sales.map((row) => [row.cashier_id, row]));
  const refundsByCashier = new Map(refundTotals.map((row) => [row.cashier_id, row.refunds]));
  const paymentsByCashier = new Map<number, Record<string, string>>();
  for (const payment of payments) {
    const grouped = paymentsByCashier.get(payment.cashier_id) ?? {};
    grouped[payment.method] = payment.amount;
    paymentsByCashier.set(payment.cashier_id, grouped);
  }
  const shiftFinancials = new Map(shiftTotals.map((row) => [row.shift_id, row]));
  const now = Date.now();
  const rows: CashierRow[] = cashiers.map((cashier) => {
    const totals = salesByCashier.get(cashier.id);
    const gross = new Decimal(totals?.gross ?? 0);
    const refunds = new Decimal(refundsByCashier.get(cashier.id) ?? "0");
    const shiftFinance = cashier.shift_id ? shiftFinancials.get(cashier.shift_id) : undefined;
    const shiftAge = cashier.shift_status === "open" && cashier.shift_opened_at
      ? Math.max(0, Math.floor((now - new Date(cashier.shift_opened_at).getTime()) / 1000))
      : cashier.shift_opened_at && cashier.shift_closed_at
        ? Math.max(0, Math.floor((new Date(cashier.shift_closed_at).getTime() - new Date(cashier.shift_opened_at).getTime()) / 1000))
        : 0;
    const isOnline = Boolean(cashier.online);
    const status = cashierPresenceState({
      online: isOnline, lastActivityAt: cashier.last_activity_at,
      shiftStatus: cashier.shift_status,
    });
    const paymentAmounts = paymentsByCashier.get(cashier.id) ?? {};
    const expectedCash = cashier.shift_status === "open"
      ? new Decimal(cashier.opening_cash ?? 0)
        .plus(shiftFinance?.cash_sales ?? 0).plus(shiftFinance?.deposits ?? 0)
        .minus(shiftFinance?.withdrawals ?? 0).minus(shiftFinance?.cash_expenses ?? 0)
      : new Decimal(0);
    return {
      id: cashier.id, name: cashier.name, username: cashier.username,
      employeeNumber: cashier.employee_number, branchId: cashier.branch_id, branch: cashier.branch_name,
      roles: cashier.roles ? cashier.roles.split(",") : [], online: isOnline,
      active: status === "active", loginAt: iso(cashier.login_at),
      lastActivityAt: iso(cashier.last_activity_at),
      shiftId: cashier.shift_id, shiftStatus: cashier.shift_status,
      shiftOpenedAt: iso(cashier.shift_opened_at), shiftClosedAt: iso(cashier.shift_closed_at),
      counter: cashier.counter_number, openingCash: cashier.opening_cash ?? "0.00", status,
      transactions: Number(totals?.transactions ?? 0), grossSales: gross.toFixed(2),
      discounts: totals?.discounts ?? "0.00", refunds: refunds.toFixed(2),
      netSales: gross.minus(refunds).toFixed(2),
      payments: {
        cash: paymentAmounts.cash ?? "0.00", mpesa: paymentAmounts.mpesa ?? "0.00",
        card: paymentAmounts.card ?? "0.00", bank_transfer: paymentAmounts.bank_transfer ?? "0.00",
        credit: paymentAmounts.credit ?? "0.00",
      },
      expenses: shiftFinance?.approved_expenses ?? "0.00",
      expectedCash: expectedCash.toFixed(2), shiftDurationSeconds: shiftAge,
    };
  });
  const paymentTotals = rows.reduce<{
    transactions: number;
    gross: Decimal;
    refunds: Decimal;
    net: Decimal;
    payments: Record<string, Decimal>;
  }>((totals, cashier) => {
    totals.transactions += cashier.transactions;
    totals.gross = totals.gross.plus(cashier.grossSales);
    totals.refunds = totals.refunds.plus(cashier.refunds);
    totals.net = totals.net.plus(cashier.netSales);
    for (const method of Object.keys(totals.payments)) {
      totals.payments[method] = totals.payments[method]!.plus(cashier.payments[method] ?? 0);
    }
    return totals;
  }, {
    transactions: 0, gross: new Decimal(0), refunds: new Decimal(0), net: new Decimal(0),
    payments: { cash: new Decimal(0), mpesa: new Decimal(0), card: new Decimal(0), bank_transfer: new Decimal(0), credit: new Decimal(0) },
  });
  return {
    cashiers: rows,
    updatedAt: new Date().toISOString(),
    totals: {
      online: rows.filter((cashier) => cashier.online).length,
      activeShifts: rows.filter((cashier) => cashier.shiftStatus === "open").length,
      transactions: paymentTotals.transactions, grossSales: paymentTotals.gross.toFixed(2),
      refunds: paymentTotals.refunds.toFixed(2), netSales: paymentTotals.net.toFixed(2),
      payments: Object.fromEntries(Object.entries(paymentTotals.payments).map(([method, amount]) => [method, amount.toFixed(2)])),
    },
    thresholds: { onlineSeconds: onlineTimeoutSeconds, idleSeconds: idleTimeoutSeconds },
  };
}

export async function getCashierMonitorDetails(user: MonitorUser, cashierId: number) {
  assertCanMonitor(user);
  const monitor = await getCashierMonitoring(user, {
    scope: "shift", cashierId,
  });
  const cashier = monitor.cashiers[0];
  if (!cashier) throw new HttpError(404, "Cashier not found.");
  if (!cashier.shiftId || cashier.shiftStatus !== "open") {
    return { cashier, transactions: [], expenses: [], cashMovements: [] };
  }
  const [transactions, expenses, cashMovements] = await Promise.all([
    query<Array<RowDataPacket & {
      id: number; receipt_number: string; total: string; discount: string; status: string;
      created_at: Date; customer: string | null; item_count: number; quantity: string;
      payment_methods: string | null; refunded: string;
    }>>(
      `SELECT s.id, s.receipt_number, s.total, s.discount, s.status, s.created_at,
              c.name AS customer, COALESCE(si.item_count,0) AS item_count,
              COALESCE(si.quantity,0) AS quantity,
              GROUP_CONCAT(DISTINCT sp.method ORDER BY sp.method SEPARATOR ',') AS payment_methods,
              COALESCE((SELECT SUM(r.total) FROM refunds r WHERE r.sale_id=s.id AND r.status='completed'),0) AS refunded
       FROM sales s LEFT JOIN customers c ON c.id=s.customer_id
       LEFT JOIN (
         SELECT sale_id, COUNT(*) AS item_count, SUM(quantity) AS quantity
         FROM sale_items GROUP BY sale_id
       ) si ON si.sale_id=s.id
       LEFT JOIN sale_payments sp ON sp.sale_id=s.id AND sp.status='completed'
       WHERE s.shift_id=? AND s.cashier_id=? AND s.branch_id=?
       GROUP BY s.id, s.receipt_number, s.total, s.discount, s.status, s.created_at, c.name, si.item_count, si.quantity
       ORDER BY s.created_at DESC LIMIT 500`,
      [cashier.shiftId, cashierId, cashier.branchId],
    ),
    query<Array<RowDataPacket & {
      id: number; category: string; description: string; amount: string;
      payment_method: string; status: string; created_at: Date;
    }>>(
      `SELECT e.id, ec.name AS category, e.description, e.amount, e.payment_method, e.status, e.created_at
       FROM expenses e JOIN expense_categories ec ON ec.id=e.category_id
       WHERE e.shift_id=? ORDER BY e.created_at DESC`,
      [cashier.shiftId],
    ),
    query<Array<RowDataPacket & {
      id: number; movement_type: string; amount: string; description: string; created_at: Date;
    }>>(
      "SELECT id, movement_type, amount, description, created_at FROM cash_movements WHERE shift_id=? ORDER BY created_at DESC",
      [cashier.shiftId],
    ),
  ]);
  return {
    cashier,
    transactions: transactions.map((transaction) => ({
      id: transaction.id, receiptNumber: transaction.receipt_number, total: transaction.total,
      discount: transaction.discount, status: transaction.status === "pending_payment" ? "pending" : transaction.status,
      createdAt: iso(transaction.created_at), customer: transaction.customer,
      itemCount: Number(transaction.item_count), quantity: transaction.quantity,
      paymentMethod: transaction.payment_methods, refunded: transaction.refunded,
    })),
    expenses: expenses.map((expense) => ({
      id: expense.id, category: expense.category, description: expense.description,
      amount: expense.amount, paymentMethod: expense.payment_method, status: expense.status,
      createdAt: iso(expense.created_at),
    })),
    cashMovements: cashMovements.map((movement) => ({
      id: movement.id, type: movement.movement_type, amount: movement.amount,
      description: movement.description, createdAt: iso(movement.created_at),
    })),
  };
}

export async function getMonitoredSaleReceipt(user: MonitorUser, saleId: number) {
  assertCanMonitor(user);
  const conditions = ["s.id=?", "EXISTS (SELECT 1 FROM user_roles cr JOIN roles crl ON crl.id=cr.role_id WHERE cr.user_id=s.cashier_id AND crl.name='cashier')"];
  const parameters: number[] = [saleId];
  if (!user.roles.includes("admin")) {
    conditions.push("s.branch_id=?");
    parameters.push(user.branchId);
  }
  const sales = await query<Array<RowDataPacket & {
    id: number; cashier_id: number; branch_id: number; receipt_number: string; subtotal: string;
    discount: string; tax: string; total: string; status: string; created_at: Date;
    cashier: string; customer: string | null; branch: string; cash_received: string | null; change_due: string;
  }>>(
    `SELECT s.id, s.cashier_id, s.branch_id, s.receipt_number, s.subtotal, s.discount, s.tax,
            s.total, s.status, s.created_at, u.name AS cashier, c.name AS customer, b.name AS branch,
            s.cash_received, s.change_due
     FROM sales s JOIN users u ON u.id=s.cashier_id JOIN branches b ON b.id=s.branch_id
     LEFT JOIN customers c ON c.id=s.customer_id
     WHERE ${conditions.join(" AND ")} LIMIT 1`,
    parameters,
  );
  const sale = sales[0];
  if (!sale) throw new HttpError(404, "Transaction not found.");
  const [items, payments] = await Promise.all([
    query<Array<RowDataPacket & {
      id: number; sku_snapshot: string; name_snapshot: string; quantity: string;
      unit_price: string; line_total: string; refunded: string;
    }>>(
      `SELECT si.id, si.sku_snapshot, si.name_snapshot, si.quantity, si.unit_price, si.line_total,
              COALESCE((SELECT SUM(ri.quantity) FROM refund_items ri WHERE ri.sale_item_id=si.id),0) AS refunded
       FROM sale_items si WHERE si.sale_id=? ORDER BY si.id`,
      [saleId],
    ),
    query<Array<RowDataPacket & { method: string; amount: string; status: string; provider_reference: string | null }>>(
      "SELECT method, amount, status, provider_reference FROM sale_payments WHERE sale_id=? ORDER BY id",
      [saleId],
    ),
  ]);
  return {
    sale: {
      id: sale.id, receiptNumber: sale.receipt_number, subtotal: sale.subtotal, discount: sale.discount,
      tax: sale.tax, total: sale.total, status: sale.status, createdAt: iso(sale.created_at),
      cashier: sale.cashier, customer: sale.customer, branch: sale.branch,
      cashReceived: sale.cash_received, changeDue: sale.change_due,
    },
    items: items.map((item) => ({
      id: item.id, sku: item.sku_snapshot, name: item.name_snapshot,
      quantity: item.quantity, unitPrice: item.unit_price, lineTotal: item.line_total, refunded: item.refunded,
    })),
    payments: payments.map((payment) => ({
      method: payment.method, amount: payment.amount, status: payment.status,
      reference: payment.provider_reference,
    })),
  };
}
