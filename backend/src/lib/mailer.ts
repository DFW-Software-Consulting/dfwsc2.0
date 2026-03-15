import nodemailer, { type Transporter } from "nodemailer";

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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

export async function sendInvoiceEmail(opts: {
  to: string;
  clientName: string;
  amountCents: number;
  description: string;
  dueDate?: Date | null;
  payUrl: string;
  isSubscription: boolean;
  paymentsRemaining?: number | null;
}): Promise<void> {
  const dollars = (opts.amountCents / 100).toFixed(2);
  const formattedAmount = `$${dollars}`;

  let subject: string;
  if (opts.isSubscription) {
    if (opts.paymentsRemaining != null) {
      subject = `Monthly Invoice (${opts.paymentsRemaining} payments remaining): ${formattedAmount}`;
    } else {
      subject = `Monthly Hosting Invoice: ${formattedAmount}`;
    }
  } else {
    subject = `Invoice for ${formattedAmount}`;
  }

  const dueDateLine = opts.dueDate
    ? `<p style="color:#6b7280;font-size:14px;">Due: ${opts.dueDate.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</p>`
    : "";

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;background:#f9fafb;padding:32px;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px;border:1px solid #e5e7eb;">
    <h2 style="color:#111827;margin-top:0;">Invoice from DFW Software Consulting</h2>
    <p style="color:#374151;">Hi ${escapeHtml(opts.clientName)},</p>
    <p style="color:#374151;">You have a new invoice for <strong>${formattedAmount}</strong>.</p>
    <p style="color:#374151;"><strong>Description:</strong> ${escapeHtml(opts.description)}</p>
    ${dueDateLine}
    <div style="text-align:center;margin:32px 0;">
      <a href="${opts.payUrl}"
         style="background:#2563eb;color:#ffffff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;font-size:16px;">
        Pay Now
      </a>
    </div>
    <p style="color:#6b7280;font-size:12px;">If you have questions, reply to this email.</p>
  </div>
</body>
</html>`.trim();

  const text = [
    `Invoice from DFW Software Consulting`,
    ``,
    `Hi ${opts.clientName},`,
    ``,
    `You have a new invoice for ${formattedAmount}.`,
    `Description: ${opts.description}`,
    opts.dueDate ? `Due: ${opts.dueDate.toLocaleDateString()}` : "",
    ``,
    `Pay here: ${opts.payUrl}`,
  ]
    .filter((line) => line !== undefined)
    .join("\n");

  await sendMail({ to: opts.to, subject, text, html });
}
