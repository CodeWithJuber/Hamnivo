import type { chatWidgetEn } from './en';

type Strings<T> = { [K in keyof T]: T[K] extends string ? string : Strings<T[K]> };
/** Every locale has exactly the English Chat widget keys. */
export type ChatWidgetTranslation = Strings<typeof chatWidgetEn>;
