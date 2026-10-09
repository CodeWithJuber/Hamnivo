import type { automationsEn } from './en';

type Strings<T> = { [K in keyof T]: T[K] extends string ? string : Strings<T[K]> };
/** Every locale has exactly the English Automations keys. */
export type AutomationsTranslation = Strings<typeof automationsEn>;
