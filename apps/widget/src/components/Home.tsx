import type { HamnivoClient } from '@hamnivo/client';
import type { CustomerConversation, HelpArticle, WidgetConfig } from '@hamnivo/contracts';
import { Button } from '@hamnivo/ui/components/button';
import { ChevronRightIcon, MailIcon, MessagesSquareIcon, SearchIcon } from 'lucide-react';
import { type FormEvent, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BidiText } from './BidiText.js';
import { StatusLine } from './StatusLine.js';

/** Only web links open from the chat. */
const webLink = (url: string | null): string | null => {
  try {
    return url && /^https?:$/.test(new URL(url).protocol) ? url : null;
  } catch {
    return null;
  }
};

/**
 * The chat's home before a conversation (W11, W17, W19): the brand's greeting and who can answer
 * right now, in the brand's colour under the header; the words of a proactive prompt the visitor
 * opened; the visitor's last conversation, one press away; the brand's suggested questions (each
 * starts the conversation) and a search of the brand's public help. Results are the brand's own
 * articles, never generated text. While nobody can answer, a card offers to leave a message;
 * the questions and the message box stay, since the assistant may still help. While chat isn't
 * available to this visitor (H20), help search stays and the questions show without starting a
 * chat; the chat says why below, in neutral words.
 */
export function Home(props: {
  client: HamnivoClient;
  greeting: string;
  /** The prompt the visitor opened the chat from, in the brand's own words. */
  prompt: { brand: string; text: string } | null;
  suggestions: readonly string[];
  search: boolean;
  /** Who can answer right now; left out where the configuration does not say. */
  availability?: WidgetConfig['availability'] | undefined;
  locale?: string;
  /** Opens the contact form; null while someone can answer or the brand has none. */
  onContact?: (() => void) | null;
  /** False while chat isn't available to this visitor: nothing here starts a chat. */
  available?: boolean;
  /** The visitor's latest other conversation, offered to go back to; null when there is none. */
  recent?: CustomerConversation | null;
  onOpenRecent?: (conversationId: string) => void;
  onAsk: (question: string) => void;
}) {
  const { t } = useTranslation();
  const searchId = useId();
  const available = props.available !== false;
  const [query, setQuery] = useState('');
  const [state, setState] = useState<
    | { phase: 'idle' }
    | { phase: 'searching' }
    | { phase: 'done'; query: string; items: HelpArticle[] }
    | { phase: 'failed' }
  >({ phase: 'idle' });
  const results = useRef<HTMLHeadingElement>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const q = query.trim();
    if (!q) return;
    setState({ phase: 'searching' });
    try {
      const found = await props.client.helpSearch(q);
      setState({ phase: 'done', query: q, items: found.items });
      requestAnimationFrame(() => results.current?.focus());
    } catch {
      setState({ phase: 'failed' });
    }
  };

  return (
    <div className="mb-4 flex flex-col gap-4" data-testid="home">
      {/* The greeting carries on from the header, edge to edge, in the same colour. */}
      <div className="hv-hero -mx-4 -mt-4 flex flex-col gap-2 rounded-b-xl px-5 pt-3 pb-5 [@media(max-height:26rem)]:pt-1 [@media(max-height:26rem)]:pb-2">
        <h2 className="text-xl font-semibold [@media(max-height:26rem)]:text-md">
          {t('surface.home.title')}
        </h2>
        <p className="text-[0.9375rem] leading-relaxed" data-testid="greeting">
          {props.greeting}
        </p>
        {props.availability && available ? (
          <StatusLine
            availability={props.availability}
            locale={props.locale ?? 'en'}
            tone="inherit"
          />
        ) : null}
      </div>
      {props.prompt ? (
        <section
          aria-label={t('surface.proactive.from', { brand: props.prompt.brand })}
          className="hv-enter rounded-xl rounded-ss-sm border border-border bg-surface px-3.5 py-2 text-[0.9375rem] text-text shadow-sm"
          data-testid="proactive-greeting"
        >
          <BidiText text={props.prompt.text} />
        </section>
      ) : null}
      {props.onContact && available ? (
        <section
          aria-labelledby={`${searchId}-contact`}
          className="flex flex-col gap-2 rounded-xl border border-primary/40 bg-surface p-4 shadow-sm"
          data-testid="contact-card"
        >
          <h2 id={`${searchId}-contact`} className="text-[0.9375rem] font-semibold text-text">
            {t('surface.contact.title')}
          </h2>
          <p className="text-sm text-text">{t('surface.contact.body')}</p>
          <Button
            id="hv-contact-open"
            className="h-auto min-h-11 self-start whitespace-normal py-2"
            onClick={props.onContact}
          >
            <MailIcon className="size-4" aria-hidden="true" />
            {t('surface.contact.open')}
          </Button>
        </section>
      ) : null}
      {props.recent && props.onOpenRecent ? (
        <section
          aria-labelledby={`${searchId}-recent`}
          className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2.5 shadow-sm"
          data-testid="recent-conversation"
        >
          <MessagesSquareIcon className="size-5 shrink-0 text-text-muted" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 id={`${searchId}-recent`} className="text-xs font-medium text-text-muted">
              {t('ui.lastChat')}
            </h2>
            <p className="line-clamp-1 break-words text-sm text-text">
              {props.recent.lastMessagePreview ? (
                <BidiText text={props.recent.lastMessagePreview} />
              ) : (
                t('surface.conversations.empty')
              )}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 rounded-full"
            onClick={() => props.recent && props.onOpenRecent?.(props.recent.id)}
          >
            {t('ui.openChat')}
          </Button>
        </section>
      ) : null}
      {props.suggestions.length ? (
        <section aria-labelledby={`${searchId}-suggestions`} className="flex flex-col gap-2">
          <h2 id={`${searchId}-suggestions`} className="px-1 text-sm font-medium text-text-muted">
            {t('surface.home.suggestions')}
          </h2>
          <ul
            className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-sm"
            data-testid="suggestions"
          >
            {props.suggestions.map((question) => (
              <li key={question} className="relative border-b border-border last:border-b-0">
                {/* Only the question is in the button; the arrow beside it is decoration. */}
                <button
                  type="button"
                  className="min-h-11 w-full px-3.5 py-2.5 pe-10 text-start text-[0.9375rem] text-text outline-none hover:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring disabled:text-text-muted disabled:hover:bg-transparent"
                  dir="auto"
                  disabled={!available}
                  onClick={() => props.onAsk(question)}
                >
                  {question}
                </button>
                <ChevronRightIcon
                  className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-text-muted rtl:rotate-180"
                  aria-hidden="true"
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {props.search ? (
        <section className="flex flex-col gap-2" data-testid="help-search">
          <search>
            <form
              className="flex items-center gap-1 rounded-xl border border-input bg-surface p-1 shadow-sm focus-within:border-primary focus-within:ring-2 focus-within:ring-ring/30"
              onSubmit={(e) => void submit(e)}
            >
              <label htmlFor={searchId} className="sr-only">
                {t('surface.home.searchLabel')}
              </label>
              <input
                id={searchId}
                type="search"
                value={query}
                maxLength={200}
                dir="auto"
                placeholder={t('surface.home.searchPlaceholder')}
                onChange={(e) => setQuery(e.target.value)}
                // 16 px, so phones do not zoom in when the box takes focus.
                className="min-h-11 min-w-0 flex-1 bg-transparent px-2.5 py-2 text-md text-text outline-none placeholder:text-text-muted focus-visible:outline-none"
              />
              <Button
                type="submit"
                variant="ghost"
                size="icon"
                className="size-11 shrink-0 rounded-lg text-text-secondary"
                busy={state.phase === 'searching'}
                aria-label={t('surface.home.search')}
              >
                <SearchIcon className="size-4" aria-hidden="true" />
              </Button>
            </form>
          </search>
          <div aria-live="polite" className="flex flex-col gap-2">
            {state.phase === 'searching' ? (
              <p className="text-sm text-text-muted">{t('surface.home.searching')}</p>
            ) : null}
            {state.phase === 'failed' ? (
              <p className="text-sm text-text-muted">
                {available ? t('surface.home.searchFailed') : t('surface.home.searchFailedOnly')}
              </p>
            ) : null}
            {state.phase === 'done' ? (
              state.items.length === 0 ? (
                <p className="text-sm text-text-muted">
                  {available
                    ? t('surface.home.noResults', { query: state.query })
                    : t('surface.home.noResultsOnly', { query: state.query })}
                </p>
              ) : (
                <>
                  <h2
                    ref={results}
                    tabIndex={-1}
                    className="text-sm font-medium text-text outline-none"
                  >
                    {t('surface.home.resultsFor', { query: state.query })}
                  </h2>
                  <ul className="flex flex-col gap-2" data-testid="help-results">
                    {state.items.map((article) => (
                      <li
                        key={article.id}
                        className="hv-enter rounded-xl border border-border bg-surface px-3 py-2 text-sm shadow-sm"
                      >
                        <h3 className="font-medium text-text" dir="auto">
                          {article.title}
                        </h3>
                        {article.heading ? (
                          <p className="text-xs text-text-muted" dir="auto">
                            {article.heading}
                          </p>
                        ) : null}
                        <p className="mt-1 text-text" dir="auto">
                          {article.excerpt}
                        </p>
                        {webLink(article.url) ? (
                          <a
                            href={webLink(article.url) as string}
                            target="_blank"
                            rel="noopener noreferrer nofollow"
                            className="mt-1 inline-flex text-link underline underline-offset-2"
                          >
                            {t('surface.home.openArticle')}
                          </a>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </>
              )
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
