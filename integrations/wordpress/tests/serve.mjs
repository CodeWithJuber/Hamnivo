/**
 * Try the plugin on your computer: a throwaway WordPress with the built plugin active, in your
 * browser. It is the same WordPress Playground the tests use. Nothing is installed, and everything
 * is gone when you press Ctrl+C.
 *
 *   node integrations/wordpress/tests/serve.mjs            # http://127.0.0.1:9400
 *   HAMNIVO_PORT=9500 node integrations/wordpress/tests/serve.mjs
 *
 * Sign in with the user admin and the password password.
 */
import { installBuiltPlugin, startSite } from './playground.mjs';

const port = Number(process.env.HAMNIVO_PORT ?? 9400);
const say = (line) => process.stdout.write(`${line}\n`);

say(
  'Building the plugin and starting WordPress. The first run downloads WordPress and takes a minute.',
);
const plugin = installBuiltPlugin();
const site = await startSite({
  plugin,
  port,
  blueprintText: JSON.stringify({
    landingPage: '/wp-admin/options-general.php?page=hamnivo-chat',
    preferredVersions: { php: process.env.HAMNIVO_PHP ?? '8.3', wp: 'latest' },
    steps: [{ step: 'activatePlugin', pluginPath: 'hamnivo-chat/hamnivo-chat.php' }],
  }),
});

say('');
say(
  `Hamnivo Chat is active. Open its settings: ${site.base}/wp-admin/options-general.php?page=hamnivo-chat`,
);
say('Sign in with the user "admin" and the password "password". Press Ctrl+C to stop.');

const stop = () => {
  site.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await new Promise(() => {});
