const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const validateEmail = (v) => {
  if (!v || !v.trim()) return "Email is required";
  if (!EMAIL_REGEX.test(v.trim())) return "Please enter a valid email address";
  return null;
};

export const validatePassword = (v, minLen = 8) => {
  if (!v) return "Password is required";
  if (v.length < minLen) return `Password must be at least ${minLen} characters`;
  return null;
};

export const validateUrl = (v) => {
  if (!v || !v.trim()) return null;
  if (!v.trim().startsWith("https://")) return "URL must start with https://";
  return null;
};

export const validateFeeValue = (v, type) => {
  if (type === "percent") {
    const n = parseFloat(v);
    if (Number.isNaN(n) || n <= 0 || n > 100)
      return "Fee percent must be greater than 0 and at most 100.";
  } else if (type === "cents") {
    const n = parseInt(v, 10);
    if (Number.isNaN(n) || n < 0 || !Number.isInteger(n))
      return "Fee must be a non-negative whole number of cents.";
  }
  return null;
};

export const validateName = (v, min = 1, max = 100, fieldName = "Name") => {
  if (!v || !v.trim()) return `${fieldName} is required`;
  const len = v.trim().length;
  if (len < min || len > max) return `${fieldName} must be between ${min} and ${max} characters`;
  return null;
};
