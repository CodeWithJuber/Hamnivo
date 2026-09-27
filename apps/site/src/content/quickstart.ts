import { repoUrl } from '../lib/links';

/**
 * Commands for the four quick-start steps, taken from sections 1-4 of docs/self-hosting.md.
 * They are the same in every language; the step text lives in the dictionaries.
 */
export const quickstartCommands: readonly [string, string, string, string] = [
  ['docker --version', 'node --version', 'pnpm --version'].join('\n'),
  [`git clone ${repoUrl}.git`, 'cd Hamnivo', 'pnpm install'].join('\n'),
  'bash scripts/setup/env.sh',
  ['pnpm services:up', 'pnpm db:migrate', 'pnpm chatwoot:up', 'pnpm api'].join('\n'),
];
