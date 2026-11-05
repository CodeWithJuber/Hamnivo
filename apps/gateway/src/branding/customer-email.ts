import { CustomerEmailBranding, DEFAULT_EMAIL_BRANDING } from '@hamnivo/contracts';
import { type Db, schema, withTenant } from '@hamnivo/db';
import { displayName, type Mailer, type MailMessage } from '../platform/mailer.js';

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
}
/** Tenant-owned presentation only. The authenticated SMTP envelope/From address stays platform-owned. */
export function brandCustomerMessage(
  message: MailMessage,
  fallbackName: string,
  raw: unknown,
): MailMessage {
  const branding = CustomerEmailBranding.parse(raw);
  const name = displayName(branding.senderName ?? fallbackName);
  const logo = branding.logoUrl
    ? `<img src="${escapeHtml(branding.logoUrl)}" alt="${escapeHtml(name)}" width="160" style="max-width:160px;height:auto">`
    : '';
  return {
    ...message,
    senderName: name,
    ...(branding.replyTo ? { replyTo: branding.replyTo } : {}),
    html: `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#172b36"><main style="max-width:640px;margin:24px auto">${logo}<h1 style="font-size:20px">${escapeHtml(name)}</h1><div style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(message.text)}</div></main></body></html>`,
  };
}
export async function sendBrandedCustomerMail(
  db: Db,
  mailer: Mailer,
  tenantId: string,
  fallbackName: string,
  message: MailMessage,
): Promise<void> {
  const branding = await withTenant(db, { tenantId, actorId: 'notifications' }, async (tx) => {
    const [row] = await tx
      .select({ email: schema.tenantBranding.email })
      .from(schema.tenantBranding)
      .limit(1);
    return row?.email ?? DEFAULT_EMAIL_BRANDING;
  });
  await mailer.send(brandCustomerMessage(message, fallbackName, branding));
}
