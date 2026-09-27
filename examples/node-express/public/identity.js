// Tells Hamnivo Chat who is signed in to this website, and signs the chat out with the website.
// The loader script is async; it defines window.Hamnivo when it runs.

/** Resolves with window.Hamnivo once the loader has run, or undefined if it could not load. */
function loadedHamnivo() {
  if (window.Hamnivo) return Promise.resolve(window.Hamnivo);
  const loader = document.querySelector('script[data-widget-id]');
  if (!loader) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    loader.addEventListener('load', () => resolve(window.Hamnivo), { once: true });
    loader.addEventListener('error', () => resolve(undefined), { once: true });
  });
}

/** identify() and reset() wait for the chat frame. A chat that cannot load must not block us. */
function atMost(milliseconds, promise) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(resolve, milliseconds))]);
}

// On sign-out, end the chat's verified session first, so the next person here starts anonymous.
const signOut = document.getElementById('sign-out');
signOut?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const reset = window.Hamnivo?.reset().catch(() => {});
  await atMost(3000, reset);
  signOut.submit();
});

// When signed in, get a fresh assertion from this website's server and pass it to the chat.
async function identify() {
  const hamnivo = await loadedHamnivo();
  if (!hamnivo) return;
  const response = await fetch('/hamnivo/identity', { credentials: 'same-origin' });
  if (!response.ok) return;
  const { assertion } = await response.json();
  await hamnivo.identify(assertion);
}

if (document.body.dataset.signedIn === 'true') {
  identify().catch((error) => {
    console.warn('Hamnivo Chat could not verify the customer:', error);
  });
}
