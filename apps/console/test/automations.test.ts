import { AutomationDefinition, CreateAutomationRequest } from '@hamnivo/contracts';
import { definitionProblems, evaluate, kindOfEvent } from '@hamnivo/domain/automations';
import i18next from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import { TEMPLATE_IDS, TEMPLATES, templateOf } from '../src/lib/automation-templates';
import {
  type Automation,
  activityText,
  automationIds,
  bodyOf,
  controlOfPath,
  definitionOf,
  domainOf,
  draftOf,
  factsOf,
  isDirty,
  newCondition,
  previewLanguageOf,
  problemControl,
  problemsOf,
  sampleFactsFor,
  statusOf,
  summaryOf,
  warningsOf,
  withField,
  wordsIn,
} from '../src/lib/automations';

beforeAll(async () => {
  await initI18n('en');
});

const t = () => i18next.t;
const NOW = Date.parse('2026-10-09T12:00:00.000Z');

const automation = (patch: Partial<Automation> = {}): Automation => ({
  id: 'aut_1',
  brandId: 'brd_1',
  name: 'Welcome reply',
  kind: 'conversation',
  enabled: true,
  draft: templateOf('welcome').definition,
  revision: 2,
  published: {
    version: 3,
    publishedAt: '2026-10-09T10:00:00.000Z',
    publishedBy: 'staff_1',
    publishedByName: 'Ali',
    definition: templateOf('welcome').definition,
  },
  unpublishedChanges: false,
  stats: { runsThisWeek: 34, lastRunAt: '2026-10-09T10:00:00.000Z' },
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-09T10:00:00.000Z',
  ...patch,
});

describe('templates', () => {
  it('offers every template the gallery names, ready-made ones first', () => {
    expect(TEMPLATES.map((template) => template.id)).toEqual([...TEMPLATE_IDS]);
    expect(TEMPLATES.filter((template) => template.scratch).map((x) => x.id)).toEqual([
      'scratchWebsite',
      'scratchChat',
    ]);
  });

  for (const template of TEMPLATES) {
    it(`${template.id}: passes the contract, as a draft to create and as a definition`, () => {
      expect(AutomationDefinition.parse(template.definition)).toEqual(template.definition);
      const request = CreateAutomationRequest.safeParse({
        name: i18next.t(`automations.templates.${template.id}.name`),
        definition: template.definition,
      });
      expect(request.success, JSON.stringify(request.error?.issues)).toBe(true);
    });

    it(`${template.id}: is of its kind and could be published as it is`, () => {
      expect(kindOfEvent(template.definition.event.type)).toBe(template.kind);
      // The tag of "Tag by page" is the one value left for the brand; the domain does not check
      // tags (the gateway checks them against the brand's own), so no template has a problem.
      expect(definitionProblems(domainOf(template.definition))).toEqual([]);
    });

    it(`${template.id}: survives the editor unchanged, with nothing to put right`, () => {
      const draft = draftOf('Name', template.definition);
      expect(bodyOf(draft).definition).toEqual(template.definition);
      expect(problemsOf(draft)).toEqual([]);
      expect(warningsOf(draft)).toEqual([]);
    });
  }

  it('leaves the tag of "Tag by page" for the brand to choose', () => {
    const tagByPage = templateOf('tagByPage');
    expect(tagByPage.choose).toBe('tag');
    expect(tagByPage.definition.actions).toEqual([{ type: 'add_tag', tag: 'checkout' }]);
  });

  it('writes the words customers read in every language of the chat', () => {
    for (const template of TEMPLATES) {
      for (const action of template.definition.actions) {
        if (action.type !== 'show_prompt' && action.type !== 'send_message') continue;
        for (const lang of ['ar', 'hi', 'ur'] as const) {
          expect(action.message[lang]?.trim(), `${template.id} ${lang}`).toBeTruthy();
          expect(action.message[lang]).not.toBe(action.message.en);
        }
      }
    }
  });

  it('only sends a message while the AI does not have the chat', () => {
    for (const id of ['welcome', 'rescue', 'outOfHours'] as const) {
      const without = {
        ...templateOf(id).definition,
        conditions: templateOf(id).definition.conditions.filter((c) => c.field !== 'owner'),
      };
      expect(definitionProblems(domainOf(without)).map((p) => p.code)).toContain(
        'message_needs_people',
      );
    }
  });
});

describe('a rule in one sentence', () => {
  it('says when, if and then', () => {
    expect(summaryOf(templateOf('pricing').definition, t())).toBe(
      'When a visitor has been on a page for 30 sec, if the page address contains /pricing → show a prompt',
    );
    expect(summaryOf(templateOf('rescue').definition, t())).toBe(
      'When a customer has waited 90 sec for a reply, if who has the chat is not the AI → send a message and set the priority to high',
    );
    expect(summaryOf(templateOf('outOfHours').definition, t())).toBe(
      'When a chat starts, if it is outside business hours and who has the chat is not the AI → send a message and make a ticket',
    );
    expect(summaryOf(templateOf('returning').definition, t())).toBe(
      'When a visitor has been on a page for 5 sec, if the number of visits is at least 3 → show a prompt',
    );
  });

  it('joins "any" with or, names countries and teams, and says minutes', () => {
    const definition = AutomationDefinition.parse({
      event: { type: 'customer_waiting', seconds: 600 },
      match: 'any',
      conditions: [
        { field: 'country', op: 'is', value: ['PK', 'AE'] },
        { field: 'device', op: 'is_not', value: ['mobile'] },
      ],
      actions: [{ type: 'assign_team', teamId: 'team_1' }],
    });
    expect(summaryOf(definition, t(), { team: () => 'Billing' })).toBe(
      'When a customer has waited 10 min for a reply, if the country is Pakistan or United Arab Emirates or the device is not a phone → send it to Billing',
    );
  });

  it('says a rule without conditions runs every time', () => {
    expect(summaryOf(templateOf('scratchChat').definition, t())).toBe(
      'When a chat starts → set the priority to medium',
    );
  });

  it('follows the interface language', async () => {
    await i18next.changeLanguage('ar');
    try {
      const text = summaryOf(templateOf('pricing').definition, i18next.t);
      expect(text).toContain('/pricing');
      expect(text).not.toContain('When a visitor');
    } finally {
      await i18next.changeLanguage('en');
    }
  });
});

describe('where a rule stands and what it did', () => {
  it('reads off, draft only, unpublished changes and published', () => {
    expect(statusOf(automation())).toEqual({ key: 'published', version: 3 });
    expect(statusOf(automation({ unpublishedChanges: true }))).toEqual({
      key: 'changes',
      version: 3,
    });
    expect(statusOf(automation({ published: null, unpublishedChanges: true }))).toEqual({
      key: 'draft',
      version: null,
    });
    expect(statusOf(automation({ enabled: false })).key).toBe('off');
  });

  it('counts runs for chat rules and says website rules run in browsers', () => {
    expect(activityText(automation(), t(), NOW)).toBe(
      'Ran 34 times this week · last run 2 hours ago',
    );
    expect(
      activityText(automation({ stats: { runsThisWeek: 0, lastRunAt: null } }), t(), NOW),
    ).toBe('Hasn’t run yet');
    expect(activityText(automation({ kind: 'visitor' }), t(), NOW)).toBe(
      'Runs in visitors’ browsers',
    );
  });
});

describe('the working copy', () => {
  it('starts a condition again when it asks about another kind of fact', () => {
    const text = { ...newCondition('page_url', 'c0'), op: 'starts_with', text: '/shop' };
    expect(withField(text, 'referrer')).toMatchObject({ op: 'starts_with', text: '/shop' });
    expect(withField(text, 'device')).toMatchObject({ op: 'is', choices: [], text: '' });
    expect(withField(text, 'hours_open')).toMatchObject({ op: 'is', flag: true });
  });

  it('says what the schema would refuse, and where', () => {
    const draft = draftOf('', templateOf('pricing').definition);
    draft.seconds = '700';
    const [condition] = draft.conditions;
    if (condition) condition.text = ' ';
    const [action] = draft.actions;
    if (action) action.message = { en: '', ar: 'مرحبا', hi: '', ur: '' };
    const problems = problemsOf(draft);
    expect(problems.map((problem) => problem.kind)).toEqual([
      'name',
      'seconds',
      'conditionValue',
      'messageEnglish',
    ]);
    expect(problems.map(problemControl)).toEqual([
      automationIds.name,
      automationIds.seconds,
      automationIds.conditionValue('c0'),
      'action-a0-message-en',
    ]);
  });

  it('knows when it changed', () => {
    const saved = draftOf('Pricing', templateOf('pricing').definition);
    const draft = draftOf('Pricing', templateOf('pricing').definition);
    expect(isDirty(draft, saved)).toBe(false);
    draft.match = 'any';
    expect(isDirty(draft, saved)).toBe(true);
  });

  it('points the gateway’s field errors at the right row', () => {
    const draft = draftOf('Out of hours', templateOf('outOfHours').definition);
    expect(controlOfPath('definition.conditions.1.value', draft)).toBe('condition-c1-value');
    expect(controlOfPath('definition.conditions.1.value.0', draft)).toBe('condition-c1-value');
    expect(controlOfPath('definition.conditions.0.field', draft)).toBe('condition-c0-field');
    expect(controlOfPath('definition.actions.0.type', draft)).toBe('action-a0-type');
    expect(controlOfPath('definition.actions.0.message.ar', draft)).toBe('action-a0-message-ar');
    expect(controlOfPath('definition.actions.1.teamId', draft)).toBe('action-a1-team');
    expect(controlOfPath('definition.event.seconds', draft)).toBe('automation-seconds');
    expect(controlOfPath('definition.event.type', draft)).toBe('automation-event');
    expect(controlOfPath('definition.actions', draft)).toBe('automation-add-action');
    expect(controlOfPath('definition.conditions.9.value', draft)).toBe('automation-conditions');
    expect(controlOfPath('name', draft)).toBe('automation-name');
  });

  it('warns, as the gateway would refuse to publish, before anything is sent', () => {
    const draft = draftOf('Welcome', templateOf('welcome').definition);
    draft.conditions = [];
    expect(warningsOf(draft)).toEqual([
      { path: ['actions', 0, 'type'], code: 'message_needs_people' },
    ]);
    const website = draftOf('Prompt', templateOf('pricing').definition);
    website.actions = [];
    expect(warningsOf(website).map((w) => w.code)).toEqual(['prompt_required']);
  });
});

describe('Try it', () => {
  it('reads an empty sample fact as unknown', () => {
    const sample = { ...sampleFactsFor(''), page_url: '', visit_count: '', device: '' };
    const facts = factsOf({ ...sample, hours_open: '', owner: '', tag: ' ' });
    expect(facts).toMatchObject({
      page_url: null,
      visit_count: null,
      device: null,
      language: null,
      hours_open: null,
      owner: null,
      tag: null,
    });
  });

  it('reads what is filled in as the evaluator expects it', () => {
    const facts = factsOf({
      ...sampleFactsFor('ar'),
      page_url: ' https://shop.example/pricing ',
      visit_count: '4',
      country: 'pk',
      signed_in: 'no',
      tag: 'vip, refund ,',
      team: 'team_1',
    });
    expect(facts).toEqual({
      page_url: 'https://shop.example/pricing',
      referrer: null,
      visit_count: 4,
      country: 'PK',
      device: 'desktop',
      language: 'ar',
      signed_in: false,
      hours_open: true,
      anyone_online: true,
      owner: 'waiting',
      tag: ['vip', 'refund'],
      team: 'team_1',
    });
  });

  it('gives the verdicts the worker would reach', () => {
    const draft = draftOf('Pricing', templateOf('pricing').definition);
    const check = (patch: Partial<ReturnType<typeof sampleFactsFor>>) =>
      evaluate(domainOf(definitionOf(draft)), factsOf({ ...sampleFactsFor('en'), ...patch }));
    expect(check({ page_url: 'https://example.com/' })).toEqual({
      matched: false,
      conditions: [false],
    });
    expect(check({ page_url: 'https://example.com/Pricing/teams' })).toEqual({
      matched: true,
      conditions: [true],
    });
    expect(check({ page_url: '' })).toEqual({ matched: false, conditions: [null] });
    const outOfHours = draftOf('Closed', templateOf('outOfHours').definition);
    expect(
      evaluate(
        domainOf(definitionOf(outOfHours)),
        factsOf({ ...sampleFactsFor('en'), hours_open: 'no', owner: 'ai' }),
      ),
    ).toEqual({ matched: false, conditions: [true, false] });
  });

  it('previews messages in the visitor’s language, or in English', () => {
    expect(previewLanguageOf({ ...sampleFactsFor('ur') })).toBe('ur');
    expect(previewLanguageOf({ ...sampleFactsFor('ar-EG') })).toBe('ar');
    expect(previewLanguageOf({ ...sampleFactsFor('fr') })).toBe('en');
    const texts = { en: 'Hello', ar: 'مرحبا', hi: '', ur: '' };
    expect(wordsIn(texts, 'ar')).toEqual({ text: 'مرحبا', lang: 'ar' });
    expect(wordsIn(texts, 'hi')).toEqual({ text: 'Hello', lang: 'en' });
  });
});
