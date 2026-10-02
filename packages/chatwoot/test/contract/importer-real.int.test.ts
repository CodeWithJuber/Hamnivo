import { importerContract } from './importer.js';

const baseUrl = process.env.CHATWOOT_URL;
const platformToken = process.env.CHATWOOT_PLATFORM_TOKEN;

importerContract(
  'real Chatwoot v4.18.0-ce',
  async () => {
    const response = await fetch(`${baseUrl}/api`);
    const info = (await response.json()) as { version?: string };
    if (info.version !== '4.18.0')
      throw new Error(`Expected Chatwoot 4.18.0, found ${info.version}`);
    return { baseUrl: baseUrl as string, platformToken: platformToken as string };
  },
  Boolean(baseUrl && platformToken),
);
