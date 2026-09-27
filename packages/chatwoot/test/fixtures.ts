import { readFileSync } from 'node:fs';

type Json = Record<string, unknown>;

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/v4.18.0/${name}`, import.meta.url), 'utf8'));

/** Payloads captured from a real Chatwoot v4.18.0-ce (credentials and source ids scrubbed). */
export const api = read('api.json') as Record<string, Json>;
export const webhooks = read('webhooks.json') as Array<{
  source: 'account' | 'inbox' | 'bot';
  event: string;
  payload: Json;
}>;
