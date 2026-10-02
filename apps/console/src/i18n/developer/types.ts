import type { developerEn } from './en';

type Strings<T> = { [K in keyof T]: T[K] extends string ? string : Strings<T[K]> };
/** Every locale has exactly the English developer keys. */
export type DeveloperTranslation = Strings<typeof developerEn>;
