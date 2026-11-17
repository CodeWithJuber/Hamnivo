import type { Message } from '@hamnivo/contracts';
import i18next from 'i18next';
import { renderToString } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  durationText,
  initialsOf,
  namesText,
  TeamAvatars,
} from '../src/components/shell/TeamAvatars.js';
import { Avatar } from '../src/components/thread/Avatar.js';
import { type Custom, toThread } from '../src/components/thread/model.js';
import { initI18n } from '../src/i18n.js';

beforeAll(async () => {
  await initI18n('en');
});

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

describe('the team on the home screen', () => {
  it('shows each person’s photo, or their initials, and says who is online and how soon', async () => {
    await i18next.changeLanguage('en');
    const html = renderToString(
      <TeamAvatars
        locale="en"
        team={{
          online: [
            { name: 'Sara', photoUrl: 'https://cdn.noor.example/sara.jpg' },
            { name: 'Ali Raza', photoUrl: null },
          ],
          replyMinutes: 5,
        }}
      />,
    );
    expect(html).toContain('src="https://cdn.noor.example/sara.jpg"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect((html.match(/data-testid="team-avatar"/g) ?? []).length).toBe(2);
    expect(text(html)).toContain('AR');
    expect(text(html)).toContain('Sara and Ali Raza are online');
    expect(text(html)).toContain('Usually replies in 5 minutes');
  });

  it('says it for one person, in the visitor’s language, and nothing when there is nothing to say', async () => {
    await i18next.changeLanguage('en');
    const one = renderToString(
      <TeamAvatars
        locale="en"
        team={{ online: [{ name: 'Sara', photoUrl: null }], replyMinutes: null }}
      />,
    );
    expect(text(one)).toBe('S Sara is online');
    expect(
      renderToString(<TeamAvatars locale="en" team={{ online: [], replyMinutes: null }} />),
    ).toBe('');
    await i18next.changeLanguage('ur');
    const urdu = renderToString(
      <TeamAvatars
        locale="ur"
        team={{ online: [{ name: 'Sara', photoUrl: null }], replyMinutes: 60 }}
      />,
    );
    expect(text(urdu)).toContain('آن لائن');
    expect(text(urdu)).toContain('عام طور پر');
    await i18next.changeLanguage('en');
  });

  it('writes names, initials and durations the way people read them', () => {
    expect(namesText(['Sara', 'Ali', 'Hana'], 'en')).toBe('Sara, Ali, and Hana');
    expect(initialsOf('  sara  noor khan ')).toBe('SN');
    expect(durationText(1, 'en')).toBe('1 minute');
    expect(durationText(120, 'en')).toBe('2 hours');
    expect(durationText(1440, 'en')).toBe('1 day');
  });
});

describe('a teammate’s reply in the conversation', () => {
  it('carries the first name and photo the gateway sent, and initials without a photo', () => {
    const thread = toThread(
      [
        {
          id: 'msg_1',
          conversationId: 'cnv_1',
          sequence: 1,
          sender: {
            kind: 'human_agent',
            displayName: 'Sara',
            roleLabel: 'Support agent',
            avatarUrl: 'https://cdn.noor.example/sara.jpg',
          },
          visibility: 'public',
          parts: [{ type: 'text', text: 'Your parcel ships today.', format: 'plain' }],
          createdAt: '2026-11-17T10:00:00.000Z',
          clientMessageId: null,
          delivery: null,
          language: 'en',
        } as Message,
      ],
      [],
      'You',
      null,
    );
    const custom = thread[0]?.metadata?.custom as unknown as Custom;
    expect(custom).toMatchObject({
      kind: 'human_agent',
      name: 'Sara',
      role: 'Support agent',
      avatarUrl: 'https://cdn.noor.example/sara.jpg',
    });
    const photo = renderToString(
      <Avatar kind="human_agent" name="Sara" url="https://cdn.noor.example/sara.jpg" />,
    );
    expect(photo).toContain('src="https://cdn.noor.example/sara.jpg"');
    expect(photo).toContain('referrerPolicy="no-referrer"');
    const initials = renderToString(<Avatar kind="human_agent" name="Sara" url={null} />);
    expect(initials).not.toContain('<img');
    expect(text(initials)).toContain('S');
  });
});
