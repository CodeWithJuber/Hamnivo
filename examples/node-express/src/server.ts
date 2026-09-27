import { createIdentityAssertion } from '@hamnivo/server';
import { createApp } from './app.js';
import { type Config, readConfig } from './config.js';

let config: Config;
try {
  config = readConfig(process.env);
  // Sign one throwaway assertion, so a wrong widget ID or key fails now and not at the first customer.
  await createIdentityAssertion({
    widgetId: config.widgetId,
    key: config.key,
    customer: { id: 'startup-check' },
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

createApp(config).listen(config.port, () => {
  process.stdout.write(`Example shop on http://localhost:${config.port}\n`);
});
