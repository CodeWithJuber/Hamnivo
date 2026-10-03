import { z } from 'zod';
import { typeId } from './ids.js';

/**
 * The saved replies and tags of a brand's chat account, edited in Studio. They live in the
 * conversation authority (Chatwoot canned responses and labels) and are shared by every brand on
 * the same chat account. Changing them needs `inbox.manage` on the brand.
 */

const ShortCode = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[\p{L}\p{N}_-]+$/u, 'Letters, numbers, - and _ only');

export const SavedReplyRecord = z
  .object({
    id: typeId('savedReply'),
    shortCode: z.string(),
    content: z.string(),
  })
  .meta({ id: 'SavedReplyRecord' });
export type SavedReplyRecord = z.infer<typeof SavedReplyRecord>;

export const SavedReplyRecordList = z
  .object({ items: z.array(SavedReplyRecord) })
  .meta({ id: 'SavedReplyRecordList' });
export type SavedReplyRecordList = z.infer<typeof SavedReplyRecordList>;

export const SaveSavedReplyRequest = z
  .object({ shortCode: ShortCode, content: z.string().trim().min(1).max(5000) })
  .meta({ id: 'SaveSavedReplyRequest' });
export type SaveSavedReplyRequest = z.infer<typeof SaveSavedReplyRequest>;

export const UpdateSavedReplyRequest = z
  .object({
    shortCode: ShortCode.optional(),
    content: z.string().trim().min(1).max(5000).optional(),
  })
  .refine((v) => v.shortCode !== undefined || v.content !== undefined, {
    message: 'Send a short code, the text or both',
  })
  .meta({ id: 'UpdateSavedReplyRequest' });

/** A tag is named by its title: letters, numbers, - and _, lower case as the chat account keeps it. */
export const TagTitle = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .regex(/^[\p{L}\p{N}_-]+$/u, 'Letters, numbers, - and _ only');

const TagColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'A colour like #1F93FF');

export const TagRecord = z
  .object({
    title: z.string(),
    description: z.string().nullable(),
    color: z.string().nullable(),
  })
  .meta({ id: 'TagRecord' });
export type TagRecord = z.infer<typeof TagRecord>;

export const TagRecordList = z.object({ items: z.array(TagRecord) }).meta({ id: 'TagRecordList' });
export type TagRecordList = z.infer<typeof TagRecordList>;

export const CreateTagRequest = z
  .object({
    title: TagTitle,
    description: z.string().trim().max(200).optional(),
    color: TagColor.optional(),
  })
  .meta({ id: 'CreateTagRequest' });
export type CreateTagRequest = z.infer<typeof CreateTagRequest>;

export const UpdateTagRequest = z
  .object({
    title: TagTitle.optional(),
    description: z.string().trim().max(200).nullable().optional(),
    color: TagColor.optional(),
  })
  .refine((v) => v.title !== undefined || v.description !== undefined || v.color !== undefined, {
    message: 'Send a new name, a description, a colour or any of them',
  })
  .meta({ id: 'UpdateTagRequest' });
export type UpdateTagRequest = z.infer<typeof UpdateTagRequest>;
