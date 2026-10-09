import type { channelsEn } from './en';

/** Arabic needs more plural forms than English (zero, two, few, many) for counted text. */
type MorePlurals = { [key: `${string}_${'zero' | 'two' | 'few' | 'many'}`]: string };
type Strings<T> = {
  [K in keyof T]: T[K] extends string ? string : Strings<T[K]>;
} & Partial<MorePlurals>;
/** Every locale has the English Channels keys, plus any plural forms its language needs. */
export type ChannelsTranslation = Strings<typeof channelsEn>;
