/**
 * Sends one test error from the gateway to the error tracker, to check SENTRY_DSN end to end.
 * In production: `docker compose exec api node dist/main.error-test.js`.
 */
import { loadConfig } from './config.js';
import {
  flushErrorReports,
  reportError,
  startErrorReporting,
} from './observability/error-reporting.js';

loadConfig();
if (!startErrorReporting('api')) {
  console.error('SENTRY_DSN is not set, so there is nothing to test.');
  process.exit(1);
}
reportError(new Error('Hamnivo test error: the gateway reaches the error tracker'), {
  check: 'main.error-test',
});
await flushErrorReports(5000);
process.stdout.write('Sent. Look for "Hamnivo test error" in the error tracker.\n');
