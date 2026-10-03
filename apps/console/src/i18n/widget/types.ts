import type { chatSettingsEn } from './en';

type Strings<T> = { [K in keyof T]: T[K] extends string ? string : Strings<T[K]> };
/** Every locale has exactly the English chat-settings keys. */
export type ChatSettingsTranslation = Strings<typeof chatSettingsEn>;
