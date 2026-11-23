import { describe, expect, it } from "vitest";
import { dailyEvaluationQuerySchema, getDailyEvaluation } from "./enterprise.js";

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
