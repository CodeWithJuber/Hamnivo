import type { ticketsEn } from './en';

type Strings<T> = { [K in keyof T]: T[K] extends string ? string : Strings<T[K]> };
/** Every locale has exactly the English ticket keys. */
export type TicketsTranslation = Strings<typeof ticketsEn>;
