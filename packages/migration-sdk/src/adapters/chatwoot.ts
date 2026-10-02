import type { SourceDescriptor } from '../types.js';

/**
 * Another Chatwoot account, read through its Application API with a token (M04). The reader
 * (in the gateway, which holds the credential) writes what it reads as a Hamnivo package, so the
 * snapshot is checked, previewed and imported like any uploaded export.
 */

/** Conversations one import reads; a later import of the same account continues after them. */
export const CHATWOOT_SNAPSHOT_DEFAULT = 1000;

export const chatwootDescriptor: SourceDescriptor = {
  system: 'chatwoot',
  accepts: ['api'],
  fields: [
    {
      source: 'conversation.id',
      target: 'conversation.source_id',
      status: 'supported',
      required: true,
    },
    { source: 'conversation.status', target: 'conversation.status', status: 'supported' },
    { source: 'conversation.created_at', target: 'conversation.started_at', status: 'supported' },
    {
      source: 'conversation.custom_attributes',
      target: 'conversation.attribute',
      status: 'transformed',
    },
    { source: 'conversation.labels', target: 'conversation.labels', status: 'unsupported' },
    { source: 'conversation.assignee', target: 'conversation.assignee', status: 'unsupported' },
    { source: 'conversation.team', target: 'conversation.team', status: 'unsupported' },
    { source: 'message.content', target: 'message.text', status: 'supported' },
    { source: 'message.private', target: 'message.visibility', status: 'supported' },
    {
      source: 'message.created_at',
      target: 'message.original_time',
      status: 'supported',
      required: true,
    },
    { source: 'message.sender', target: 'message.author', status: 'supported' },
    { source: 'message.attachments', target: 'attachment.file', status: 'supported' },
    { source: 'message.activity', target: 'message.kind', status: 'unsupported' },
    { source: 'contact.name', target: 'contact.name', status: 'supported' },
    { source: 'contact.email', target: 'contact.unverified_email', status: 'transformed' },
    { source: 'contact.phone_number', target: 'contact.unverified_phone', status: 'transformed' },
    { source: 'contact.custom_attributes', target: 'contact.attribute', status: 'transformed' },
    { source: 'contact.identifier', target: 'contact.identifier', status: 'unsupported' },
  ],
  limits: [
    { code: 'chatwoot_snapshot_cap', severity: 'warning' },
    { code: 'chatwoot_agent_scope', severity: 'info' },
    { code: 'chatwoot_activity', severity: 'info' },
    { code: 'chatwoot_unverified_contacts', severity: 'info' },
    { code: 'chatwoot_token_once', severity: 'info' },
  ],
};
