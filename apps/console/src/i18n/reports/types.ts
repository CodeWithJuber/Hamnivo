import type { reportsEn } from './en';

type Strings<T> = { [K in keyof T]: T[K] extends string ? string : Strings<T[K]> };
/** Every locale has exactly the English report keys. */
export type ReportsTranslation = Strings<typeof reportsEn>;
