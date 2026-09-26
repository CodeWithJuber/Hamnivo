import { ID_PREFIX, type IdKind } from '@hamnivo/contracts';
import { TypeID } from 'typeid-js';
import { uuidv7 } from 'uuidv7';

/** New time-ordered UUIDv7 for a primary key. */
export const newId = (): string => uuidv7();

export class InvalidPublicIdError extends Error {
  override name = 'InvalidPublicIdError';
  constructor(
    readonly kind: IdKind,
    readonly value: string,
  ) {
    super(`Not a valid ${ID_PREFIX[kind]}_… identifier`);
  }
}

/** Database UUID → public TypeID (`conv_01j9…`). */
export function toPublicId(kind: IdKind, uuid: string): string {
  return TypeID.fromUUID(ID_PREFIX[kind], uuid).toString();
}

/** Public TypeID → database UUID. Rejects other kinds so IDs cannot be confused across resources. */
export function fromPublicId(kind: IdKind, publicId: string): string {
  try {
    return TypeID.fromString(publicId, ID_PREFIX[kind]).toUUID();
  } catch {
    throw new InvalidPublicIdError(kind, publicId);
  }
}

/** New public TypeID together with its UUID. */
export function newPublicId(kind: IdKind): { id: string; publicId: string } {
  const id = newId();
  return { id, publicId: toPublicId(kind, id) };
}
