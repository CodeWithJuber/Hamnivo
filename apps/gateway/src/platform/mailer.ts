import nodemailer, { type Transporter } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Stable identifier of the template, e.g. `auth.verify-email`. */
  template: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Sends through any SMTP server (Mailpit in development, your provider in production). */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;
  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(url);
  }
  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      headers: { 'X-Hamnivo-Template': message.template },
    });
  }
}

/** Development fallback without SMTP: writes the message to the log so links can be followed. */
export class LogMailer implements Mailer {
  constructor(private readonly log: (line: string) => void) {}
  async send(message: MailMessage): Promise<void> {
    this.log(
      `[mail] to=${message.to} template=${message.template}\n${message.subject}\n${message.text}`,
    );
  }
}

/** Test double that keeps messages in memory. */
export class MemoryMailer implements Mailer {
  readonly messages: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> {
    this.messages.push(message);
  }
  last(to: string, template?: string): MailMessage | undefined {
    return this.messages.findLast((m) => m.to === to && (!template || m.template === template));
  }
}
