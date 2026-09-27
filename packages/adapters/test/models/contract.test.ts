import { describeProviderContract } from './contract.js';
import { interceptProviders } from './harness.js';
import { KITS } from './kits.js';

const http = interceptProviders();

for (const kit of KITS) describeProviderContract(kit, http);
