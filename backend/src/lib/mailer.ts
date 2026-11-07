import he from "he";
import nodemailer, { type Transporter } from "nodemailer";
import { isCircuitOpenError, withSmtpCircuit } from "./circuit-breakers";
import {
  SMTP_CONNECTION_TIMEOUT_MS,
  SMTP_GREETING_TIMEOUT_MS,
  SMTP_SOCKET_TIMEOUT_MS,
} from "./constants";

type MailPayload = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

let cachedTransporter: Transporter | null = null;

export function createTransport(): Transporter {
  const host = process.env.SMTP_HOST;
  const portValue = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !portValue || !user || !pass) {
    throw new Error("SMTP configuration is incomplete.");
  }

  const port = Number(portValue);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("SMTP_PORT must be a positive integer.");
  }

  const secure = port === 465;

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user,
      pass,
    },
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
  });
}

function resolveTransporter(): Transporter {
  if (cachedTransporter) {
    return cachedTransporter;
  }

  cachedTransporter = createTransport();
  return cachedTransporter;
}

export async function sendMail(payload: MailPayload): Promise<void> {
  const transporter = resolveTransporter();
  const from =
    process.env.SMTP_FROM ??
    `${process.env.SMTP_USER ?? "noreply"}@${process.env.SMTP_HOST ?? "localhost"}`;

  try {
    await withSmtpCircuit(async () => {
      await transporter.sendMail({
        from,
        to: payload.to,
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
      });
    });
  } catch (error) {
    if (isCircuitOpenError(error)) {
      process.stderr.write("SMTP circuit breaker is open; email send skipped.\n");
    }
    throw error;
  }
}

type OnboardingEmailOptions = {
  to: string;
  companyName: string;
  clientName: string;
  onboardingUrl: string;
} & ({ kind: "welcome"; regenerateUrl: string } | { kind: "refresh"; regenerateUrl?: undefined });

/**
 * Builds the onboarding email. "welcome" is sent when a client is first created (onboarding link
 * plus API key retrieval link); "refresh" is sent when an admin resends an expired onboarding link.
 */
export function buildOnboardingEmail(opts: OnboardingEmailOptions): MailPayload {
  const { to, companyName, clientName, onboardingUrl } = opts;
  const safeName = he.encode(clientName);

  if (opts.kind === "welcome") {
    const { regenerateUrl } = opts;
    return {
      to,
      subject: `${companyName} - Stripe Onboarding`,
      html: `
        <h1>Welcome to ${he.encode(companyName)}</h1>
        <p>Hi ${safeName},</p>
        <p>Click the link below to start your Stripe onboarding process.</p>
        <a href="${onboardingUrl}">Onboard Now</a>
        <p>You will also need an API key to integrate with our services. Use the link below to retrieve it. This link expires in 15 minutes.</p>
        <a href="${regenerateUrl}">Retrieve Your API Key</a>
        <p>If you did not request this, please ignore this email.</p>
      `,
      text: `
        Welcome to ${companyName}
        Hi ${clientName},
        Click the link below to start your Stripe onboarding process.
        ${onboardingUrl}
        You will also need an API key to integrate with our services. Use the link below to retrieve it. This link expires in 15 minutes.
        ${regenerateUrl}
        If you did not request this, please ignore this email.
      `,
    };
  }

  return {
    to,
    subject: `${companyName} - New Onboarding Link`,
    html: `
        <h1>Stripe Onboarding Link Refreshed</h1>
        <p>Hi ${safeName},</p>
        <p>Your previous onboarding link has expired or been invalidated.</p>
        <p>Click the new link below to continue with your Stripe onboarding process.</p>
        <a href="${onboardingUrl}">Continue Onboarding</a>
        <p>If you did not request this, please contact us.</p>
        <p><strong>Note:</strong> This link will expire in 24 hours.</p>
      `,
    text: `
        Stripe Onboarding Link Refreshed
        Hi ${clientName},
        Your previous onboarding link has expired or been invalidated.
        Click the new link below to continue with your Stripe onboarding process.
        ${onboardingUrl}
        If you did not request this, please contact us.
        Note: This link will expire in 24 hours.
      `,
  };
}

export function clearTransporterCache() {
  cachedTransporter = null;
}
