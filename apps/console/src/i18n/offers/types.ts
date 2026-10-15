import type { offersEn } from './en';

type Strings<T> = { [K in keyof T]: T[K] extends string ? string : Strings<T[K]> };
/** Every locale has exactly the English offer keys. */
export type OffersTranslation = Strings<typeof offersEn>;
