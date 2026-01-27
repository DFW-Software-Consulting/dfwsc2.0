declare module 'nodemailer' {
  export interface MailOptions {
    from?: string;
    to: string;
    subject: string;
    text?: string;
    html?: string;
  }

  export interface TransportOptions {
    host: string;
    port: number;
    secure?: boolean;
    auth?: {
      user: string;
      pass: string;
    };
  }

  export interface Transporter {
    sendMail(mail: MailOptions): Promise<unknown>;
  }

  const nodemailer: {
    createTransport(options: TransportOptions): Transporter;
  };

  export default nodemailer;
}
