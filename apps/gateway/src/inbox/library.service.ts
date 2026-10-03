import { ChatwootError } from '@hamnivo/chatwoot';
import type {
  CreateTagRequest,
  SavedReplyRecord,
  SaveSavedReplyRequest,
  TagRecord,
  UpdateSavedReplyRequest,
  UpdateTagRequest,
} from '@hamnivo/contracts';
import { appendAudit, fromPublicId, schema, type TenantTx, toPublicId } from '@hamnivo/db';
import type { ActorCredential, AuthorityLabel, AuthoritySavedReply } from '@hamnivo/domain';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { authorityUnavailable } from '../authority/outbound.service.js';
import { AuthorityRegistry, type ConnectionRuntime } from '../authority/registry.js';
import { uuidV5 } from '../authority/uuid.js';
import { AppError } from '../common/app-error.js';
import { enforce } from '../identity/staff.guard.js';
import { brandConnectionId } from '../migration/destination.js';
import { CLOCK, type Clock } from '../tokens.js';
import { InboxAccess } from './access.js';
import { InboxSignals } from './signals.service.js';

/** The most conversations told at once that their tags changed (the rest catch up on reload). */
const SIGNAL_LIMIT = 500;

/** A brand's chat account. */
interface Library {
  brandPublicId: string;
  runtime: ConnectionRuntime;
}

/**
 * The library belongs to the chat account, not to a person: Hamnivo's `inbox.manage` is what lets
 * someone change it, and the chat service takes the change from the integration user (it allows
 * tags to administrators only, and keeps no author on a saved reply).
 */
const ADMIN: ActorCredential = { kind: 'integration' };

const tagView = (label: AuthorityLabel): TagRecord => ({
  title: label.title,
  description: label.description,
  color: label.color,
});

/** The same id a saved reply has in the composer's list, so the two never disagree. */
const replyId = (connectionId: string, reply: AuthoritySavedReply) =>
  toPublicId('savedReply', uuidV5(connectionId, `canned:${reply.ref}`));

const replyView = (connectionId: string, reply: AuthoritySavedReply): SavedReplyRecord => ({
  id: replyId(connectionId, reply) as SavedReplyRecord['id'],
  shortCode: reply.shortCode,
  content: reply.content,
});

const taken = (path: string, message: string) =>
  new AppError('VALIDATION_FAILED', { fields: [{ path, message }] });

/** What went wrong in the chat service, said in terms the person can act on. */
function refused(error: unknown, detail: string): AppError {
  if (error instanceof ChatwootError && error.status === 422) {
    return new AppError('VALIDATION_FAILED', {
      detail: 'The chat service did not accept this. Check that the name is not already used.',
      internal: error,
    });
  }
  if (error instanceof ChatwootError && error.status === 404) {
    return new AppError('NOT_FOUND', {
      detail: 'It was removed meanwhile. Reload the page and try again.',
      internal: error,
    });
  }
  return authorityUnavailable(error, detail);
}

/**
 * The saved replies and tags of a brand's chat account, edited in Studio (H04, H05). They live in
 * Chatwoot (canned responses and labels), so every change goes there first; Hamnivo keeps its own
 * copy of the tags on each conversation, which a rename or a delete updates. Changing anything needs
 * `inbox.manage` on the brand.
 */
@Injectable()
export class InboxLibraryService {
  constructor(
    private readonly access: InboxAccess,
    private readonly registry: AuthorityRegistry,
    private readonly signals: InboxSignals,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The brand's chat account, once the caller may manage inboxes for the brand. */
  private async open(principal: StaffPrincipal, brandPublicId: string): Promise<Library> {
    let brandId: string;
    try {
      brandId = fromPublicId('brand', brandPublicId);
    } catch {
      throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
    }
    const connectionId = await this.access.tx(principal, async (tx) => {
      const [brand] = await tx.select().from(schema.brands).where(eq(schema.brands.id, brandId));
      if (!brand) throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
      enforce(
        this.access.decide(principal, 'inbox.manage', { workspaceId: brand.workspaceId, brandId }),
      );
      return brandConnectionId(tx, brandId);
    });
    if (!connectionId) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'Chat is not set up for this brand yet, so it has no saved replies or tags.',
        reason: 'no_chat_account',
      });
    }
    return { brandPublicId, runtime: await this.registry.get(principal.tenantId, connectionId) };
  }

  private audit(
    principal: StaffPrincipal,
    library: Library,
    action: string,
    data: Record<string, unknown>,
    tx?: TenantTx,
  ) {
    const write = (inner: TenantTx) =>
      appendAudit(inner, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action,
        targetType: 'brand',
        targetId: library.brandPublicId,
        outcome: 'success',
        data,
      });
    return tx ? write(tx) : this.access.tx(principal, write);
  }

  // ------------------------------------------------------------------------------ saved replies

  private async replies(library: Library): Promise<AuthoritySavedReply[]> {
    try {
      return await library.runtime.authority.listSavedReplies(undefined, ADMIN);
    } catch (error) {
      throw refused(error, 'Saved replies could not be loaded. Please try again.');
    }
  }

  /** Another saved reply with this short code (the chat account keeps each short code once). */
  private shortCodeTaken(replies: AuthoritySavedReply[], shortCode: string, own?: string) {
    const wanted = shortCode.toLowerCase();
    return replies.some((r) => r.ref !== own && r.shortCode.toLowerCase() === wanted);
  }

  async savedReplies(
    principal: StaffPrincipal,
    brandId: string,
  ): Promise<{ items: SavedReplyRecord[] }> {
    const library = await this.open(principal, brandId);
    const replies = await this.replies(library);
    return {
      items: replies
        .map((r) => replyView(library.runtime.connectionId, r))
        .sort((a, b) => a.shortCode.localeCompare(b.shortCode)),
    };
  }

  async createSavedReply(
    principal: StaffPrincipal,
    brandId: string,
    input: SaveSavedReplyRequest,
  ): Promise<SavedReplyRecord> {
    const library = await this.open(principal, brandId);
    if (this.shortCodeTaken(await this.replies(library), input.shortCode)) {
      throw taken('shortCode', 'Another saved reply already uses this short code.');
    }
    let created: AuthoritySavedReply;
    try {
      created = await library.runtime.authority.createSavedReply(input, ADMIN);
    } catch (error) {
      throw refused(error, 'The saved reply could not be added. Please try again.');
    }
    await this.audit(principal, library, 'inbox.saved_reply_created', {
      shortCode: created.shortCode,
    });
    return replyView(library.runtime.connectionId, created);
  }

  async updateSavedReply(
    principal: StaffPrincipal,
    brandId: string,
    savedReplyId: string,
    input: UpdateSavedReplyRequest,
  ): Promise<SavedReplyRecord> {
    const library = await this.open(principal, brandId);
    const replies = await this.replies(library);
    const current = replies.find((r) => replyId(library.runtime.connectionId, r) === savedReplyId);
    if (!current) throw new AppError('NOT_FOUND', { detail: 'Saved reply not found.' });
    if (
      input.shortCode !== undefined &&
      this.shortCodeTaken(replies, input.shortCode, current.ref)
    ) {
      throw taken('shortCode', 'Another saved reply already uses this short code.');
    }
    let updated: AuthoritySavedReply;
    try {
      updated = await library.runtime.authority.updateSavedReply(
        current.ref,
        {
          ...(input.shortCode !== undefined ? { shortCode: input.shortCode } : {}),
          ...(input.content !== undefined ? { content: input.content } : {}),
        },
        ADMIN,
      );
    } catch (error) {
      throw refused(error, 'The saved reply could not be changed. Please try again.');
    }
    await this.audit(principal, library, 'inbox.saved_reply_updated', {
      shortCode: updated.shortCode,
      ...(updated.shortCode !== current.shortCode ? { was: current.shortCode } : {}),
      textChanged: updated.content !== current.content,
    });
    return replyView(library.runtime.connectionId, updated);
  }

  async deleteSavedReply(
    principal: StaffPrincipal,
    brandId: string,
    savedReplyId: string,
  ): Promise<void> {
    const library = await this.open(principal, brandId);
    const current = (await this.replies(library)).find(
      (r) => replyId(library.runtime.connectionId, r) === savedReplyId,
    );
    if (!current) throw new AppError('NOT_FOUND', { detail: 'Saved reply not found.' });
    try {
      await library.runtime.authority.deleteSavedReply(current.ref, ADMIN);
    } catch (error) {
      throw refused(error, 'The saved reply could not be deleted. Please try again.');
    }
    await this.audit(principal, library, 'inbox.saved_reply_deleted', {
      shortCode: current.shortCode,
    });
  }

  // ------------------------------------------------------------------------------------- tags

  private async labels(library: Library): Promise<AuthorityLabel[]> {
    try {
      return await library.runtime.authority.listLabels(ADMIN);
    } catch (error) {
      throw refused(error, 'Tags could not be loaded. Please try again.');
    }
  }

  /** The tag with this name (the chat account keeps tag names in lower case). */
  private find(labels: AuthorityLabel[], title: string): AuthorityLabel {
    const wanted = title.toLowerCase();
    const found = labels.find((l) => l.title.toLowerCase() === wanted);
    if (!found) throw new AppError('NOT_FOUND', { detail: 'Tag not found.' });
    return found;
  }

  async tags(principal: StaffPrincipal, brandId: string): Promise<{ items: TagRecord[] }> {
    const library = await this.open(principal, brandId);
    return {
      items: (await this.labels(library))
        .map(tagView)
        .sort((a, b) => a.title.localeCompare(b.title)),
    };
  }

  async createTag(
    principal: StaffPrincipal,
    brandId: string,
    input: CreateTagRequest,
  ): Promise<TagRecord> {
    const library = await this.open(principal, brandId);
    const title = input.title.toLowerCase();
    if ((await this.labels(library)).some((l) => l.title.toLowerCase() === title)) {
      throw taken('title', 'A tag with this name already exists.');
    }
    let created: AuthorityLabel;
    try {
      created = await library.runtime.authority.createLabel({
        title,
        ...(input.description ? { description: input.description } : {}),
        ...(input.color ? { color: input.color } : {}),
      });
    } catch (error) {
      throw refused(error, 'The tag could not be added. Please try again.');
    }
    await this.audit(principal, library, 'inbox.tag_created', { title: created.title });
    return tagView(created);
  }

  async updateTag(
    principal: StaffPrincipal,
    brandId: string,
    title: string,
    input: UpdateTagRequest,
  ): Promise<TagRecord> {
    const library = await this.open(principal, brandId);
    const labels = await this.labels(library);
    const current = this.find(labels, title);
    const next = input.title?.toLowerCase();
    if (next !== undefined && labels.some((l) => l.ref !== current.ref && l.title === next)) {
      throw taken('title', 'A tag with this name already exists.');
    }
    let updated: AuthorityLabel;
    try {
      updated = await library.runtime.authority.updateLabel(current.ref, {
        ...(next !== undefined ? { title: next } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
      });
    } catch (error) {
      throw refused(error, 'The tag could not be changed. Please try again.');
    }
    if (updated.title === current.title) {
      await this.audit(principal, library, 'inbox.tag_updated', { title: updated.title });
    } else {
      await this.followTag(principal, library, current.title, updated.title);
    }
    return tagView(updated);
  }

  /**
   * The chat account moves a renamed tag onto its conversations, and takes a deleted one off them,
   * a little later in a background job. This does the same to Hamnivo's copy (what the inbox
   * filters and shows) straight away, in one step with the audit entry, and tells open inboxes.
   * A deleted tag is taken off without any webhook, so nothing else would ever correct the copy;
   * a conversation that changes in the few seconds before the job runs can bring the tag back
   * until the next time it changes.
   */
  private async followTag(
    principal: StaffPrincipal,
    library: Library,
    from: string,
    to: string | null,
  ): Promise<void> {
    const state = schema.conversationInboxState;
    const control = schema.conversationControls;
    const changed = await this.access.tx(principal, async (tx) => {
      const rows = await tx
        .update(state)
        .set({
          labels:
            to === null
              ? sql`array_remove(${state.labels}, ${from})`
              : // The new name in the old one's place, once, with the order of the other tags kept.
                sql`(
                  select coalesce(array_agg(t.tag order by t.position), '{}'::text[])
                  from (
                    select distinct on (u.tag) u.tag, u.position
                    from unnest(array_replace(${state.labels}, ${from}, ${to})) with ordinality as u(tag, position)
                    order by u.tag, u.position
                  ) t
                )`,
          updatedAt: this.clock(),
        })
        .from(control)
        .where(
          and(
            eq(control.tenantId, state.tenantId),
            eq(control.id, state.conversationId),
            eq(control.connectionId, library.runtime.connectionId),
            sql`${state.labels} @> array[${from}]::text[]`,
          ),
        )
        .returning({ conversationId: state.conversationId });
      await this.audit(
        principal,
        library,
        to === null ? 'inbox.tag_deleted' : 'inbox.tag_renamed',
        to === null
          ? { title: from, conversations: rows.length }
          : { from, to, conversations: rows.length },
        tx,
      );
      return rows.map((row) => row.conversationId);
    });
    await this.signals.changed(principal.tenantId, changed.slice(0, SIGNAL_LIMIT));
  }

  async deleteTag(principal: StaffPrincipal, brandId: string, title: string): Promise<void> {
    const library = await this.open(principal, brandId);
    const current = this.find(await this.labels(library), title);
    try {
      await library.runtime.authority.deleteLabel(current.ref);
    } catch (error) {
      throw refused(error, 'The tag could not be deleted. Please try again.');
    }
    await this.followTag(principal, library, current.title, null);
  }
}
