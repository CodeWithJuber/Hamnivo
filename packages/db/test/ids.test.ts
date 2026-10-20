import { ID_PREFIX, type IdKind, isTypeId } from '@hamnivo/contracts';
import { describe, expect, it } from 'vitest';
import { fromPublicId, InvalidPublicIdError, newId, newPublicId, toPublicId } from '../src/ids.js';

describe('identifiers', () => {
  it('creates time-ordered UUIDv7 values', () => {
    const first = newId();
    const second = newId();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first < second).toBe(true);
  });

  it('round-trips between UUIDs and TypeIDs of the right kind', () => {
    for (const kind of Object.keys(ID_PREFIX) as IdKind[]) {
      const { id, publicId } = newPublicId(kind);
      expect(isTypeId(publicId, ID_PREFIX[kind])).toBe(true);
      expect(fromPublicId(kind, publicId)).toBe(id);
      expect(toPublicId(kind, id)).toBe(publicId);
    }
  });

  it('rejects IDs of another kind or malformed IDs', () => {
    const { publicId } = newPublicId('conversation');
    expect(() => fromPublicId('message', publicId)).toThrow(InvalidPublicIdError);
    expect(() => fromPublicId('conversation', 'conv_short')).toThrow(InvalidPublicIdError);
    expect(() => fromPublicId('conversation', '')).toThrow(InvalidPublicIdError);
  });
});
