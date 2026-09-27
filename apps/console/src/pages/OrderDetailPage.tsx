import { parseAmountInput } from '@hamnivo/domain/commerce';
import { Button } from '@hamnivo/ui/components/button';
import { Label } from '@hamnivo/ui/components/label';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { RadioGroup, RadioGroupItem } from '@hamnivo/ui/components/radio-group';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@hamnivo/ui/components/sheet';
import { StatusBadge, type StatusTone } from '@hamnivo/ui/components/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@hamnivo/ui/components/table';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeftIcon, XIcon } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, ConfirmDialog, DialogFooter } from '../components/AppDialog';
import { SelectField, TextareaField, TextField } from '../components/Fields';
import { PageHeader, Section } from '../components/PageHeader';
import { ActionError, QueryState } from '../components/States';
import { directionOf, isLocale } from '../i18n';
import { newIdempotencyKey } from '../lib/api';
import {
  type FulfilmentInput,
  formatAmount,
  formatDay,
  formatWhen,
  type OrderDetail,
  type RefundView,
  useOrder,
  useRecordFulfilment,
  useRefundDecision,
  useRequestRefund,
} from '../lib/commerce';
import { returnFocus, useOpener } from '../lib/focus';
import { isCancelled } from '../lib/reauth';
import { useTenant } from '../lib/tenant';
import { FulfilmentText, PaymentBadge } from './OrdersPage';

const REFUND_TONE: Record<RefundView['state'], StatusTone> = {
  requested: 'neutral',
  policy_checked: 'neutral',
  awaiting_approval: 'warning',
  submitted: 'info',
  pending: 'info',
  succeeded: 'success',
  rejected: 'neutral',
  failed: 'danger',
  unknown: 'warning',
};

const REASONS = ['customer_request', 'damaged', 'not_delivered', 'duplicate', 'other'] as const;

const FULFILMENT_TONE: Record<string, StatusTone> = {
  not_started: 'neutral',
  pending: 'neutral',
  in_progress: 'info',
  delayed: 'warning',
  shipped: 'info',
  delivered: 'success',
  provisioned: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

/** What each kind can become: a shipment ships and is delivered, a service becomes active. */
const NEXT_STATES = {
  shipment: ['in_progress', 'delayed', 'shipped', 'delivered', 'failed'],
  service: ['in_progress', 'delayed', 'provisioned', 'failed'],
} as const satisfies Record<FulfilmentInput['kind'], readonly FulfilmentInput['state'][]>;

/** States in which a delivery estimate still means something. */
const ESTIMABLE: readonly string[] = ['in_progress', 'delayed', 'shipped'];

/** Only paid orders are fulfilled. */
const FULFILLABLE: readonly string[] = ['confirmed', 'partially_fulfilled', 'fulfilled'];

/** Records a shipment or service update the shop reported (C10, HNV-21-02). */
function FulfilmentDialog({
  order,
  open,
  onOpenChange,
}: {
  order: OrderDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const record = useRecordFulfilment(order.order.id);
  const [kind, setKind] = useState<FulfilmentInput['kind']>('shipment');
  const [state, setState] = useState<FulfilmentInput['state']>('in_progress');
  const [estimate, setEstimate] = useState('');
  const [carrierRef, setCarrierRef] = useState('');
  const [note, setNote] = useState('');
  const [failure, setFailure] = useState<unknown>(null);
  const estimable = ESTIMABLE.includes(state);

  const reset = () => {
    setKind('shipment');
    setState('in_progress');
    setEstimate('');
    setCarrierRef('');
    setNote('');
    setFailure(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(null);
    try {
      await record.mutateAsync({
        kind,
        state,
        ...(estimable && estimate ? { estimateAt: `${estimate}T00:00:00.000Z` } : {}),
        ...(carrierRef.trim() ? { carrierRef: carrierRef.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      announce(t('commerce.fulfilmentForm.saved'));
      reset();
      onOpenChange(false);
    } catch (caught) {
      if (!isCancelled(caught)) setFailure(caught);
    }
  };

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title={t('commerce.fulfilmentForm.title')}
      description={t('commerce.fulfilmentForm.description')}
      testId="fulfilment-dialog"
    >
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} noValidate>
        <SelectField
          id="fulfilment-kind"
          label={t('commerce.fulfilmentForm.kind')}
          value={kind}
          onChange={(event) => {
            const next = event.target.value as FulfilmentInput['kind'];
            setKind(next);
            if (!(NEXT_STATES[next] as readonly string[]).includes(state)) setState('in_progress');
          }}
          options={(['shipment', 'service'] as const).map((value) => ({
            value,
            label: t(`commerce.detail.kind.${value}`),
          }))}
        />
        <SelectField
          id="fulfilment-state"
          label={t('commerce.fulfilmentForm.state')}
          value={state}
          onChange={(event) => setState(event.target.value as FulfilmentInput['state'])}
          options={NEXT_STATES[kind].map((value) => ({
            value,
            label: t(`commerce.fulfilment.${value}`),
          }))}
        />
        {estimable ? (
          <TextField
            id="fulfilment-estimate"
            type="date"
            label={t('commerce.fulfilmentForm.estimate')}
            labelNote={t('app.optional')}
            hint={t('commerce.fulfilmentForm.estimateHint')}
            value={estimate}
            dir="ltr"
            onChange={(event) => setEstimate(event.target.value)}
          />
        ) : null}
        <TextField
          id="fulfilment-carrier"
          label={t('commerce.fulfilmentForm.carrierRef')}
          labelNote={t('app.optional')}
          value={carrierRef}
          maxLength={120}
          dir="ltr"
          autoComplete="off"
          onChange={(event) => setCarrierRef(event.target.value)}
        />
        <TextareaField
          id="fulfilment-note"
          label={t('commerce.fulfilmentForm.note')}
          labelNote={t('app.optional')}
          hint={t('commerce.fulfilmentForm.noteHint')}
          value={note}
          maxLength={500}
          onChange={(event) => setNote(event.target.value)}
        />
        <ActionError error={failure} />
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {t('app.cancel')}
          </Button>
          <Button type="submit" busy={record.isPending}>
            {t('commerce.fulfilmentForm.submit')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}

/** Each shipment or service with its milestone, the shop's estimate, source and last update. */
function FulfilmentList({ order }: { order: OrderDetail }) {
  const { t } = useTranslation();
  if (order.fulfillments.length === 0) {
    return <p className="text-sm text-text-secondary">{t('commerce.detail.noFulfilment')}</p>;
  }
  return (
    <ul className="flex flex-col gap-3" data-testid="fulfilments">
      {order.fulfillments.map((f) => (
        <li
          key={f.id}
          className="flex flex-col gap-1 rounded-lg border border-border p-3 text-sm"
          data-fulfilment={f.state}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{t(`commerce.detail.kind.${f.kind}`)}</span>
            <StatusBadge
              tone={FULFILMENT_TONE[f.state] ?? 'neutral'}
              data-testid="fulfilment-state"
            >
              <FulfilmentText state={f.state} />
            </StatusBadge>
          </div>
          {f.estimateAt ? (
            <p data-testid="fulfilment-estimate">
              {t('commerce.detail.estimate', { date: formatDay(f.estimateAt) })}
            </p>
          ) : null}
          {f.carrierRef ? (
            <p className="text-text-secondary">
              {t('commerce.detail.tracking', { ref: `\u2068${f.carrierRef}\u2069` })}
            </p>
          ) : null}
          {f.note ? (
            <p className="text-text" dir="auto">
              {f.note}
            </p>
          ) : null}
          <p className="text-xs text-text-secondary">
            {t(`commerce.detail.source.${f.source}`)} ·{' '}
            {t('commerce.detail.updated', { time: formatWhen(f.lastUpdateAt) })}
          </p>
        </li>
      ))}
    </ul>
  );
}

/** Refund request drawer (C12, U06): the amount is read in any script and never guessed. */
function RefundDrawer({
  order,
  open,
  onOpenChange,
}: {
  order: OrderDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const announce = useAnnouncer();
  const request = useRequestRefund(order.order.id);
  const opener = useOpener(open);
  const currency = order.order.currency;
  const [amount, setAmount] = useState('');
  const [choices, setChoices] = useState<string[]>([]);
  const [choice, setChoice] = useState('');
  const [reason, setReason] = useState<(typeof REASONS)[number]>('customer_request');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(null);
  const requestId = useRef<string | null>(null);
  const dir = directionOf(isLocale(i18n.language) ? i18n.language : 'en');
  const max = BigInt(order.refundable.maxMinor);
  const policy =
    order.refundable.policy.approval === 'always'
      ? t('commerce.refunds.policyAlways')
      : t('commerce.refunds.policyThreshold', {
          amount: formatAmount(order.refundable.policy.autoApproveMaxMinor, currency),
        });

  const reset = () => {
    setAmount('');
    setChoices([]);
    setChoice('');
    setNote('');
    setError(undefined);
    setFailure(null);
    requestId.current = null;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(null);
    let minor: string | null = choice || null;
    if (!minor) {
      const parsed = parseAmountInput(amount, currency);
      if (parsed.kind === 'invalid') {
        setError(t(`commerce.refunds.invalid.${parsed.reason}`, { currency }));
        return;
      }
      if (parsed.kind === 'ambiguous') {
        setChoices(parsed.candidates.map((m) => m.amountMinor.toString()));
        setError(undefined);
        return;
      }
      minor = parsed.money.amountMinor.toString();
    }
    if (BigInt(minor) > max) {
      setError(t('commerce.refunds.invalid.over'));
      return;
    }
    setError(undefined);
    requestId.current ??= newIdempotencyKey();
    try {
      await request.mutateAsync({
        amountMinor: minor,
        reason,
        clientRequestId: requestId.current,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      announce(t('commerce.refunds.state.awaiting_approval'));
      reset();
      onOpenChange(false);
    } catch (caught) {
      if (!isCancelled(caught)) setFailure(caught);
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <SheetContent
        side={dir === 'rtl' ? 'left' : 'right'}
        showCloseButton={false}
        className="w-full gap-0 overflow-y-auto p-0 sm:max-w-md"
        data-testid="refund-sheet"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus(opener.current);
        }}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border p-4">
          <div className="flex min-w-0 flex-col gap-1">
            <SheetTitle className="text-lg">{t('commerce.refunds.request')}</SheetTitle>
            <SheetDescription className="text-sm">
              {t('commerce.refunds.requestDescription', {
                amount: formatAmount(order.refundable.maxMinor, currency),
              })}{' '}
              {policy}
            </SheetDescription>
          </div>
          <SheetClose asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t('app.close')}>
              <XIcon aria-hidden="true" />
            </Button>
          </SheetClose>
        </div>
        <form
          className="flex flex-col gap-4 p-4"
          onSubmit={(event) => void submit(event)}
          noValidate
        >
          <TextField
            id="refund-amount"
            label={t('commerce.refunds.amount', { currency })}
            hint={t('commerce.refunds.amountHint')}
            error={error}
            value={amount}
            inputMode="decimal"
            dir="ltr"
            autoComplete="off"
            onChange={(event) => {
              setAmount(event.target.value);
              setChoices([]);
              setChoice('');
            }}
          />
          {choices.length > 0 ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium text-text">
                {t('commerce.refunds.ambiguous')}
              </legend>
              <RadioGroup value={choice} onValueChange={setChoice}>
                {choices.map((value) => (
                  <div key={value} className="flex items-center gap-2">
                    <RadioGroupItem id={`refund-choice-${value}`} value={value} />
                    <Label htmlFor={`refund-choice-${value}`}>
                      {formatAmount(value, currency)}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </fieldset>
          ) : null}
          <SelectField
            id="refund-reason"
            label={t('commerce.refunds.reason')}
            value={reason}
            onChange={(event) => setReason(event.target.value as (typeof REASONS)[number])}
            options={REASONS.map((value) => ({
              value,
              label: t(`commerce.refunds.reasons.${value}`),
            }))}
          />
          <TextareaField
            id="refund-note"
            label={t('commerce.refunds.note')}
            labelNote={t('app.optional')}
            value={note}
            maxLength={1000}
            onChange={(event) => setNote(event.target.value)}
          />
          <ActionError error={failure} />
          <Button type="submit" busy={request.isPending}>
            {t('commerce.refunds.submit')}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function RefundItem({ order, refund }: { order: OrderDetail; refund: RefundView }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const decide = useRefundDecision(order.order.id);
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectError, setRejectError] = useState<unknown>(null);
  const amount = formatAmount(refund.amountMinor, refund.currency);
  const note =
    refund.approval.reason === 'same_person'
      ? t('commerce.refunds.samePerson')
      : refund.approval.reason === 'no_permission'
        ? t('commerce.refunds.noPermission')
        : null;
  return (
    <li
      className="flex flex-col gap-2 rounded-lg border border-border p-3"
      data-refund={refund.id}
      data-state={refund.state}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold tabular-nums">{amount}</span>
        <StatusBadge tone={REFUND_TONE[refund.state]} data-testid="refund-state">
          {t(`commerce.refunds.state.${refund.state}`)}
        </StatusBadge>
        <span className="text-sm text-text-secondary">
          {t(`commerce.refunds.reasons.${refund.reason}`)}
        </span>
      </div>
      <p className="text-sm text-text-secondary">
        {t('commerce.refunds.requestedBy', {
          name: refund.requestedBy.name,
          time: formatWhen(refund.requestedAt),
        })}
      </p>
      {refund.note ? (
        <p className="text-sm text-text" dir="auto">
          {refund.note}
        </p>
      ) : null}
      {refund.approvedBy ? (
        <p className="text-sm text-text-secondary">
          {t('commerce.refunds.approvedBy', {
            name: refund.approvedBy.name,
            time: formatWhen(refund.approvedAt),
          })}
        </p>
      ) : null}
      {refund.rejectedBy ? (
        <p className="text-sm text-text-secondary">
          {t('commerce.refunds.rejectedBy', {
            name: refund.rejectedBy.name,
            reason: refund.rejectionReason ?? '',
          })}
        </p>
      ) : null}
      {refund.failureReason ? (
        <p className="text-sm text-danger">
          {t('commerce.refunds.failureReason', { reason: refund.failureReason })}
        </p>
      ) : null}
      {['submitted', 'pending', 'unknown'].includes(refund.state) ? (
        <p className="text-sm text-text-secondary">{t('commerce.refunds.pendingNote')}</p>
      ) : null}
      {refund.providerRef ? (
        <p className="text-xs text-text-secondary">
          {t('commerce.detail.providerRef')}:{' '}
          <bdi dir="ltr" className="font-mono">
            {refund.providerRef}
          </bdi>
        </p>
      ) : null}
      {refund.state === 'awaiting_approval' && note ? (
        <p className="text-sm text-text" data-testid="approval-note">
          {note}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {refund.state === 'awaiting_approval' && can('commerce.refunds.approve') ? (
          <>
            <Button disabled={!refund.approval.canApprove} onClick={() => setApproving(true)}>
              {t('commerce.refunds.approve')}
            </Button>
            <Button
              variant="secondary"
              disabled={!refund.approval.canApprove}
              onClick={() => setRejecting(true)}
            >
              {t('commerce.refunds.reject')}
            </Button>
          </>
        ) : null}
        {['submitted', 'pending', 'unknown'].includes(refund.state) ? (
          <Button
            variant="secondary"
            busy={decide.isPending}
            onClick={() =>
              void decide
                .mutateAsync({ refundId: refund.id, decision: 'refresh' })
                .catch(() => undefined)
            }
          >
            {t('commerce.refunds.check')}
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={approving}
        onOpenChange={setApproving}
        title={t('commerce.refunds.approveTitle', { amount })}
        confirmLabel={t('commerce.refunds.approveConfirm')}
        testId="approve-refund-dialog"
        onConfirm={() => decide.mutateAsync({ refundId: refund.id, decision: 'approve' })}
      >
        <p>{t('commerce.refunds.approveBody')}</p>
      </ConfirmDialog>
      <AppDialog
        open={rejecting}
        onOpenChange={(next) => {
          if (!next) {
            setRejectReason('');
            setRejectError(null);
          }
          setRejecting(next);
        }}
        title={t('commerce.refunds.rejectTitle')}
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!rejectReason.trim()) return;
            try {
              await decide.mutateAsync({
                refundId: refund.id,
                decision: 'reject',
                reason: rejectReason.trim(),
              });
              setRejecting(false);
            } catch (caught) {
              if (!isCancelled(caught)) setRejectError(caught);
            }
          }}
        >
          <TextareaField
            id={`reject-${refund.id}`}
            label={t('commerce.refunds.rejectReason')}
            value={rejectReason}
            required
            maxLength={500}
            onChange={(event) => setRejectReason(event.target.value)}
          />
          <ActionError error={rejectError} />
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setRejecting(false)}>
              {t('app.cancel')}
            </Button>
            <Button
              type="submit"
              variant="destructive"
              busy={decide.isPending}
              disabled={!rejectReason.trim()}
            >
              {t('commerce.refunds.rejectConfirm')}
            </Button>
          </DialogFooter>
        </form>
      </AppDialog>
    </li>
  );
}

function Detail({ order }: { order: OrderDetail }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const [drawer, setDrawer] = useState(false);
  const [recording, setRecording] = useState(false);
  const currency = order.order.currency;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('commerce.detail.title', { reference: order.order.reference })}
        description={t('commerce.detail.observed', { time: formatWhen(order.observedAt) })}
        eyebrow={
          <Link
            to="/orders"
            className="inline-flex items-center gap-1 text-sm text-link underline underline-offset-2"
          >
            <ArrowLeftIcon className="size-4 rtl:rotate-180" aria-hidden="true" />
            {t('commerce.detail.back')}
          </Link>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <PaymentBadge state={order.order.paymentState} />
            <StatusBadge
              tone={FULFILMENT_TONE[order.order.fulfillmentState] ?? 'neutral'}
              data-testid="order-fulfilment-state"
            >
              <FulfilmentText state={order.order.fulfillmentState} />
            </StatusBadge>
          </div>
        }
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Section id="order-items" title={t('commerce.detail.items')}>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
            <dt className="text-text-secondary">{t('commerce.detail.seller')}</dt>
            <dd>
              <bdi>{order.merchant.name}</bdi>
            </dd>
            <dt className="text-text-secondary">{t('commerce.detail.customer')}</dt>
            <dd>
              <bdi>{order.order.customer.displayName ?? t('commerce.orders.visitor')}</bdi>
            </dd>
            <dt className="text-text-secondary">{t('commerce.orders.columns.placed')}</dt>
            <dd>{formatWhen(order.order.placedAt)}</dd>
          </dl>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('commerce.detail.items')}</TableHead>
                <TableHead className="text-end">{t('commerce.detail.total')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {order.lines.map((line) => (
                <TableRow key={line.lineId}>
                  <TableCell>
                    <bdi>
                      {line.quantity} × {line.name}
                    </bdi>
                  </TableCell>
                  <TableCell className="text-end tabular-nums">
                    {formatAmount(line.totalMinor, currency)}
                  </TableCell>
                </TableRow>
              ))}
              {order.shippingMinor ? (
                <TableRow>
                  <TableCell>{t('commerce.detail.delivery')}</TableCell>
                  <TableCell className="text-end tabular-nums">
                    {formatAmount(order.shippingMinor, currency)}
                  </TableCell>
                </TableRow>
              ) : null}
              <TableRow>
                <TableCell className="font-semibold">{t('commerce.detail.total')}</TableCell>
                <TableCell
                  className="text-end font-semibold tabular-nums"
                  data-testid="order-total"
                >
                  {formatAmount(order.order.totalMinor, currency)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </Section>
        <Section id="order-payment" title={t('commerce.detail.payment')}>
          {order.payment ? (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
              <dt className="text-text-secondary">{t('commerce.detail.paid')}</dt>
              <dd className="tabular-nums">
                {formatAmount(order.payment.capturedMinor, currency)}
              </dd>
              <dt className="text-text-secondary">{t('commerce.detail.refunded')}</dt>
              <dd className="tabular-nums" data-testid="refunded-amount">
                {formatAmount(order.payment.refundedMinor, currency)}
              </dd>
              <dt className="text-text-secondary">{t('commerce.detail.refundable')}</dt>
              <dd className="tabular-nums">{formatAmount(order.refundable.maxMinor, currency)}</dd>
              <dt className="text-text-secondary">{t('commerce.detail.paidAt')}</dt>
              <dd>{formatWhen(order.payment.capturedAt)}</dd>
              <dt className="text-text-secondary">{t('commerce.detail.providerRef')}</dt>
              <dd>
                <bdi dir="ltr" className="font-mono text-xs">
                  {order.payment.providerRef ?? '—'}
                </bdi>
              </dd>
            </dl>
          ) : null}
        </Section>
      </div>
      <Section
        id="order-fulfilment"
        title={t('commerce.detail.fulfilments')}
        actions={
          can('commerce.orders.manage') && FULFILLABLE.includes(order.order.state) ? (
            <Button variant="secondary" onClick={() => setRecording(true)}>
              {t('commerce.fulfilmentForm.open')}
            </Button>
          ) : null
        }
      >
        <FulfilmentList order={order} />
      </Section>
      <Section
        id="order-refunds"
        title={t('commerce.refunds.title')}
        actions={
          can('commerce.refunds.request') && BigInt(order.refundable.maxMinor) > 0n ? (
            <Button onClick={() => setDrawer(true)}>{t('commerce.refunds.request')}</Button>
          ) : null
        }
      >
        {order.refunds.length === 0 ? (
          <p className="text-sm text-text-secondary">{t('commerce.refunds.none')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {order.refunds.map((refund) => (
              <RefundItem key={refund.id} order={order} refund={refund} />
            ))}
          </ul>
        )}
      </Section>
      <Section
        id="order-operations"
        title={t('commerce.detail.operations')}
        description={t('commerce.detail.operationsDescription')}
      >
        <ul className="flex flex-col gap-3 text-sm">
          {order.operations.map((op) => (
            <li
              key={op.id}
              className="flex flex-col gap-1 rounded-lg border border-border p-3"
              data-operation={op.state}
            >
              <div className="flex flex-wrap items-center gap-2">
                <bdi dir="ltr" className="font-mono text-xs">
                  {op.kind}
                </bdi>
                <StatusBadge
                  tone={
                    op.state === 'succeeded'
                      ? 'success'
                      : op.state === 'failed'
                        ? 'danger'
                        : op.state === 'unknown'
                          ? 'warning'
                          : 'neutral'
                  }
                >
                  {t(`commerce.detail.operationState.${op.state}`)}
                </StatusBadge>
              </div>
              <ol className="flex flex-col gap-0.5 text-xs text-text-secondary">
                {op.receipts.map((receipt) => (
                  <li key={receipt.id}>
                    <bdi dir="ltr">
                      {t('commerce.detail.receipt', {
                        kind: receipt.kind,
                        outcome: receipt.outcome,
                        source: receipt.source,
                        time: formatWhen(receipt.observedAt),
                      })}
                    </bdi>
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ul>
      </Section>
      {order.exceptions.length > 0 ? (
        <Section id="order-exceptions" title={t('commerce.detail.exceptions')}>
          <ul className="flex flex-col gap-2 text-sm">
            {order.exceptions.map((e) => (
              <li key={e.id}>
                {t(`commerce.finance.kind.${e.kind}`)} ·{' '}
                {t(`commerce.finance.action.${e.nextSafeAction}`)}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <RefundDrawer order={order} open={drawer} onOpenChange={setDrawer} />
      <FulfilmentDialog order={order} open={recording} onOpenChange={setRecording} />
    </div>
  );
}

/** One order: items, payment, refunds with approval, provider calls and exceptions (C10, C12). */
export function OrderDetailPage() {
  const { t } = useTranslation();
  const { orderId } = useParams({ from: '/_studio/orders/$orderId' });
  const order = useOrder(orderId);
  return (
    <QueryState query={order} label={t('commerce.detail.loading')}>
      {(data) => <Detail order={data} />}
    </QueryState>
  );
}
