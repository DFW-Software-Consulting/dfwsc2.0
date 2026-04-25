import type { FastifyReply } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as stripeModule from "../../lib/stripe";
import {
  calculateDaysUntilDue,
  DATE_FORMAT_REGEX,
  DEFAULT_DAYS_UNTIL_DUE,
  DEFAULT_INVOICE_DUE_DAYS,
  STRIPE_LIST_LIMIT,
  validateAmountCents,
  validateDateFormat,
  validateDateRange,
  validateInterval,
  validateLimit,
  validateRequiredString,
  validateTaxRate,
  validateWorkspace,
  validateWorkspaceQuery,
} from "../../lib/validation";

vi.mock("../../lib/stripe", () => ({
  stripe: {
    taxRates: {
      retrieve: vi.fn(),
    },
  },
}));

const mockReply = () => {
  const res = {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  return res as unknown as FastifyReply;
};

describe("validation constants", () => {
  it("should export correct constants", () => {
    expect(STRIPE_LIST_LIMIT).toBe(100);
    expect(DEFAULT_DAYS_UNTIL_DUE).toBe(30);
    expect(DEFAULT_INVOICE_DUE_DAYS).toBe(30);
    expect(DATE_FORMAT_REGEX.source).toBe("^\\d{4}-\\d{2}-\\d{2}$");
  });
});

describe("validateWorkspace", () => {
  it("should return workspace for valid dfwsc_services", () => {
    const res = mockReply();
    const result = validateWorkspace("dfwsc_services", res);
    expect(result).toBe("dfwsc_services");
    expect(res.status).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });

  it("should return workspace for valid client_portal", () => {
    const res = mockReply();
    const result = validateWorkspace("client_portal", res);
    expect(result).toBe("client_portal");
    expect(res.status).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });

  it("should return null and send error for invalid workspace", () => {
    const res = mockReply();
    const result = validateWorkspace("invalid", res);
    expect(result).toBeNull();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith({
      error: "workspace is required (dfwsc_services|client_portal|ledger_crm).",
    });
  });

  it("should return null for undefined workspace", () => {
    const res = mockReply();
    const result = validateWorkspace(undefined, res);
    expect(result).toBeNull();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("should return null for null workspace", () => {
    const res = mockReply();
    const result = validateWorkspace(null, res);
    expect(result).toBeNull();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("should return null for number workspace", () => {
    const res = mockReply();
    const result = validateWorkspace(123, res);
    expect(result).toBeNull();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe("validateWorkspaceQuery", () => {
  it("should return workspace for valid query", () => {
    const res = mockReply();
    const result = validateWorkspaceQuery("dfwsc_services", res);
    expect(result).toBe("dfwsc_services");
    expect(res.status).not.toHaveBeenCalled();
  });

  it("should return workspace for client_portal", () => {
    const res = mockReply();
    const result = validateWorkspaceQuery("client_portal", res);
    expect(result).toBe("client_portal");
    expect(res.status).not.toHaveBeenCalled();
  });

  it("should return null and send error for invalid query", () => {
    const res = mockReply();
    const result = validateWorkspaceQuery("invalid", res);
    expect(result).toBeNull();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith({
      error: "workspace query parameter is required (dfwsc_services|client_portal|ledger_crm).",
    });
  });

  it("should return null for undefined query", () => {
    const res = mockReply();
    const result = validateWorkspaceQuery(undefined, res);
    expect(result).toBeNull();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe("validateDateFormat", () => {
  it("should return Date for valid format", () => {
    const res = mockReply();
    const result = validateDateFormat("2024-01-15", "startDate", res);
    expect(result).toBeInstanceOf(Date);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("should return null for invalid format (not YYYY-MM-DD)", () => {
    const res = mockReply();
    const result = validateDateFormat("2024/01/15", "startDate", res);
    expect(result).toBeNull();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith({
      error: "startDate must be in YYYY-MM-DD format.",
    });
  });

  it("should return null for invalid format (wrong order)", () => {
    const res = mockReply();
    const result = validateDateFormat("01-15-2024", "endDate", res);
    expect(result).toBeNull();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith({
      error: "endDate must be in YYYY-MM-DD format.",
    });
  });

  it("should return null for invalid date string", () => {
    const res = mockReply();
    const result = validateDateFormat("2024-13-45", "startDate", res);
    expect(result).toBeNull();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith({
      error: "startDate is invalid.",
    });
  });

  it("should return null for empty string", () => {
    const res = mockReply();
    const result = validateDateFormat("", "startDate", res);
    expect(result).toBeNull();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("should return Date for leap year date", () => {
    const res = mockReply();
    const result = validateDateFormat("2024-02-29", "startDate", res);
    expect(result).toBeInstanceOf(Date);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("should accept dates that JavaScript auto-corrects (Feb 29 non-leap year becomes Mar 1)", () => {
    const res = mockReply();
    const result = validateDateFormat("2023-02-29", "startDate", res);
    expect(result).toBeInstanceOf(Date);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe("validateDateRange", () => {
  it("should return true for valid date range", () => {
    const res = mockReply();
    const startDate = new Date("2024-01-01");
    const endDate = new Date("2024-01-31");
    const result = validateDateRange(startDate, endDate, res);
    expect(result).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("should return false when endDate equals startDate", () => {
    const res = mockReply();
    const date = new Date("2024-01-15");
    const result = validateDateRange(date, date, res);
    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith({
      error: "endDate must be after startDate.",
    });
  });

  it("should return false when endDate is before startDate", () => {
    const res = mockReply();
    const startDate = new Date("2024-12-31");
    const endDate = new Date("2024-01-01");
    const result = validateDateRange(startDate, endDate, res);
    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("should work with millisecond difference", () => {
    const res = mockReply();
    const startDate = new Date("2024-01-01T00:00:00.000Z");
    const endDate = new Date("2024-01-01T00:00:00.001Z");
    const result = validateDateRange(startDate, endDate, res);
    expect(result).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe("validateTaxRate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return true for valid tax rate", async () => {
    const res = mockReply();
    vi.mocked(stripeModule.stripe.taxRates.retrieve).mockResolvedValue({} as never);
    const result = await validateTaxRate("txr_123", res);
    expect(result).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("should return false and send error for invalid tax rate", async () => {
    const res = mockReply();
    vi.mocked(stripeModule.stripe.taxRates.retrieve).mockRejectedValue(new Error("Not found"));
    const result = await validateTaxRate("txr_invalid", res);
    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith({
      error: "Invalid taxRateId.",
    });
  });

  it("should return false on Stripe API error", async () => {
    const res = mockReply();
    vi.mocked(stripeModule.stripe.taxRates.retrieve).mockRejectedValue(new Error("API error"));
    const result = await validateTaxRate("txr_123", res);
    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe("validateLimit", () => {
  it("should return null when limit is undefined", () => {
    const res = mockReply();
    const result = validateLimit(undefined, res);
    expect(result).toBeNull();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("should return parsed limit for valid number", () => {
    const res = mockReply();
    const result = validateLimit("50", res);
    expect(result).toBe(50);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("should return 1 for minimum value", () => {
    const res = mockReply();
    const result = validateLimit("1", res);
    expect(result).toBe(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("should return 100 for maximum value", () => {
    const res = mockReply();
    const result = validateLimit("100", res);
    expect(result).toBe(100);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("should return null for zero", () => {
    const res = mockReply();
    const result = validateLimit("0", res);
    expect(result).toBeNull();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith({
      error: "limit must be an integer between 1 and 100.",
    });
  });

  it("should return null for negative number", () => {
    const res = mockReply();
    const result = validateLimit("-5", res);
    expect(result).toBeNull();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("should return null for value above 100", () => {
    const res = mockReply();
    const result = validateLimit("101", res);
    expect(result).toBeNull();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("should return null for non-integer", () => {
    const res = mockReply();
    const result = validateLimit("5.5", res);
    expect(result).toBeNull();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("should return null for NaN string", () => {
    const res = mockReply();
    const result = validateLimit("abc", res);
    expect(result).toBeNull();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("should return null for null value", () => {
    const res = mockReply();
    const result = validateLimit(null, res);
    expect(result).toBeNull();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("should return correct number for numeric input", () => {
    const res = mockReply();
    const result = validateLimit(50, res);
    expect(result).toBe(50);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe("validateAmountCents", () => {
  it("should return true for valid positive integer", () => {
    const res = mockReply();
    const result = validateAmountCents(100, res);
    expect(result).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("should return true for large amount", () => {
    const res = mockReply();
    const result = validateAmountCents(1000000, res);
    expect(result).toBe(true);
  });

  it("should return false for zero", () => {
    const res = mockReply();
    const result = validateAmountCents(0, res);
    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith({
      error: "amountCents must be a positive integer.",
    });
  });

  it("should return false for negative number", () => {
    const res = mockReply();
    const result = validateAmountCents(-100, res);
    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("should return false for non-integer", () => {
    const res = mockReply();
    const result = validateAmountCents(100.5, res);
    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("should return false for string", () => {
    const res = mockReply();
    const result = validateAmountCents("100", res);
    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("should return false for undefined", () => {
    const res = mockReply();
    const result = validateAmountCents(undefined, res);
    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("should return false for null", () => {
    const res = mockReply();
    const result = validateAmountCents(null, res);
    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe("validateRequiredString", () => {
  it("should return true for valid string", () => {
    const res = mockReply();
    const result = validateRequiredString("test", "name", res);
    expect(result).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("should return true for string with whitespace", () => {
    const res = mockReply();
    const result = validateRequiredString("  test  ", "name", res);
    expect(result).toBe(true);
  });

  it("should return false for empty string", () => {
    const res = mockReply();
    const result = validateRequiredString("", "name", res);
    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith({
      error: "name is required.",
    });
  });

  it("should return false for whitespace-only string", () => {
    const res = mockReply();
    const result = validateRequiredString("   ", "name", res);
    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("should return false for undefined", () => {
    const res = mockReply();
    const result = validateRequiredString(undefined, "name", res);
    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("should return false for null", () => {
    const res = mockReply();
    const result = validateRequiredString(null, "name", res);
    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("should return false for number", () => {
    const res = mockReply();
    const result = validateRequiredString(123, "name", res);
    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("should return false for empty object", () => {
    const res = mockReply();
    const result = validateRequiredString({}, "name", res);
    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe("validateInterval", () => {
  const allowedIntervals = ["day", "week", "month", "year"] as const;

  it("should return true for valid interval (day)", () => {
    const res = mockReply();
    const result = validateInterval("day", allowedIntervals, res);
    expect(result).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("should return true for valid interval (week)", () => {
    const res = mockReply();
    const result = validateInterval("week", allowedIntervals, res);
    expect(result).toBe(true);
  });

  it("should return true for valid interval (month)", () => {
    const res = mockReply();
    const result = validateInterval("month", allowedIntervals, res);
    expect(result).toBe(true);
  });

  it("should return true for valid interval (year)", () => {
    const res = mockReply();
    const result = validateInterval("year", allowedIntervals, res);
    expect(result).toBe(true);
  });

  it("should return false for invalid interval", () => {
    const res = mockReply();
    const result = validateInterval("hourly", allowedIntervals, res);
    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith({
      error: "interval must be one of: day, week, month, year.",
    });
  });

  it("should return false for undefined", () => {
    const res = mockReply();
    const result = validateInterval(undefined, allowedIntervals, res);
    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("should return false for null", () => {
    const res = mockReply();
    const result = validateInterval(null, allowedIntervals, res);
    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("should return false for number", () => {
    const res = mockReply();
    const result = validateInterval(123, allowedIntervals, res);
    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("should work with different allowed intervals", () => {
    const res = mockReply();
    const customIntervals = ["daily", "weekly"] as const;
    const result = validateInterval("daily", customIntervals, res);
    expect(result).toBe(true);
  });

  it("should format error message correctly", () => {
    const res = mockReply();
    const customIntervals = ["a", "b", "c"] as const;
    validateInterval("d", customIntervals, res);
    expect(res.send).toHaveBeenCalledWith({
      error: "interval must be one of: a, b, c.",
    });
  });
});

describe("calculateDaysUntilDue", () => {
  it("should return default days when dueDate is null", () => {
    const result = calculateDaysUntilDue(null);
    expect(result).toBe(DEFAULT_DAYS_UNTIL_DUE);
  });

  it("should return default days when dueDate is undefined", () => {
    const result = calculateDaysUntilDue(undefined);
    expect(result).toBe(DEFAULT_DAYS_UNTIL_DUE);
  });

  it("should return default days when dueDate is empty string", () => {
    const result = calculateDaysUntilDue("");
    expect(result).toBe(DEFAULT_DAYS_UNTIL_DUE);
  });

  it("should return calculated days for future date", () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 10);
    const result = calculateDaysUntilDue(futureDate.toISOString().split("T")[0]);
    expect(result).toBeGreaterThanOrEqual(10);
  });

  it("should return minimum 1 day for past date", () => {
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 5);
    const result = calculateDaysUntilDue(pastDate.toISOString().split("T")[0]);
    expect(result).toBe(1);
  });

  it("should return minimum 1 day for today", () => {
    const today = new Date().toISOString().split("T")[0];
    const result = calculateDaysUntilDue(today);
    expect(result).toBe(1);
  });

  it("should use custom default days", () => {
    const result = calculateDaysUntilDue(null, 60);
    expect(result).toBe(60);
  });

  it("should calculate days correctly for 30 days from now", () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 30);
    const result = calculateDaysUntilDue(futureDate.toISOString().split("T")[0]);
    expect(result).toBeGreaterThanOrEqual(29);
    expect(result).toBeLessThanOrEqual(31);
  });
});

describe("DATE_FORMAT_REGEX", () => {
  it("should match valid YYYY-MM-DD format", () => {
    expect(DATE_FORMAT_REGEX.test("2024-01-15")).toBe(true);
    expect(DATE_FORMAT_REGEX.test("2024-12-31")).toBe(true);
    expect(DATE_FORMAT_REGEX.test("2000-01-01")).toBe(true);
  });

  it("should not match invalid formats", () => {
    expect(DATE_FORMAT_REGEX.test("2024/01/15")).toBe(false);
    expect(DATE_FORMAT_REGEX.test("01-15-2024")).toBe(false);
    expect(DATE_FORMAT_REGEX.test("2024-1-15")).toBe(false);
    expect(DATE_FORMAT_REGEX.test("2024-01-1")).toBe(false);
    expect(DATE_FORMAT_REGEX.test("24-01-15")).toBe(false);
    expect(DATE_FORMAT_REGEX.test("")).toBe(false);
    expect(DATE_FORMAT_REGEX.test("2024")).toBe(false);
    expect(DATE_FORMAT_REGEX.test("January 15, 2024")).toBe(false);
  });
});
