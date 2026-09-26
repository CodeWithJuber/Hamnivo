import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';
import { EmptyState, LoadingRegion, RecoverableError } from '../src/components/async-states';
import { Button } from '../src/components/button';
import { FormErrorSummary, focusFirstInvalid } from '../src/components/form-error-summary';
import { LaneLabel } from '../src/components/lane';
import { initials, ParticipantAvatar, ParticipantBadge } from '../src/components/participant-badge';
import { ReasonedAction } from '../src/components/reasoned-action';
import { ActionOutcomeBadge, DeliveryStatus } from '../src/components/status-badge';

async function expectNoAxeViolations(container: HTMLElement) {
  const result = await axe.run(container, {
    // Colour contrast needs real layout; it is covered by token tests and the Storybook audit.
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  expect(result.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

describe('Button', () => {
  it('ignores clicks while busy and exposes aria-busy', async () => {
    const onClick = vi.fn();
    render(
      <Button busy onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: /save/i });
    expect(button).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('keeps its label text while busy', () => {
    render(<Button busy>Publish</Button>);
    expect(screen.getByRole('button')).toHaveTextContent('Publish');
  });
});

describe('ReasonedAction', () => {
  it('keeps the control focusable, blocks activation and describes the reason', async () => {
    const onClick = vi.fn();
    render(
      <ReasonedAction reason="Choose a handoff queue first">
        <Button onClick={onClick}>Publish</Button>
      </ReasonedAction>,
    );
    const button = screen.getByRole('button', { name: 'Publish' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    expect(button).toHaveAccessibleDescription('Choose a handoff queue first');
    button.focus();
    expect(button).toHaveFocus();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('renders the child untouched when there is no reason', async () => {
    const onClick = vi.fn();
    render(
      <ReasonedAction reason={null}>
        <Button onClick={onClick}>Publish</Button>
      </ReasonedAction>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('Async states', () => {
  it('distinguishes no-records from no-matches and always offers an action', async () => {
    const { container } = render(
      <EmptyState
        kind="no-matches"
        title="No conversations match"
        action={<Button>Reset filters</Button>}
      />,
    );
    expect(container.querySelector('[data-kind="no-matches"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Reset filters' })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('stops showing a skeleton after the timeout (never loops forever)', () => {
    vi.useFakeTimers();
    render(
      <LoadingRegion
        loading
        label="Loading conversations"
        skeleton={<div>skeleton</div>}
        timeoutMs={1000}
        timedOut={<p>Still loading. Retry?</p>}
      >
        <p>content</p>
      </LoadingRegion>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Loading conversations');
    act(() => vi.advanceTimersByTime(1001));
    expect(screen.getByText('Still loading. Retry?')).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('reports a recoverable error as an alert with a support reference', async () => {
    const onRetry = vi.fn();
    const { container } = render(
      <RecoverableError
        title="Unable to load"
        description="Check your connection."
        retryLabel="Retry"
        onRetry={onRetry}
        reference="req_123"
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('req_123');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
    await expectNoAxeViolations(container);
  });
});

describe('FormErrorSummary', () => {
  it('takes focus and links each error to its field', async () => {
    render(
      <form>
        <FormErrorSummary
          title="Fix 1 field"
          errors={[{ fieldId: 'email', message: 'Enter a valid email address' }]}
        />
        <label htmlFor="email">Email</label>
        <input id="email" aria-invalid="true" defaultValue="maya@" />
      </form>,
    );
    expect(screen.getByRole('alert')).toHaveFocus();
    await userEvent.click(screen.getByRole('link', { name: 'Enter a valid email address' }));
    expect(screen.getByLabelText('Email')).toHaveFocus();
    expect(screen.getByLabelText('Email')).toHaveValue('maya@');
  });

  it('focusFirstInvalid moves focus to the first invalid control', () => {
    render(
      <div>
        <input aria-label="a" />
        <input aria-label="b" aria-invalid="true" />
      </div>,
    );
    expect(focusFirstInvalid()).toBe(true);
    expect(screen.getByLabelText('b')).toHaveFocus();
  });
});

describe('Identity and lanes', () => {
  it('never renders initials for an AI participant', () => {
    const { container } = render(<ParticipantAvatar kind="ai_primary" name="Hamnivo AI" />);
    expect(container.textContent).toBe('');
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('computes initials for people', () => {
    expect(initials('Maya Saleh')).toBe('MS');
    expect(initials('  sana ')).toBe('SA');
    expect(initials('')).toBe('?');
  });

  it('labels the role in text', async () => {
    const { container } = render(
      <ParticipantBadge kind="ai_specialist" name="Billing" roleLabel="AI specialist" />,
    );
    expect(screen.getByText('AI specialist')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('labels private lanes in text, not only colour', () => {
    render(<LaneLabel lane="internal" withDescription />);
    expect(screen.getByText('Internal note')).toBeInTheDocument();
    expect(screen.getByText(/authorized teammates only/)).toBeInTheDocument();
  });

  it('always pairs delivery and outcome icons with text', () => {
    render(
      <div>
        <DeliveryStatus state="failed" label="Not sent" />
        <ActionOutcomeBadge outcome="unknown" label="Outcome unconfirmed" />
      </div>,
    );
    expect(screen.getByText('Not sent')).toBeInTheDocument();
    expect(screen.getByText('Outcome unconfirmed').closest('[data-outcome]')).toHaveAttribute(
      'data-outcome',
      'unknown',
    );
  });
});

describe('keyboard', () => {
  it('activates buttons with Enter and Space', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Send</Button>);
    const button = screen.getByRole('button', { name: 'Send' });
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });
});
