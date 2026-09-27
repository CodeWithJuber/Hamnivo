import type { commerceEn } from './en';

type Strings<T> = { [K in keyof T]: T[K] extends string ? string : Strings<T[K]> };
/** Every locale has exactly the English commerce keys. */
export type CommerceTranslation = Strings<typeof commerceEn>;
