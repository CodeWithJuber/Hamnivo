import type { TFunction } from 'i18next';
import type { RiskClass } from './actions';
import type { HttpToolArgumentIn, HttpToolEndpoint, HttpToolMethod } from './ai-power';

/**
 * A request of a custom HTTP tool as a person edits it (D10): the words, the method and path, and
 * the details the AI fills in. Kept apart from the dialog so what it checks and what it sends can
 * be tried without a browser.
 */

export const VALUE_TYPES = ['string', 'integer', 'number', 'boolean'] as const;
export type ValueType = (typeof VALUE_TYPES)[number];

export interface ArgumentDraft {
  /** Only for React: details are told apart by their place in the list. */
  uid: number;
  name: string;
  place: HttpToolArgumentIn;
  /** The name in the request when it is not the detail's own name; empty otherwise. */
  key: string;
  type: ValueType;
  required: boolean;
  about: string;
}

export interface EndpointDraft {
  title: string;
  /** What the AI is told the tool does. */
  about: string;
  method: HttpToolMethod;
  path: string;
  /** Empty: the gateway decides from the method. */
  risk: '' | RiskClass;
  args: ArgumentDraft[];
}

const ARGUMENT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** Most details one request has (the gateway's limit for a request written by hand). */
export const MOST_DETAILS = 20;

let counter = 0;
const nextUid = () => {
  counter += 1;
  return counter;
};

export const blankDraft = (): EndpointDraft => ({
  title: '',
  about: '',
  method: 'GET',
  path: '',
  risk: '',
  args: [],
});

export function newArgument(overrides: Partial<ArgumentDraft> = {}): ArgumentDraft {
  return {
    uid: nextUid(),
    name: '',
    place: 'query',
    key: '',
    type: 'string',
    required: false,
    about: '',
    ...overrides,
  };
}

const valueType = (type: string): ValueType =>
  (VALUE_TYPES as readonly string[]).includes(type) ? (type as ValueType) : 'string';

/** A stored request as the form starts from it, when a person changes it. */
export function draftOf(endpoint: HttpToolEndpoint): EndpointDraft {
  return {
    title: endpoint.title,
    about: endpoint.description,
    method: endpoint.method,
    path: endpoint.path,
    risk: endpoint.risk,
    args: endpoint.arguments.map((argument) =>
      newArgument({
        name: argument.name,
        place: argument.in,
        key: argument.key === argument.name ? '' : argument.key,
        type: valueType(argument.type),
        required: argument.required,
        about: argument.description ?? '',
      }),
    ),
  };
}

/** The `{names}` a path asks to be filled in, in order, without repeats. */
export function placeholdersOf(path: string): string[] {
  return [...new Set([...path.matchAll(/\{([^{}/]+)\}/g)].map((match) => match[1] ?? ''))].filter(
    Boolean,
  );
}

/** The `{names}` of the path that no detail going into the path fills in. */
export function missingPlaceholders(draft: EndpointDraft): string[] {
  const filled = new Set(
    draft.args.filter((a) => a.place === 'path').map((a) => a.key.trim() || a.name.trim()),
  );
  return placeholdersOf(draft.path).filter((holder) => !filled.has(holder));
}

/** A detail that fills a `{name}` of the path, started for the person. */
export function pathArgument(holder: string): ArgumentDraft {
  const usable = ARGUMENT_NAME.test(holder);
  return newArgument({
    name: usable ? holder : '',
    place: 'path',
    key: usable ? '' : holder,
    required: true,
  });
}

/** Problems a person can fix without asking the gateway, by field id. */
export function draftErrors(draft: EndpointDraft, t: TFunction): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!draft.title.trim()) errors['ep-title'] = t('aiPower.http.endpointDialog.errors.title');
  if (!draft.about.trim()) errors['ep-about'] = t('aiPower.http.endpointDialog.errors.about');
  if (!draft.path.trim().startsWith('/')) {
    errors['ep-path'] = t('aiPower.http.endpointDialog.errors.path');
  }
  const seen = new Set<string>();
  for (const arg of draft.args) {
    const name = arg.name.trim();
    if (!ARGUMENT_NAME.test(name)) {
      errors[`ep-arg-${arg.uid}-name`] = t('aiPower.http.endpointDialog.errors.detailName');
    } else if (seen.has(name)) {
      errors[`ep-arg-${arg.uid}-name`] = t('aiPower.http.endpointDialog.errors.detailDuplicate');
    }
    seen.add(name);
  }
  return errors;
}

/** The request as the gateway takes it (`endpoint` of a new service, or the body of a change). */
export function endpointBody(draft: EndpointDraft): Record<string, unknown> {
  return {
    title: draft.title.trim(),
    description: draft.about.trim(),
    method: draft.method,
    path: draft.path.trim(),
    arguments: draft.args.map((arg) => ({
      name: arg.name.trim(),
      in: arg.place,
      ...(arg.key.trim() && arg.key.trim() !== arg.name.trim() ? { key: arg.key.trim() } : {}),
      type: arg.type,
      required: arg.place === 'path' ? true : arg.required,
      ...(arg.about.trim() ? { description: arg.about.trim() } : {}),
    })),
    ...(draft.risk ? { risk: draft.risk } : {}),
  };
}
