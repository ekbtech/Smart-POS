import { describe, expect, it } from "vitest";
import type { AuthUser } from "./auth.js";
import { canAssignStaffRole, createStaffSchema, staffStatusSchema } from "./staff.js";

const actor = (roles: string[]): AuthUser => ({
  id: 1,
  name: "Test User",
  email: "test@example.com",
  branchId: 1,
  roles,
});

describe("staff management validation", () => {
  it("normalizes whitespace in staff fields and accepts optional employee details", () => {
    const result = createStaffSchema.parse({
      name: "  Alex Staff  ",
      email: "staff@example.com",
      username: "alex.staff",
      password: "a-secure-password",
      role: "cashier",
      departmentId: 2,
      jobTitle: "  Cashier  ",
      phone: "  +254700000000 ",
      hiredAt: "2026-01-15",
    });

    expect(result.name).toBe("Alex Staff");
    expect(result.jobTitle).toBe("Cashier");
    expect(result.hiredAt).toBe("2026-01-15");
  });

  it("rejects short passwords and invalid roles", () => {
    const input = {
      name: "Alex Staff",
      email: "staff@example.com",
      password: "short",
      role: "cashier",
    };
    expect(createStaffSchema.safeParse(input).success).toBe(false);
    expect(createStaffSchema.safeParse({ ...input, password: "long-enough-password", role: "root" }).success).toBe(false);
  });

  it("allows only administrators to create accounts and assign roles", () => {
    expect(canAssignStaffRole(actor(["manager"]), "cashier")).toBe(false);
    expect(canAssignStaffRole(actor(["manager"]), "manager")).toBe(false);
    expect(canAssignStaffRole(actor(["manager"]), "admin")).toBe(false);
    expect(canAssignStaffRole(actor(["admin"]), "manager")).toBe(true);
    expect(canAssignStaffRole(actor(["admin"]), "admin")).toBe(true);
  });

  it("accepts only explicit boolean account status changes", () => {
    expect(staffStatusSchema.safeParse({ isActive: false }).success).toBe(true);
    expect(staffStatusSchema.safeParse({ isActive: "false" }).success).toBe(false);
    expect(staffStatusSchema.safeParse({ isActive: false, role: "admin" }).success).toBe(false);
  });
});
