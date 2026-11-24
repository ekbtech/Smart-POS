import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "./auth.js";
import { dailyEvaluationQuerySchema, getDailyEvaluation, listElectronicReceipts } from "./enterprise.js";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("./db.js", () => ({
  pool: { execute: executeMock },
  withTransaction: vi.fn(),
}));

const user = {
  id: 1,
  name: "Manager",
  email: "manager@example.com",
  branchId: 1,
  roles: ["manager"],
};

describe("daily evaluation access and filters", () => {
  it("accepts ISO dates and positive branch IDs", () => {
    expect(dailyEvaluationQuerySchema.safeParse({ date: "2025-03-08", branchId: "2" }).success).toBe(true);
    expect(dailyEvaluationQuerySchema.safeParse({ date: "2025-02-30" }).success).toBe(false);
    expect(dailyEvaluationQuerySchema.safeParse({ date: "2025-03-08", branchId: "0" }).success).toBe(false);
  });

  it("rejects users without an authorized evaluation role", async () => {
    await expect(getDailyEvaluation({ ...user, roles: ["cashier"] }, "2025-03-08"))
      .rejects.toMatchObject({ status: 403 });
  });

  it("rejects impossible dates before querying the database", async () => {
    await expect(getDailyEvaluation(user, "2025-02-30"))
      .rejects.toMatchObject({ status: 400 });
  });
});

const cashier: AuthUser = {
  id: 12,
  name: "Riley Cashier",
  email: "riley@example.test",
  branchId: 3,
  roles: ["cashier"],
  modules: ["receipts", "transaction_own"],
};

describe("electronic receipt access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValueOnce([[]]);
  });

  it("limits cashier receipts to their authenticated account and branch", async () => {
    await listElectronicReceipts(cashier);

    const [sql, parameters] = executeMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("er.branch_id=?");
    expect(sql).toContain("s.cashier_id=?");
    expect(parameters).toEqual([3, 12]);
  });

  it("allows all-transaction permission to see other cashiers in the assigned branch", async () => {
    await listElectronicReceipts({
      ...cashier,
      modules: [...(cashier.modules ?? []), "transaction_all"],
    });

    const [sql, parameters] = executeMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("er.branch_id=?");
    expect(sql).not.toContain("s.cashier_id=?");
    expect(parameters).toEqual([3]);
  });

  it("rejects users without transaction-history visibility", async () => {
    await expect(listElectronicReceipts({ ...cashier, modules: ["receipts"] }))
      .rejects.toMatchObject({ status: 403 });
    expect(executeMock).not.toHaveBeenCalled();
  });
});
