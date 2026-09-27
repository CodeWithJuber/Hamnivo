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
