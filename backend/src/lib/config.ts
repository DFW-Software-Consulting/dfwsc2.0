import { AppError } from "./errors";

export function resolveFrontendOrigin(): string {
  const origin = process.env.FRONTEND_ORIGIN?.split(",")[0].trim().replace(/\/$/, "");
  if (!origin) {
    throw new AppError("FRONTEND_ORIGIN is not configured", 500, "CONFIGURATION_ERROR");
  }
  return origin;
}
