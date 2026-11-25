import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "./auth.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("./db.js", () => ({
  query: queryMock,
}));

import {
  cashierMonitorFiltersSchema, cashierPresenceState, getCashierMonitoring,
} from "./cashier-monitoring.js";

const manager: AuthUser = {
  id: 1,
  name: "Store Manager",
  email: "manager@example.test",
  branchId: 3,
  roles: ["manager"],
  modules: ["cashier_monitoring"],
};

describe("cashier monitoring access and filters", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires a complete ordered date range for custom monitoring", () => {
    expect(cashierMonitorFiltersSchema.safeParse({ scope: "custom", from: "2026-02-01", to: "2026-02-04" }).success).toBe(true);
    expect(cashierMonitorFiltersSchema.safeParse({ scope: "custom", from: "2026-02-01" }).success).toBe(false);
    expect(cashierMonitorFiltersSchema.safeParse({ scope: "custom", from: "2026-02-04", to: "2026-02-01" }).success).toBe(false);
  });

  it("distinguishes active, idle, open-but-offline, offline, and closed shifts", () => {
    const now = Date.now();
    expect(cashierPresenceState({ online: true, lastActivityAt: new Date(now), shiftStatus: "open", now }))
      .toBe("active");
    expect(cashierPresenceState({
      online: true, lastActivityAt: new Date(now - 6 * 60_000), shiftStatus: "open", now,
    })).toBe("idle");
    expect(cashierPresenceState({ online: false, lastActivityAt: null, shiftStatus: "open", now }))
      .toBe("shift_open_offline");
    expect(cashierPresenceState({ online: false, lastActivityAt: null, shiftStatus: null, now }))
      .toBe("offline");
    expect(cashierPresenceState({ online: false, lastActivityAt: null, shiftStatus: "closed", now }))
      .toBe("shift_closed");
  });

  it("rejects monitoring access without the module before reading cashier data", async () => {
    await expect(getCashierMonitoring({
      ...manager, modules: [],
    }, cashierMonitorFiltersSchema.parse({ scope: "shift" }))).rejects.toMatchObject({ status: 403 });
    expect(queryMock).not.toHaveBeenCalled();
  });
});
