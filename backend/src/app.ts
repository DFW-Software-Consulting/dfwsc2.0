import crypto from "node:crypto";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastify from "fastify";
import fastifyRawBody from "fastify-raw-body";
import { logMaskedEnvSummary, validateEnv } from "./lib/env";
import { AppError } from "./lib/errors";
import { warnIfInMemoryRateLimit } from "./lib/rate-limit";
import authRoutes from "./routes/auth";
import clientRoutes from "./routes/clients";
import configRoutes from "./routes/config";
import connectRoutes from "./routes/connect";
import groupRoutes from "./routes/groups";
import healthRoutes from "./routes/health";
import metricsRoutes from "./routes/metrics";
import paymentsRoutes from "./routes/payments";
import productRoutes from "./routes/products";
import settingsRoutes from "./routes/settings";
import webhooksRoute from "./routes/webhooks";

// Resolve trustProxy from TRUST_PROXY env. Fastify 5.12 no longer supports
// numeric hop counts (a hop count can't validate the immediate peer, so it fails
// closed and trusts nothing). Instead we trust proxies by address: unset/blank
// uses the default private-network list, so request.ip is the real client when
// the API sits behind the Docker reverse proxy, while a client connecting
// directly from a public address can't spoof X-Forwarded-For. Accepts
// 'true'/'false' (boolean) or a comma-separated list of IPs/CIDRs/named ranges
// (Fastify throws at startup on an invalid entry). A bare integer is the legacy
// hop-count form: it falls back to the default list and is flagged so
// buildServer() can warn.
export const DEFAULT_TRUSTED_PROXIES = "loopback,linklocal,uniquelocal";

function parseTrustProxy(): { value: boolean | string; legacyHopCount: boolean } {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw.trim() === "") {
    return { value: DEFAULT_TRUSTED_PROXIES, legacyHopCount: false };
  }
  const trimmed = raw.trim();
  if (trimmed === "true") {
    return { value: true, legacyHopCount: false };
  }
  if (trimmed === "false") {
    return { value: false, legacyHopCount: false };
  }
  if (/^\d+$/.test(trimmed)) {
    return { value: DEFAULT_TRUSTED_PROXIES, legacyHopCount: true };
  }
  return { value: trimmed, legacyHopCount: false };
}

export function resolveTrustProxy(): boolean | string {
  return parseTrustProxy().value;
}

// Reuse an inbound X-Request-Id for tracing so a request's logs correlate
// end-to-end across the proxy and the app in Loki/Promtail-aggregated output,
// instead of always minting a fresh id server-side. Bounded to a safe charset
// and length so a client can't inject arbitrary values into log lines.
const REQUEST_ID_HEADER_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
function resolveRequestId(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return value && REQUEST_ID_HEADER_PATTERN.test(value) ? value : crypto.randomUUID();
}

export async function buildServer() {
  const logger = process.env.NODE_ENV === "test" ? { level: "silent" } : true;
  const trustProxy = parseTrustProxy();
  const server = fastify({
    logger,
    // Trust private-network reverse proxies so request.ip reflects the real
    // client, not the proxy. Configurable via TRUST_PROXY (defaults to
    // loopback,linklocal,uniquelocal).
    trustProxy: trustProxy.value,
    // Generate unique request IDs for tracing, reusing an inbound X-Request-Id
    // (e.g. set by the reverse proxy) when present so logs correlate end-to-end.
    genReqId: (req) => resolveRequestId(req.headers["x-request-id"]),
    ajv: {
      customOptions: {
        allErrors: true,
      },
    },
    schemaErrorFormatter: (errors, _dataVar) => {
      const required = errors.filter((e) => e.keyword === "required");
      if (required.length > 0) {
        const missing = Array.from(
          new Set(
            required
              .map((e) => (e.params as { missingProperty?: string }).missingProperty)
              .filter(Boolean)
          )
        );
        if (missing.length > 1) {
          return new Error(`${missing.join(", ")} are required.`);
        }
        const [firstMissing] = missing;
        return new Error(`${firstMissing} is required.`);
      }
      const messages = errors.map((e) => e.message).filter(Boolean);
      return new Error(messages.join(", "));
    },
  });
  if (trustProxy.legacyHopCount) {
    server.log.warn(
      `TRUST_PROXY=${process.env.TRUST_PROXY?.trim()} is a numeric hop count, which Fastify no longer supports; using the default private-network list (${DEFAULT_TRUSTED_PROXIES}) instead. Set TRUST_PROXY to a comma-separated IP/CIDR list.`
    );
  }
  const env = validateEnv();
  logMaskedEnvSummary(server, env);
  warnIfInMemoryRateLimit(server.log);

  const frontendOrigin = env.FRONTEND_ORIGIN ?? "";

  const allowedOrigins = frontendOrigin
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  server.register(fastifyCors, {
    origin: allowedOrigins.length > 0 ? allowedOrigins : false,
    credentials: true,
  });

  // Security headers (HSTS, X-Content-Type-Options, frame protections, referrer
  // policy, etc.) at the API layer. CSP is left to the frontend (front/nginx.conf)
  // since this is a JSON API, not an HTML document — CSP mainly governs document
  // capabilities (script/style sources, framing of *this* document), and a
  // restrictive default CSP here risks breaking the Swagger UI served at /docs.
  server.register(fastifyHelmet, {
    contentSecurityPolicy: false,
  });

  server.register(fastifyRawBody, {
    field: "rawBody",
    global: false,
    encoding: "utf8",
    runFirst: true,
  });

  // Add request ID to response headers for debugging and tracing
  server.addHook("onSend", async (request, reply) => {
    reply.header("X-Request-Id", request.id);
  });

  server.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: error.message,
        code: error.code,
        requestId: request.id,
      });
    }

    const fastifyError = error as Error & { statusCode?: number; validation?: unknown };
    const statusCode = fastifyError.statusCode ?? (fastifyError.validation ? 400 : 500);

    if (fastifyError.validation) {
      reply.status(statusCode).send({ error: fastifyError.message, requestId: request.id });
      return;
    }

    request.log.error(fastifyError, fastifyError.message);

    const safeMessage =
      statusCode < 500 && fastifyError.message ? fastifyError.message : "Internal Server Error";

    reply.status(statusCode).send({ error: safeMessage, requestId: request.id });
  });

  /**
   * 🚀 Optional Swagger Setup
   * ------------------------------------------------------------
   * This section conditionally enables Fastify Swagger + Swagger UI.
   *
   * By default, Swagger is *enabled* for local/dev environments.
   * For production, you can disable it by setting:
   *
   *    ENABLE_SWAGGER=false
   *
   * inside your `.env.prod` file.
   *
   * When disabled, Swagger modules aren't loaded at all — this keeps
   * the production image lighter and avoids module-not-found errors
   * (since dev-only dependencies like @fastify/swagger aren't installed
   * in production builds).
   *
   * Example ENV config:
   * ------------------------------------------------------------
   * ENABLE_SWAGGER=true   # for local dev
   * ENABLE_SWAGGER=false  # for prod builds
   * ------------------------------------------------------------
   */

  if (process.env.ENABLE_SWAGGER === "true") {
    const { default: fastifySwagger } = await import("@fastify/swagger");
    const { default: fastifySwaggerUi } = await import("@fastify/swagger-ui");
    await server.register(fastifySwagger, {
      openapi: { info: { title: "Stripe Portal API", version: "1.0.0" } },
    });
    await server.register(fastifySwaggerUi, { routePrefix: "/docs" });
    server.log.info("✅ Swagger UI available at /docs");
  } else {
    server.log.info("🚫 Swagger disabled");
  }

  server.register(configRoutes);
  server.register(healthRoutes, { prefix: "/api/v1" });
  server.register(authRoutes, { prefix: "/api/v1" });
  server.register(connectRoutes, { prefix: "/api/v1" });
  server.register(paymentsRoutes, { prefix: "/api/v1" });
  server.register(webhooksRoute, { prefix: "/api/v1" });
  server.register(clientRoutes, { prefix: "/api/v1" });
  server.register(groupRoutes, { prefix: "/api/v1" });
  server.register(productRoutes, { prefix: "/api/v1" });
  server.register(settingsRoutes, { prefix: "/api/v1" });
  server.register(metricsRoutes, { prefix: "/api/v1" });

  server.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: "Not Found" });
  });

  return server;
}
