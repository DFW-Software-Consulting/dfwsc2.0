import nodemailer, { Transporter } from 'nodemailer';

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
    throw new Error('SMTP configuration is incomplete.');
  }

  const port = Number(portValue);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('SMTP_PORT must be a positive integer.');
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
  const from = process.env.SMTP_FROM ?? process.env.SMTP_USER ?? '';

  await transporter.sendMail({
    from,
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
  });
}

export function clearTransporterCache() {
  cachedTransporter = null;
}
