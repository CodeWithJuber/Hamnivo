# Hamnivo Chat for Shopify

The Shopify theme app extension lives in [`integrations/shopify`](../../integrations/shopify). It is
an app embed block: a store owner switches it on in the theme editor and types the widget ID and the
two addresses.

- **Put the chat on a store today, with no app:** paste the install code into the theme. The steps
  are in [`docs/guide/integrations/shopify.md`](../../docs/guide/integrations/shopify.md).
- **Publish the app embed:** [`integrations/shopify/README.md`](../../integrations/shopify/README.md).
  It needs the owner's Shopify Partner account.

## What this folder holds

The tests that run as part of the repository's checks, because this is a package of it:

```bash
pnpm --filter @hamnivo/example-shopify test
```

They run in a second, with no network and no Shopify account:

- the app embed block, rendered with LiquidJS for the values a merchant could type, and read by an
  HTML parser: the loader with the widget ID and the API address, only the origin of the chat
  address, trailing slashes, a port, spaces from a paste, an optional API address, every widget ID
  and address that must be refused, and values that try to close the attribute or add an element;
- that the block uses only the Liquid tags and filters that Shopify and LiquidJS both have, and does
  not depend on how an engine splits a string with a trailing slash;
- the schema of the block, the locale file with the theme editor's words, the folders the Shopify
  CLI reads, and the limits Shopify enforces when the app is deployed;
- that the app is extension-only: no access scopes, no client ID in git, no webhooks.
