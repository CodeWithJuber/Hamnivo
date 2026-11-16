import { type DragEvent, useRef, useState } from 'react';

const carriesFiles = (event: DragEvent) => event.dataTransfer?.types?.includes('Files') === true;

/**
 * Files dragged onto the chat (W09). `over` is true while files hover over the element the
 * handlers are on, so the chat can say where they will go; what is dropped goes to `onFiles`,
 * which checks each file as the paperclip does. Without `enabled` nothing is handled, and the
 * browser treats a drop as it does everywhere else.
 */
export function useFileDrop(enabled: boolean, onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false);
  // Entering a child fires a second "enter" before the parent's "leave": count them.
  const depth = useRef(0);
  if (!enabled) return { over: false, handlers: {} };
  return {
    over,
    handlers: {
      onDragEnter: (event: DragEvent) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        depth.current += 1;
        setOver(true);
      },
      onDragOver: (event: DragEvent) => {
        if (carriesFiles(event)) event.preventDefault();
      },
      onDragLeave: (event: DragEvent) => {
        if (!carriesFiles(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      },
      onDrop: (event: DragEvent) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        depth.current = 0;
        setOver(false);
        const files = [...(event.dataTransfer?.files ?? [])];
        if (files.length) onFiles(files);
      },
    },
  };
}
