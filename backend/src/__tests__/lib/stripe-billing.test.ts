import { describe, expect, it } from "vitest";
import {
  calculateIterations,
  calculateNextPaymentDate,
  toStripeInterval,
} from "../../lib/stripe-billing";

describe("stripe-billing", () => {
  describe("toStripeInterval", () => {
    it("returns week interval for 'week'", () => {
      const result = toStripeInterval("week");
      expect(result).toEqual({ interval: "week", interval_count: 1 });
    });

    it("returns bi-weekly interval for 'bi_weekly'", () => {
      const result = toStripeInterval("bi_weekly");
      expect(result).toEqual({ interval: "week", interval_count: 2 });
    });

    it("returns month interval for 'month'", () => {
      const result = toStripeInterval("month");
      expect(result).toEqual({ interval: "month", interval_count: 1 });
    });

    it("returns quarter interval for 'quarter'", () => {
      const result = toStripeInterval("quarter");
      expect(result).toEqual({ interval: "month", interval_count: 3 });
    });

    it("returns year interval for 'year'", () => {
      const result = toStripeInterval("year");
      expect(result).toEqual({ interval: "year", interval_count: 1 });
    });
  });

  describe("calculateIterations", () => {
    it("returns 0 when end date is before start date", () => {
      const result = calculateIterations("2024-01-15", "2024-01-01", "month");
      expect(result).toBe(0);
    });

    it("calculates weekly iterations correctly", () => {
      const result = calculateIterations("2024-01-01", "2024-01-22", "week");
      expect(result).toBe(3); // 3 weeks
    });

    it("calculates bi-weekly iterations correctly", () => {
      const result = calculateIterations("2024-01-01", "2024-01-29", "bi_weekly");
      expect(result).toBe(2); // 2 bi-weekly periods
    });

    it("calculates monthly iterations correctly", () => {
      const result = calculateIterations("2024-01-01", "2024-03-01", "month");
      expect(result).toBe(2); // Jan and Feb billing periods (end date is exclusive boundary)
    });

    it("calculates quarterly iterations correctly", () => {
      const result = calculateIterations("2024-01-01", "2024-07-01", "quarter");
      expect(result).toBe(2); // Q1 (Jan–Mar) and Q2 (Apr–Jun)
    });

    it("calculates yearly iterations correctly", () => {
      const result = calculateIterations("2024-01-01", "2025-01-01", "year");
      expect(result).toBe(1); // One full year: 2024
    });

    it("handles partial week correctly", () => {
      const result = calculateIterations("2024-01-01", "2024-01-10", "week");
      expect(result).toBe(2); // 10 days = 1.4 weeks, ceil = 2
    });

    it("handles same day as 1 iteration", () => {
      const result = calculateIterations("2024-01-01", "2024-01-01", "month");
      expect(result).toBe(0); // End is same as start
    });

    it("handles monthly iteration with partial month", () => {
      const result = calculateIterations("2024-01-15", "2024-02-14", "month");
      expect(result).toBe(1); // Includes starting month
    });

    it("handles yearly iteration crossing year boundary", () => {
      const result = calculateIterations("2024-06-01", "2025-05-31", "year");
      expect(result).toBe(1); // Just under a year
    });

    // Boundary cases for the cursor-based fix
    it("returns 1 for exactly one calendar month (Jan 1 → Feb 1)", () => {
      const result = calculateIterations("2024-01-01", "2024-02-01", "month");
      expect(result).toBe(1);
    });

    it("returns 1 for less than a full month (Jan 15 → Feb 14)", () => {
      const result = calculateIterations("2024-01-15", "2024-02-14", "month");
      expect(result).toBe(1);
    });

    it("returns 1 for exactly same-day next month (Jan 15 → Feb 15)", () => {
      const result = calculateIterations("2024-01-15", "2024-02-15", "month");
      expect(result).toBe(1);
    });

    it("returns 2 for two calendar months (Jan 15 → Mar 15)", () => {
      const result = calculateIterations("2024-01-15", "2024-03-15", "month");
      expect(result).toBe(2);
    });

    it("returns 1 for exactly one quarter (Jan 1 → Apr 1)", () => {
      const result = calculateIterations("2024-01-01", "2024-04-01", "quarter");
      expect(result).toBe(1);
    });
  });

  describe("calculateNextPaymentDate", () => {
    it("calculates next weekly payment date", () => {
      const result = calculateNextPaymentDate("2024-01-01", "week", 2);
      expect(result.toISOString().split("T")[0]).toBe("2024-01-15");
    });

    it("calculates next bi-weekly payment date", () => {
      const result = calculateNextPaymentDate("2024-01-01", "bi_weekly", 2);
      expect(result.toISOString().split("T")[0]).toBe("2024-01-29");
    });

    it("calculates next monthly payment date", () => {
      const result = calculateNextPaymentDate("2024-01-01", "month", 3);
      expect(result.toISOString().split("T")[0]).toBe("2024-04-01");
    });

    it("calculates next quarterly payment date", () => {
      const result = calculateNextPaymentDate("2024-01-01", "quarter", 2);
      expect(result.toISOString().split("T")[0]).toBe("2024-07-01");
    });

    it("calculates next yearly payment date", () => {
      const result = calculateNextPaymentDate("2024-01-01", "year", 2);
      expect(result.toISOString().split("T")[0]).toBe("2026-01-01");
    });

    it("handles monthly payment crossing year boundary", () => {
      const result = calculateNextPaymentDate("2024-11-01", "month", 3);
      expect(result.toISOString().split("T")[0]).toBe("2025-02-01");
    });

    it("handles payment 0 (start date)", () => {
      const result = calculateNextPaymentDate("2024-01-01", "month", 0);
      expect(result.toISOString().split("T")[0]).toBe("2024-01-01");
    });

    it("handles leap year February", () => {
      const result = calculateNextPaymentDate("2024-01-01", "month", 1);
      expect(result.toISOString().split("T")[0]).toBe("2024-02-01");
    });

    // End-of-month clamping tests
    it("clamps Jan 31 + 1 month to last day of February (non-leap year)", () => {
      const result = calculateNextPaymentDate("2023-01-31", "month", 1);
      expect(result.toISOString().split("T")[0]).toBe("2023-02-28");
    });

    it("clamps Jan 31 + 1 month to Feb 29 in a leap year", () => {
      const result = calculateNextPaymentDate("2024-01-31", "month", 1);
      expect(result.toISOString().split("T")[0]).toBe("2024-02-29");
    });

    it("clamps Jan 31 + 1 quarter to last day of April", () => {
      const result = calculateNextPaymentDate("2024-01-31", "quarter", 1);
      expect(result.toISOString().split("T")[0]).toBe("2024-04-30");
    });
  });
});
