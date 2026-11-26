# Hamnivo Chat for Google Tag Manager

A tag template for Google Tag Manager (GTM). A marketer adds the Hamnivo Chat tag, types the widget
ID and the chat address, picks the pages it runs on, and publishes. There is no code to paste.

The full guide for people who use GTM is in
[`docs/guide/integrations/gtm.md`](../../docs/guide/integrations/gtm.md). It also shows the other
way, a Custom HTML tag with the install code, which works with every version of Hamnivo.

## What is here

```
template.tpl     the template, in the file format GTM imports and the Community Template Gallery reads
metadata.yaml    what the Gallery needs besides the template (see "Submit it to the Gallery")
LICENSE          Apache 2.0, which the Gallery requires. The rest of this repository is AGPL-3.0-only,
                 with the exceptions listed in its NOTICE file.
```

## How it works

The tag loads `loader.js` from the chat address with GTM's `injectScript`, and the settings go in
the query of that address:

```
https://chat.example.com/loader.js?widgetId=wid_…&api=https%3A%2F%2Fapi.example.com
```

The install code of Hamnivo Studio sets the same two things as `data-widget-id` and `data-api` on its
script tag. A tag template cannot set attributes on a script, so the loader reads the same names from
its own address when an attribute is missing, and an attribute wins when both are there. That change
is in `packages/widget-loader/src/loader.ts`, and `examples/gtm` tests it on the built loader.

- The tag refuses a widget ID that is not `wid_` and 26 lower-case letters and digits, a chat address
  that is not `https://` with a host name (no login, no query), and an API address that is not an
  https address. It says which one in the GTM preview, and fails the tag.
- It keeps only the origin of the chat address and the path of the API address.
- It asks `queryPermission` before it loads anything.
- Its one permission to inject scripts is `https://*/loader.js*`: any https host, but only a file
  called `loader.js`. The host is a wildcard because every customer runs Hamnivo on their own
  address, which Google cannot know. A GTM administrator can narrow it to one host after importing
  the template, under Permissions, Injects scripts.
- It uses the address as the cache token, so a tag that fires on every page view of a single-page
  site loads the script once.

## Try it

In GTM, open Templates, then Tag Templates, then New, and from the three-dot menu choose Import.
Pick `template.tpl`. Open the Tests tab and click Run Tests: the ten scenarios in the file run in
GTM itself, which is the final check. Then create a tag from the template and use Preview.

Without GTM, `pnpm --filter @hamnivo/example-gtm test` runs the same scenarios in a small stand-in
for GTM's sandbox, and many more settings, good and bad. It also runs the built loader in a browser
simulation, given the address the template builds.

## Submit it to the Gallery

This needs the owner's Google account, and a GitHub repository of its own, because the Gallery reads
`template.tpl`, `metadata.yaml` and `LICENSE` from the root of a repository.

1. Create a public repository, for example `hamnivo-gtm-template`. Turn on its Issues.
2. Copy `template.tpl`, `metadata.yaml`, `LICENSE` and this README into its root, and commit.
3. Put that commit's SHA in `metadata.yaml`, under `versions`.
4. In the GTM template editor, open Info and accept the Gallery's terms. Then submit the repository's
   address at tagmanager.google.com/gallery.
5. Google reviews it. Expect to be asked to narrow permissions: `https://*/loader.js*` is as narrow
   as a self-hosted product can be, and the review is the place to explain that.

Nothing in this repository submits anything.
