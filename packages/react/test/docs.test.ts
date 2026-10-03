import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The guide for developers, docs/guide/integrations/react-vue-next.md, shows code that is
 * type-checked with this package (test/snippets). These tests keep the guide and the checked code
 * the same: a snippet that is changed in one place and not in the other fails here.
 */
const guide = readFileSync(
  join(import.meta.dirname, '../../../docs/guide/integrations/react-vue-next.md'),
  'utf8',
);
const snippet = (name: string) =>
  readFileSync(join(import.meta.dirname, 'snippets', name), 'utf8').trimEnd();

describe('the README', () => {
  const readme = readFileSync(join(import.meta.dirname, '../README.md'), 'utf8');

  it.each(['app.tsx', 'next-layout.tsx'])('shows %s exactly as it is type-checked', (name) => {
    expect(readme).toContain(`\`\`\`tsx\n${snippet(name)}\n\`\`\``);
  });

  it('points at the guide, which exists', () => {
    expect(readme).toContain('docs/guide/integrations/react-vue-next.md');
  });
});

describe('the guide', () => {
  it.each([
    'app.tsx',
    'chat-button.tsx',
    'my-chat.tsx',
    'next-layout.tsx',
    'next-chat.tsx',
    'next-identity-route.ts',
  ])('shows %s exactly as it is type-checked', (name) => {
    expect(guide).toContain(
      `\`\`\`${name.endsWith('.tsx') ? 'tsx' : 'ts'}\n${snippet(name)}\n\`\`\``,
    );
  });

  it('names every prop of the component, and every hook it explains', () => {
    const props = readFileSync(join(import.meta.dirname, '../src/chat.ts'), 'utf8');
    const loader = readFileSync(join(import.meta.dirname, '../src/embed.ts'), 'utf8');
    const named = [
      ...(
        /export interface HamnivoLoaderOptions \{([\s\S]*?)\n\}/.exec(loader)?.[1] ?? ''
      ).matchAll(/^ {2}(\w+)\??:/gm),
    ].map((match) => match[1] as string);
    expect(named).toEqual([
      'widgetId',
      'chatUrl',
      'apiUrl',
      'locale',
      'mode',
      'position',
      'color',
      'container',
      'height',
      'labels',
      'nonce',
    ]);
    for (const name of [...named, 'customer', 'onReady', 'onError']) {
      expect(guide, name).toContain(`\`${name}\``);
    }
    expect(props).toContain('customer?: HamnivoCustomer | null');
    for (const hook of ['useHamnivo', 'useHamnivoClient', 'useOutbox', 'useConversationStream']) {
      expect(guide, hook).toContain(hook);
    }
  });

  it('tells the owner how a release is made, with the tags the workflow reacts to', () => {
    expect(guide).toContain('react-v0.1.0');
    expect(guide).toContain('NPM_TOKEN');
    const workflow = readFileSync(
      join(import.meta.dirname, '../../../.github/workflows/release-packages.yml'),
      'utf8',
    );
    expect(workflow).toContain("- 'react-v*'");
    expect(workflow).toContain("- 'vue-v*'");
  });
});
