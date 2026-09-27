import { KNOWLEDGE_MAX_BYTES, type KNOWLEDGE_MEDIA_TYPES } from '@hamnivo/contracts';
import { fileTypeFromBuffer } from 'file-type';
import { convert, type FormatCallback } from 'html-to-text';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';

type MediaType = (typeof KNOWLEDGE_MEDIA_TYPES)[number];

export type ExtractionFailure = 'type_mismatch' | 'unreadable' | 'too_large' | 'timeout';

export class ExtractionError extends Error {
  constructor(
    readonly reason: ExtractionFailure,
    message: string,
  ) {
    super(message);
    this.name = 'ExtractionError';
  }
}

const MAX_PDF_PAGES = 500;
const PARSE_TIMEOUT_MS = 30_000;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Stops waiting for a parser; in-process parsing itself cannot be interrupted. */
function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ExtractionError('timeout', 'The file took too long to read.')),
      PARSE_TIMEOUT_MS,
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

// HTML headings become Markdown headings, so chunks keep the section they came from.
const heading: FormatCallback = (element, walk, builder, options) => {
  builder.openBlock({ leadingLineBreaks: 2 });
  builder.addInline(`${'#'.repeat(Number(options.level ?? 2))} `);
  walk(element.children, builder);
  builder.closeBlock({ trailingLineBreaks: 2 });
};

function htmlText(html: string): string {
  return convert(html, {
    wordwrap: false,
    formatters: { heading },
    selectors: [
      ...[1, 2, 3, 4, 5, 6].map((level) => ({
        selector: `h${level}`,
        format: 'heading',
        options: { level },
      })),
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'script', format: 'skip' },
      { selector: 'style', format: 'skip' },
      { selector: 'nav', format: 'skip' },
      { selector: 'footer', format: 'skip' },
    ],
  });
}

function utf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ExtractionError('unreadable', 'The text is not valid UTF-8.');
  }
}

/**
 * Plain text of an uploaded document. The declared type must match the content: a PDF must be a
 * PDF, and a "text" upload must not be a binary file.
 */
export async function extractDocumentText(
  bytes: Uint8Array,
  mediaType: MediaType,
): Promise<string> {
  if (bytes.byteLength > KNOWLEDGE_MAX_BYTES) {
    throw new ExtractionError('too_large', 'The file is larger than 5 MB.');
  }
  const sniffed = await fileTypeFromBuffer(bytes);
  switch (mediaType) {
    case 'text/plain':
    case 'text/markdown':
    case 'text/html': {
      if (sniffed && sniffed.mime !== 'application/xml') {
        throw new ExtractionError('type_mismatch', `The file is ${sniffed.mime}, not text.`);
      }
      const text = utf8(bytes);
      return mediaType === 'text/html' ? htmlText(text) : text;
    }
    case 'application/pdf': {
      if (sniffed?.mime !== 'application/pdf') {
        throw new ExtractionError('type_mismatch', 'The file is not a PDF.');
      }
      try {
        const pdf = await bounded(getDocumentProxy(new Uint8Array(bytes)));
        if (pdf.numPages > MAX_PDF_PAGES) {
          throw new ExtractionError('too_large', `The PDF has more than ${MAX_PDF_PAGES} pages.`);
        }
        const { text } = await bounded(extractText(pdf, { mergePages: true }));
        return text;
      } catch (error) {
        if (error instanceof ExtractionError) throw error;
        throw new ExtractionError('unreadable', 'The PDF could not be read.');
      }
    }
    case DOCX: {
      if (sniffed?.mime !== DOCX) {
        throw new ExtractionError('type_mismatch', 'The file is not a Word document.');
      }
      try {
        const result = await bounded(mammoth.extractRawText({ buffer: Buffer.from(bytes) }));
        return result.value;
      } catch (error) {
        if (error instanceof ExtractionError) throw error;
        throw new ExtractionError('unreadable', 'The Word document could not be read.');
      }
    }
  }
}
