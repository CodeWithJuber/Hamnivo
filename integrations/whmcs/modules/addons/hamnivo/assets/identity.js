/**
 * Tells Hamnivo Chat who is signed in to the WHMCS client area, and signs the chat out with WHMCS.
 *
 * - Signed in: it asks this WHMCS for a fresh identity assertion and passes it to the chat with
 *   Hamnivo.identify(). The server signs it. Nothing the browser says about a client counts. If
 *   the server also sends page context (product names, when the admin turned that on) and the
 *   chat can take it, it is passed on too.
 * - Signed out: if this browser was verified before, it calls Hamnivo.reset(), so the next person on
 *   a shared computer starts anonymous.
 * - A click on the log out link ends the chat session first, for up to three seconds.
 *
 * The loader script is async. window.Hamnivo exists once it has run, so this waits for it.
 */
(() => {
  const config = window.HamnivoWhmcs;
  const FLAG = 'hamnivo-whmcs:verified';
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
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        // A header only this page's own scripts can add. The server refuses a request without it.
        headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
      })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`WHMCS answered ${response.status}`);
        }
        return response.json();
      })
      .then((body) =>
        hamnivo.identify(body.assertion).then(() => {
          if (body.context && typeof hamnivo.setContext === 'function') {
            hamnivo.setContext(body.context);
          }
        }),
      )
      .then(() => {
        remember(true);
      });

  // The client area logs out at logout.php. Some themes and WHMCS versions use the route /logout,
  // as a path or as index.php?rp=/logout. Only this website's own links count.
  const isLogOut = (href) => {
    let url;
    try {
      url = new URL(href, window.location.href);
    } catch {
      return false;
    }
    return (
      url.origin === window.location.origin &&
      (/\/logout(\.php)?\/?$/.test(url.pathname) ||
        /\/logout\/?$/.test(url.searchParams.get('rp') ?? ''))
    );
  };

  if (config.loggedIn) {
    loaded()
      .then((hamnivo) => (hamnivo ? identify(hamnivo) : undefined))
      .catch((error) => {
        window.console?.warn('Hamnivo Chat could not verify the client:', error);
      });

    // A click on the log out link waits for the chat to sign out, then clicks the same link again.
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
