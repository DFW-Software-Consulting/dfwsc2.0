import he from "he";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAdminToken } from "./helpers/auth";
import { setTestEnv } from "./helpers/env";
import { createAppDbMock, createStripeMock } from "./helpers/mock-factories";
import { seedClient as _seedClient } from "./helpers/seed";

vi.mock("bcryptjs", () => ({
  default: {
    hash: async (plaintext: string) => `hashed:${plaintext}`,
    compare: async (plaintext: string, hashed: string) => hashed === `hashed:${plaintext}`,
  },
}));

vi.mock("drizzle-orm", () => ({
  asc: (field: unknown) => ({ asc: true, field }),
  desc: (field: unknown) => ({ desc: true, field }),
  count: () => ({ fn: "count" }),
  eq: (field: unknown, value: unknown) => ({ value, field }),
  ne: (field: unknown, value: unknown) => ({ not: true, value, field }),
  inArray: (field: unknown, values: unknown[]) => ({ inArray: true, field, values }),
  and: (...conditions: any[]) => ({ all: conditions }),
  isNull: (field: unknown) => ({ isNull: true, field }),
  or: (...conditions: any[]) => ({ or: conditions }),
  lt: (field: unknown, value: unknown) => ({ lt: true, field, value }),
}));

const dataStore = {
  clients: new Map<string, any>(),
  clientsByApiKey: new Map<string, string>(),
  onboardingTokens: new Map<string, any>(),
  webhookEvents: new Map<string, any>(),
  clientGroups: new Map<string, any>(),
  paymentLedger: new Map<string, any>(),
  apiKeyRegenerationTokens: new Map<string, any>(),
};

vi.mock("../db/client", () => ({
  db: createAppDbMock(dataStore),
  __dataStore: dataStore,
}));

const stripeMock = createStripeMock();
const settingsState = { companyName: "" };
const sendMailMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../lib/stripe", () => ({ stripe: stripeMock }));

vi.mock("../lib/stripe-billing", () => ({
  stripe: stripeMock,
  getSettings: vi.fn(async () => ({
    default_fee_cents: "0",
    company_name: settingsState.companyName,
  })),
}));

vi.mock("../lib/mailer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/mailer")>()),
  sendMail: (...args: unknown[]) => sendMailMock(...args),
}));

const FRONTEND = "https://portal.example.test";

async function createServer() {
  vi.resetModules();
  const { buildServer } = await import("../app");
  return buildServer();
}

function sentMail() {
  expect(sendMailMock).toHaveBeenCalledTimes(1);
  return sendMailMock.mock.calls[0][0] as {
    to: string;
    subject: string;
    html: string;
    text: string;
  };
}

const htmlEncode = (value: string) => he.encode(value);

beforeEach(() => {
  setTestEnv();
  process.env.FRONTEND_ORIGIN = FRONTEND;
  settingsState.companyName = "";
  for (const store of Object.values(dataStore)) store.clear();
  vi.clearAllMocks();
  sendMailMock.mockResolvedValue(undefined);
  stripeMock.accounts.create.mockImplementation(async (params: any) => ({
    id: `acct_${params.metadata.clientId.replace(/-/g, "").slice(0, 20)}`,
    charges_enabled: false,
    payouts_enabled: false,
    details_submitted: false,
  }));
});

afterEach(() => {
  delete process.env.FRONTEND_ORIGIN;
});

// Golden output of the two onboarding emails. The special-character variant checks that html is
// entity-encoded while text stays raw.
const VARIANTS = [
  { company: "", name: "Client", label: "defaults" },
  { company: 'Acme & <Sons> "Co"', name: "Jo <b>&\"'", label: "special characters" },
];

describe("onboarding email output", () => {
  for (const { company, name, label } of VARIANTS) {
    const companyName = company || "DFW Software Consulting";

    it(`initiate sends the exact welcome email (${label})`, async () => {
      settingsState.companyName = company;
      const server = await createServer();
      const response = await server.inject({
        method: "POST",
        url: "/api/v1/onboard-client/initiate",
        headers: { authorization: `Bearer ${makeAdminToken()}` },
        payload: { name, email: "welcome@example.com", workspace: "client_portal" },
      });
      expect(response.statusCode).toBe(201);
      const mail = sentMail();
      const onboardingUrl = mail.text.match(/(\S+\/onboard#token=\S+)/)?.[1] ?? "";
      const regenerateUrl = mail.text.match(/(\S+\/regenerate-key#token=\S+)/)?.[1] ?? "";
      expect(onboardingUrl.startsWith(`${FRONTEND}/onboard#token=`)).toBe(true);
      expect(regenerateUrl.startsWith(`${FRONTEND}/regenerate-key#token=`)).toBe(true);
      expect(Object.keys(mail).sort()).toEqual(["html", "subject", "text", "to"]);
      expect(mail.to).toBe("welcome@example.com");
      expect(mail.subject).toBe(`${companyName} - Stripe Onboarding`);
      expect(mail.html).toBe(`
        <h1>Welcome to ${htmlEncode(companyName)}</h1>
        <p>Hi ${htmlEncode(name)},</p>
        <p>Click the link below to start your Stripe onboarding process.</p>
        <a href="${onboardingUrl}">Onboard Now</a>
        <p>You will also need an API key to integrate with our services. Use the link below to retrieve it. This link expires in 15 minutes.</p>
        <a href="${regenerateUrl}">Retrieve Your API Key</a>
        <p>If you did not request this, please ignore this email.</p>
      `);
      expect(mail.text).toBe(`
        Welcome to ${companyName}
        Hi ${name},
        Click the link below to start your Stripe onboarding process.
        ${onboardingUrl}
        You will also need an API key to integrate with our services. Use the link below to retrieve it. This link expires in 15 minutes.
        ${regenerateUrl}
        If you did not request this, please ignore this email.
      `);
      await server.close();
    });

    it(`resend sends the exact refresh email (${label})`, async () => {
      settingsState.companyName = company;
      _seedClient(dataStore, { id: "client-resend", name, email: "resend@example.com" });
      const server = await createServer();
      const response = await server.inject({
        method: "POST",
        url: "/api/v1/onboard-client/resend",
        headers: { authorization: `Bearer ${makeAdminToken()}` },
        payload: { clientId: "client-resend" },
      });
      expect(response.statusCode).toBe(200);
      const mail = sentMail();
      const onboardingUrl = mail.text.match(/(\S+\/onboard#token=\S+)/)?.[1] ?? "";
      expect(onboardingUrl.startsWith(`${FRONTEND}/onboard#token=`)).toBe(true);
      expect(Object.keys(mail).sort()).toEqual(["html", "subject", "text", "to"]);
      expect(mail.to).toBe("resend@example.com");
      expect(mail.subject).toBe(`${companyName} - New Onboarding Link`);
      expect(mail.html).toBe(`
        <h1>Stripe Onboarding Link Refreshed</h1>
        <p>Hi ${htmlEncode(name)},</p>
        <p>Your previous onboarding link has expired or been invalidated.</p>
        <p>Click the new link below to continue with your Stripe onboarding process.</p>
        <a href="${onboardingUrl}">Continue Onboarding</a>
        <p>If you did not request this, please contact us.</p>
        <p><strong>Note:</strong> This link will expire in 24 hours.</p>
      `);
      expect(mail.text).toBe(`
        Stripe Onboarding Link Refreshed
        Hi ${name},
        Your previous onboarding link has expired or been invalidated.
        Click the new link below to continue with your Stripe onboarding process.
        ${onboardingUrl}
        If you did not request this, please contact us.
        Note: This link will expire in 24 hours.
      `);
      await server.close();
    });
  }
});
