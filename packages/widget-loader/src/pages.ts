/**
 * Pages the website keeps the chat off (`data-hide-on="/checkout*, /admin/*"`): a list of paths,
 * each exact or with `*` for any run of characters. The query and the hash are not part of a
 * path. Pure, so it is tested without a browser.
 */
export function hiddenOn(patterns: string | undefined, path: string): boolean {
  if (!patterns) return false;
  return patterns.split(',').some((raw) => {
    const pattern = raw.trim();
    if (!pattern) return false;
    const exact = pattern
      .split('*')
      .map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${exact}/?$`).test(path);
  });
}
