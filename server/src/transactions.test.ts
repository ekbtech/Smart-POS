import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "./auth.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("./db.js", () => ({
  query: queryMock,
}));

import { listTransactions, transactionHistoryQuerySchema, transactionsToCsv } from "./transactions.js";

const cashier: AuthUser = {
  id: 12,
  name: "Riley Cashier",
  email: "riley@example.test",
  branchId: 3,
  roles: ["cashier"],
  modules: ["sales", "transaction_own", "transaction_details"],
};

describe("transaction history access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("limits cashier searches to their own branch and authenticated account", async () => {
    queryMock.mockResolvedValueOnce([]);
    const filters = transactionHistoryQuerySchema.parse({
      q: "receipt",
      from: "2026-01-01",
      to: "2026-01-31",
      paymentMethod: "cash",
      status: "completed",
    });

    await listTransactions(cashier, filters);

    const [sql, parameters] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("s.branch_id = ?");
    expect(sql).toContain("s.cashier_id = ?");
    expect(sql).toContain("sp.method = ?");
    expect(sql).toContain("FROM refunds");
    expect(parameters).toContain(3);
    expect(parameters).toContain(12);
    expect(parameters).toContain("cash");
  });

  it("rejects a cashier filter for another cashier before querying", async () => {
    const filters = transactionHistoryQuerySchema.parse({ cashierId: "99" });

    await expect(listTransactions(cashier, filters)).rejects.toMatchObject({ status: 403 });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("accepts only valid history filter values and ordered dates", () => {
    expect(transactionHistoryQuerySchema.safeParse({ status: "unknown" }).success).toBe(false);
    expect(transactionHistoryQuerySchema.safeParse({ from: "2026-02-02", to: "2026-02-01" }).success).toBe(false);
  });

  it("exports transaction values as CSV without spreadsheet formula execution", () => {
    const csv = transactionsToCsv([{
      id: 7,
      receiptNumber: "=SUM(A1:A2)",
      branchId: 3,
      branch: "North",
      subtotal: "10.00",
      discount: "0.00",
      tax: "0.00",
      total: "10.00",
      cashReceived: "10.00",
      changeDue: "0.00",
      createdAt: "2026-01-01T10:00:00.000Z",
      status: "completed",
      cashierId: 12,
      cashier: "Riley Cashier",
      customer: null,
      itemCount: 1,
      paymentMethod: "cash",
      amountPaid: "10.00",
    }]);

    expect(csv).toContain("'=SUM(A1:A2)");
    expect(csv).toContain('"Transaction ID","Receipt Number"');
  });
});
