import { startFakeChatwoot } from '../../src/fake/index.js';
import { authorityContract } from './suite.js';

authorityContract('fake Chatwoot', async () => {
  const fake = await startFakeChatwoot();
  return {
    baseUrl: fake.url,
    platformToken: fake.platformToken,
    receiverHost: '127.0.0.1',
    webhookBase: (port) => `http://127.0.0.1:${port}`,
    close: () => fake.close(),
    fake: true,
  };
});
