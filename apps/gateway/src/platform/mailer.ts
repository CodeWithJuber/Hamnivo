import nodemailer, { type Transporter } from 'nodemailer';
import { type EmailTemplate, renderEmail } from './emails/index.js';

export interface MailMessage {
  to: string;
  subject: string;
  /** The plain-text version, always sent (and the only one some clients show). */
  text: string;
  /** The HTML version (React Email), when there is one. */
  html?: string;
  /** The display name of the sender, such as a workspace's own; the address stays MAIL_FROM's. */
  senderName?: string;
  /** Stable identifier of the template, e.g. `auth.verify-email`. */
  template: string;
  /** Extra headers, such as List-Unsubscribe for customer emails. */
  headers?: Record<string, string>;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Renders a transactional email and sends it with its HTML and plain-text versions. */
export async function sendTemplate(
  mailer: Mailer,
  message: { to: string; template: string; senderName?: string },
  email: EmailTemplate,
): Promise<void> {
  const rendered = await renderEmail(email);
  await mailer.send({
    to: message.to,
    template: message.template,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    ...(message.senderName ? { senderName: message.senderName } : {}),
  });
}

/** The address part of `Name <address>` (or the whole value when it is a bare address). */
export function addressOf(from: string): string {
  return /<([^>]+)>/.exec(from)?.[1]?.trim() ?? from.trim();
}

/** A display name safe for a From header: one line, no angle brackets or quotes, 80 characters. */
export function displayName(name: string): string {
  return name
    .replace(/[\r\n<>"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
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
    const name = message.senderName ? displayName(message.senderName) : '';
    await this.transport.sendMail({
      // nodemailer quotes and encodes the name; the address is always the server's own.
      from: name ? { name, address: addressOf(this.from) } : this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      headers: { ...message.headers, 'X-Hamnivo-Template': message.template },
    });
  }
}

/** Development fallback without SMTP: writes the message to the log so links can be followed. */
export class LogMailer implements Mailer {
  constructor(private readonly log: (line: string) => void) {}
  async send(message: MailMessage): Promise<void> {
    const from = message.senderName ? ` from="${displayName(message.senderName)}"` : '';
    this.log(
      `[mail] to=${message.to} template=${message.template}${from}\n${message.subject}\n${message.text}`,
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
