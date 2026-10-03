import { createHash } from 'node:crypto';
import {
  ATTACHMENT_TYPES,
  type AttachmentPart,
  type AttachmentRejection,
  type AttachmentType,
} from '@hamnivo/contracts';
import { type Db, fromPublicId, schema, type TenantTx, toPublicId, withTenant } from '@hamnivo/db';
import type { AuthorityAttachment, OutgoingAttachment } from '@hamnivo/domain';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, count, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { fileTypeFromBuffer } from 'file-type';
import type { z } from 'zod';
import { attachmentPublicId } from '../authority/extended-parts.js';
import { authorityUnavailable } from '../authority/outbound.service.js';
import { AuthorityRegistry } from '../authority/registry.js';
import { authorityMessageUuid } from '../authority/uuid.js';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import type { Scanner, ScanVerdict } from '../knowledge/scanner.js';
import { APP_DB, CLOCK, type Clock } from '../tokens.js';
import { AuthorityContactsService } from './contacts.service.js';
import { brandSurface } from './settings.service.js';
import type { WidgetClaims } from './tokens.service.js';

/** The scanner for customer files (ClamAV in production; see surface.module.ts). */
export const ATTACHMENT_SCANNER = Symbol('ATTACHMENT_SCANNER');

/**
 * Whether customer files can be scanned: ClamAV, or the EICAR check outside production. Without
 * it the widget does not offer files, and every upload is refused.
 */
export const filesScannable = (config: Pick<AppConfig, 'CLAMAV_URL' | 'NODE_ENV'>) =>
  Boolean(config.CLAMAV_URL) || config.NODE_ENV !== 'production';

/** How long a scanned file waits in quarantine to be sent. */
const QUARANTINE_MS = 24 * 60 * 60_000;
/** Longest wait for the scanner; a scan that does not finish is a refusal. */
const SCAN_TIMEOUT_MS = 30_000;
/** Uploads one visitor may make in ten minutes (refused ones included). */
const UPLOADS_PER_10_MINUTES = 30;

const EXTENSIONS: Record<AttachmentType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
};
const SERVED_TYPES = new Set<string>(ATTACHMENT_TYPES);

/**
 * A file name that is safe to show and store: no path, no control or direction-override
 * characters, at most 120 characters, and the extension of the type found in the bytes.
 */
export function cleanFileName(raw: string, mimeType: AttachmentType): string {
  const base = raw
    .normalize('NFC')
    .split(/[\\/]/)
    .pop()
    ?.replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .trim();
  const stem =
    (base ?? '')
      .replace(/\.[^.]{1,10}$/, '')
      .slice(0, 120)
      .trim() || 'file';
  return `${stem}.${EXTENSIONS[mimeType]}`;
}

/** The type of a file from its bytes (W09); the name and the declared type are never trusted. */
export async function sniff(bytes: Uint8Array): Promise<string | null> {
  return (await fileTypeFromBuffer(bytes))?.mime ?? null;
}

function rejected(reason: AttachmentRejection, detail: string): AppError {
  return new AppError(reason === 'too_large' ? 'UPLOAD_TOO_LARGE' : 'UPLOAD_REJECTED', {
    detail,
    reason,
  });
}

type UploadRow = typeof schema.widgetUploads.$inferSelect;

function partOf(row: UploadRow): z.infer<typeof AttachmentPart> {
  return {
    type: 'attachment',
    uploadId: toPublicId('upload', row.id),
    name: row.name,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    status: row.status === 'rejected' ? 'rejected' : 'available',
    ...(row.rejectionReason ? { rejectionReason: row.rejectionReason as AttachmentRejection } : {}),
  };
}

/**
 * Customer files (W09). An upload waits in quarantine: its type is read from its bytes, the brand's
 * size, count and type limits apply, and the scanner (ClamAV in production) must pass it; any
 * scanner failure refuses the file. Only then can a message carry it to the conversation
 * authority, which owns it afterwards. Downloads go through here too: the caller must see the
 * conversation, and the file is scanned again on its way out.
 */
@Injectable()
export class WidgetAttachmentsService {
  private readonly logger = new Logger(WidgetAttachmentsService.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ATTACHMENT_SCANNER) private readonly scanner: Scanner,
    private readonly registry: AuthorityRegistry,
    private readonly contacts: AuthorityContactsService,
  ) {}

  private tx<T>(claims: WidgetClaims, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: claims.tenantId, actorId: toPublicId('customer', claims.principalId) },
      work,
    );
  }

  /** The principal's own conversation, or NOT_FOUND (never "forbidden"). */
  private async own(tx: TenantTx, claims: WidgetClaims, conversationId: string) {
    const [control] = await tx
      .select()
      .from(schema.conversationControls)
      .where(
        and(
          eq(schema.conversationControls.id, conversationId),
          eq(schema.conversationControls.principalId, claims.principalId),
        ),
      );
    if (!control) throw new AppError('NOT_FOUND', { detail: 'Conversation not found.' });
    return control;
  }

  /** A scan that fails, throws or takes too long is a refusal (fail closed). */
  private async scan(bytes: Uint8Array): Promise<ScanVerdict> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.scanner.scan(bytes),
        new Promise<ScanVerdict>((resolve) => {
          timer = setTimeout(
            () => resolve({ clean: false, engine: 'timeout', reason: 'scan_unavailable' }),
            SCAN_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      this.logger.warn(`scanner failed: ${String(error)}`);
      return { clean: false, engine: 'error', reason: 'scan_unavailable' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async upload(
    claims: WidgetClaims,
    conversationPublicId: string,
    rawName: string,
    bytes: Buffer,
  ): Promise<z.infer<typeof AttachmentPart>> {
    const conversationId = fromPublicId('conversation', conversationPublicId);
    const now = this.clock();
    const limits = await this.tx(claims, async (tx) => {
      await this.own(tx, claims, conversationId);
      const { settings } = await brandSurface(tx, claims.brandId);
      const u = schema.widgetUploads;
      const [recent] = await tx
        .select({ n: count() })
        .from(u)
        .where(
          and(
            eq(u.principalId, claims.principalId),
            gt(u.createdAt, new Date(now.getTime() - 10 * 60_000)),
          ),
        );
      const [waiting] = await tx
        .select({ n: count() })
        .from(u)
        .where(
          and(
            eq(u.conversationId, conversationId),
            eq(u.principalId, claims.principalId),
            eq(u.status, 'available'),
            isNull(u.clientMessageId),
          ),
        );
      return {
        attachments: settings.attachments,
        recent: recent?.n ?? 0,
        waiting: waiting?.n ?? 0,
      };
    });
    const { attachments } = limits;
    if (!attachments.enabled) {
      throw new AppError('FEATURE_DISABLED', { detail: 'Files can’t be sent in this chat.' });
    }
    if (limits.recent >= UPLOADS_PER_10_MINUTES) {
      throw new AppError('RATE_LIMITED', {
        detail: 'Too many files in a short time. Please wait a few minutes.',
        retryAfter: 60,
      });
    }
    const maxBytes = attachments.maxMegabytes * 1024 * 1024;
    if (bytes.length > maxBytes) {
      throw rejected('too_large', `Files can be up to ${attachments.maxMegabytes} MB.`);
    }
    if (bytes.length === 0) throw rejected('unreadable', 'The file is empty.');
    if (limits.waiting >= attachments.maxFiles) {
      throw rejected('too_many', `Send up to ${attachments.maxFiles} files in one message.`);
    }
    const detected = await sniff(bytes);
    const allowed = attachments.allowedTypes as readonly string[];
    const sha256 = createHash('sha256').update(bytes).digest();
    const record = (status: 'available' | 'rejected', extra: Partial<UploadRow>) =>
      this.tx(claims, async (tx) => {
        const [row] = await tx
          .insert(schema.widgetUploads)
          .values({
            tenantId: claims.tenantId,
            brandId: claims.brandId,
            conversationId,
            principalId: claims.principalId,
            name: extra.name ?? 'file',
            mimeType: extra.mimeType ?? 'application/octet-stream',
            sizeBytes: bytes.length,
            sha256,
            status,
            rejectionReason: extra.rejectionReason ?? null,
            scanEngine: extra.scanEngine ?? null,
            scannedAt: extra.scannedAt ?? null,
            content: status === 'available' ? bytes : null,
            expiresAt: new Date(now.getTime() + QUARANTINE_MS),
          })
          .returning();
        if (!row) throw new Error('upload insert returned nothing');
        return row;
      });
    if (!detected || !allowed.includes(detected)) {
      await record('rejected', {
        mimeType: detected ?? 'application/octet-stream',
        rejectionReason: 'type_not_allowed',
      });
      throw rejected(
        'type_not_allowed',
        'This type of file can’t be sent here. Send a picture (PNG, JPEG, WebP or GIF) or a PDF.',
      );
    }
    const type = detected as AttachmentType;
    const name = cleanFileName(rawName, type);
    const verdict = await this.scan(bytes);
    if (!verdict.clean) {
      const reason = verdict.reason === 'malware' ? 'malware_detected' : 'scan_unavailable';
      await record('rejected', {
        name,
        mimeType: type,
        rejectionReason: reason,
        scanEngine: verdict.engine,
        scannedAt: this.clock(),
      });
      throw rejected(
        reason,
        reason === 'malware_detected'
          ? 'This file was refused because it may be harmful.'
          : 'This file couldn’t be checked for viruses right now, so it wasn’t accepted. Please try again later.',
      );
    }
    const row = await record('available', {
      name,
      mimeType: type,
      scanEngine: verdict.engine,
      scannedAt: this.clock(),
    });
    return partOf(row);
  }

  /**
   * Claims scanned uploads for one message. A retry of the same message (same client message id)
   * may claim them again; another message may not. Returns the files in the order given.
   */
  async reserve(
    tx: TenantTx,
    claims: WidgetClaims,
    conversationId: string,
    uploadPublicIds: readonly string[],
    clientMessageId: string,
  ): Promise<{ ids: string[]; files: OutgoingAttachment[]; alreadySent: boolean }> {
    const { settings } = await brandSurface(tx, claims.brandId);
    if (!settings.attachments.enabled) {
      throw new AppError('FEATURE_DISABLED', { detail: 'Files can’t be sent in this chat.' });
    }
    if (uploadPublicIds.length > settings.attachments.maxFiles) {
      throw rejected(
        'too_many',
        `Send up to ${settings.attachments.maxFiles} files in one message.`,
      );
    }
    let ids: string[];
    try {
      ids = uploadPublicIds.map((id) => fromPublicId('upload', id));
    } catch {
      throw new AppError('UPLOAD_REJECTED', { detail: 'Unknown file.', reason: 'unreadable' });
    }
    if (new Set(ids).size !== ids.length) {
      throw new AppError('VALIDATION_FAILED', { detail: 'The same file is attached twice.' });
    }
    const u = schema.widgetUploads;
    const rows = await tx
      .select()
      .from(u)
      .where(
        and(
          inArray(u.id, ids),
          eq(u.conversationId, conversationId),
          eq(u.principalId, claims.principalId),
        ),
      )
      .for('update');
    const byId = new Map(rows.map((row) => [row.id, row]));
    const files: OutgoingAttachment[] = [];
    let sent = 0;
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) {
        throw new AppError('UPLOAD_REJECTED', {
          detail: 'One of the files is not available. Please attach it again.',
          reason: 'unreadable',
        });
      }
      if (row.clientMessageId && row.clientMessageId !== clientMessageId) {
        throw new AppError('UPLOAD_REJECTED', {
          detail: 'This file was already sent with another message.',
          reason: 'unreadable',
        });
      }
      if (row.status === 'sent' && row.clientMessageId === clientMessageId) {
        sent += 1;
        continue;
      }
      if (row.status !== 'available' || !row.content) {
        throw new AppError('UPLOAD_REJECTED', {
          detail:
            row.status === 'rejected'
              ? 'This file was refused and can’t be sent.'
              : 'This file waited too long and was removed. Please attach it again.',
          reason: (row.rejectionReason as AttachmentRejection | null) ?? 'unreadable',
        });
      }
      files.push({ name: row.name, mimeType: row.mimeType, bytes: row.content });
    }
    if (sent > 0 && sent < ids.length) {
      throw new AppError('UPLOAD_REJECTED', {
        detail: 'Some of these files were already sent. Please attach them again.',
        reason: 'unreadable',
      });
    }
    await tx
      .update(u)
      .set({ clientMessageId })
      .where(and(inArray(u.id, ids), isNull(u.clientMessageId)));
    return { ids, files, alreadySent: sent === ids.length };
  }

  /** The authority owns the files now: the quarantined copies are dropped. */
  async markSent(claims: WidgetClaims, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const u = schema.widgetUploads;
    const l = schema.messageLedger;
    await this.tx(claims, (tx) =>
      tx
        .update(u)
        .set({
          status: 'sent',
          content: null,
          // The authority's id of the message, as the ledger recorded it.
          authorityMessageId: sql`(select ${l.authorityMessageId} from ${l}
            where ${l.conversationId} = ${u.conversationId} and ${l.senderKind} = 'customer'
              and ${l.senderId} = ${u.principalId}::text
              and ${l.clientMessageId} = ${u.clientMessageId}
            limit 1)`,
          sentAt: this.clock(),
        })
        .where(and(inArray(u.id, [...ids]), eq(u.status, 'available'))),
    );
  }

  /**
   * A file from one of the caller's conversations, as the customer view of the authority lists
   * it (private notes and their files are never in that view). The bytes are scanned on the way
   * out; a refused or unscannable file is not served.
   */
  async download(
    claims: WidgetClaims,
    conversationPublicId: string,
    attachmentId: string,
  ): Promise<{ bytes: Uint8Array; contentType: string; name: string }> {
    const conversationId = fromPublicId('conversation', conversationPublicId);
    fromPublicId('upload', attachmentId);
    const context = await this.tx(claims, async (tx) => {
      const control = await this.own(tx, claims, conversationId);
      const [contact] = await tx
        .select()
        .from(schema.authorityContacts)
        .where(
          and(
            eq(schema.authorityContacts.inboxId, control.inboxId),
            eq(schema.authorityContacts.principalId, claims.principalId),
          ),
        );
      const [inbox] = await tx
        .select({ externalInboxId: schema.authorityInboxes.externalInboxId })
        .from(schema.authorityInboxes)
        .where(eq(schema.authorityInboxes.id, control.inboxId));
      return {
        control,
        inbox,
        sourceId: contact ? this.contacts.sourceIdOf(claims.tenantId, contact) : null,
      };
    });
    const notFound = () => new AppError('NOT_FOUND', { detail: 'File not found.' });
    if (!context.sourceId || !context.inbox) throw notFound();
    const runtime = await this.registry.get(claims.tenantId, context.control.connectionId);
    let found: AuthorityAttachment | undefined;
    try {
      const messages = await runtime.authority.listMessages(
        String(context.control.externalConversationId),
        {
          view: 'customer',
          contactSourceId: context.sourceId,
          inboxRef: String(context.inbox.externalInboxId),
        },
      );
      for (const message of messages) {
        if (message.contentAttributes.deleted === true) continue;
        const messageId = toPublicId(
          'message',
          authorityMessageUuid(context.control.connectionId, message.ref),
        );
        found = message.attachments.find(
          (a) => a.url && attachmentPublicId(messageId, a.ref) === attachmentId,
        );
        if (found) break;
      }
    } catch (error) {
      throw authorityUnavailable(error, 'The file could not be loaded. Please try again.');
    }
    if (!found) throw notFound();
    let file: { bytes: Uint8Array; contentType: string | null };
    try {
      file = await runtime.authority.downloadAttachment(found);
    } catch (error) {
      throw authorityUnavailable(error, 'The file could not be loaded. Please try again.');
    }
    const verdict = await this.scan(file.bytes);
    if (!verdict.clean) {
      throw new AppError('UPLOAD_REJECTED', {
        detail:
          verdict.reason === 'malware'
            ? 'This file was blocked because it may be harmful.'
            : 'This file couldn’t be checked for viruses right now. Please try again later.',
        reason: verdict.reason === 'malware' ? 'malware_detected' : 'scan_unavailable',
      });
    }
    // The type comes from the bytes, never from the name or the authority. Pictures and PDFs keep
    // theirs (the widget shows previews); anything else is served as plain bytes.
    const detected = await sniff(file.bytes);
    return {
      bytes: file.bytes,
      contentType:
        detected !== null && SERVED_TYPES.has(detected) ? detected : 'application/octet-stream',
      name: found.name ?? 'file',
    };
  }
}
