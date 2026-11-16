import { ComposerPrimitive, useAui, useAuiState } from '@assistant-ui/react';
import type { HamnivoClient, OutgoingAttachment } from '@hamnivo/client';
import { Button } from '@hamnivo/ui/components/button';
import { ArrowUpIcon, PaperclipIcon, SmileIcon, SquareIcon, XIcon } from 'lucide-react';
import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  lazy,
  Suspense,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useTypingReports } from '../../useTyping.js';
import { BidiText, directionOf } from '../BidiText.js';
import { fileSize } from '../Parts.js';

// The emoji load when the visitor first asks for them.
const EmojiPicker = lazy(() => import('./EmojiPicker.js'));

/** A file being attached: checked by the gateway, then sent with the next message (W09). */
export interface Chip {
  id: string;
  name: string;
  size: number;
  state: 'uploading' | 'ready' | 'refused';
  file?: OutgoingAttachment;
  reason?: string;
}

/**
 * The message box (U08). Enter sends and Shift+Enter starts a new line, but an Enter that
 * confirms an input method composition (Hindi, Urdu, Arabic or Chinese keyboards) never sends:
 * browsers flag it with isComposing, Safari only with key code 229 after the composition ends.
 * The box follows the direction of what is typed, so Urdu typed in the English interface reads
 * right to left. Files go with the words (W09): from the paperclip, dropped on the chat, or
 * pasted here. What is typed is kept as a draft (W07).
 */
export function Composer(props: {
  label: string;
  send: string;
  draftScope: string;
  /** The conversation the words go to; null before there is one (nothing is reported then). */
  conversationId: string | null;
  client: HamnivoClient;
  chips: readonly Chip[];
  attach: { allowed: boolean; accept: string; maxFiles: number; maxMb: number };
  onFiles: (files: File[]) => void;
  onRemoveChip: (id: string) => void;
  onSendFiles: () => void;
  locale: string;
  prefill: { text: string; at: number } | null;
  /** Called once the words are in the box, so a remounted box does not type them again. */
  onPrefilled: (at: number) => void;
  /** Stops the answer being written, where the gateway can; absent otherwise. */
  onStop?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const aui = useAui();
  const text = useAuiState((s) => s.composer.text);
  const composing = useRef(false);
  const picker = useRef<HTMLInputElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const emojiButton = useRef<HTMLButtonElement>(null);
  const [emoji, setEmoji] = useState(false);
  const hintId = useId();
  const uploading = props.chips.some((c) => c.state === 'uploading');
  const ready = props.chips.some((c) => c.state === 'ready');
  const { drafts } = props.client;
  const scope = props.draftScope;
  const { conversationId, client } = props;
  // Staff see "typing…" while the visitor writes.
  useTypingReports(
    conversationId ? (typing) => client.reportTyping(conversationId, typing) : null,
    text,
  );

  // The draft comes back after a reload; typing keeps it for this person and conversation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the scope changes
  useEffect(() => {
    const draft = drafts.get(scope);
    if (draft && !aui.composer().getState().text) aui.composer().setText(draft);
  }, [scope]);
  useEffect(() => {
    const timer = setTimeout(() => drafts.set(scope, text), 300);
    return () => clearTimeout(timer);
  }, [drafts, scope, text]);
  // The website's words go in the box only; the visitor reads them and chooses to send.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per prefill
  useEffect(() => {
    if (!props.prefill) return;
    aui.composer().setText(props.prefill.text);
    props.onPrefilled(props.prefill.at);
  }, [props.prefill]);
  // A click anywhere else puts the emoji away.
  useEffect(() => {
    if (!emoji) return;
    const away = (event: PointerEvent) => {
      if (!shell.current?.parentElement?.contains(event.target as Node)) setEmoji(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [emoji]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };
  const onSubmit = (event: FormEvent) => {
    setEmoji(false);
    if (uploading) {
      event.preventDefault();
      return;
    }
    // Files alone: the composer only sends words, so they go from here.
    if (!text.trim() && ready) {
      event.preventDefault();
      props.onSendFiles();
    }
  };
  /** Pictures and files on the clipboard are attached; words are pasted as always. */
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (!props.attach.allowed || files.length === 0) return;
    event.preventDefault();
    props.onFiles(files);
  };
  /** Puts an emoji where the caret is, and the caret after it. */
  const insert = (symbol: string) => {
    const area = shell.current?.querySelector('textarea');
    const current = aui.composer().getState().text;
    const start = area?.selectionStart ?? current.length;
    const end = area?.selectionEnd ?? current.length;
    aui.composer().setText(current.slice(0, start) + symbol + current.slice(end));
    requestAnimationFrame(() => {
      const caret = start + symbol.length;
      area?.setSelectionRange(caret, caret);
    });
  };
  const closeEmoji = () => {
    setEmoji(false);
    emojiButton.current?.focus();
  };

  return (
    <ComposerPrimitive.Root className="relative flex flex-col gap-2" onSubmit={onSubmit}>
      {props.chips.length ? (
        <ul
          className="flex flex-wrap gap-2"
          aria-label={t('surface.files.attach')}
          data-testid="file-chips"
        >
          {props.chips.map((chip) => (
            <li
              key={chip.id}
              className={`hv-pop flex max-w-full items-center gap-1 rounded-full border bg-surface py-0.5 ps-2.5 pe-0.5 text-xs ${
                chip.state === 'refused'
                  ? 'border-danger/40 text-danger'
                  : 'border-border text-text'
              }`}
              data-state={chip.state}
            >
              <PaperclipIcon className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 break-all">
                <BidiText text={chip.name} />
              </span>
              <span className="text-text-muted">· {fileSize(chip.size, props.locale)}</span>
              <span className="text-text-muted">
                ·{' '}
                {chip.state === 'uploading'
                  ? t('surface.files.uploading')
                  : chip.state === 'ready'
                    ? t('surface.files.ready')
                    : (chip.reason ?? t('surface.files.refused'))}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-8 rounded-full"
                aria-label={t('surface.files.remove', { name: chip.name })}
                onClick={() => props.onRemoveChip(chip.id)}
              >
                <XIcon className="size-3.5" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div
        ref={shell}
        className="flex items-end gap-0.5 rounded-xl border border-input bg-surface p-1 shadow-sm [@media(max-height:26rem)]:p-0.5 transition-shadow duration-[var(--hv-motion-fast)] focus-within:border-primary focus-within:ring-2 focus-within:ring-ring/30"
      >
        {props.attach.allowed ? (
          <>
            <input
              ref={picker}
              type="file"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              accept={props.attach.accept}
              multiple={props.attach.maxFiles > 1}
              onChange={(e) => {
                props.onFiles([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
              data-testid="file-input"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11 shrink-0 rounded-lg text-text-secondary"
              aria-label={t('surface.files.attach')}
              aria-describedby={hintId}
              onClick={() => picker.current?.click()}
            >
              <PaperclipIcon className="size-5" aria-hidden="true" />
            </Button>
            <span id={hintId} className="sr-only">
              {t('surface.files.hint', { size: props.attach.maxMb })}
            </span>
          </>
        ) : null}
        <ComposerPrimitive.Input
          aria-label={props.label}
          placeholder={props.label}
          maxLength={10_000}
          dir={directionOf(text)}
          rows={1}
          // A long message scrolls in the box instead of pushing the conversation off a phone.
          maxRows={5}
          submitMode="none"
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          // 16 px, so phones do not zoom in when the box takes focus; the frame around it shows focus.
          className="min-h-11 min-w-0 flex-1 resize-none bg-transparent px-2 py-2.5 text-md text-text outline-none placeholder:text-text-muted focus-visible:outline-none"
        />
        <Button
          ref={emojiButton}
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 shrink-0 rounded-lg text-text-secondary max-[20rem]:hidden"
          aria-label={t('ui.emoji')}
          aria-expanded={emoji}
          onClick={() => setEmoji((open) => !open)}
        >
          <SmileIcon className="size-5" aria-hidden="true" />
        </Button>
        {/* While a reply is written, an empty box offers Stop; words typed meanwhile can still be sent. */}
        {props.onStop && !text.trim() && !ready ? (
          <Button
            type="button"
            variant="secondary"
            className="size-11 shrink-0 rounded-full p-0"
            aria-label={t('ui.stop')}
            title={t('ui.stop')}
            onClick={props.onStop}
            data-testid="stop-reply"
          >
            <SquareIcon className="size-4 fill-current" aria-hidden="true" />
          </Button>
        ) : text.trim() ? (
          <ComposerPrimitive.Send asChild>
            <Button
              className="size-11 shrink-0 rounded-full p-0"
              aria-label={props.send}
              title={props.send}
              aria-disabled={uploading || undefined}
            >
              <ArrowUpIcon className="size-5" aria-hidden="true" />
            </Button>
          </ComposerPrimitive.Send>
        ) : (
          <Button
            type="submit"
            className="size-11 shrink-0 rounded-full p-0"
            aria-label={props.send}
            title={props.send}
            disabled={!ready || uploading}
            data-testid="send-files"
          >
            <ArrowUpIcon className="size-5" aria-hidden="true" />
          </Button>
        )}
      </div>
      {emoji ? (
        <Suspense fallback={null}>
          <EmojiPicker label={t('ui.emoji')} onPick={insert} onClose={closeEmoji} />
        </Suspense>
      ) : null}
    </ComposerPrimitive.Root>
  );
}
