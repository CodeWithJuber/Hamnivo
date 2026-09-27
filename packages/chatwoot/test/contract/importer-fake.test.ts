import { startFakeChatwoot } from '../../src/fake/index.js';
import { importerContract } from './importer.js';

importerContract('fake Chatwoot', async () => {
  const fake = await startFakeChatwoot();
  return {
    baseUrl: fake.url,
    platformToken: fake.platformToken,
    fake: {
      outboundFor: (accountId) => fake.outbound.filter((o) => o.accountId === accountId).length,
      addIntegrationHook: (accountId, appId, inboxId) =>
        fake.addIntegrationHook(accountId, appId, inboxId),
    },
    close: () => fake.close(),
  };
});
