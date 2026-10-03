import { createElement as h, type ReactNode } from 'react';
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from 'react-email';

/**
 * The frame every Hamnivo email shares, built with React Email components: a plain, readable
 * column that works in every mail client, a single call to action, the link spelled out under the
 * button, and a short footer saying why the email arrived. Plain `createElement` keeps the gateway
 * free of JSX tooling.
 */

const colors = {
  page: '#f4f5f7',
  card: '#ffffff',
  text: '#1d2a30',
  muted: '#5b6b73',
  border: '#e2e6e9',
  action: '#192a30',
  onAction: '#ffffff',
};

const font =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans', 'Helvetica Neue', Arial, sans-serif";

export const paragraph = {
  fontSize: '15px',
  lineHeight: '24px',
  color: colors.text,
  margin: '0 0 16px',
};
export const small = {
  fontSize: '13px',
  lineHeight: '20px',
  color: colors.muted,
  margin: '0 0 12px',
};

export function P(children: ReactNode) {
  return h(Text, { style: paragraph }, children);
}

export function Small(children: ReactNode) {
  return h(Text, { style: small }, children);
}

/** The one call to action, with its link written out for clients that block buttons. */
export function Action(label: string, url: string) {
  return h(
    Section,
    { style: { margin: '24px 0' } },
    h(
      Button,
      {
        href: url,
        style: {
          backgroundColor: colors.action,
          color: colors.onAction,
          borderRadius: '8px',
          padding: '12px 20px',
          fontSize: '15px',
          fontWeight: 600,
          textDecoration: 'none',
          display: 'inline-block',
        },
      },
      label,
    ),
    h(
      Text,
      { style: { ...small, margin: '16px 0 0', wordBreak: 'break-all' } },
      'If the button does not work, open this link: ',
      h(Link, { href: url, style: { color: colors.action } }, url),
    ),
  );
}

export interface LayoutProps {
  /** Shown above the heading: the workspace, or Hamnivo. */
  from: string;
  /** The inbox preview line. */
  preview: string;
  heading: string;
  /** Why this email arrived. */
  footer: string;
  children: ReactNode[];
}

export function Layout({ from, preview, heading, footer, children }: LayoutProps) {
  return h(
    Html,
    { lang: 'en', dir: 'ltr' },
    h(Head, null),
    h(Preview, null, preview),
    h(
      Body,
      { style: { backgroundColor: colors.page, fontFamily: font, margin: 0, padding: '24px 0' } },
      h(
        Container,
        {
          style: {
            backgroundColor: colors.card,
            border: `1px solid ${colors.border}`,
            borderRadius: '12px',
            maxWidth: '560px',
            padding: '32px',
          },
        },
        h(Text, { style: { ...small, fontWeight: 600, margin: '0 0 8px' } }, from),
        h(
          Heading,
          {
            as: 'h1',
            style: { fontSize: '22px', lineHeight: '30px', color: colors.text, margin: '0 0 16px' },
          },
          heading,
        ),
        ...children,
        h(Hr, { style: { borderColor: colors.border, margin: '24px 0 16px' } }),
        h(Text, { style: { ...small, margin: 0 } }, footer),
      ),
    ),
  );
}
