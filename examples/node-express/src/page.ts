import { USERS, type User } from './users.js';

export interface PageOptions {
  widgetId: string;
  widgetOrigin: string;
  api: string;
  user: User | undefined;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The shop's only page: the sign-in state, the Hamnivo loader and the identity script. */
export function renderPage({ widgetId, widgetOrigin, api, user }: PageOptions): string {
  const account = user
    ? `<p>Signed in as ${escapeHtml(user.name)}.</p>
      <form id="sign-out" method="post" action="/sign-out">
        <button type="submit">Sign out</button>
      </form>`
    : `<form method="post" action="/sign-in">
        <label for="user">Sign in as</label>
        <select id="user" name="userId">
          ${USERS.map((u) => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.name)}</option>`).join('')}
        </select>
        <button type="submit">Sign in</button>
      </form>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Example shop</title>
  </head>
  <body data-signed-in="${user ? 'true' : 'false'}">
    <main>
      <h1>Example shop</h1>
      <p>A stand-in website that verifies its signed-in customers to Hamnivo Chat.</p>
      ${account}
    </main>
    <script src="${escapeHtml(widgetOrigin)}/loader.js" data-widget-id="${escapeHtml(widgetId)}"
      data-api="${escapeHtml(api)}" async></script>
    <script type="module" src="/identity.js"></script>
  </body>
</html>
`;
}
