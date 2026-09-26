import * as React from 'react';

type Politeness = 'polite' | 'assertive';
type Announce = (message: string, politeness?: Politeness) => void;

const AnnouncerContext = React.createContext<Announce | null>(null);

/**
 * App-level live regions (WCAG 4.1.3). Announce meaningful status — "Reply ready", "Message failed
 * to send" — never every streamed token (UX flow spec §4).
 */
function AnnouncerProvider({ children }: { children: React.ReactNode }) {
  const [polite, setPolite] = React.useState('');
  const [assertive, setAssertive] = React.useState('');
  const announce = React.useCallback<Announce>((message, politeness = 'polite') => {
    const set = politeness === 'assertive' ? setAssertive : setPolite;
    // Clear first so repeating the same message is announced again.
    set('');
    requestAnimationFrame(() => set(message));
  }, []);
  return (
    <AnnouncerContext.Provider value={announce}>
      {children}
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-slot="announcer-polite"
      >
        {polite}
      </div>
      <div
        className="sr-only"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        data-slot="announcer-assertive"
      >
        {assertive}
      </div>
    </AnnouncerContext.Provider>
  );
}

function useAnnouncer(): Announce {
  const announce = React.useContext(AnnouncerContext);
  if (!announce) throw new Error('useAnnouncer must be used inside <AnnouncerProvider>');
  return announce;
}

export { AnnouncerProvider, useAnnouncer };
