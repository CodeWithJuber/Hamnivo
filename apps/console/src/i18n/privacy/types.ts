import type { privacyEn } from './en';

type Strings<T> = { [K in keyof T]: T[K] extends string ? string : Strings<T[K]> };
/** Every locale has exactly the English privacy keys. */
export type PrivacyTranslation = Strings<typeof privacyEn>;
