import type { aiDraftsEn } from './en';

type Strings<T> = { [K in keyof T]: T[K] extends string ? string : Strings<T[K]> };
/** Every locale has exactly the English AI draft keys. */
export type AiDraftsTranslation = Strings<typeof aiDraftsEn>;
