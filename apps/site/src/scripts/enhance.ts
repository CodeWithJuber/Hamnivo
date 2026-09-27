/**
 * The only client script, and optional: without it every page still works. It reveals copy
 * buttons where the Clipboard API exists and, when the live demo is on, the "Open the chat"
 * button once the loader has defined window.Hamnivo.
 */

if (navigator.clipboard) {
  for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-copy]')) {
    const id = button.dataset.copy ?? '';
    const status = document.querySelector<HTMLElement>(`[data-copy-status="${id}"]`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    button.hidden = false;
    button.addEventListener('click', async () => {
      const text = document.getElementById(id)?.textContent ?? '';
      let message = button.dataset.copied ?? '';
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        message = button.dataset.failed ?? '';
      }
      if (!status) return;
      status.textContent = message;
      clearTimeout(timer);
      timer = setTimeout(() => {
        status.textContent = '';
      }, 4000);
    });
  }
}

const openChat = document.querySelector<HTMLButtonElement>('button[data-open-chat]');
if (openChat) {
  const reveal = () => {
    if (window.Hamnivo) openChat.hidden = false;
  };
  document.querySelector('script[data-widget-id]')?.addEventListener('load', reveal);
  reveal();
  openChat.addEventListener('click', () => window.Hamnivo?.open());
}
