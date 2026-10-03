/**
 * Tells Hamnivo Chat who is signed in to this site, and signs the chat out with the site.
 *
 * - Signed in: it asks this site's server for a fresh identity assertion and passes it to the chat
 *   with Hamnivo.identify(). The server signs it. Nothing the browser says about a customer counts.
 * - Signed out: if this browser was verified before, it calls Hamnivo.reset(), so the next person
 *   on a shared computer starts anonymous.
 * - A click on a log out link ends the chat session first, for up to three seconds.
 *
 * The loader script is async. window.Hamnivo exists once it has run, so this waits for it.
 */
(() => {
  const config = window.HamnivoChatIdentity;
  const FLAG = 'hamnivo-chat:verified';
  if (!config || !window.fetch || !window.Promise) {
    return;
  }

  const remember = (verified) => {
    try {
      if (verified) {
        window.localStorage.setItem(FLAG, '1');
      } else {
        window.localStorage.removeItem(FLAG);
      }
    } catch {
      // No storage, for example in a private window: the next page does the same work again.
    }
  };

  const wasVerified = () => {
    try {
      return window.localStorage.getItem(FLAG) === '1';
    } catch {
      return false;
    }
  };

  // Resolves with window.Hamnivo once the loader has run, or with nothing after ten seconds.
  const loaded = () =>
    new Promise((resolve) => {
      let tries = 0;
      const check = () => {
        if (window.Hamnivo) {
          resolve(window.Hamnivo);
        } else if (++tries > 100) {
          resolve();
        } else {
          window.setTimeout(check, 100);
        }
      };
      check();
    });

  // identify() and reset() wait for the chat frame. A chat that cannot load must not block us.
  const atMost = (milliseconds, promise) =>
    Promise.race([
      promise,
      new Promise((resolve) => {
        window.setTimeout(resolve, milliseconds);
      }),
    ]);

  const reset = (hamnivo) =>
    hamnivo
      .reset()
      .catch(() => {})
      .then(() => {
        remember(false);
      });

  const identify = (hamnivo) =>
    window
      .fetch(config.endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'X-WP-Nonce': config.nonce, Accept: 'application/json' },
      })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`The site answered ${response.status}`);
        }
        return response.json();
      })
      .then((body) => hamnivo.identify(body.assertion))
      .then(() => {
        remember(true);
      });

  const isLogOut = (href) => {
    let url;
    try {
      url = new URL(href, window.location.href);
    } catch {
      return false;
    }
    // WordPress: wp-login.php?action=logout. WooCommerce: ?customer-logout=true, or with pretty
    // permalinks, /my-account/customer-logout/.
    return (
      url.origin === window.location.origin &&
      (url.searchParams.get('action') === 'logout' ||
        url.searchParams.has('customer-logout') ||
        /\/customer-logout$/.test(url.pathname.replace(/\/+$/, '')))
    );
  };

  if (config.loggedIn) {
    loaded()
      .then((hamnivo) => (hamnivo ? identify(hamnivo) : undefined))
      .catch((error) => {
        window.console?.warn('Hamnivo Chat could not verify the customer:', error);
      });

    // A click on a log out link waits for the chat to sign out, then clicks the same link again.
    let again = false;
    document.addEventListener('click', (event) => {
      const link = event.target?.closest ? event.target.closest('a[href]') : null;
      const plain =
        event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
      if (again || !link || !plain || !window.Hamnivo || !isLogOut(link.href)) {
        return;
      }
      event.preventDefault();
      atMost(3000, reset(window.Hamnivo)).then(() => {
        again = true;
        link.click();
        again = false;
      });
    });
  } else if (wasVerified()) {
    loaded().then((hamnivo) => (hamnivo ? reset(hamnivo) : undefined));
  }
})();
