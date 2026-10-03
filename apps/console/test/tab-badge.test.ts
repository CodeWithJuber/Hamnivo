import { describe, expect, it } from 'vitest';
import { badgeText, countLabel, reconcileTitle, titleWithCount } from '../src/lib/tab-badge';

describe('the count on the tab', () => {
  it('puts the number of chats in front of the title', () => {
    expect(titleWithCount('Inbox · Hamnivo Studio', 3)).toBe('(3) Inbox · Hamnivo Studio');
    expect(titleWithCount('Hamnivo Studio', 1)).toBe('(1) Hamnivo Studio');
  });

  it('shows nothing when no chat needs you, and takes an old count off', () => {
    expect(titleWithCount('Inbox · Hamnivo Studio', 0)).toBe('Inbox · Hamnivo Studio');
    expect(titleWithCount('(3) Inbox · Hamnivo Studio', 0)).toBe('Inbox · Hamnivo Studio');
  });

  it('replaces the count instead of stacking another in front', () => {
    expect(titleWithCount('(3) Inbox · Hamnivo Studio', 5)).toBe('(5) Inbox · Hamnivo Studio');
    expect(titleWithCount('(99+) Inbox', 2)).toBe('(2) Inbox');
  });

  it('does not mistake a title that starts with a bracket for a count', () => {
    expect(titleWithCount('(Draft) Notes', 2)).toBe('(2) (Draft) Notes');
    expect(titleWithCount('(Draft) Notes', 0)).toBe('(Draft) Notes');
  });

  it('says 99+ for a large number, and the icon says 9+ for ten or more', () => {
    expect(countLabel(99)).toBe('99');
    expect(countLabel(100)).toBe('99+');
    expect(countLabel(0)).toBe('');
    expect(countLabel(-4)).toBe('');
    expect(countLabel(Number.NaN)).toBe('');
    expect(badgeText(9)).toBe('9');
    expect(badgeText(10)).toBe('9+');
    expect(badgeText(0)).toBe('');
  });

  it('tells a page that sets its own title to put the count back, and leaves a right title alone', () => {
    // A page opened and set its title: the count has to come back.
    expect(reconcileTitle('Maya Khan · Hamnivo Studio', 2)).toBe('(2) Maya Khan · Hamnivo Studio');
    expect(reconcileTitle('(2) Maya Khan · Hamnivo Studio', 2)).toBeNull();
    expect(reconcileTitle('(2) Inbox', 0)).toBe('Inbox');
    expect(reconcileTitle('Inbox', 0)).toBeNull();
  });
});
