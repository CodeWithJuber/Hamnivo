import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import type * as React from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';
import { useDocumentTheme } from '../hooks/use-document-theme';

/**
 * Toast region. Toasts supplement persistent state; they must never be the only place a failed
 * payment, revoked permission or lost connection is reported (UX flow spec §4).
 */
function Toaster(props: ToasterProps) {
  const theme = useDocumentTheme();
  return (
    <Sonner
      theme={theme}
      className="toaster group"
      closeButton
      icons={{
        success: <CircleCheckIcon className="size-[18px] text-success" aria-hidden="true" />,
        info: <InfoIcon className="size-[18px] text-info" aria-hidden="true" />,
        warning: <TriangleAlertIcon className="size-[18px] text-warning" aria-hidden="true" />,
        error: <OctagonXIcon className="size-[18px] text-danger" aria-hidden="true" />,
        loading: <Loader2Icon className="size-[18px] animate-spin" aria-hidden="true" />,
      }}
      style={
        {
          '--normal-bg': 'var(--hv-surface)',
          '--normal-text': 'var(--hv-text)',
          '--normal-border': 'var(--hv-border)',
          '--success-bg': 'var(--hv-success-subtle)',
          '--success-text': 'var(--hv-text)',
          '--success-border': 'var(--hv-success)',
          '--error-bg': 'var(--hv-danger-subtle)',
          '--error-text': 'var(--hv-text)',
          '--error-border': 'var(--hv-danger)',
          '--border-radius': 'var(--hv-radius-lg)',
        } as React.CSSProperties
      }
      {...props}
    />
  );
}

export { Toaster };
