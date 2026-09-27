# Hamnivo Chat on a static page

The smallest way to add Hamnivo Chat to a website is one script tag. `index.html` has it, with
placeholders.

## Use it

1. In `index.html`, replace the three placeholders:
   - `https://chat.example.com`: where Hamnivo Chat and its `loader.js` are served;
   - `YOUR_WIDGET_ID`: the brand's widget ID (`wid_…`);
   - `https://api.example.com`: the Hamnivo API.
2. Serve the page from a web server. Opening the file directly (`file://`) does not work, because
   such a page has no origin. For example, run this in this folder:

   ```bash
   python3 -m http.server 8080
   ```

   Then open `http://localhost:8080`.
3. Make sure the page's origin is one of the brand's allowed websites (see below).
4. Click the chat button in the bottom corner.

The loader options and the JavaScript API (`Hamnivo.open()`, `Hamnivo.on(…)` and more) are in
[`packages/widget-loader/README.md`](../../packages/widget-loader/README.md).

## Allowed websites

- The chat opens only on the brand's allowed websites (`allowedOrigins`). Elsewhere, the API
  refuses the chat session with `ORIGIN_NOT_ALLOWED`, and the chat page refuses to be framed.
- An origin is the scheme, the host name and the port, with no path. For example
  `https://shop.example.com` or `http://localhost:8080`.
- Origins must match exactly:
  - `http://localhost:8080` and `http://127.0.0.1:8080` are different origins;
  - `https://example.com` and `https://www.example.com` are different origins too.
- You set the list when you create the brand (`allowedOrigins` in `POST /v1/admin/brands`). A
  brand can list up to 50 websites.
- A brand that lists no website works only on local pages (`localhost` and `127.0.0.1`). This is
  for development.

## Verified customers

A static page cannot vouch for a signed-in customer, because that needs a server-side secret. See
[`docs/guides/identity.md`](../../docs/guides/identity.md) and the Express example in
[`../node-express`](../node-express).
