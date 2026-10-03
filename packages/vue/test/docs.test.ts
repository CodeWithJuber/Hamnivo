import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc';
import { HamnivoChat } from '../src/index.js';

/**
 * The guide for developers, docs/guide/integrations/react-vue-next.md, shows Vue code. The plugin
 * snippet is type-checked with this package (test/snippets), and the single-file components are
 * compiled here, so that a typo in them fails a test and not a reader.
 */
const guide = readFileSync(
  join(import.meta.dirname, '../../../docs/guide/integrations/react-vue-next.md'),
  'utf8',
);
const blocks = (language: string) =>
  [...guide.matchAll(new RegExp(`\`\`\`${language}\\n([\\s\\S]*?)\\n\`\`\``, 'g'))].map(
    (match) => match[1] as string,
  );

describe('the README', () => {
  it('shows main.ts exactly as it is type-checked', () => {
    const readme = readFileSync(join(import.meta.dirname, '../README.md'), 'utf8');
    const main = readFileSync(join(import.meta.dirname, 'snippets/main.ts'), 'utf8').trimEnd();
    expect(readme).toContain(`\`\`\`ts\n${main}\n\`\`\``);
  });
});

describe('the guide', () => {
  it('shows main.ts exactly as it is type-checked', () => {
    const main = readFileSync(join(import.meta.dirname, 'snippets/main.ts'), 'utf8').trimEnd();
    expect(guide).toContain(`\`\`\`ts\n${main}\n\`\`\``);
  });

  it('has single-file components that compile, with a script that sets up what the template uses', () => {
    const components = blocks('vue');
    expect(components.length).toBeGreaterThanOrEqual(3);
    for (const [index, source] of components.entries()) {
      const filename = `Example${index}.vue`;
      const { descriptor, errors } = parse(source, { filename });
      expect(errors, filename).toEqual([]);
      expect(descriptor.template, filename).not.toBeNull();
      const script = descriptor.scriptSetup
        ? compileScript(descriptor, { id: filename, inlineTemplate: false })
        : undefined;
      const compiled = compileTemplate({
        source: descriptor.template?.content ?? '',
        filename,
        id: filename,
        compilerOptions: { bindingMetadata: script?.bindings },
      });
      expect(compiled.errors, filename).toEqual([]);
      expect(compiled.tips, filename).toEqual([]);
    }
  });

  it('names the bindings that its templates use, which the script has', () => {
    for (const source of blocks('vue').filter((block) => block.includes('<script setup'))) {
      const { descriptor } = parse(source, { filename: 'Example.vue' });
      const script = compileScript(descriptor, { id: 'Example.vue', inlineTemplate: false });
      const template = descriptor.template?.content ?? '';
      for (const used of ['loaded', 'unread', 'open', 'user', 'getAssertion']) {
        if (new RegExp(`\\b${used}\\b`).test(template)) {
          expect(Object.keys(script.bindings ?? {}), used).toContain(used);
        }
      }
    }
  });
});

describe('the component', () => {
  it('has the props of the React component, so that one guide serves both', () => {
    expect(Object.keys(HamnivoChat.props).sort()).toEqual(
      [
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
        'customer',
      ].sort(),
    );
    expect(Object.keys(HamnivoChat.emits ?? {}).sort()).toEqual(['error', 'ready']);
  });
});
