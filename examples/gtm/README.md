# Hamnivo Chat for Google Tag Manager

The Google Tag Manager (GTM) template lives in [`integrations/gtm`](../../integrations/gtm). A
marketer imports it, types the widget ID and the chat address, and publishes.

- **Use it:** [`docs/guide/integrations/gtm.md`](../../docs/guide/integrations/gtm.md), which also has
  the Custom HTML way.
- **How it works and how to submit it to the Community Template Gallery:**
  [`integrations/gtm/README.md`](../../integrations/gtm/README.md).

## What this folder holds

The tests that run as part of the repository's checks, because this is a package of it:

```bash
pnpm --filter @hamnivo/example-gtm test
```

They run in a few seconds, with no network and no Google account:

- the template file: the sections GTM writes, in order, the JSON in them, the form and the regular
  expressions of its checks, the permissions (logging in debug mode, and `loader.js` over https),
  and that the code keeps to what the GTM sandbox runs;
- the template run in a small stand-in for GTM's sandbox: the ten scenarios written in the file, and
  many more settings, good and bad, with the address it loads, the cache token, the log it writes
  and that it fails the tag once and only once;
- the built loader in a browser simulation, given its settings in the address of its script, which is
  all that GTM's `injectScript` can pass: the widget ID, the API address, the other settings, an
  attribute winning over the address, and the old way with attributes alone;
- the two halves together: the address the template builds is the address the loader is given.

The stand-in is not GTM. After you change `template.tpl`, import it in GTM and run its tests there.
