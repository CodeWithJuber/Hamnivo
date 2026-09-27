import { bidiSegments } from '@hamnivo/domain';
import DOMPurify from 'dompurify';
import { Marked } from 'marked';

const markdown = new Marked({ gfm: true, breaks: true });

// Links from answers open outside the chat and never pass the widget's context on.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
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
 * Markdown from agents and staff as safe HTML (W08): a short allow-list of tags, links only to
 * http(s) and mailto, no images, scripts, styles or event handlers. Headings keep their text.
 * Identifiers are isolated for right-to-left reading after sanitizing, as elements built here.
 */
export function renderMarkdown(text: string): string {
  const html = markdown.parse(text, { async: false });
  const fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href', 'target', 'rel'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
    RETURN_DOM_FRAGMENT: true,
  });
  isolateIdentifiers(fragment);
  const container = document.createElement('div');
  container.append(fragment);
  return container.innerHTML;
}
