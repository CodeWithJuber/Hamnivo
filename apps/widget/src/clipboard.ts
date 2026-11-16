/**
 * Copies text for the visitor. The chat runs in a frame on someone else's website, where the
 * clipboard is only open to it when the website's loader allows it (`allow="clipboard-write"`),
 * so the older selection-based copy is tried when the newer one is refused. Resolves false when
 * neither worked; nothing is thrown.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Not allowed in this frame: try the selection below.
  }
  try {
    const active = document.activeElement as HTMLElement | null;
    const holder = document.createElement('textarea');
    holder.value = text;
    holder.readOnly = true;
    holder.tabIndex = -1;
    holder.setAttribute('aria-hidden', 'true');
    holder.style.cssText = 'position:fixed;inset-block-start:0;opacity:0;pointer-events:none';
    document.body.append(holder);
    holder.select();
    const copied = document.execCommand('copy');
    holder.remove();
    active?.focus?.();
    return copied;
  } catch {
    return false;
  }
}
