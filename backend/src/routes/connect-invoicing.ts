import type { FastifyInstance } from "fastify";
import { registerCustomerRoutes } from "./connect-invoicing/customers";
import { registerInvoiceCreateRoutes } from "./connect-invoicing/invoice-create";
import { registerInvoiceLifecycleRoutes } from "./connect-invoicing/invoice-lifecycle";
import { registerInvoiceReadRoutes } from "./connect-invoicing/invoice-reads";
import { registerInvoiceSendRoutes } from "./connect-invoicing/invoice-send";
import { createInvoicingDeps } from "./connect-invoicing/shared";

// Connected-account invoicing: customers, and draft invoices with their reads and lifecycle. Every
// Stripe call is a DIRECT call on the client's own Express account (see connect-invoicing/shared).
//
// One plugin, one encapsulation scope: the hook below and every route live on the same instance.
// The rate limiters and the claim-release map are built once here and shared by every module.
export default async function connectInvoicingRoutes(fastify: FastifyInstance) {
  const deps = createInvoicingDeps();

  // A create that gives its claim back must do so BEFORE the response leaves, or a caller that
  // retries the moment it sees the error would find the row still claimed (IN_USE). Errors are
  // sent from inside the handler, so the release is also run from onSend.
  fastify.addHook("onSend", async (request) => {
    const release = deps.pendingRelease.get(request);
    if (release) {
      deps.pendingRelease.delete(request);
      await release();
    }
  });

  registerCustomerRoutes(fastify, deps);
  registerInvoiceCreateRoutes(fastify, deps);
  registerInvoiceReadRoutes(fastify, deps);
  registerInvoiceLifecycleRoutes(fastify, deps);
  registerInvoiceSendRoutes(fastify, deps);
}
