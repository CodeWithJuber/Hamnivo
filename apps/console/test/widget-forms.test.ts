import {
  CHAT_FORM_FIELD_KINDS,
  CHAT_FORM_MAX_FIELDS,
  ConsentSettings,
  ConsentMode as ContractConsentMode,
  OfflineFormWhen,
  SINGLE_CHAT_CHAT_FORM_FIELD_KINDS,
  WidgetForms,
} from '@hamnivo/contracts';
import { describe, expect, it } from 'vitest';
import { textsOf } from '../src/lib/appearance';
import {
  addOption,
  bodyOf,
  CONSENT_MODES,
  consentBodyOf,
  consentDraftOf,
  consentProblemsOf,
  consentWordsChanged,
  controlOfPath,
  DEFAULT_FIELD_LABELS,
  draftOf,
  FIELD_KINDS,
  type FieldDraft,
  type FormsDraft,
  freeId,
  isConsentDirty,
  isDirty,
  isLockedInOffline,
  MAX_FIELDS,
  moved,
  newField,
  nextKind,
  OFFLINE_WHEN,
  problemControl,
  problemsOf,
  SINGLE_KINDS,
  withKind,
} from '../src/lib/widget-forms';

const TEAM = 'team_01j9zk7w3xq8r4t2v6m5n1p0cd';
const OTHER_TEAM = 'team_01j9zk7w3xq8r4t2v6m5n1p0ce';

/** The forms a brand starts with, as the gateway fills them in. */
const defaults = () => WidgetForms.parse({});
const draft = () => draftOf(defaults());
/** Whether the gateway's own schema takes what Studio would send. */
const accepted = (forms: FormsDraft) => WidgetForms.safeParse(bodyOf(forms)).success;

const field = (patch: Partial<FieldDraft> = {}): FieldDraft => ({
  id: 'topic',
  kind: 'choice',
  label: textsOf({ en: 'Topic' }),
  required: false,
  options: [
    { id: 'option', label: textsOf({ en: 'Orders' }), teamId: '' },
    { id: 'option-2', label: textsOf({ en: 'Returns' }), teamId: '' },
  ],
  ...patch,
});

describe('the lists Studio keeps match the contract', () => {
  it('has the same kinds of answer, single kinds, limits and choices', () => {
    expect([...FIELD_KINDS]).toEqual([...CHAT_FORM_FIELD_KINDS]);
    expect([...SINGLE_KINDS]).toEqual([...SINGLE_CHAT_CHAT_FORM_FIELD_KINDS]);
    expect(MAX_FIELDS).toBe(CHAT_FORM_MAX_FIELDS);
    expect([...OFFLINE_WHEN].sort()).toEqual([...OfflineFormWhen.options].sort());
    expect([...CONSENT_MODES].sort()).toEqual([...ContractConsentMode.options].sort());
  });

  it('starts every new field with words in all four languages', () => {
    for (const kind of FIELD_KINDS) {
      for (const text of Object.values(DEFAULT_FIELD_LABELS[kind]))
        expect(text.trim()).not.toBe('');
    }
  });
});

describe('a working copy of the forms', () => {
  it('reads the forms a brand starts with and sends them back unchanged', () => {
    const forms = defaults();
    expect(bodyOf(draftOf(forms))).toEqual(forms);
    expect(problemsOf(draft())).toEqual([]);
    expect(accepted(draft())).toBe(true);
  });

  it('keeps every language written, trimmed, and leaves out the empty ones', () => {
    const forms = draft();
    forms.prechat.fields = [
      { ...forms.prechat.fields[0], label: textsOf({ en: ' Name ', ar: ' الاسم ', hi: '' }) },
    ] as FieldDraft[];
    expect(bodyOf(forms).prechat.fields[0]?.label).toEqual({ en: 'Name', ar: 'الاسم' });
  });

  it('sends answers only for lists, and teams only for a department', () => {
    const forms = draft();
    const list = field({ kind: 'department' });
    list.options = list.options.map((option, i) => ({ ...option, teamId: i ? OTHER_TEAM : TEAM }));
    forms.prechat.fields = [list, { ...field({ id: 'note', kind: 'text' }) }];
    const body = bodyOf(forms);
    expect(body.prechat.fields[0]?.options.map((option) => option.teamId)).toEqual([
      TEAM,
      OTHER_TEAM,
    ]);
    // A text field kept its old answers in the draft (for switching back), but sends none.
    expect(body.prechat.fields[1]?.options).toEqual([]);
    expect(accepted(forms)).toBe(true);
    // A choice never names a team, even one left over from being a department.
    forms.prechat.fields = [withKind(list, 'choice')];
    expect(bodyOf(forms).prechat.fields[0]?.options.map((option) => option.teamId)).toEqual([
      null,
      null,
    ]);
  });

  it('sends Hamnivo’s own thank-you words (null) until the brand writes some', () => {
    const forms = draft();
    expect(bodyOf(forms).offline.thanks).toBeNull();
    forms.offline.thanks = textsOf({ en: 'Thanks!', ur: 'شکریہ!' });
    expect(bodyOf(forms).offline.thanks).toEqual({ en: 'Thanks!', ur: 'شکریہ!' });
  });

  it('is changed only when what would be sent changes', () => {
    const saved = draft();
    const same = draft();
    expect(isDirty(same, saved)).toBe(false);
    same.prechat.enabled = true;
    expect(isDirty(same, saved)).toBe(true);
    // Words typed into a hidden, non-list field's answers are not a change customers would see.
    const hidden = draft();
    const name = hidden.prechat.fields[0] as FieldDraft;
    hidden.prechat.fields = [{ ...name, options: field().options }];
    expect(isDirty(hidden, saved)).toBe(false);
  });
});

describe('changing a form', () => {
  it('adds the first common question the form does not ask yet, then short texts', () => {
    const forms = draft();
    expect(nextKind(forms.offline.fields)).toBe('phone');
    const phone = newField(forms.offline.fields);
    expect(phone).toMatchObject({ id: 'phone', kind: 'phone', required: false });
    expect(phone.label).toEqual(DEFAULT_FIELD_LABELS.phone);
    const all = [...forms.offline.fields, phone];
    expect(nextKind(all)).toBe('text');
    expect(newField(all)).toMatchObject({ id: 'text', kind: 'text' });
    expect(newField([...all, newField(all)]).id).toBe('text-2');
  });

  it('finds a free id', () => {
    expect(freeId('option', [])).toBe('option');
    expect(freeId('option', ['option', 'option-2'])).toBe('option-3');
  });

  it('swaps default words with the kind, keeps the brand’s own, and makes room for answers', () => {
    const name = newField([]);
    const email = withKind(name, 'email');
    expect(email.label).toEqual(DEFAULT_FIELD_LABELS.email);
    expect(email.required).toBe(true);
    const own = withKind({ ...name, label: textsOf({ en: 'Who are you?' }) }, 'text');
    expect(own.label.en).toBe('Who are you?');
    const list = withKind(name, 'choice');
    expect(list.options).toHaveLength(2);
    expect(list.options.map((option) => option.id)).toEqual(['option', 'option-2']);
    expect(addOption(list).options.map((option) => option.id)).toEqual([
      'option',
      'option-2',
      'option-3',
    ]);
    // The id answers are stored by never changes with the kind.
    expect(list.id).toBe(name.id);
  });

  it('moves a field up or down, and not past either end', () => {
    expect(moved(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moved(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moved(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moved(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });

  it('keeps the contact form’s email and question in place', () => {
    const forms = draft();
    const kinds = forms.offline.fields.map((f) => [f.kind, isLockedInOffline('offline', f)]);
    expect(kinds).toEqual([
      ['name', false],
      ['email', true],
      ['question', true],
    ]);
    expect(isLockedInOffline('prechat', forms.offline.fields[1] as FieldDraft)).toBe(false);
  });
});

describe('what would be refused', () => {
  const problems = (forms: FormsDraft) => problemsOf(forms).map((p) => [p.form, p.kind]);

  it('asks for English words on every question and answer', () => {
    const forms = draft();
    forms.prechat.fields = [
      field({ label: textsOf({ ar: 'الموضوع' }) }),
      field({
        id: 'other',
        options: [
          { id: 'option', label: textsOf({ hi: 'ऑर्डर' }), teamId: '' },
          { id: 'option-2', label: textsOf({ en: 'Returns' }), teamId: '' },
        ],
      }),
    ];
    expect(problems(forms)).toEqual([
      ['prechat', 'label'],
      ['prechat', 'optionLabel'],
    ]);
    expect(accepted(forms)).toBe(false);
  });

  it('wants 2 to 10 answers in a list, and a team for each department answer', () => {
    const forms = draft();
    const one = field({ options: [field().options[0] as FieldDraft['options'][number]] });
    const department = field({ id: 'team', kind: 'department' });
    forms.prechat.fields = [one, department];
    expect(problemsOf(forms)).toEqual([
      { form: 'prechat', kind: 'fewOptions', field: 'topic', index: 0 },
      { form: 'prechat', kind: 'optionTeam', field: 'team', index: 1, option: 'option' },
      { form: 'prechat', kind: 'optionTeam', field: 'team', index: 1, option: 'option-2' },
    ]);
    expect(accepted(forms)).toBe(false);
    let many = field();
    for (let i = 0; i < 9; i += 1) many = addOption(many);
    many.options = many.options.map((option) => ({ ...option, label: textsOf({ en: 'x' }) }));
    forms.prechat.fields = [many];
    expect(problems(forms)).toEqual([['prechat', 'manyOptions']]);
    expect(accepted(forms)).toBe(false);
  });

  it('asks for a name, an email and the like once each, and at most six questions', () => {
    const forms = draft();
    forms.prechat.fields = [newField([]), { ...newField([]), id: 'name-2' }];
    expect(problemsOf(forms)).toEqual([
      { form: 'prechat', kind: 'duplicateKind', field: 'name-2', index: 1, fieldKind: 'name' },
    ]);
    expect(accepted(forms)).toBe(false);
    forms.prechat.fields = Array.from({ length: 7 }, (_, i) => ({
      ...field({ id: `text-${i}`, kind: 'text' }),
      options: [],
    }));
    expect(problems(forms)).toEqual([['prechat', 'tooManyFields']]);
    expect(accepted(forms)).toBe(false);
  });

  it('needs a required email and a required question in the contact form', () => {
    const forms = draft();
    forms.offline.fields = forms.offline.fields.map((f) => ({ ...f, required: false }));
    expect(problems(forms)).toEqual([
      ['offline', 'needsEmail'],
      ['offline', 'needsQuestion'],
    ]);
    expect(accepted(forms)).toBe(false);
    forms.offline.fields = [];
    expect(problems(forms)).toEqual([
      ['offline', 'needsEmail'],
      ['offline', 'needsQuestion'],
    ]);
  });

  it('wants English thank-you words when another language is written', () => {
    const forms = draft();
    forms.offline.thanks = textsOf({ ar: 'شكرًا' });
    expect(problems(forms)).toEqual([['offline', 'thanksEnglish']]);
    expect(accepted(forms)).toBe(false);
  });

  it('points each problem at the control that fixes it', () => {
    const forms = draft();
    forms.prechat.fields = [
      field({ label: textsOf({}) }),
      field({ id: 'team', kind: 'department' }),
    ];
    forms.offline.thanks = textsOf({ hi: 'धन्यवाद' });
    forms.offline.fields = [];
    expect(problemsOf(forms).map(problemControl)).toEqual([
      'prechat-field-topic-label-en',
      'prechat-field-team-option-option-team',
      'prechat-field-team-option-option-2-team',
      'offline-fields',
      'offline-fields',
      'offline-thanks-en',
    ]);
  });

  it('points a refusal from the gateway at its control, by the path it names', () => {
    const forms = draft();
    forms.prechat.fields = [field({ kind: 'department' })];
    expect(controlOfPath('prechat.fields.0.label.en', forms)).toBe('prechat-field-topic-label-en');
    expect(controlOfPath('prechat.fields.0.options.1.teamId', forms)).toBe(
      'prechat-field-topic-option-option-2-team',
    );
    expect(controlOfPath('prechat.fields.0.options.1.label.en', forms)).toBe(
      'prechat-field-topic-option-option-2-label-en',
    );
    expect(controlOfPath('prechat.fields.0.options', forms)).toBe('prechat-field-topic-add-option');
    expect(controlOfPath('prechat.fields.0.kind', forms)).toBe('prechat-field-topic-kind');
    expect(controlOfPath('offline.fields', forms)).toBe('offline-fields');
    expect(controlOfPath('offline.fields.9.label', forms)).toBe('offline-fields');
    expect(controlOfPath('offline.thanks.en', forms)).toBe('offline-thanks-en');
    expect(controlOfPath('offline.when', forms)).toBe('offline-when-either');
    expect(controlOfPath('prechat.skipVerified', forms)).toBe('prechat-skip-verified');
    expect(controlOfPath('elsewhere', forms)).toBe('prechat-form');
  });
});

describe('consent before chatting', () => {
  it('reads and sends the settings, with Hamnivo’s own words while none are written', () => {
    const saved = consentDraftOf(ConsentSettings.parse({}));
    expect(saved).toEqual({ mode: 'off', text: textsOf(null) });
    expect(consentBodyOf(saved)).toEqual({ mode: 'off', text: null });
    const written = { mode: 'eu' as const, text: textsOf({ en: 'We keep this chat.' }) };
    expect(consentBodyOf(written)).toEqual({ mode: 'eu', text: { en: 'We keep this chat.' } });
    expect(ConsentSettings.safeParse(consentBodyOf(written)).success).toBe(true);
  });

  it('knows a change of mode from a change of words, which asks customers again', () => {
    const saved = consentDraftOf({ mode: 'everyone', text: { en: 'Old words' } });
    expect(isConsentDirty(saved, saved)).toBe(false);
    const mode = { ...saved, mode: 'eu' as const };
    expect(isConsentDirty(mode, saved)).toBe(true);
    expect(consentWordsChanged(mode, saved)).toBe(false);
    const words = { ...saved, text: textsOf({ en: 'New words' }) };
    expect(consentWordsChanged(words, saved)).toBe(true);
    // Spaces around the same words are not new words.
    expect(consentWordsChanged({ ...saved, text: textsOf({ en: ' Old words ' }) }, saved)).toBe(
      false,
    );
  });

  it('wants English words when another language is written', () => {
    expect(consentProblemsOf({ mode: 'everyone', text: textsOf({ ar: 'نحتفظ' }) })).toEqual([
      'english',
    ]);
    expect(consentProblemsOf({ mode: 'everyone', text: textsOf(null) })).toEqual([]);
  });
});
