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
 * Markdown from agents and staff as safe HTML (W08): a short allow-list of tags, links only to
 * http(s) and mailto, no images, scripts, styles or event handlers. Headings keep their text.
 */
export function renderMarkdown(text: string): string {
  const html = markdown.parse(text, { async: false });
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href', 'target', 'rel'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
  });
}
