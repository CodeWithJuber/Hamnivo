/**
 * Writes src/routeTree.gen.ts from the files in src/routes (settings in tsr.config.json).
 * The Vite plugin does the same during `dev` and `build`; this script lets `tsc --noEmit` run
 * first on a fresh checkout, where the generated file (git-ignored) does not exist yet.
 * Plain JavaScript, so it runs on every Node version the repository supports.
 */
import { fileURLToPath } from 'node:url';
import { Generator, getConfig } from '@tanstack/router-generator';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = getConfig({}, root);
await new Generator({ config, root }).run();
