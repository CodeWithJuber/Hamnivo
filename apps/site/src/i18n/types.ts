import type { FeatureId, features } from '../content/features';

/** One string per status entry, so every language lists the same points in the same order. */
type StringsFor<T extends readonly unknown[]> = { readonly [K in keyof T]: string };

interface FeatureCopy<Id extends FeatureId> {
  eyebrow: string;
  title: string;
  lead: string;
  points: StringsFor<(typeof features)[Id]['points']>;
  note?: string;
}

interface StepCopy {
  title: string;
  /** Text in `backticks` is shown as code and always reads left to right. */
  body: string;
}

/**
 * Every visible string of the site. Brand names, commands and code stay in English in every
 * language; technical terms such as API or SDK are kept where readers expect them.
 */
export interface Dictionary {
  meta: { title: string; description: string; ogImageAlt: string };
  a11y: { skipLink: string; languageNav: string };
  nav: { github: string };
  hero: {
    eyebrow: string;
    title: string;
    lead: string;
    primaryCta: string;
    secondaryCta: string;
    status: string;
    statusLink: string;
  };
  coming: string;
  features: { [Id in FeatureId]: FeatureCopy<Id> };
  demo: {
    eyebrow: string;
    title: string;
    liveBody: string;
    openChat: string;
    liveCode: string;
    offlineBody: string;
    offlineHint: string;
    guideLink: string;
  };
  selfHost: {
    eyebrow: string;
    title: string;
    lead: string;
    steps: readonly [StepCopy, StepCopy, StepCopy, StepCopy];
    guideLink: string;
    note: string;
  };
  code: { html: string; terminal: string; copy: string; copied: string; copyFailed: string };
  footer: {
    tagline: string;
    about: string;
    projectHeading: string;
    source: string;
    guide: string;
    status: string;
    docs: string;
    license: string;
    /** Shown on translated pages until a native speaker has reviewed them. */
    reviewNote?: string;
  };
  /** Accessible names the chat loader gives its launcher and iframe. */
  widget: { label: string; closeLabel: string; title: string };
}
