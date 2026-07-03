import type { FastifyRequest } from "fastify";
import { AppError } from "./errors";

export function resolveFrontendOrigin(): string {
  const origin = process.env.FRONTEND_ORIGIN?.split(",")[0].trim().replace(/\/$/, "");
  if (!origin) {
    throw new AppError("FRONTEND_ORIGIN is not configured", 500, "CONFIGURATION_ERROR");
  }
  return origin;
}

/**
 * Resolves the server's own base URL for building callback/refresh links.
 *
 * `API_BASE_URL` is always preferred. In production, an unset `API_BASE_URL`
 * is a hard configuration error rather than falling back to
 * request-supplied `X-Forwarded-Host`/`Host` headers, which are untrusted
 * and can be spoofed by a client to redirect Stripe onboarding links
 * elsewhere. The header-derived fallback is only permitted outside
 * production (local/dev convenience).
 */
export function resolveServerBaseUrl(request: FastifyRequest): string {
  if (process.env.API_BASE_URL) {
    return process.env.API_BASE_URL.replace(/\/$/, "");
  }

  if (process.env.NODE_ENV === "production") {
    throw new AppError("API_BASE_URL is not configured", 500, "CONFIGURATION_ERROR");
  }

  const host = request.headers["x-forwarded-host"] ?? request.headers.host;
  const protocol = (request.headers["x-forwarded-proto"] as string) ?? request.protocol;

  if (!host || !protocol) {
    throw new Error("Unable to determine server base URL for onboarding.");
  }

  return `${protocol}://${host}`.replace(/\/$/, "");
}
