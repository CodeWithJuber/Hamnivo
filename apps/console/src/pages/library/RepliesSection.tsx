import { EmptyState } from '@hamnivo/ui/components/async-states';
import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@hamnivo/ui/components/table';
import { MessageSquareTextIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, ConfirmDialog, DialogFooter } from '../../components/AppDialog';
import { TextareaField, TextField } from '../../components/Fields';
import { Section } from '../../components/PageHeader';
import { ActionError, QueryState } from '../../components/States';
import { formatNumber } from '../../lib/format';
import {
  CODE_PATTERN,
  insertAt,
  LIMITS,
  REPLY_DETAILS,
  refusedField,
  type SavedReplyRecord,
  useDeleteReply,
  useLibraryReplies,
  useSaveReply,
} from '../../lib/library';

/** From this many saved replies on, the list can be searched. */
const SEARCHABLE_FROM = 6;

/** What can be wrong with the form, and the words for it. */
const PROBLEMS = {
  codeRequired: 'inboxAlerts.library.replies.dialog.codeRequired',
  codeInvalid: 'inboxAlerts.library.replies.dialog.codeInvalid',
  codeTaken: 'inboxAlerts.library.replies.dialog.codeTaken',
  textRequired: 'inboxAlerts.library.replies.dialog.textRequired',
} as const;
type Problem = keyof typeof PROBLEMS;

/** Whether a saved reply matches what was typed in the search box (code or text, any case). */
export function matches(reply: SavedReplyRecord, search: string): boolean {
  const wanted = search.trim().toLowerCase();
  return (
    wanted === '' ||
    reply.shortCode.toLowerCase().includes(wanted) ||
    reply.content.toLowerCase().includes(wanted)
  );
}

/** The short code and text of one saved reply, to add or change; only what changed is sent. */
export function ReplyForm({
  brandId,
  reply,
  codes,
  onDone,
}: {
  brandId: string;
  reply: SavedReplyRecord | null;
  /** The short codes already in use (lower case), other than this reply's own. */
  codes: string[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const save = useSaveReply(brandId);
  const area = useRef<HTMLTextAreaElement>(null);
  const [code, setCode] = useState(reply?.shortCode ?? '');
  const [text, setText] = useState(reply?.content ?? '');
  const [tried, setTried] = useState(false);

  const shortCode = code.trim();
  const content = text.trim();
  const codeChanged = !reply || shortCode !== reply.shortCode;
  // The text is compared as it will be kept: without the spaces around it.
  const textChanged = !reply || content !== reply.content.trim();
  // A code made elsewhere may break today's rules; it is only checked when it is changed.
  const codeProblem: Problem | null = !codeChanged
    ? null
    : shortCode === ''
      ? 'codeRequired'
      : shortCode.length > LIMITS.code || !CODE_PATTERN.test(shortCode)
        ? 'codeInvalid'
        : codes.includes(shortCode.toLowerCase()) || refusedField(save.error, 'shortCode')
          ? 'codeTaken'
          : null;
  const textProblem: Problem | null = content === '' ? 'textRequired' : null;
  const dirty = codeChanged || textChanged;

  const insert = (token: string) => {
    const field = area.current;
    const next = insertAt(
      text,
      token,
      field?.selectionStart ?? text.length,
      field?.selectionEnd ?? text.length,
    );
    setText(next.text);
    save.reset();
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(next.cursor, next.cursor);
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (codeProblem || textProblem || !dirty) return;
    save.mutate(
      {
        ...(reply ? { id: reply.id } : {}),
        ...(codeChanged ? { shortCode } : {}),
        ...(textChanged ? { content } : {}),
      },
      {
        onSuccess: () => {
          announce(
            t(reply ? 'inboxAlerts.library.replies.saved' : 'inboxAlerts.library.replies.added', {
              code: shortCode,
            }),
          );
          onDone();
        },
      },
    );
  };

  const shown = (problem: Problem | null, field: 'code' | 'text'): string | undefined =>
    (tried || (field === 'code' && refusedField(save.error, 'shortCode'))) && problem
      ? t(PROBLEMS[problem])
      : undefined;
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <TextField
        id="reply-code"
        label={t('inboxAlerts.library.replies.dialog.code')}
        hint={t('inboxAlerts.library.replies.dialog.codeHint')}
        value={code}
        maxLength={LIMITS.code + 20}
        autoComplete="off"
        onChange={(event) => {
          setCode(event.target.value);
          save.reset();
        }}
        error={shown(codeProblem, 'code')}
      />
      <TextareaField
        id="reply-text"
        ref={area}
        label={t('inboxAlerts.library.replies.dialog.text')}
        hint={t('inboxAlerts.library.replies.dialog.textHint', {
          number: formatNumber(LIMITS.text),
        })}
        value={text}
        maxLength={LIMITS.text}
        rows={6}
        onChange={(event) => setText(event.target.value)}
        error={shown(textProblem, 'text')}
      />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-text">
          {t('inboxAlerts.library.replies.dialog.details')}
        </legend>
        <p className="text-sm text-text-secondary">
          {t('inboxAlerts.library.replies.dialog.detailsHint')}
        </p>
        <div className="flex flex-wrap gap-2">
          {REPLY_DETAILS.map((detail) => (
            <Button
              key={detail.id}
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => insert(detail.token)}
              data-token={detail.token}
            >
              <PlusIcon aria-hidden="true" />
              {t(`inboxAlerts.library.replies.dialog.detail.${detail.id}`)}
            </Button>
          ))}
        </div>
      </fieldset>
      {refusedField(save.error, 'shortCode') ? null : <ActionError error={save.error} />}
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onDone}>
          {t('app.cancel')}
        </Button>
        <Button type="submit" busy={save.isPending} disabled={!dirty}>
          {t(
            reply
              ? 'inboxAlerts.library.replies.dialog.save'
              : 'inboxAlerts.library.replies.dialog.add',
          )}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * The brand's saved replies: what staff pick from the Saved replies button beside the reply box.
 * Adding, changing and deleting are for people who manage the inbox; the change reaches everyone
 * at once because the list lives in the chat account.
 */
export function RepliesSection({ brandId }: { brandId: string }) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const query = useLibraryReplies(brandId);
  const remove = useDeleteReply(brandId);
  const [editing, setEditing] = useState<SavedReplyRecord | 'new' | null>(null);
  const [deleting, setDeleting] = useState<SavedReplyRecord | null>(null);
  const [search, setSearch] = useState('');
  const items = query.data?.items ?? [];
  const reply = editing === 'new' ? null : editing;
  const otherCodes = items.filter((r) => r.id !== reply?.id).map((r) => r.shortCode.toLowerCase());
  const add = (
    <Button onClick={() => setEditing('new')} data-testid="add-reply">
      <PlusIcon aria-hidden="true" />
      {t('inboxAlerts.library.replies.add')}
    </Button>
  );
  return (
    <Section
      id="library-replies"
      title={t('inboxAlerts.library.replies.title')}
      description={t('inboxAlerts.library.replies.description')}
      actions={query.data && query.data.items.length > 0 ? add : null}
    >
      <QueryState
        query={query}
        label={t('inboxAlerts.library.loading')}
        isEmpty={(data) => data.items.length === 0}
        empty={
          <EmptyState
            kind="no-records"
            title={t('inboxAlerts.library.replies.empty.title')}
            description={t('inboxAlerts.library.replies.empty.description')}
            icon={<MessageSquareTextIcon className="size-6 text-text-muted" aria-hidden="true" />}
            action={add}
          />
        }
      >
        {(data) => {
          const shown = data.items.filter((r) => matches(r, search));
          return (
            <div className="flex flex-col gap-3">
              {data.items.length >= SEARCHABLE_FROM ? (
                <div className="max-w-sm">
                  <TextField
                    id="reply-search"
                    type="search"
                    label={t('inboxAlerts.library.replies.search')}
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </div>
              ) : null}
              {shown.length === 0 ? (
                <p role="status" className="text-sm text-text-secondary">
                  {t('inboxAlerts.library.replies.noMatch')}
                </p>
              ) : (
                <Table data-testid="reply-table">
                  <TableCaption className="sr-only">
                    {t('inboxAlerts.library.replies.table')}
                  </TableCaption>
                  <TableHeader>
                    <TableRow>
                      {(['code', 'text', 'actions'] as const).map((column) => (
                        <TableHead key={column} className="text-start">
                          {t(`inboxAlerts.library.replies.columns.${column}`)}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shown.map((item) => (
                      <TableRow key={item.id} data-testid="reply-row">
                        <TableCell className="min-w-28 align-top font-medium">
                          <bdi>{item.shortCode}</bdi>
                        </TableCell>
                        <TableCell className="max-w-lg min-w-48 align-top whitespace-normal">
                          <bdi dir="auto" className="line-clamp-3 whitespace-pre-line">
                            {item.content}
                          </bdi>
                        </TableCell>
                        <TableCell className="align-top">
                          <div className="flex flex-wrap gap-2">
                            <Button
                              variant="secondary"
                              size="sm"
                              aria-label={t('inboxAlerts.library.replies.editFor', {
                                code: item.shortCode,
                              })}
                              onClick={() => setEditing(item)}
                            >
                              <PencilIcon aria-hidden="true" />
                              {t('inboxAlerts.library.replies.edit')}
                            </Button>
                            <Button
                              variant="destructive"
                              size="sm"
                              aria-label={t('inboxAlerts.library.replies.deleteFor', {
                                code: item.shortCode,
                              })}
                              onClick={() => setDeleting(item)}
                            >
                              <Trash2Icon aria-hidden="true" />
                              {t('inboxAlerts.library.replies.delete')}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          );
        }}
      </QueryState>
      <AppDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={
          reply
            ? t('inboxAlerts.library.replies.dialog.editTitle', { code: reply.shortCode })
            : t('inboxAlerts.library.replies.dialog.addTitle')
        }
        description={t('inboxAlerts.library.replies.dialog.description')}
        testId="reply-dialog"
      >
        <ReplyForm
          key={reply?.id ?? 'new'}
          brandId={brandId}
          reply={reply}
          codes={otherCodes}
          onDone={() => setEditing(null)}
        />
      </AppDialog>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('inboxAlerts.library.replies.confirm.title', { code: deleting?.shortCode ?? '' })}
        confirmLabel={t('inboxAlerts.library.replies.confirm.action')}
        variant="destructive-solid"
        testId="delete-reply-dialog"
        onConfirm={async () => {
          if (!deleting) return;
          await remove.mutateAsync(deleting.id);
          announce(t('inboxAlerts.library.replies.deleted', { code: deleting.shortCode }));
        }}
      >
        <p>{t('inboxAlerts.library.replies.confirm.body')}</p>
      </ConfirmDialog>
    </Section>
  );
}
