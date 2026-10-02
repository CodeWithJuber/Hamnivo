import { readFile } from 'node:fs/promises';
import { closeDb, createDb, toPublicId } from '@hamnivo/db';
import { BillingOperationError, BillingOperations } from './billing/operations.js';
import { loadConfig } from './config.js';

/**
 * Platform billing from the command line (A16), for Hamnivo's operator:
 *
 *   billing plans
 *   billing plan:set <plan.json>
 *   billing plan:assign <tenant id or slug> <plan key>
 *   billing invoices:generate <YYYY-MM>
 *   billing invoice:issue <invoice id or number>
 *   billing invoice:paid <invoice id or number> [payment reference]
 *   billing invoice:failed <invoice id or number> <reason> [retry date]
 *   billing invoice:void <invoice id or number> <reason>
 *
 * Needs DATABASE_URL and DATABASE_PLATFORM_URL; HAMNIVO_OPERATOR names who runs it (audited).
 */

const usage = `usage: billing <plans | plan:set | plan:assign | invoices:generate | invoice:issue | invoice:paid | invoice:failed | invoice:void> …`;

const config = loadConfig();
if (!config.DATABASE_PLATFORM_URL) {
  console.error('DATABASE_PLATFORM_URL is not set.');
  process.exit(1);
}
const platform = createDb(config.DATABASE_PLATFORM_URL, { max: 1 });
const app = createDb(config.DATABASE_URL, { max: 1 });
const operations = new BillingOperations({
  platform,
  app,
  operator: process.env.HAMNIVO_OPERATOR?.trim() || 'operator',
  dueDays: config.BILLING_INVOICE_DUE_DAYS,
});

const print = (value: unknown) =>
  process.stdout.write(
    `${JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`,
  );

const invoiceLine = (row: { id: string; number: string; status: string; totalMinor: bigint }) => ({
  id: toPublicId('invoice', row.id),
  number: row.number,
  status: row.status,
  totalMinor: row.totalMinor,
});

const [command, ...args] = process.argv.slice(2);
try {
  switch (command) {
    case 'plans':
      print(await operations.plans());
      break;
    case 'plan:set': {
      if (!args[0]) throw new BillingOperationError('plan:set <plan.json>');
      print(await operations.setPlan(JSON.parse(await readFile(args[0], 'utf8'))));
      break;
    }
    case 'plan:assign': {
      if (!args[0] || !args[1]) throw new BillingOperationError('plan:assign <tenant> <plan>');
      print(await operations.assignPlan(args[0], args[1]));
      break;
    }
    case 'invoices:generate': {
      if (!args[0]) throw new BillingOperationError('invoices:generate <YYYY-MM>');
      print((await operations.generateInvoices(args[0])).map(invoiceLine));
      break;
    }
    case 'invoice:issue':
      if (!args[0]) throw new BillingOperationError('invoice:issue <invoice>');
      print(invoiceLine(await operations.issue(args[0])));
      break;
    case 'invoice:paid':
      if (!args[0]) throw new BillingOperationError('invoice:paid <invoice> [reference]');
      print(invoiceLine(await operations.markPaid(args[0], args[1] ?? null)));
      break;
    case 'invoice:failed': {
      if (!args[0] || !args[1]) {
        throw new BillingOperationError('invoice:failed <invoice> <reason> [retry date]');
      }
      const retryAt = args[2] ? new Date(args[2]) : null;
      if (retryAt && Number.isNaN(retryAt.getTime())) {
        throw new BillingOperationError(`Not a date: ${args[2]}`);
      }
      print(invoiceLine(await operations.recordPaymentFailure(args[0], args[1], retryAt)));
      break;
    }
    case 'invoice:void':
      if (!args[0] || !args[1]) throw new BillingOperationError('invoice:void <invoice> <reason>');
      print(invoiceLine(await operations.voidInvoice(args[0], args[1])));
      break;
    default:
      throw new BillingOperationError(usage);
  }
} catch (error) {
  process.exitCode = 1;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  await Promise.all([closeDb(platform), closeDb(app)]);
}
