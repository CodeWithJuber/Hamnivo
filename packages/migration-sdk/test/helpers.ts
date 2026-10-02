import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync } from 'fflate';

/**
 * The tawk.to fixtures follow the export shape tawk.to documents (help centre, "How do I convert
 * JSON files?", and the chat transcript webhook): one JSON file per chat, or an array of chats.
 * Names, addresses and IDs are made up.
 */
export const TAWK_DIR = join(import.meta.dirname, 'fixtures', 'tawk');

export function tawkFiles(): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const name of readdirSync(TAWK_DIR).sort()) {
    files.set(`Northline Studio chats/${name}`, readFileSync(join(TAWK_DIR, name)));
  }
  return files;
}

/**
 * Zendesk fixtures follow its full JSON export: NDJSON with `{"ticket": {…}}` per line (Support API
 * ticket and comment fields), the users export, and an error file for tickets over 1 MB (its exact
 * shape is not documented: a line with the ticket ID and an error). Intercom fixtures are
 * conversations and contacts as its REST API returns them. People and IDs are made up.
 */
export const ZENDESK_DIR = join(import.meta.dirname, 'fixtures', 'zendesk');
export const INTERCOM_DIR = join(import.meta.dirname, 'fixtures', 'intercom');

/** The files of a fixture folder, optionally without some of them. */
export function fixtureFiles(dir: string, except: string[] = []): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const name of readdirSync(dir).sort()) {
    if (except.some((part) => name.includes(part))) continue;
    files.set(`export/${name}`, readFileSync(join(dir, name)));
  }
  return files;
}

/**
 * The Zendesk export as Zendesk names its files: NDJSON with a `.json` extension. (The fixtures are
 * stored as `.ndjson` so formatters leave them line by line.)
 */
export function zendeskFiles(except: string[] = []): Map<string, Uint8Array> {
  return new Map(
    [...fixtureFiles(ZENDESK_DIR, except)].map(([name, bytes]) => [
      name.replace(/\.ndjson$/, '.json'),
      bytes,
    ]),
  );
}

export const ndjson = (values: unknown[]) =>
  new TextEncoder().encode(values.map((value) => `${JSON.stringify(value)}\n`).join(''));

export function zip(files: Map<string, Uint8Array>): Uint8Array {
  return zipSync(Object.fromEntries(files));
}

export const tawkZip = () => zip(tawkFiles());

export function tawkChat(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'chat',
    visitor: { name: `Visitor ${id}`, id: `v-${id}`, email: null },
    messageCount: 1,
    createdOn: '2026-09-01T10:00:00.000Z',
    messages: [
      { sender: { t: 'v' }, type: 'msg', time: '2026-09-01T10:00:00.000Z', msg: `Hello ${id}` },
    ],
    ...overrides,
  };
}

export const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** The error a function throws (fails the test when it returns). */
export function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected an error');
}
