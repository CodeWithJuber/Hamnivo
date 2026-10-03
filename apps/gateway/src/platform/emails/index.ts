import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Action, Layout, P, Small } from './layout.js';

/**
 * Hamnivo's transactional emails: welcome, invitation, address verification, password reset,
 * failed payment and receipt. Each renders to HTML with React's server renderer and carries a plain-text
 * version written for people (and kept stable for tests and filters), never derived from the HTML.
 * Text is English, the source language; the workspace's sender name goes in the From header.
 */

export type EmailTemplate =
  | { kind: 'welcome'; name: string; workspace: string; studioUrl: string }
  | {
      kind: 'invitation';
      workspace: string | null;
      role: string;
      acceptUrl: string;
      email: string;
      inviter: string | null;
      days: number;
    }
  | { kind: 'verification'; url: string }
  | { kind: 'password-reset'; url: string }
  | {
      kind: 'payment-failed';
      workspace: string;
      amount: string;
      /** When the plan falls back to free if it stays unpaid (formatted); null: no grace period. */
      graceEndsAt: string | null;
      /** The provider's page where the invoice can be paid. */
      payUrl: string | null;
      manageUrl: string;
    }
  | {
      kind: 'receipt';
      workspace: string;
      amount: string;
      number: string | null;
      paidAt: string;
      plan: string | null;
      invoiceUrl: string | null;
      manageUrl: string;
    };

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

interface Built {
  subject: string;
  element: ReactElement;
  text: string;
}

const lines = (...parts: (string | null | false)[]) =>
  parts.filter((part): part is string => typeof part === 'string').join('\n');

function build(template: EmailTemplate): Built {
  switch (template.kind) {
    case 'welcome': {
      const subject = `Your workspace ${template.workspace} is ready`;
      return {
        subject,
        element: Layout({
          from: 'Hamnivo',
          preview: `${template.workspace} is ready. Open Studio to add your first brand.`,
          heading: `Welcome, ${template.name}`,
          footer: 'You get this email because you created a Hamnivo workspace.',
          children: [
            P(`Your workspace ${template.workspace} is ready.`),
            P(
              'Next, add your first brand in Studio. Hamnivo sets up its chat engine for you, then you can put the chat on your website.',
            ),
            Action('Open Studio', template.studioUrl),
          ],
        }),
        text: lines(
          `Welcome, ${template.name}.`,
          '',
          `Your workspace ${template.workspace} is ready. Next, add your first brand in Studio:`,
          '',
          template.studioUrl,
          '',
          'Hamnivo sets up its chat engine for you, then you can put the chat on your website.',
        ),
      };
    }
    case 'invitation': {
      const where = template.workspace
        ? `the ${template.workspace} workspace`
        : 'a Hamnivo workspace';
      const subject = template.workspace
        ? `You have been invited to ${template.workspace} on Hamnivo`
        : 'You have been invited to Hamnivo';
      const by = template.inviter ? `${template.inviter} invited you` : 'You were invited';
      return {
        subject,
        element: Layout({
          from: template.workspace ?? 'Hamnivo',
          preview: `${by} to join ${where} as ${template.role}.`,
          heading: 'You are invited',
          footer: `This invitation was sent to ${template.email}. If you did not expect it, you can ignore this email.`,
          children: [
            P(`${by} to join ${where} as ${template.role}.`),
            P(
              `Accept within ${template.days} days. Sign in, or create your account, with this email address (${template.email}).`,
            ),
            Action('Accept invitation', template.acceptUrl),
          ],
        }),
        text: lines(
          `${by} to join ${where} as ${template.role}.`,
          '',
          `Accept within ${template.days} days:`,
          template.acceptUrl,
          '',
          `Sign in with this email address (${template.email}) to accept.`,
        ),
      };
    }
    case 'verification':
      return {
        subject: 'Confirm your email for Hamnivo',
        element: Layout({
          from: 'Hamnivo',
          preview: 'Confirm this address to finish creating your account.',
          heading: 'Confirm your email',
          footer: 'If you did not sign up, you can ignore this email.',
          children: [
            P('Confirm this address to finish creating your account.'),
            Action('Confirm email', template.url),
          ],
        }),
        text: lines(
          'Confirm this address to finish creating your account:',
          '',
          template.url,
          '',
          'If you did not sign up, you can ignore this email.',
        ),
      };
    case 'password-reset':
      return {
        subject: 'Reset your Hamnivo password',
        element: Layout({
          from: 'Hamnivo',
          preview: 'Choose a new password within one hour.',
          heading: 'Reset your password',
          footer:
            'If you did not ask for this, you can ignore this email. Your password stays the same.',
          children: [
            P('Use this link within one hour to choose a new password.'),
            Action('Choose a new password', template.url),
          ],
        }),
        text: lines(
          'Use this link within one hour to choose a new password:',
          '',
          template.url,
          '',
          'If you did not ask for this, you can ignore this email.',
        ),
      };
    case 'payment-failed': {
      const subject = `Payment failed for ${template.workspace}`;
      const keep = template.graceEndsAt
        ? `Your plan stays as it is until ${template.graceEndsAt}. If the payment still fails then, the workspace moves to the free plan.`
        : 'If the payment keeps failing, the workspace moves to the free plan.';
      return {
        subject,
        element: Layout({
          from: template.workspace,
          preview: `We could not collect ${template.amount}. Update your payment method to keep your plan.`,
          heading: 'Your payment failed',
          footer: `You get this email because you manage billing for ${template.workspace}.`,
          children: [
            P(`We could not collect ${template.amount} for ${template.workspace}.`),
            P(keep),
            Action(
              template.payUrl ? 'Pay the invoice' : 'Update payment method',
              template.payUrl ?? template.manageUrl,
            ),
            Small(`You can also manage billing in Studio: ${template.manageUrl}`),
          ],
        }),
        text: lines(
          `We could not collect ${template.amount} for ${template.workspace}.`,
          '',
          keep,
          '',
          template.payUrl ? 'Pay the invoice:' : 'Update your payment method:',
          template.payUrl ?? template.manageUrl,
          '',
          `Manage billing in Studio: ${template.manageUrl}`,
        ),
      };
    }
    case 'receipt': {
      const subject = `Receipt for ${template.workspace}: ${template.amount}`;
      const what = template.plan ? `${template.plan} plan` : 'your plan';
      return {
        subject,
        element: Layout({
          from: template.workspace,
          preview: `We received ${template.amount} for ${what}. Thank you.`,
          heading: 'Payment received',
          footer: `You get this email because you manage billing for ${template.workspace}.`,
          children: [
            P(`We received ${template.amount} for ${what} on ${template.paidAt}. Thank you.`),
            template.number
              ? Small(`Invoice ${template.number}`)
              : Small('Invoice details are in Studio.'),
            Action(
              template.invoiceUrl ? 'View invoice' : 'Open billing',
              template.invoiceUrl ?? template.manageUrl,
            ),
          ],
        }),
        text: lines(
          `We received ${template.amount} for ${what} on ${template.paidAt}. Thank you.`,
          template.number ? `Invoice ${template.number}` : null,
          '',
          template.invoiceUrl ? 'View the invoice:' : 'Billing in Studio:',
          template.invoiceUrl ?? template.manageUrl,
        ),
      };
    }
  }
}

/** Renders an email to its subject, HTML and plain-text versions. */
export async function renderEmail(template: EmailTemplate): Promise<RenderedEmail> {
  const built = build(template);
  return {
    subject: built.subject,
    html: `<!DOCTYPE html>${renderToStaticMarkup(built.element)}`,
    text: built.text,
  };
}
