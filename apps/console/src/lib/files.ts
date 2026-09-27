import type { KnowledgeMediaType } from './types';

/** Largest upload, the same as KNOWLEDGE_MAX_BYTES in @hamnivo/contracts (checked here first). */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const BY_EXTENSION: Record<string, KnowledgeMediaType> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  html: 'text/html',
  htm: 'text/html',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
};

export const ACCEPTED_FILES = [
  ...Object.keys(BY_EXTENSION).map((ext) => `.${ext}`),
  ...new Set(Object.values(BY_EXTENSION)),
].join(',');

/** The media type the gateway expects, from the file name (browsers often leave type empty). */
export function mediaTypeOf(file: File): KnowledgeMediaType | null {
  const extension = file.name.toLowerCase().split('.').pop() ?? '';
  return BY_EXTENSION[extension] ?? null;
}

/** File bytes as base64, without the data: URL prefix. */
export function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const url = String(reader.result ?? '');
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}
