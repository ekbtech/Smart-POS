import { describe, expect, it } from "vitest";
import { HttpError } from "./errors.js";
import { calculateReportProfit, parseReportRange } from "./reports.js";

describe("report date ranges", () => {
  it("defaults to the most recent 30 calendar days", () => {
    expect(parseReportRange({}, new Date("2026-03-08T19:00:00.000Z"))).toEqual({
      from: "2026-02-07",
      to: "2026-03-08",
    });
  });

  it("accepts a valid inclusive range of up to 366 days", () => {
    expect(parseReportRange({ from: "2025-01-01", to: "2026-01-01" })).toEqual({
      from: "2025-01-01",
      to: "2026-01-01",
    });
  });

  it("rejects invalid calendar dates, reversed dates, and ranges over 366 days", () => {
    expect(() => parseReportRange({ from: "2026-02-30", to: "2026-03-01" })).toThrow(HttpError);
    expect(() => parseReportRange({ from: "2026-03-02", to: "2026-03-01" })).toThrow(HttpError);
    expect(() => parseReportRange({ from: "2025-01-01", to: "2026-01-02" })).toThrow(HttpError);
  });
});

describe("report profit calculations", () => {
  it("subtracts costs and refunds, then approved expenses using decimal arithmetic", () => {
    expect(calculateReportProfit({
      revenue: "200.00",
      refundedNet: "100.00",
      costOfGoodsSold: "100.00",
      returnedCost: "50.00",
      expenses: "10.00",
      soldUnits: "2.000",
      costedUnits: "2.000",
      unknownRefundUnits: "0.000",
    })).toEqual({ grossProfit: "50.00", netProfit: "40.00", costCoverage: 100 });
  });

  it("withholds profit when any sold or refunded quantity has unknown cost", () => {
    expect(calculateReportProfit({
      revenue: "100.00",
      refundedNet: "0.00",
      costOfGoodsSold: "50.00",
      returnedCost: "0.00",
      expenses: "5.00",
      soldUnits: "2.000",
      costedUnits: "1.000",
      unknownRefundUnits: "0.000",
    })).toEqual({ grossProfit: null, netProfit: null, costCoverage: 50 });
  });
});
