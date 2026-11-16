// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/markdown.js';

const dom = (text: string, options?: Parameters<typeof renderMarkdown>[1]) => {
  const root = document.createElement('div');
  root.innerHTML = renderMarkdown(text, options);
  return root;
};

describe('markdown in answers (W08)', () => {
  it('keeps what an answer may hold and drops what could run or load', () => {
    const root = dom(
      [
        'Hello **there** <script>alert(1)</script>',
        '',
        '<img src="https://x.example/a.png" onerror="alert(1)">',
        '',
        '[safe](https://noor.example/help) and [unsafe](javascript:alert(1))',
      ].join('\n'),
    );
    expect(root.querySelector('strong')?.textContent).toBe('there');
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('img')).toBeNull();
    expect(root.innerHTML).not.toContain('onerror');
    const links = [...root.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://noor.example/help', null]);
    expect(links[0]?.getAttribute('target')).toBe('_blank');
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer nofollow');
  });

  it('puts a heading two levels under the chat’s own, so no answer names the chat', () => {
    const root = dom('# Title\n\n### Part\n\n###### Small');
    expect(root.querySelector('h1, h2')).toBeNull();
    expect(root.querySelector('h3')?.textContent).toBe('Title');
    expect(root.querySelector('h5')?.textContent).toBe('Part');
    expect(root.querySelector('h6')?.textContent).toBe('Small');
  });

  it('frames a table so it scrolls by itself and the keyboard can reach it', () => {
    const root = dom('| Option | Cost |\n|---|---:|\n| Express | $9.90 |', {
      labels: { copy: 'Copy', table: 'Table', source: 'Source {n}' },
    });
    const frame = root.querySelector('.hv-table');
    expect(frame?.getAttribute('role')).toBe('region');
    expect(frame?.getAttribute('aria-label')).toBe('Table');
    expect(frame?.getAttribute('tabindex')).toBe('0');
    expect(frame?.querySelectorAll('th')).toHaveLength(2);
    expect(frame?.querySelector('td[align="right"]')?.textContent).toBe('$9.90');
    // A class or a style from the answer never reaches the page.
    expect(root.querySelector('table')?.getAttribute('class')).toBeNull();
  });

  it('names the language of code and gives it a copy button', () => {
    const root = dom('```bash\ncurl https://api.noor.example/v1/orders\n```\n\nUse `status`.', {
      labels: { copy: 'Copy', table: 'Table', source: 'Source {n}' },
    });
    const frame = root.querySelector('.hv-code');
    expect(frame?.querySelector('.hv-code-head span')?.textContent).toBe('bash');
    const button = frame?.querySelector('button[data-hv-copy]');
    expect(button?.textContent).toBe('Copy');
    expect(button?.getAttribute('type')).toBe('button');
    expect(frame?.querySelector('pre')?.textContent).toContain('curl https://api.noor.example');
    expect(frame?.querySelector('pre')?.getAttribute('dir')).toBe('ltr');
    // Code inside a sentence is not framed.
    expect(root.querySelectorAll('.hv-code')).toHaveLength(1);
  });

  it('links [n] to the answer’s sources, and only to sources it lists', () => {
    const text = 'Ships the same day [1]. Returns within 30 days [2]. See also [3] and `[1]`.';
    const root = dom(text, {
      sources: 2,
      labels: { copy: 'Copy', table: 'Table', source: 'Source {n}' },
    });
    const cites = [...root.querySelectorAll('a[data-hv-cite]')];
    expect(cites.map((a) => a.getAttribute('data-hv-cite'))).toEqual(['1', '2']);
    expect(cites[0]?.getAttribute('aria-label')).toBe('Source 1');
    expect(cites[0]?.getAttribute('href')).toBe('#source-1');
    expect(root.textContent).toContain('[3]');
    expect(root.querySelector('code')?.textContent).toBe('[1]');
    // Without sources the numbers stay as the answer wrote them.
    expect(dom(text).querySelector('a[data-hv-cite]')).toBeNull();
  });

  it('keeps an order number in order inside a right-to-left sentence', () => {
    const root = dom('طلبك NB-2026-0000918273645 في الطريق');
    const isolated = root.querySelector('bdi[dir="ltr"]');
    expect(isolated?.textContent).toBe('NB-2026-0000918273645');
  });

  it('gives the same answer back without parsing it again, unless told not to keep it', () => {
    const first = renderMarkdown('Kept **once**');
    expect(renderMarkdown('Kept **once**')).toBe(first);
    expect(renderMarkdown('Being written', { cache: false })).toContain('Being written');
  });
});
