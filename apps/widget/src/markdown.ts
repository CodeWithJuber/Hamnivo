import { bidiSegments } from '@hamnivo/domain';
import DOMPurify from 'dompurify';
import { Marked } from 'marked';

const markdown = new Marked({ gfm: true, breaks: true });

/** Words the page writes into an answer: they come from the chat's own language file. */
export interface MarkdownLabels {
  /** On the button that copies a piece of code. */
  copy: string;
  /** Names a table for screen readers, since it scrolls by itself. */
  table: string;
  /** Names the link from a number in the text to its source: `{n}` is the number. */
  source: string;
}

export interface MarkdownOptions {
  labels?: MarkdownLabels;
  /** How many sources the answer lists: `[1]` to `[n]` in its text link to them. */
  sources?: number;
  /** Off for an answer still being written, whose text changes with every piece. */
  cache?: boolean;
}

// Links from answers open outside the chat and never pass the widget's context on.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
  }
});
// A class only names the language of a piece of code; a cell may only say how it is aligned.
DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (data.attrName === 'class') {
    data.keepAttr = node.tagName === 'CODE' && /^language-[\w+#.-]{1,30}$/.test(data.attrValue);
  }
  if (data.attrName === 'align') {
    data.keepAttr =
      (node.tagName === 'TH' || node.tagName === 'TD') &&
      /^(left|right|center)$/.test(data.attrValue);
  }
});

const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'del',
  'ul',
  'ol',
  'li',
  'a',
  'code',
  'pre',
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
];

/**
 * Wraps identifiers, amounts, emails and web addresses in `<bdi dir="ltr">` (U08), so an order
 * number keeps its order inside an Arabic or Urdu sentence. Code and links read left to right.
 */
function isolateIdentifiers(root: DocumentFragment) {
  for (const element of root.querySelectorAll('code, pre')) element.setAttribute('dir', 'ltr');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const node of texts) {
    if (node.parentElement?.closest('code, pre, a')) continue;
    const segments = bidiSegments(node.data);
    if (!segments.some((segment) => segment.isolate)) continue;
    node.replaceWith(
      ...segments.map((segment) => {
        if (!segment.isolate) return document.createTextNode(segment.text);
        const bdi = document.createElement('bdi');
        bdi.setAttribute('dir', 'ltr');
        bdi.textContent = segment.text;
        return bdi;
      }),
    );
  }
}

/**
 * A heading in an answer is a heading inside a message, two levels under the chat's own: the
 * page keeps one outline, and no answer can pose as the name of the chat.
 */
function lowerHeadings(root: DocumentFragment) {
  for (const heading of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const level = Math.min(6, Number(heading.tagName.slice(1)) + 2);
    const lowered = document.createElement(`h${level}`);
    lowered.append(...heading.childNodes);
    heading.replaceWith(lowered);
  }
}

/** A wide table scrolls inside its own frame, which the keyboard can reach, never the chat. */
function frameTables(root: DocumentFragment, label: string) {
  for (const table of root.querySelectorAll('table')) {
    const frame = document.createElement('div');
    frame.className = 'hv-table';
    frame.setAttribute('role', 'region');
    frame.setAttribute('aria-label', label);
    frame.tabIndex = 0;
    table.replaceWith(frame);
    frame.append(table);
  }
}

/** Code gets its language named and a button that copies it (handled where it is rendered). */
function frameCode(root: DocumentFragment, label: string) {
  for (const pre of root.querySelectorAll('pre')) {
    const language = /language-([\w+#.-]+)/.exec(pre.querySelector('code')?.className ?? '')?.[1];
    const frame = document.createElement('div');
    frame.className = 'hv-code';
    const head = document.createElement('div');
    head.className = 'hv-code-head';
    const name = document.createElement('span');
    name.setAttribute('dir', 'ltr');
    name.textContent = language ?? '';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.setAttribute('data-hv-copy', '');
    copy.textContent = label;
    head.append(name, copy);
    pre.tabIndex = 0;
    pre.replaceWith(frame);
    frame.append(head, pre);
  }
}

/** `[2]` in an answer becomes a link to its second source, when the answer lists that many. */
function linkSources(root: DocumentFragment, count: number, label: string) {
  if (count <= 0) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const node of texts) {
    if (node.parentElement?.closest('code, pre, a')) continue;
    const pieces = node.data.split(/(\[\d{1,2}\])/);
    if (pieces.length < 2) continue;
    node.replaceWith(
      ...pieces.map((piece) => {
        const number = Number(/^\[(\d{1,2})\]$/.exec(piece)?.[1]);
        if (!number || number > count) return document.createTextNode(piece);
        const link = document.createElement('a');
        link.className = 'hv-cite';
        link.href = `#source-${number}`;
        link.setAttribute('data-hv-cite', String(number));
        link.setAttribute('aria-label', label.replace('{n}', String(number)));
        link.textContent = String(number);
        return link;
      }),
    );
  }
}

const DEFAULT_LABELS: MarkdownLabels = { copy: 'Copy', table: 'Table', source: 'Source {n}' };
const CACHE_SIZE = 200;
const cache = new Map<string, string>();

/**
 * Markdown from agents and staff as safe HTML (W08): a short allow-list of tags, links only to
 * http(s) and mailto, no images, scripts, styles or event handlers. Identifiers are isolated for
 * right-to-left reading, tables and code are framed, and the numbers of sources become links,
 * all after sanitizing and as elements built here. An answer already shown is not parsed again.
 */
export function renderMarkdown(text: string, options: MarkdownOptions = {}): string {
  const labels = options.labels ?? DEFAULT_LABELS;
  const sources = options.sources ?? 0;
  const key = `${labels.copy}\u0000${labels.table}\u0000${labels.source}\u0000${sources}\u0000${text}`;
  const known = options.cache === false ? undefined : cache.get(key);
  if (known !== undefined) return known;
  const html = markdown.parse(text, { async: false });
  const fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'align'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
    // How a cell is aligned is a word, not an address: it is checked above, not as a link.
    ADD_URI_SAFE_ATTR: ['align'],
    RETURN_DOM_FRAGMENT: true,
  });
  lowerHeadings(fragment);
  // Before identifiers are isolated: that would take the number out of its brackets.
  linkSources(fragment, sources, labels.source);
  isolateIdentifiers(fragment);
  frameTables(fragment, labels.table);
  frameCode(fragment, labels.copy);
  const container = document.createElement('div');
  container.append(fragment);
  const rendered = container.innerHTML;
  if (options.cache !== false) {
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value as string);
    cache.set(key, rendered);
  }
  return rendered;
}
