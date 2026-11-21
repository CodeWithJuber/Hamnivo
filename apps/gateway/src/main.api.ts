import { createApiApp } from './app.js';
import { loadConfig } from './config.js';
import { startErrorReporting } from './observability/error-reporting.js';

const config = loadConfig();
startErrorReporting('api');
const app = await createApiApp(config);
app.enableShutdownHooks();
await app.listen({ host: config.HOST, port: config.PORT });
