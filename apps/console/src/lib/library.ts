/**
 * Saved replies and tags in Studio: the two lists a brand's team shares, edited by people who
 * manage the inbox. They live in the brand's chat account; the gateway decides who may change them
 * and keeps the inbox in step. This file asks for them and holds the choices the forms offer.
 */
import type * as C from '@hamnivo/contracts';
import { api, isApiError } from './api';
import { useStudioMutation, useStudioQuery } from './queries';
import { useTenant } from './tenant';

export type SavedReplyRecord = C.SavedReplyRecord;
export type TagRecord = C.TagRecord;

export const libraryKeys = {
  all: (brandId: string) => ['library', brandId] as const,
  replies: (brandId: string) => ['library', brandId, 'replies'] as const,
  tags: (brandId: string) => ['library', brandId, 'tags'] as const,
};

const base = (brandId: string) => `/v1/admin/brands/${encodeURIComponent(brandId)}`;

/** What a change reloads: the lists here, and the inbox views that show tags and saved replies. */
const reloads = (brandId: string) =>
  [libraryKeys.all(brandId), ['inbox', 'list'], ['inbox', 'conversation']] as const;

export function useLibraryReplies(brandId: string) {
  const { can } = useTenant();
  return useStudioQuery<{ items: SavedReplyRecord[] }>(
    libraryKeys.replies(brandId),
    `${base(brandId)}/saved-replies`,
    { enabled: brandId !== '' && can('inbox.manage') },
  );
}

export function useLibraryTags(brandId: string) {
  const { can } = useTenant();
  return useStudioQuery<{ items: TagRecord[] }>(
    libraryKeys.tags(brandId),
    `${base(brandId)}/tags`,
    { enabled: brandId !== '' && can('inbox.manage') },
  );
}

/** Adds a saved reply, or (with an id) changes the short code or the text it already has. */
export function useSaveReply(brandId: string) {
  return useStudioMutation<{ id?: string; shortCode?: string; content?: string }, SavedReplyRecord>(
    ({ id, ...body }, tenant) => {
      const path = `${base(brandId)}/saved-replies${id ? `/${encodeURIComponent(id)}` : ''}`;
      return api<SavedReplyRecord>(path, { method: id ? 'PATCH' : 'POST', tenant, body });
    },
    reloads(brandId),
  );
}

export function useDeleteReply(brandId: string) {
  return useStudioMutation<string, undefined>(
    (id, tenant) =>
      api<undefined>(`${base(brandId)}/saved-replies/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        tenant,
      }),
    reloads(brandId),
  );
}

/** What a tag form sends: all of it for a new tag, only what changed for an existing one. */
export interface TagChange {
  /** The tag's current name when it already exists. */
  was?: string;
  title?: string;
  description?: string | null;
  color?: string;
}

export function useSaveTag(brandId: string) {
  return useStudioMutation<TagChange, TagRecord>(({ was, ...body }, tenant) => {
    const path = `${base(brandId)}/tags${was ? `/${encodeURIComponent(was)}` : ''}`;
    return api<TagRecord>(path, { method: was ? 'PATCH' : 'POST', tenant, body });
  }, reloads(brandId));
}

export function useDeleteTag(brandId: string) {
  return useStudioMutation<string, undefined>(
    (title, tenant) =>
      api<undefined>(`${base(brandId)}/tags/${encodeURIComponent(title)}`, {
        method: 'DELETE',
        tenant,
      }),
    reloads(brandId),
  );
}

// ------------------------------------------------------------------ what the forms offer

/** The ready-made colours a tag can have, Chatwoot's own blue first. */
export const TAG_COLORS = [
  { id: 'blue', hex: '#1f93ff' },
  { id: 'green', hex: '#16a34a' },
  { id: 'teal', hex: '#0d9488' },
  { id: 'orange', hex: '#ea580c' },
  { id: 'red', hex: '#dc2626' },
  { id: 'pink', hex: '#db2777' },
  { id: 'purple', hex: '#7c3aed' },
  { id: 'grey', hex: '#6b7280' },
] as const;

export type TagColorId = (typeof TAG_COLORS)[number]['id'];

/** What a new tag gets: the same blue the chat account would pick. */
export const DEFAULT_TAG_COLOR: string = TAG_COLORS[0].hex;

/** The ready-made colour with this value (any letter case), or undefined for one made elsewhere. */
export function paletteColor(hex: string | null | undefined) {
  const wanted = hex?.toLowerCase();
  return TAG_COLORS.find((color) => color.hex === wanted);
}

/** Details the chat account fills in from the conversation when a saved reply is used. */
export const REPLY_DETAILS = [
  { id: 'firstName', token: '{{contact.first_name}}' },
  { id: 'name', token: '{{contact.name}}' },
  { id: 'agent', token: '{{agent.name}}' },
  { id: 'brand', token: '{{inbox.name}}' },
] as const;

export type ReplyDetailId = (typeof REPLY_DETAILS)[number]['id'];

/** `text` with `token` where the cursor was (replacing what was selected); the cursor goes after it. */
export function insertAt(
  text: string,
  token: string,
  start: number,
  end: number,
): { text: string; cursor: number } {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  return { text: `${text.slice(0, from)}${token}${text.slice(to)}`, cursor: from + token.length };
}

/** What staff type to find a saved reply: letters (with their marks) and numbers, - and _. */
export const CODE_PATTERN = /^[\p{L}\p{M}\p{N}_-]+$/u;

/**
 * A tag's name, by the chat service's own rule: two characters or more, letters and numbers with -
 * and _ , not starting with - or _ . Its letters are Unicode letters without combining marks, so a
 * word written with vowel signs (as in Hindi) is refused there.
 */
export const TAG_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_-]+$/u;

export const LIMITS = { code: 40, text: 5000, tag: 50, description: 200 } as const;

/** Which part of a form the gateway refused, by the field it named. */
export function refusedField(error: unknown, path: string): boolean {
  return isApiError(error, 'VALIDATION_FAILED') && error.fields.some((f) => f.path === path);
}

/** True when the brand has no chat account yet, so there is nothing to list. */
export function isNotSetUp(error: unknown): boolean {
  return isApiError(error, 'VALIDATION_FAILED') && error.problem?.reason === 'no_chat_account';
}
