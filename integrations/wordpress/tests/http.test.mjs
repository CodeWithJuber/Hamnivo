/**
 * The plugin through real HTTP: a WordPress that runs in Playground on a local port, with the
 * plugin from the built zip, and a browser-like client that keeps cookies. It checks what the PHP
 * suite cannot: signing in, the REST nonce, saving through the Settings API, and the AJAX call.
 *
 *   node --test integrations/wordpress/tests/http.test.mjs
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { blueprint, freePort, installBuiltPlugin, startSite } from './playground.mjs';

const SECRET = 'q3Zp0xv9L2m8Yk1T5bN7cR4dWf6HjA0sEuG-iO_hXzo';
const WIDGET = 'wid_01j9zk7w3xq8r4t2v6m5n1p0ce';
const PASSWORD = 'correct horse battery staple';

/** A client that keeps cookies, as a browser does. */
function client(base) {
  const jar = new Map();
  const remember = (response) => {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const at = pair.indexOf('=');
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(line)) jar.delete(name);
      else jar.set(name, value);
    }
  };
  const cookie = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  async function request(path, { method = 'GET', headers = {}, body, redirect = 'follow' } = {}) {
    const response = await fetch(new URL(path, base), {
      method,
      redirect,
      headers: { cookie: cookie(), ...headers },
      body,
    });
    remember(response);
    return response;
  }
  return {
    request,
    async signIn(login) {
      jar.set('wordpress_test_cookie', 'WP%20Cookie%20check');
      const response = await request('/wp-login.php', {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          log: login,
          pwd: PASSWORD,
          'wp-submit': 'Log In',
          testcookie: '1',
        }),
      });
      assert.equal(response.status, 302, `signing in as ${login} answered ${response.status}`);
      assert.ok(
        [...jar.keys()].some((name) => name.startsWith('wordpress_logged_in_')),
        'a sign-in cookie',
      );
    },
    async text(path, options) {
      const response = await request(path, options);
      return { status: response.status, text: await response.text(), headers: response.headers };
    },
  };
}

const decode = (text) => text.replace(/\\\//g, '/').replace(/\\u0026/g, '&');
const configOf = (html) =>
  JSON.parse(/window\.HamnivoChatIdentity = (\{.*?\});/.exec(html)?.[1] ?? 'null');

function verifyHs256(assertion) {
  const [header, payload, signature] = assertion.split('.');
  const expected = createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url');
  assert.equal(signature, expected, 'the HS256 signature');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString()),
    claims: JSON.parse(Buffer.from(payload, 'base64url').toString()),
  };
}

let site;
let plugin;

before(async () => {
  plugin = installBuiltPlugin();
  const port = await freePort();
  site = await startSite({
    plugin,
    port,
    blueprintText: blueprint({
      php: '8.3',
      options: {
        hamnivo_chat: {
          widget_id: WIDGET,
          chat_url: 'https://chat.example.com',
          api_url: 'https://api.example.com',
          identity: '1',
          identity_kid: 'shop-2026',
          identity_secret: SECRET,
          trust_emails: '0',
        },
      },
      users: [
        {
          login: 'ayesha',
          password: PASSWORD,
          email: 'ayesha@example.com',
          name: 'Ayesha Khan',
          role: 'subscriber',
        },
        {
          login: 'manager',
          password: PASSWORD,
          email: 'manager@example.com',
          name: 'Shop Manager',
          role: 'administrator',
        },
      ],
    }),
  });
});

after(() => {
  site?.stop();
});

describe('the public site', () => {
  it('has the loader and the identity script, for a visitor who is signed out', async () => {
    const page = await client(site.base).text('/');
    assert.equal(page.status, 200);
    assert.match(
      page.text,
      /<script async data-api="https:\/\/api\.example\.com" data-widget-id="wid_01j9zk7w3xq8r4t2v6m5n1p0ce" src="https:\/\/chat\.example\.com\/loader\.js"><\/script>/,
    );
    assert.match(page.text, /assets\/identity\.js\?ver=0\.2\.0/);
    const config = configOf(page.text);
    assert.equal(config.loggedIn, false);
    assert.equal(config.nonce, '');
  });

  it("serves the plugin's script", async () => {
    const script = await client(site.base).text(
      '/wp-content/plugins/hamnivo-chat/assets/identity.js?ver=0.2.0',
    );
    assert.equal(script.status, 200);
    assert.match(script.text, /Hamnivo\.identify|hamnivo\.identify/);
  });
});

describe('verified customers', () => {
  it('refuses a visitor who is signed out', async () => {
    const page = await client(site.base).text('/');
    const endpoint = decode(configOf(page.text).endpoint);
    const response = await client(site.base).text(endpoint, { method: 'POST' });
    assert.equal(response.status, 401);
    assert.doesNotMatch(response.text, /assertion/);
  });

  it('signs an assertion for the signed-in customer, and nothing else', async () => {
    const browser = client(site.base);
    await browser.signIn('ayesha');
    const page = await browser.text('/');
    const config = configOf(page.text);
    assert.equal(config.loggedIn, true);
    assert.match(config.nonce, /^[a-f0-9]{10}$/);

    const me = await browser.text(`/?rest_route=/wp/v2/users/me`, {
      headers: { 'x-wp-nonce': config.nonce },
    });
    const userId = String(JSON.parse(me.text).id);

    const response = await browser.text(decode(config.endpoint), {
      method: 'POST',
      headers: { 'x-wp-nonce': config.nonce },
    });
    assert.equal(response.status, 200, response.text);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    const { header, claims } = verifyHs256(JSON.parse(response.text).assertion);
    assert.deepEqual(header, { alg: 'HS256', kid: 'shop-2026', typ: 'JWT' });
    assert.equal(claims.sub, userId);
    assert.equal(claims.aud, WIDGET);
    assert.equal(claims.name, 'Ayesha Khan');
    assert.equal(
      claims.email,
      undefined,
      'the email is not shared unless the site confirms addresses',
    );
    assert.equal(claims.exp - claims.iat, 120);
    assert.ok(!response.text.includes(SECRET), 'the secret never leaves the server');
    assert.ok(!page.text.includes(SECRET), 'nor is it in the page');
  });

  it('gives a new assertion each time', async () => {
    const browser = client(site.base);
    await browser.signIn('ayesha');
    const config = configOf((await browser.text('/')).text);
    const ask = async () =>
      JSON.parse(
        (
          await browser.text(decode(config.endpoint), {
            method: 'POST',
            headers: { 'x-wp-nonce': config.nonce },
          })
        ).text,
      ).assertion;
    const [first, second] = [await ask(), await ask()];
    assert.notEqual(first, second);
    assert.notEqual(verifyHs256(first).claims.jti, verifyHs256(second).claims.jti);
  });

  it('treats a signed-in browser without the REST nonce as signed out, so another website cannot ask', async () => {
    const browser = client(site.base);
    await browser.signIn('ayesha');
    const endpoint = decode(configOf((await browser.text('/')).text).endpoint);
    const without = await browser.text(endpoint, { method: 'POST' });
    assert.equal(without.status, 401);
    assert.doesNotMatch(without.text, /assertion/);
    const wrong = await browser.text(endpoint, {
      method: 'POST',
      headers: { 'x-wp-nonce': 'abcdef1234' },
    });
    assert.equal(wrong.status, 403);
    assert.doesNotMatch(wrong.text, /assertion/);
  });

  it('does not answer GET', async () => {
    const browser = client(site.base);
    await browser.signIn('ayesha');
    const config = configOf((await browser.text('/')).text);
    const response = await browser.text(decode(config.endpoint), {
      headers: { 'x-wp-nonce': config.nonce },
    });
    assert.equal(response.status, 404);
  });
});

describe('the settings page', () => {
  async function settingsPage(browser) {
    const page = await browser.text('/wp-admin/options-general.php?page=hamnivo-chat');
    assert.equal(page.status, 200, page.text.slice(0, 300));
    return page;
  }
  const field = (html, name) =>
    new RegExp(`name=["']${name}["'] value=["']([^"']*)["']`).exec(html)?.[1];

  it('is closed to customers', async () => {
    const browser = client(site.base);
    await browser.signIn('ayesha');
    const page = await browser.text('/wp-admin/options-general.php?page=hamnivo-chat');
    assert.equal(page.status, 403);
  });

  it('shows an administrator the form, with what is saved, and never the key', async () => {
    const browser = client(site.base);
    await browser.signIn('manager');
    const page = await settingsPage(browser);
    assert.match(page.text, /<h1>Hamnivo Chat<\/h1>/);
    assert.match(page.text, /value="wid_01j9zk7w3xq8r4t2v6m5n1p0ce"/);
    assert.match(page.text, /value="https:\/\/chat\.example\.com"/);
    assert.match(page.text, /id="hamnivo-chat-test"/);
    assert.match(page.text, /How to find these/);
    assert.ok(!page.text.includes(SECRET), 'the key is not printed');
    assert.match(page.text, /A key is saved\. Leave this empty to keep it\./);
    assert.match(page.text, /assets\/admin\.js/);
  });

  it('saves through the Settings API with its nonce, cleans the values and keeps the key', async () => {
    const browser = client(site.base);
    await browser.signIn('manager');
    const page = await settingsPage(browser);
    const body = new URLSearchParams({
      option_page: field(page.text, 'option_page') ?? 'hamnivo_chat',
      action: 'update',
      _wpnonce:
        field(page.text, '_wpnonce') ??
        /name="_wpnonce" value="([^"]+)"/.exec(page.text)?.[1] ??
        '',
      _wp_http_referer: '/wp-admin/options-general.php?page=hamnivo-chat',
      'hamnivo_chat[install_code]':
        '<script src="https://chat2.example.com/loader.js" data-widget-id="wid_01j9zk7w3xq8r4t2v6m5n1p0cf" data-api="https://api2.example.com/" async></script>',
      'hamnivo_chat[widget_id]': '',
      'hamnivo_chat[chat_url]': '',
      'hamnivo_chat[api_url]': '',
      'hamnivo_chat[identity]': '1',
      'hamnivo_chat[identity_kid]': 'shop-2026',
      'hamnivo_chat[identity_secret]': '',
      'hamnivo_chat[trust_emails]': '1',
    });
    const saved = await browser.request('/wp-admin/options.php', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    assert.equal(saved.status, 302, await saved.text());
    assert.match(saved.headers.get('location') ?? '', /settings-updated=true/);

    const after = await settingsPage(browser);
    assert.match(
      after.text,
      /value="wid_01j9zk7w3xq8r4t2v6m5n1p0cf"/,
      'the widget ID came from the install code',
    );
    assert.match(after.text, /value="https:\/\/chat2\.example\.com"/);
    assert.match(after.text, /value="https:\/\/api2\.example\.com"/, 'without the trailing slash');
    assert.match(after.text, /A key is saved/, 'the empty key field kept the saved key');
    assert.match(after.text, /id="hamnivo_chat_trust_emails"[^>]*checked/);

    // The public page follows the saved settings, and signing now includes the confirmed email.
    const visitor = client(site.base);
    assert.match((await visitor.text('/')).text, /src="https:\/\/chat2\.example\.com\/loader\.js"/);
    await visitor.signIn('ayesha');
    const config = configOf((await visitor.text('/')).text);
    const answer = await visitor.text(decode(config.endpoint), {
      method: 'POST',
      headers: { 'x-wp-nonce': config.nonce },
    });
    const { claims } = verifyHs256(JSON.parse(answer.text).assertion);
    assert.equal(claims.aud, 'wid_01j9zk7w3xq8r4t2v6m5n1p0cf');
    assert.equal(claims.email, 'ayesha@example.com');
    assert.equal(claims.email_verified, true);
  });

  it('refuses a save without the nonce, and a bad widget ID with a message', async () => {
    const browser = client(site.base);
    await browser.signIn('manager');
    const page = await settingsPage(browser);
    const form = (extra) =>
      new URLSearchParams({
        option_page: 'hamnivo_chat',
        action: 'update',
        _wp_http_referer: '/wp-admin/options-general.php?page=hamnivo-chat',
        'hamnivo_chat[widget_id]': 'not-a-widget-id',
        ...extra,
      });
    const headers = { 'content-type': 'application/x-www-form-urlencoded' };

    const noNonce = await browser.text('/wp-admin/options.php', {
      method: 'POST',
      headers,
      body: form({}),
    });
    assert.equal(noNonce.status, 403);

    const nonce = /name="_wpnonce" value="([^"]+)"/.exec(page.text)?.[1] ?? '';
    const bad = await browser.request('/wp-admin/options.php', {
      method: 'POST',
      redirect: 'manual',
      headers,
      body: form({ _wpnonce: nonce }),
    });
    assert.equal(bad.status, 302);
    const shown = await browser.text(
      new URL(bad.headers.get('location') ?? '', site.base).pathname +
        new URL(bad.headers.get('location') ?? '', site.base).search,
    );
    assert.match(shown.text, /The widget ID is wid_ followed by 26 lowercase letters and digits/);
    assert.match(
      shown.text,
      /value="wid_01j9zk7w3xq8r4t2v6m5n1p0cf"/,
      'the saved widget ID was kept',
    );
  });

  it('runs Test connection through AJAX, with the nonce, for an administrator only', async () => {
    const browser = client(site.base);
    await browser.signIn('manager');
    const page = await settingsPage(browser);
    const admin = JSON.parse(
      /window\.hamnivoChatAdmin = (\{.*?\});/s.exec(page.text)?.[1] ?? 'null',
    );
    const nonce = admin?.nonce ?? '';
    assert.ok(nonce, 'the page carries a nonce for the test');
    assert.equal(admin.action, 'hamnivo_chat_test');
    const ask = (extra) =>
      browser.text('/wp-admin/admin-ajax.php', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          action: 'hamnivo_chat_test',
          widget_id: WIDGET,
          chat_url: 'https://chat.nowhere.invalid',
          api_url: '',
          ...extra,
        }),
      });

    const noNonce = await ask({});
    assert.equal(noNonce.status, 403);

    const answer = await ask({ nonce });
    assert.equal(answer.status, 200);
    const payload = JSON.parse(answer.text);
    assert.equal(payload.success, true);
    assert.equal(payload.data.ok, false);
    assert.equal(payload.data.checks[0].ok, true, 'the widget ID is fine');
    assert.equal(payload.data.checks[1].ok, false, 'the chat address cannot be reached');
    assert.match(payload.data.checks[1].detail, /could not/);

    const customer = client(site.base);
    await customer.signIn('ayesha');
    const refused = await customer.text('/wp-admin/admin-ajax.php', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ action: 'hamnivo_chat_test', nonce }),
    });
    assert.ok(
      refused.status === 403 || JSON.parse(refused.text || 'null')?.success === false,
      'a customer is refused',
    );
  });
});
