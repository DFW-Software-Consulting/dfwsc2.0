import { beforeEach, describe, expect, it } from 'vitest';
import { clearTransporterCache, sendMail } from '../lib/mailer';

type MailhogMessage = {
  Content?: {
    Headers?: {
      To?: string[];
      Subject?: string[];
    };
  };
};

type MailhogResponse = {
  items?: MailhogMessage[];
};

async function fetchMessages(): Promise<MailhogMessage[]> {
  const response = await fetch('http://mailhog:8025/api/v2/messages');
  if (!response.ok) {
    throw new Error(`MailHog API returned ${response.status}`);
  }

  const data = (await response.json()) as MailhogResponse;
  return data.items ?? [];
}

async function findMessage(to: string, subject: string): Promise<MailhogMessage | null> {
  const maxAttempts = 10;
  const delayMs = 300;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const items = await fetchMessages();
    const match = items.find(item => {
      const headers = item.Content?.Headers;
      return headers?.To?.includes(to) && headers?.Subject?.includes(subject);
    });

    if (match) {
      return match;
    }

    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  return null;
}

beforeEach(async () => {
  process.env.SMTP_HOST = 'mailhog';
  process.env.SMTP_PORT = '1025';
  process.env.SMTP_USER = 'test';
  process.env.SMTP_PASS = 'test';
  process.env.SMTP_FROM = 'no-reply@dfwsc.test';

  clearTransporterCache();

  try {
    await fetch('http://mailhog:8025/api/v1/messages', { method: 'DELETE' });
  } catch (error) {
    console.warn('Failed to clear MailHog messages before SMTP test execution.', error);
  }
});

describe('SMTP (MailHog)', () => {
  it('delivers an email via SMTP transport', async () => {
    const recipient = 'smtp-test@example.com';
    const subject = 'SMTP Smoke Test';

    await sendMail({
      to: recipient,
      subject,
      text: 'Hello from SMTP integration test.',
    });

    const message = await findMessage(recipient, subject);
    expect(message).toBeTruthy();
  });
});
