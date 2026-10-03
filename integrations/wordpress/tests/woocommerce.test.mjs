/**
 * The plugin next to the real WooCommerce, installed from wordpress.org into the Playground site.
 * It is slow (WooCommerce is about 30 MB and sets itself up), so it is not part of the default run:
 *
 *   HAMNIVO_WOOCOMMERCE=1 node --test integrations/wordpress/tests/woocommerce.test.mjs
 *
 * It checks that a WooCommerce customer is verified with the name the shop knows, and that the
 * My account page, with its log out link, works with the plugin's script.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { freePort, installBuiltPlugin, startSite } from './playground.mjs';

const SECRET = 'q3Zp0xv9L2m8Yk1T5bN7cR4dWf6HjA0sEuG-iO_hXzo';
const WIDGET = 'wid_01j9zk7w3xq8r4t2v6m5n1p0ce';
const PASSWORD = 'correct horse battery staple';
const enabled = process.env.HAMNIVO_WOOCOMMERCE === '1';

const settings = {
  widget_id: WIDGET,
  chat_url: 'https://chat.example.com',
  api_url: 'https://api.example.com',
  identity: '1',
  identity_kid: 'shop-2026',
  identity_secret: SECRET,
  trust_emails: '1',
};

const code = `<?php
require '/wordpress/wp-load.php';
update_option( 'hamnivo_chat', json_decode( '${JSON.stringify(settings)}', true ) );
if ( ! username_exists( 'aisha' ) ) {
  $id = wc_create_new_customer( 'aisha@example.com', 'aisha', '${PASSWORD}' );
  if ( is_wp_error( $id ) ) { throw new Exception( $id->get_error_message() ); }
  update_user_meta( $id, 'billing_first_name', 'Aisha' );
  update_user_meta( $id, 'billing_last_name', 'Siddiqui' );
  wp_update_user( [ 'ID' => $id, 'display_name' => 'aisha' ] );
}
`;

const blueprintText = JSON.stringify({
  preferredVersions: { php: '8.3', wp: 'latest' },
  steps: [
    { step: 'activatePlugin', pluginPath: 'hamnivo-chat/hamnivo-chat.php' },
    {
      step: 'installPlugin',
      pluginData: { resource: 'wordpress.org/plugins', slug: 'woocommerce' },
      options: { activate: true },
    },
    { step: 'runPHP', code },
  ],
});

let site;

describe('the plugin with WooCommerce', {
  skip: !enabled && 'set HAMNIVO_WOOCOMMERCE=1 to run this slow test',
}, () => {
  before(async () => {
    site = await startSite({
      plugin: installBuiltPlugin(),
      port: await freePort(),
      blueprintText,
      timeoutMs: 600_000,
    });
  });
  after(() => site?.stop());

  async function signIn() {
    const jar = new Map();
    const remember = (response) => {
      for (const line of response.headers.getSetCookie()) {
        const [pair] = line.split(';');
        const at = pair.indexOf('=');
        jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
      }
    };
    const cookie = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    jar.set('wordpress_test_cookie', 'WP%20Cookie%20check');
    const login = await fetch(`${site.base}/wp-login.php`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookie() },
      body: new URLSearchParams({
        log: 'aisha',
        pwd: PASSWORD,
        'wp-submit': 'Log In',
        testcookie: '1',
      }),
    });
    remember(login);
    assert.equal(login.status, 302);
    return async (path, options = {}) => {
      const response = await fetch(new URL(path, site.base), {
        redirect: 'follow',
        ...options,
        headers: { cookie: cookie(), ...options.headers },
      });
      return { status: response.status, text: await response.text(), headers: response.headers };
    };
  }

  it('verifies a WooCommerce customer with the name the shop knows', async () => {
    const get = await signIn();
    const page = await get('/');
    const config = JSON.parse(
      /window\.HamnivoChatIdentity = (\{.*?\});/.exec(page.text)?.[1] ?? 'null',
    );
    assert.equal(config.loggedIn, true);
    const endpoint = config.endpoint.replace(/\\\//g, '/');
    const answer = await get(endpoint, { method: 'POST', headers: { 'x-wp-nonce': config.nonce } });
    assert.equal(answer.status, 200, answer.text);
    const [header, payload, signature] = JSON.parse(answer.text).assertion.split('.');
    assert.equal(
      signature,
      createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url'),
    );
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    assert.equal(claims.name, 'Aisha Siddiqui', 'the billing name, not the login');
    assert.equal(claims.email, 'aisha@example.com');
    assert.equal(claims.email_verified, true);
    assert.equal(claims.aud, WIDGET);
  });

  it('has the loader and the identity script on the My account page, next to the log out link', async () => {
    const get = await signIn();
    const page = await get('/?pagename=my-account');
    const account =
      page.status === 200 && page.text.includes('customer-logout')
        ? page
        : await get('/my-account/');
    assert.equal(account.status, 200);
    assert.match(account.text, /href="[^"]*customer-logout[^"]*"/, "WooCommerce's log out link");
    assert.match(account.text, /src="https:\/\/chat\.example\.com\/loader\.js"/);
    assert.match(account.text, /assets\/identity\.js\?ver=0\.2\.0/);
  });
});
