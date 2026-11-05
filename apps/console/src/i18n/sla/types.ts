import type { slaEn } from './en';

type Strings<T> = { [K in keyof T]: T[K] extends string ? string : Strings<T[K]> };
/** Every locale has exactly the English reply-time keys. */
export type SlaTranslation = Strings<typeof slaEn>;
