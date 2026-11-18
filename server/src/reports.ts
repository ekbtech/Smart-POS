import { Decimal } from "decimal.js";
import { z } from "zod";
import { query } from "./db.js";
import { HttpError } from "./errors.js";

type ProfitInputs = {
  revenue: string;
  refundedNet: string;
  costOfGoodsSold: string;
  returnedCost: string;
  expenses: string;
  soldUnits: string;
  costedUnits: string;
  unknownRefundUnits: string;
};

export function calculateReportProfit(input: ProfitInputs) {
  const sold = new Decimal(input.soldUnits);
  const costed = new Decimal(input.costedUnits);
  const unknownRefunds = new Decimal(input.unknownRefundUnits);
  const costComplete = costed.equals(sold) && unknownRefunds.isZero();
  const costCoverage = sold.isZero()
    ? unknownRefunds.isZero() ? 100 : 0
    : Decimal.min(new Decimal(100), costed.dividedBy(sold).times(100)).toNumber();
  if (!costComplete) return { grossProfit: null, netProfit: null, costCoverage };
  const grossProfit = new Decimal(input.revenue)
    .minus(input.refundedNet)
    .minus(input.costOfGoodsSold)
    .plus(input.returnedCost)
    .toFixed(2);
  const netProfit = new Decimal(grossProfit).minus(input.expenses).toFixed(2);
  return { grossProfit, netProfit, costCoverage };
}

const reportDate = z.iso.date();
const reportRangeSchema = z.object({
  from: reportDate,
  to: reportDate,
}).strict();

export type ReportRange = z.infer<typeof reportRangeSchema>;

export function parseReportRange(input: Record<string, unknown>, now = new Date()): ReportRange {
  const fallbackTo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const fallbackFrom = new Date(fallbackTo);
  fallbackFrom.setUTCDate(fallbackFrom.getUTCDate() - 29);
  const fallback = {
    from: fallbackFrom.toISOString().slice(0, 10),
    to: fallbackTo.toISOString().slice(0, 10),
  };
  const parsed = reportRangeSchema.safeParse({
    from: input.from ?? fallback.from,
    to: input.to ?? fallback.to,
  });
  if (!parsed.success) throw new HttpError(400, "Provide valid report dates in YYYY-MM-DD format.");
  if (parsed.data.from > parsed.data.to) throw new HttpError(400, "The report start date must not be after its end date.");
  const from = Date.parse(`${parsed.data.from}T00:00:00Z`);
  const to = Date.parse(`${parsed.data.to}T00:00:00Z`);
  if ((to - from) / 86_400_000 > 365) throw new HttpError(400, "Report date ranges cannot exceed 366 days.");
  return parsed.data;
}

export async function getBranchReport(branchId: number, range: ReportRange) {
  const values = [branchId, range.from, range.to];
  const [
    financialRows,
    dailyRows,
    cashierRows,
    productRows,
    categoryRows,
    paymentRows,
    expenseRows,
    purchaseRows,
    stockRows,
    lowStockRows,
  ] = await Promise.all([
    query<Array<{
      revenue: string; tax: string; transactions: number; refunds: string;
      refunded_net: string; cogs: string; refund_cogs: string;
      costed_units: string; sold_units: string; unknown_refund_units: string;
      expenses: string; pending_expenses: string; purchase_spend: string;
    } & import("mysql2").RowDataPacket>>(
      `SELECT
         COALESCE((SELECT SUM(GREATEST(s.subtotal - s.discount, 0)) FROM sales s
                   WHERE s.branch_id = ? AND s.status = 'completed'
                     AND s.created_at >= ? AND s.created_at < DATE_ADD(?, INTERVAL 1 DAY)), 0) AS revenue,
         COALESCE((SELECT SUM(s.tax) FROM sales s
                   WHERE s.branch_id = ? AND s.status = 'completed'
                     AND s.created_at >= ? AND s.created_at < DATE_ADD(?, INTERVAL 1 DAY)), 0) AS tax,
         (SELECT COUNT(*) FROM sales s
          WHERE s.branch_id = ? AND s.status = 'completed'
            AND s.created_at >= ? AND s.created_at < DATE_ADD(?, INTERVAL 1 DAY)) AS transactions,
         COALESCE((SELECT SUM(r.total) FROM refunds r
                   WHERE r.branch_id = ? AND r.status = 'completed'
                     AND r.created_at >= ? AND r.created_at < DATE_ADD(?, INTERVAL 1 DAY)), 0) AS refunds,
         COALESCE((SELECT SUM(ri.net_amount) FROM refund_items ri
                   JOIN refunds r ON r.id = ri.refund_id
                   WHERE r.branch_id = ? AND r.status = 'completed'
                     AND r.created_at >= ? AND r.created_at < DATE_ADD(?, INTERVAL 1 DAY)), 0) AS refunded_net,
         COALESCE((SELECT SUM(si.unit_cost_snapshot * si.quantity)
                   FROM sale_items si JOIN sales s ON s.id = si.sale_id
                   WHERE s.branch_id = ? AND s.status = 'completed'
                     AND s.created_at >= ? AND s.created_at < DATE_ADD(?, INTERVAL 1 DAY)
                     AND si.unit_cost_snapshot IS NOT NULL), 0) AS cogs,
         COALESCE((SELECT SUM(si.unit_cost_snapshot * ri.quantity)
                   FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id
                   JOIN sale_items si ON si.id = ri.sale_item_id
                   WHERE r.branch_id = ? AND r.status = 'completed'
                     AND r.created_at >= ? AND r.created_at < DATE_ADD(?, INTERVAL 1 DAY)
                     AND si.unit_cost_snapshot IS NOT NULL), 0) AS refund_cogs,
         COALESCE((SELECT SUM(si.quantity)
                   FROM sale_items si JOIN sales s ON s.id = si.sale_id
                   WHERE s.branch_id = ? AND s.status = 'completed'
                     AND s.created_at >= ? AND s.created_at < DATE_ADD(?, INTERVAL 1 DAY)
                     AND si.unit_cost_snapshot IS NOT NULL), 0) AS costed_units,
         COALESCE((SELECT SUM(si.quantity)
                   FROM sale_items si JOIN sales s ON s.id = si.sale_id
                   WHERE s.branch_id = ? AND s.status = 'completed'
                     AND s.created_at >= ? AND s.created_at < DATE_ADD(?, INTERVAL 1 DAY)), 0) AS sold_units,
         COALESCE((SELECT SUM(ri.quantity)
                   FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id
                   JOIN sale_items si ON si.id = ri.sale_item_id
                   WHERE r.branch_id = ? AND r.status = 'completed'
                     AND r.created_at >= ? AND r.created_at < DATE_ADD(?, INTERVAL 1 DAY)
                     AND si.unit_cost_snapshot IS NULL), 0) AS unknown_refund_units,
         COALESCE((SELECT SUM(e.amount) FROM expenses e
                   WHERE e.branch_id = ? AND e.status = 'approved'
                     AND e.created_at >= ? AND e.created_at < DATE_ADD(?, INTERVAL 1 DAY)), 0) AS expenses,
         COALESCE((SELECT SUM(e.amount) FROM expenses e
                   WHERE e.branch_id = ? AND e.status = 'pending'
                     AND e.created_at >= ? AND e.created_at < DATE_ADD(?, INTERVAL 1 DAY)), 0) AS pending_expenses,
         COALESCE((SELECT SUM(gri.quantity * gri.unit_cost)
                   FROM goods_received_items gri
                   JOIN goods_received_notes grn ON grn.id = gri.grn_id
                   JOIN purchase_orders po ON po.id = grn.purchase_order_id
                   WHERE po.branch_id = ? AND grn.created_at >= ? AND grn.created_at < DATE_ADD(?, INTERVAL 1 DAY)), 0) AS purchase_spend`,
      [
        ...values, ...values, ...values, ...values, ...values, ...values, ...values,
        ...values, ...values, ...values, ...values, ...values, ...values,
      ],
    ),
    query<Array<{ date: string; revenue: string; transactions: number } & import("mysql2").RowDataPacket>>(
      `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS date,
              SUM(GREATEST(subtotal - discount, 0)) AS revenue, COUNT(*) AS transactions
       FROM sales WHERE branch_id = ? AND status = 'completed'
         AND created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)
       GROUP BY DATE(created_at) ORDER BY DATE(created_at)`,
      values,
    ),
    query<Array<{ name: string; transactions: number; revenue: string } & import("mysql2").RowDataPacket>>(
      `SELECT u.name, COUNT(s.id) AS transactions, SUM(GREATEST(s.subtotal - s.discount, 0)) AS revenue
       FROM sales s JOIN users u ON u.id = s.cashier_id
       WHERE s.branch_id = ? AND s.status = 'completed'
         AND s.created_at >= ? AND s.created_at < DATE_ADD(?, INTERVAL 1 DAY)
       GROUP BY u.id, u.name ORDER BY revenue DESC LIMIT 10`,
      values,
    ),
    query<Array<{ name: string; sku: string; quantity: string; revenue: string } & import("mysql2").RowDataPacket>>(
      `SELECT si.name_snapshot AS name, si.sku_snapshot AS sku,
              SUM(si.quantity) AS quantity, SUM(si.net_total) AS revenue
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE s.branch_id = ? AND s.status = 'completed'
         AND s.created_at >= ? AND s.created_at < DATE_ADD(?, INTERVAL 1 DAY)
       GROUP BY si.product_id, si.name_snapshot, si.sku_snapshot
       ORDER BY quantity DESC, revenue DESC LIMIT 10`,
      values,
    ),
    query<Array<{ name: string; revenue: string } & import("mysql2").RowDataPacket>>(
      `SELECT COALESCE(c.name, 'Uncategorised') AS name,
              SUM(si.net_total) AS revenue
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
       JOIN products p ON p.id = si.product_id
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE s.branch_id = ? AND s.status = 'completed'
         AND s.created_at >= ? AND s.created_at < DATE_ADD(?, INTERVAL 1 DAY)
       GROUP BY c.id, c.name ORDER BY revenue DESC LIMIT 12`,
      values,
    ),
    query<Array<{ method: string; amount: string; transactions: number } & import("mysql2").RowDataPacket>>(
      `SELECT sp.method, SUM(sp.amount) AS amount, COUNT(DISTINCT sp.sale_id) AS transactions
       FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
       WHERE s.branch_id = ? AND s.status = 'completed' AND sp.status = 'completed'
         AND s.created_at >= ? AND s.created_at < DATE_ADD(?, INTERVAL 1 DAY)
       GROUP BY sp.method ORDER BY amount DESC`,
      values,
    ),
    query<Array<{ category: string; amount: string; count: number } & import("mysql2").RowDataPacket>>(
      `SELECT ec.name AS category, SUM(e.amount) AS amount, COUNT(*) AS count
       FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id
       WHERE e.branch_id = ? AND e.status = 'approved'
         AND e.created_at >= ? AND e.created_at < DATE_ADD(?, INTERVAL 1 DAY)
       GROUP BY ec.id, ec.name ORDER BY amount DESC LIMIT 12`,
      values,
    ),
    query<Array<{ status: string; count: number; ordered_cost: string; received_cost: string } & import("mysql2").RowDataPacket>>(
      `SELECT po.status, COUNT(DISTINCT po.id) AS count,
              COALESCE(SUM(poi.quantity_ordered * poi.unit_cost), 0) AS ordered_cost,
              COALESCE(SUM(poi.quantity_received * poi.unit_cost), 0) AS received_cost
       FROM purchase_orders po LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
       WHERE po.branch_id = ? AND po.created_at >= ? AND po.created_at < DATE_ADD(?, INTERVAL 1 DAY)
       GROUP BY po.status ORDER BY po.status`,
      values,
    ),
    query<Array<{ value: string; units: string } & import("mysql2").RowDataPacket>>(
      `SELECT COALESCE(SUM(i.on_hand * p.purchase_price), 0) AS value,
              COALESCE(SUM(i.on_hand), 0) AS units
       FROM inventory i JOIN products p ON p.id = i.product_id
       WHERE i.branch_id = ? AND p.is_active = TRUE`,
      [branchId],
    ),
    query<Array<{ id: number; sku: string; name: string; available: string; reorder_level: string } & import("mysql2").RowDataPacket>>(
      `SELECT p.id, p.sku, p.name,
              GREATEST(COALESCE(i.on_hand - i.reserved, 0) - COALESCE(expired.quantity, 0), 0) AS available,
              p.reorder_level
       FROM products p LEFT JOIN inventory i ON i.product_id = p.id AND i.branch_id = ?
       LEFT JOIN (
         SELECT product_id, SUM(quantity_remaining) AS quantity FROM inventory_batches
         WHERE branch_id = ? AND expiry_date < CURDATE() AND quantity_remaining > 0 GROUP BY product_id
       ) expired ON expired.product_id = p.id
       WHERE p.is_active = TRUE
         AND GREATEST(COALESCE(i.on_hand - i.reserved, 0) - COALESCE(expired.quantity, 0), 0) <= p.reorder_level
       ORDER BY available ASC, p.name LIMIT 100`,
      [branchId, branchId],
    ),
  ]);
  const financial = financialRows[0];
  const soldUnits = Number(financial?.sold_units ?? 0);
  const costedUnits = Number(financial?.costed_units ?? 0);
  const revenue = Number(financial?.revenue ?? 0);
  const profitability = calculateReportProfit({
    revenue: String(financial?.revenue ?? "0"),
    refundedNet: String(financial?.refunded_net ?? "0"),
    costOfGoodsSold: String(financial?.cogs ?? "0"),
    returnedCost: String(financial?.refund_cogs ?? "0"),
    expenses: String(financial?.expenses ?? "0"),
    soldUnits: String(financial?.sold_units ?? "0"),
    costedUnits: String(financial?.costed_units ?? "0"),
    unknownRefundUnits: String(financial?.unknown_refund_units ?? "0"),
  });

  return {
    range,
    summary: {
      revenue: String(financial?.revenue ?? "0.00"),
      tax: String(financial?.tax ?? "0.00"),
      transactions: Number(financial?.transactions ?? 0),
      averageOrder: Number(financial?.transactions ?? 0) > 0
        ? (revenue / Number(financial?.transactions)).toFixed(2)
        : "0.00",
      refunds: String(financial?.refunds ?? "0.00"),
      netRevenue: (revenue - Number(financial?.refunded_net ?? 0)).toFixed(2),
      grossProfit: profitability.grossProfit,
      costCoverage: profitability.costCoverage,
      costedUnits: costedUnits.toFixed(3),
      soldUnits: soldUnits.toFixed(3),
      expenses: String(financial?.expenses ?? "0.00"),
      pendingExpenses: String(financial?.pending_expenses ?? "0.00"),
      netProfit: profitability.netProfit,
      purchaseSpend: String(financial?.purchase_spend ?? "0.00"),
      inventoryValue: String(stockRows[0]?.value ?? "0.00"),
      inventoryUnits: String(stockRows[0]?.units ?? "0.000"),
    },
    salesTrend: dailyRows.map((row) => ({
      date: row.date,
      revenue: String(row.revenue),
      transactions: Number(row.transactions),
    })),
    salesByCashier: cashierRows.map((row) => ({
      name: row.name,
      transactions: Number(row.transactions),
      revenue: String(row.revenue),
    })),
    topProducts: productRows.map((row) => ({
      name: row.name, sku: row.sku, quantity: String(row.quantity), revenue: String(row.revenue),
    })),
    salesByCategory: categoryRows.map((row) => ({ name: row.name, revenue: String(row.revenue) })),
    payments: paymentRows.map((row) => ({
      method: row.method, amount: String(row.amount), transactions: Number(row.transactions),
    })),
    expensesByCategory: expenseRows.map((row) => ({
      category: row.category, amount: String(row.amount), count: Number(row.count),
    })),
    purchases: purchaseRows.map((row) => ({
      status: row.status,
      count: Number(row.count),
      orderedCost: String(row.ordered_cost),
      receivedCost: String(row.received_cost),
    })),
    lowStock: lowStockRows.map((row) => ({
      id: row.id, sku: row.sku, name: row.name,
      available: String(row.available), reorderLevel: String(row.reorder_level),
    })),
  };
}
