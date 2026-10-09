import { describe, expect, it } from 'vitest';
import { automatedSender, channelKindOf } from '../src/authority/adopt.js';

describe('automatedSender', () => {
  it.each([
    ['noreply@shop.example', true],
    ['no-reply@shop.example', true],
    ['do-not-reply@bank.example', true],
    ['MAILER-DAEMON@mail.example', true],
    ['postmaster@mail.example', true],
    ['bounces+123@lists.example', true],
    ['norah@customer.example', false],
    ['reply@customer.example', false],
    ['', false],
    [null, false],
  ])('%s → %s', (address, expected) => {
    expect(automatedSender(address)).toBe(expected);
  });
});

describe('channelKindOf', () => {
  it('names Chatwoot channel classes', () => {
    expect(channelKindOf('Channel::Email')).toBe('email');
    expect(channelKindOf('Channel::Whatsapp')).toBe('whatsapp');
    expect(channelKindOf('Channel::Telegram')).toBe('telegram');
    expect(channelKindOf('Channel::Sms')).toBe('other');
  });
});
