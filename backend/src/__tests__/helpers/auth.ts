import jwt from "jsonwebtoken";
import { TEST_JWT_SECRET } from "./constants";

// `overrides` lets callers embed a `sub` (admin id) so requireAdminJwt's
// DB-backed re-validation resolves to a specific seeded admin — needed by
// tests that must prove a route scopes its effect to the authenticated
// admin's own row. Existing callers that omit it keep getting a plain
// `{ role: "admin" }` token (no `sub`), which requireAdminJwt trusts as-is
// without a DB lookup.
export function makeAdminToken(
  secret = TEST_JWT_SECRET,
  overrides: Record<string, unknown> = {}
): string {
  return jwt.sign({ role: "admin", ...overrides }, secret, { expiresIn: "1h" });
}
