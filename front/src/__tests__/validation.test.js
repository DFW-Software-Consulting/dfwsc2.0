import { describe, expect, it } from "vitest";
import { validateEmail, validateName, validateUrl } from "../utils/validation.js";

describe("validation with non-string falsy values", () => {
  it.each([undefined, null, 0, false, Number.NaN, ""])("treats %s as empty", (value) => {
    expect(validateEmail(value)).toBe("Email is required");
    expect(validateName(value)).toBe("Name is required");
    expect(validateUrl(value)).toBeNull();
  });
});
