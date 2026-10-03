import { z } from 'zod';
import {
  CreateTagRequest,
  SavedReplyRecord,
  SavedReplyRecordList,
  SaveSavedReplyRequest,
  TagRecord,
  TagRecordList,
  UpdateSavedReplyRequest,
  UpdateTagRequest,
} from './inbox-library.js';
import type { RouteDef } from './routes.js';

const brand = z.object({ brandId: z.string().meta({ description: 'Brand ID (brd_…)' }) });
const saved = brand.extend({
  savedReplyId: z.string().meta({ description: 'Saved reply ID (srp_…)' }),
});
const tagParams = brand.extend({
  title: z.string().meta({ description: 'The tag’s name, as listed' }),
});
const tags = ['Inbox library'];

/**
 * Saved replies and tags of the chat account a brand belongs to (Studio's editor). They are shared
 * by every brand on that account. Each route needs `inbox.manage` on the brand.
 */
export const inboxLibraryRoutes = {
  listBrandSavedReplies: {
    method: 'get',
    path: '/v1/admin/brands/{brandId}/saved-replies',
    operationId: 'listBrandSavedReplies',
    summary: 'The saved replies of the brand’s chat account (inbox.manage)',
    tags,
    auth: 'staff_session',
    params: brand,
    success: { status: 200, description: 'Saved replies', schema: SavedReplyRecordList },
  },
  createBrandSavedReply: {
    method: 'post',
    path: '/v1/admin/brands/{brandId}/saved-replies',
    operationId: 'createBrandSavedReply',
    summary: 'Add a saved reply for everyone on the chat account (inbox.manage)',
    tags,
    auth: 'staff_session',
    params: brand,
    body: SaveSavedReplyRequest,
    success: { status: 201, description: 'The saved reply', schema: SavedReplyRecord },
  },
  updateBrandSavedReply: {
    method: 'patch',
    path: '/v1/admin/brands/{brandId}/saved-replies/{savedReplyId}',
    operationId: 'updateBrandSavedReply',
    summary: 'Change a saved reply’s short code or text (inbox.manage)',
    tags,
    auth: 'staff_session',
    params: saved,
    body: UpdateSavedReplyRequest,
    success: { status: 200, description: 'The saved reply', schema: SavedReplyRecord },
  },
  deleteBrandSavedReply: {
    method: 'delete',
    path: '/v1/admin/brands/{brandId}/saved-replies/{savedReplyId}',
    operationId: 'deleteBrandSavedReply',
    summary: 'Delete a saved reply (inbox.manage)',
    tags,
    auth: 'staff_session',
    params: saved,
    success: { status: 204, description: 'Deleted' },
  },
  listBrandTags: {
    method: 'get',
    path: '/v1/admin/brands/{brandId}/tags',
    operationId: 'listBrandTags',
    summary: 'The tags of the brand’s chat account (inbox.manage)',
    tags,
    auth: 'staff_session',
    params: brand,
    success: { status: 200, description: 'Tags', schema: TagRecordList },
  },
  createBrandTag: {
    method: 'post',
    path: '/v1/admin/brands/{brandId}/tags',
    operationId: 'createBrandTag',
    summary: 'Add a tag staff can put on conversations (inbox.manage)',
    tags,
    auth: 'staff_session',
    params: brand,
    body: CreateTagRequest,
    success: { status: 201, description: 'The tag', schema: TagRecord },
  },
  updateBrandTag: {
    method: 'patch',
    path: '/v1/admin/brands/{brandId}/tags/{title}',
    operationId: 'updateBrandTag',
    summary:
      'Rename a tag or change its description or colour; conversations carrying it follow a rename (inbox.manage)',
    tags,
    auth: 'staff_session',
    params: tagParams,
    body: UpdateTagRequest,
    success: { status: 200, description: 'The tag', schema: TagRecord },
  },
  deleteBrandTag: {
    method: 'delete',
    path: '/v1/admin/brands/{brandId}/tags/{title}',
    operationId: 'deleteBrandTag',
    summary: 'Delete a tag; conversations that carry it lose it (inbox.manage)',
    tags,
    auth: 'staff_session',
    params: tagParams,
    success: { status: 204, description: 'Deleted' },
  },
} as const satisfies Record<string, RouteDef>;
