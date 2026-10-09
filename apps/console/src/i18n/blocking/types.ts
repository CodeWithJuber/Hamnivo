import type { blockingEn } from './en';

type Strings<T> = { [K in keyof T]: T[K] extends string ? string : Strings<T[K]> };
/** Every locale has exactly the English blocking keys. */
export type BlockingTranslation = Strings<typeof blockingEn>;
