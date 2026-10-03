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
import { PencilIcon, PlusIcon, TagsIcon, Trash2Icon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, ConfirmDialog, DialogFooter } from '../../components/AppDialog';
import { TextField } from '../../components/Fields';
import { Section } from '../../components/PageHeader';
import { ActionError, QueryState } from '../../components/States';
import { formatNumber } from '../../lib/format';
import {
  DEFAULT_TAG_COLOR,
  LIMITS,
  refusedField,
  TAG_PATTERN,
  type TagChange,
  type TagRecord,
  useDeleteTag,
  useLibraryTags,
  useSaveTag,
} from '../../lib/library';
import { ColorChoice, TagDot } from './ColorChoice';

/** What can be wrong with the form, and the words for it. */
const PROBLEMS = {
  nameRequired: 'inboxAlerts.library.tags.dialog.nameRequired',
  nameInvalid: 'inboxAlerts.library.tags.dialog.nameInvalid',
  nameTaken: 'inboxAlerts.library.tags.dialog.nameTaken',
} as const;
type Problem = keyof typeof PROBLEMS;

/** What the form would send: everything for a new tag, only what differs for an existing one. */
export function tagChange(
  tag: TagRecord | null,
  form: { name: string; description: string; color: string },
): TagChange {
  const title = form.name.trim().toLowerCase();
  const description = form.description.trim();
  if (!tag) {
    return { title, ...(description ? { description } : {}), color: form.color };
  }
  return {
    was: tag.title,
    ...(title !== tag.title ? { title } : {}),
    ...(description !== (tag.description ?? '').trim() ? { description: description || null } : {}),
    ...(form.color !== (tag.color ?? DEFAULT_TAG_COLOR).toLowerCase() ? { color: form.color } : {}),
  };
}

/** The name, description and colour of one tag, to add or change. */
export function TagForm({
  brandId,
  tag,
  names,
  onDone,
}: {
  brandId: string;
  tag: TagRecord | null;
  /** The names already in use (lower case), other than this tag's own. */
  names: string[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const save = useSaveTag(brandId);
  const [name, setName] = useState(tag?.title ?? '');
  const [description, setDescription] = useState(tag?.description ?? '');
  const [color, setColor] = useState((tag?.color ?? DEFAULT_TAG_COLOR).toLowerCase());
  const [tried, setTried] = useState(false);

  const title = name.trim();
  const change = tagChange(tag, { name, description, color });
  const renaming = tag !== null && change.title !== undefined;
  const dirty = tag === null || Object.keys(change).length > 1;
  const nameProblem: Problem | null =
    title === ''
      ? 'nameRequired'
      : title.length > LIMITS.tag || !TAG_PATTERN.test(title)
        ? 'nameInvalid'
        : names.includes(title.toLowerCase()) || refusedField(save.error, 'title')
          ? 'nameTaken'
          : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (nameProblem || !dirty) return;
    save.mutate(change, {
      onSuccess: () => {
        announce(
          t(tag ? 'inboxAlerts.library.tags.saved' : 'inboxAlerts.library.tags.added', {
            name: title.toLowerCase(),
          }),
        );
        onDone();
      },
    });
  };

  const say = (problem: Problem | null, show: boolean): string | undefined =>
    show && problem ? t(PROBLEMS[problem]) : undefined;
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <TextField
        id="tag-name"
        label={t('inboxAlerts.library.tags.dialog.name')}
        hint={t('inboxAlerts.library.tags.dialog.nameHint')}
        value={name}
        maxLength={LIMITS.tag + 20}
        autoComplete="off"
        onChange={(event) => {
          setName(event.target.value);
          save.reset();
        }}
        error={say(nameProblem, tried || refusedField(save.error, 'title'))}
      />
      {renaming ? (
        <p role="status" className="text-sm text-text-secondary" data-testid="rename-note">
          {t('inboxAlerts.library.tags.dialog.renameNote')}
        </p>
      ) : null}
      <TextField
        id="tag-description"
        label={t('inboxAlerts.library.tags.dialog.descriptionLabel')}
        hint={t('inboxAlerts.library.tags.dialog.descriptionHint', {
          number: formatNumber(LIMITS.description),
        })}
        value={description}
        maxLength={LIMITS.description}
        onChange={(event) => setDescription(event.target.value)}
      />
      <ColorChoice
        id="tag"
        legend={t('inboxAlerts.library.tags.dialog.color')}
        value={color}
        onChange={setColor}
      />
      {refusedField(save.error, 'title') ? null : <ActionError error={save.error} />}
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onDone}>
          {t('app.cancel')}
        </Button>
        <Button type="submit" busy={save.isPending} disabled={!dirty}>
          {t(tag ? 'inboxAlerts.library.tags.dialog.save' : 'inboxAlerts.library.tags.dialog.add')}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * The brand's tags: the list staff pick from when they tag a chat. Adding, renaming, recolouring
 * and deleting are for people who manage the inbox. A rename follows the chats that have the tag;
 * deleting only takes it off the list, so chats that already have it keep it.
 */
export function TagsSection({ brandId }: { brandId: string }) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const query = useLibraryTags(brandId);
  const remove = useDeleteTag(brandId);
  const [editing, setEditing] = useState<TagRecord | 'new' | null>(null);
  const [deleting, setDeleting] = useState<TagRecord | null>(null);
  const tag = editing === 'new' ? null : editing;
  const otherNames = (query.data?.items ?? [])
    .filter((item) => item.title !== tag?.title)
    .map((item) => item.title.toLowerCase());
  const add = (
    <Button onClick={() => setEditing('new')} data-testid="add-tag">
      <PlusIcon aria-hidden="true" />
      {t('inboxAlerts.library.tags.add')}
    </Button>
  );
  return (
    <Section
      id="library-tags"
      title={t('inboxAlerts.library.tags.title')}
      description={t('inboxAlerts.library.tags.description')}
      actions={query.data && query.data.items.length > 0 ? add : null}
    >
      <QueryState
        query={query}
        label={t('inboxAlerts.library.loading')}
        isEmpty={(data) => data.items.length === 0}
        empty={
          <EmptyState
            kind="no-records"
            title={t('inboxAlerts.library.tags.empty.title')}
            description={t('inboxAlerts.library.tags.empty.description')}
            icon={<TagsIcon className="size-6 text-text-muted" aria-hidden="true" />}
            action={add}
          />
        }
      >
        {(data) => (
          <Table data-testid="tag-table">
            <TableCaption className="sr-only">{t('inboxAlerts.library.tags.table')}</TableCaption>
            <TableHeader>
              <TableRow>
                {(['name', 'description', 'actions'] as const).map((column) => (
                  <TableHead key={column} className="text-start">
                    {t(`inboxAlerts.library.tags.columns.${column}`)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((item) => (
                <TableRow key={item.title} data-testid="tag-row">
                  <TableCell className="min-w-28 align-top font-medium">
                    <span className="flex items-center gap-2">
                      <TagDot color={item.color} />
                      <bdi>{item.title}</bdi>
                    </span>
                  </TableCell>
                  <TableCell className="max-w-md min-w-40 align-top whitespace-normal text-text-secondary">
                    {item.description ? <bdi dir="auto">{item.description}</bdi> : '—'}
                  </TableCell>
                  <TableCell className="align-top">
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        aria-label={t('inboxAlerts.library.tags.editFor', { name: item.title })}
                        onClick={() => setEditing(item)}
                      >
                        <PencilIcon aria-hidden="true" />
                        {t('inboxAlerts.library.tags.edit')}
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        aria-label={t('inboxAlerts.library.tags.deleteFor', { name: item.title })}
                        onClick={() => setDeleting(item)}
                      >
                        <Trash2Icon aria-hidden="true" />
                        {t('inboxAlerts.library.tags.delete')}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </QueryState>
      <AppDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={
          tag
            ? t('inboxAlerts.library.tags.dialog.editTitle', { name: tag.title })
            : t('inboxAlerts.library.tags.dialog.addTitle')
        }
        description={t('inboxAlerts.library.tags.dialog.description')}
        testId="tag-dialog"
      >
        <TagForm
          key={tag?.title ?? 'new'}
          brandId={brandId}
          tag={tag}
          names={otherNames}
          onDone={() => setEditing(null)}
        />
      </AppDialog>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('inboxAlerts.library.tags.confirm.title', { name: deleting?.title ?? '' })}
        confirmLabel={t('inboxAlerts.library.tags.confirm.action')}
        variant="destructive-solid"
        testId="delete-tag-dialog"
        onConfirm={async () => {
          if (!deleting) return;
          await remove.mutateAsync(deleting.title);
          announce(t('inboxAlerts.library.tags.deleted', { name: deleting.title }));
        }}
      >
        <p>{t('inboxAlerts.library.tags.confirm.body')}</p>
      </ConfirmDialog>
    </Section>
  );
}
