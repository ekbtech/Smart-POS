import type { RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import type { AuthUser } from "./auth.js";
import { query } from "./db.js";
import { HttpError } from "./errors.js";

const optionalPositiveInteger = z.preprocess(
  (value) => value === "" || value === undefined ? undefined : value,
  z.coerce.number().int().positive().optional(),
);
const optionalText = (max: number) => z.preprocess(
  (value) => value === "" || value === undefined ? undefined : value,
  z.string().trim().max(max).optional(),
);

export const transactionHistoryQuerySchema = z.object({
  q: optionalText(100),
  cashier: optionalText(120),
  from: z.preprocess((value) => value === "" || value === undefined ? undefined : value, z.iso.date().optional()),
  to: z.preprocess((value) => value === "" || value === undefined ? undefined : value, z.iso.date().optional()),
  paymentMethod: z.preprocess(
    (value) => value === "" || value === undefined ? undefined : value,
    z.enum(["cash", "mpesa", "card", "bank_transfer", "credit"]).optional(),
  ),
  status: z.preprocess(
    (value) => value === "" || value === undefined ? undefined : value,
    z.enum(["completed", "pending", "cancelled", "refunded"]).optional(),
  ),
  cashierId: optionalPositiveInteger,
  branchId: optionalPositiveInteger,
}).strict().superRefine((filters, context) => {
  if (filters.from && filters.to && filters.from > filters.to) {
    context.addIssue({ code: "custom", path: ["to"], message: "End date must be on or after start date." });
  }
});

export type TransactionHistoryFilters = z.infer<typeof transactionHistoryQuerySchema>;

export function canViewAllTransactions(user: AuthUser): boolean {
  return user.roles.includes("admin") || user.modules?.includes("transaction_all") === true;
}

export function canViewOwnTransactions(user: AuthUser): boolean {
  return user.roles.includes("admin") || user.modules?.includes("transaction_own") === true;
}

export async function listTransactions(
  user: AuthUser,
  filters: TransactionHistoryFilters,
  limit = 500,
) {
  if (!user.roles.includes("admin") && !user.modules?.includes("sales")) {
    throw new HttpError(403, "You do not have permission to access transaction history.");
  }
  const canViewAll = canViewAllTransactions(user);
  if (!canViewAll && !canViewOwnTransactions(user)) {
    throw new HttpError(403, "You do not have permission to view transactions.");
  }
  if (filters.cashierId && !canViewAll && filters.cashierId !== user.id) {
    throw new HttpError(403, "You can only view your own transactions.");
  }
  const isAdmin = user.roles.includes("admin");
  if (filters.branchId && !isAdmin && filters.branchId !== user.branchId) {
    throw new HttpError(403, "You cannot access transactions from another branch.");
  }

  const conditions: string[] = [];
  const parameters: Array<string | number> = [];
  if (isAdmin) {
    if (filters.branchId) {
      conditions.push("s.branch_id = ?");
      parameters.push(filters.branchId);
    }
  } else {
    conditions.push("s.branch_id = ?");
    parameters.push(user.branchId);
  }
  if (!canViewAll) {
    conditions.push("s.cashier_id = ?");
    parameters.push(user.id);
  } else if (filters.cashierId) {
    conditions.push("s.cashier_id = ?");
    parameters.push(filters.cashierId);
  }
  if (filters.q) {
    conditions.push("(s.receipt_number LIKE ? OR CAST(s.id AS CHAR) LIKE ? OR u.name LIKE ? OR c.name LIKE ?)");
    const like = `%${filters.q}%`;
    parameters.push(like, like, like, like);
  }
  if (filters.cashier) {
    conditions.push("u.name LIKE ?");
    parameters.push(`%${filters.cashier}%`);
  }
  if (filters.from) {
    conditions.push("s.created_at >= ?");
    parameters.push(`${filters.from} 00:00:00`);
  }
  if (filters.to) {
    conditions.push("s.created_at < DATE_ADD(?, INTERVAL 1 DAY)");
    parameters.push(`${filters.to} 00:00:00`);
  }
  if (filters.paymentMethod) {
    conditions.push("EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.sale_id = s.id AND sp.method = ?)");
    parameters.push(filters.paymentMethod);
  }
  const refundedTotal = "(SELECT COALESCE(SUM(r.total), 0) FROM refunds r WHERE r.sale_id = s.id AND r.status = 'completed')";
  if (filters.status === "completed") {
    conditions.push(`s.status = 'completed' AND ${refundedTotal} < s.total`);
  } else if (filters.status === "pending") {
    conditions.push("s.status = 'pending_payment'");
  } else if (filters.status === "cancelled") {
    conditions.push("s.status = 'cancelled'");
  } else if (filters.status === "refunded") {
    conditions.push(`s.status = 'completed' AND ${refundedTotal} >= s.total`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await query<Array<RowDataPacket & {
    id: number;
    receipt_number: string;
    branch_id: number;
    branch: string;
    subtotal: string;
    discount: string;
    tax: string;
    total: string;
    cash_received: string | null;
    change_due: string;
    created_at: Date;
    transaction_status: "completed" | "pending" | "cancelled" | "refunded";
    cashier: string;
    cashier_id: number;
    customer_name: string | null;
    item_count: number;
    payment_methods: string | null;
    amount_paid: string;
  }>>(
    `SELECT s.id, s.receipt_number, s.branch_id, b.name AS branch, s.subtotal, s.discount, s.tax, s.total,
            s.cash_received, s.change_due, s.created_at, u.id AS cashier_id, u.name AS cashier,
            c.name AS customer_name,
            (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS item_count,
            (SELECT GROUP_CONCAT(DISTINCT sp.method ORDER BY sp.method SEPARATOR ',')
             FROM sale_payments sp WHERE sp.sale_id = s.id) AS payment_methods,
            (SELECT COALESCE(SUM(sp.amount), 0) FROM sale_payments sp
             WHERE sp.sale_id = s.id AND sp.status = 'completed') AS amount_paid,
            CASE WHEN s.status = 'cancelled' THEN 'cancelled'
                 WHEN s.status = 'pending_payment' THEN 'pending'
                 WHEN ${refundedTotal} >= s.total THEN 'refunded'
                 ELSE 'completed' END AS transaction_status
     FROM sales s
     JOIN users u ON u.id = s.cashier_id
     JOIN branches b ON b.id = s.branch_id
     LEFT JOIN customers c ON c.id = s.customer_id
     ${where}
     ORDER BY s.created_at DESC, s.id DESC LIMIT ?`,
    [...parameters, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    receiptNumber: row.receipt_number,
    branchId: row.branch_id,
    branch: row.branch,
    subtotal: row.subtotal,
    discount: row.discount,
    tax: row.tax,
    total: row.total,
    cashReceived: row.cash_received,
    changeDue: row.change_due,
    createdAt: row.created_at.toISOString(),
    status: row.transaction_status,
    cashierId: row.cashier_id,
    cashier: row.cashier,
    customer: row.customer_name,
    itemCount: Number(row.item_count),
    paymentMethod: row.payment_methods,
    amountPaid: row.amount_paid,
  }));
}

function csvCell(value: string | number | null): string {
  const text = String(value ?? "");
  const safe = /^[\t\r ]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function transactionsToCsv(
  transactions: Awaited<ReturnType<typeof listTransactions>>,
): string {
  const rows: Array<Array<string | number | null>> = [
    [
      "Transaction ID", "Receipt Number", "Date", "Branch", "Cashier", "Customer", "Products",
      "Subtotal", "Discount", "Tax", "Total", "Payment Method", "Amount Paid", "Cash Received",
      "Change Given", "Status",
    ],
    ...transactions.map((transaction) => [
      transaction.id, transaction.receiptNumber, transaction.createdAt, transaction.branch,
      transaction.cashier, transaction.customer, transaction.itemCount, transaction.subtotal,
      transaction.discount, transaction.tax, transaction.total, transaction.paymentMethod,
      transaction.amountPaid, transaction.cashReceived, transaction.changeDue, transaction.status,
    ]),
  ];
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}
