import { createApiApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await createApiApp(config);
app.enableShutdownHooks();
await app.listen({ host: config.HOST, port: config.PORT });
