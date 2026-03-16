import jwt from "jsonwebtoken";
import { TEST_JWT_SECRET } from "./constants";

export function makeAdminToken(secret = TEST_JWT_SECRET): string {
  return jwt.sign({ role: "admin" }, secret, { expiresIn: "1h" });
}
