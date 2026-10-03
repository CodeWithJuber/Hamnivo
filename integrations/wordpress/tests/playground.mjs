/**
 * Helpers that run the plugin inside WordPress Playground (WordPress and PHP on WebAssembly, in
 * Node), so the tests need no database, no web server and no PHP of their own.
 *
 * Playground's CLI is GPL-2.0-or-later and large (all its PHP versions come to about 600 MB). So it
 * is not a dependency of this repository, which only takes MIT, Apache and BSD packages. It is run
 * with `pnpm dlx` at a pinned version, and cached by pnpm. Set HAMNIVO_WP_PLAYGROUND_CLI to the path of an
 * installed `wp-playground-cli` to use that instead. The first run needs the network: it downloads
 * WordPress from wordpress.org.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLAYGROUND_VERSION = '3.1.56';

const here = dirname(fileURLToPath(import.meta.url));
export const root = join(here, '..', '..', '..');
const zip = join(root, 'dist/integrations/hamnivo-chat-wordpress.zip');

/** Where the plugin is mounted inside WordPress, and the folders the tests read. */
const PLUGIN_MOUNT = '/wordpress/wp-content/plugins/hamnivo-chat';

/**
 * Builds the plugin zip and unpacks it into a temporary folder, so the tests run on exactly what
 * a site owner installs, with the bundled SDK, and not on the source folder.
 */
export function installBuiltPlugin() {
  execFileSync('bash', [join(root, 'scripts/build-integrations.sh'), 'wordpress'], {
    cwd: root,
    stdio: 'pipe',
  });
  const folder = mkdtempSync(join(tmpdir(), 'hamnivo-wp-'));
  execFileSync('unzip', ['-q', zip, '-d', folder]);
  return join(folder, 'hamnivo-chat');
}

function command() {
  return process.env.HAMNIVO_WP_PLAYGROUND_CLI
    ? [process.env.HAMNIVO_WP_PLAYGROUND_CLI]
    : ['pnpm', 'dlx', `@wp-playground/cli@${PLAYGROUND_VERSION}`];
}

/**
 * A Blueprint that activates the plugin and sets site options, as JSON text. It names the PHP and
 * WordPress versions itself: a Blueprint without them runs the newest PHP, whatever --php says.
 */
export function blueprint({ php, wp = 'latest', options = {}, users = [] } = {}) {
  const steps = [{ step: 'activatePlugin', pluginPath: 'hamnivo-chat/hamnivo-chat.php' }];
  if (Object.keys(options).length > 0) steps.push({ step: 'setSiteOptions', options });
  for (const user of users) {
    steps.push({
      step: 'runPHP',
      code: `<?php require '/wordpress/wp-load.php'; if ( ! username_exists( '${user.login}' ) ) { wp_insert_user( [ 'user_login' => '${user.login}', 'user_pass' => '${user.password}', 'user_email' => '${user.email}', 'display_name' => '${user.name}', 'role' => '${user.role}' ] ); }`,
    });
  }
  return JSON.stringify({ preferredVersions: { php, wp }, steps });
}

function mounts(plugin) {
  return [
    `--mount=${plugin}:${PLUGIN_MOUNT}`,
    `--mount=${here}:/tests`,
    `--mount=${join(root, 'integrations/php-sdk/tests/fixtures')}:/fixtures`,
  ];
}

function blueprintFile(text) {
  const folder = mkdtempSync(join(tmpdir(), 'hamnivo-blueprint-'));
  const file = join(folder, 'blueprint.json');
  writeFileSync(file, text);
  return file;
}

/**
 * Runs a PHP script inside a new WordPress that has the plugin active. Resolves with the exit
 * status and what the script printed.
 */
export function runPhp({ plugin, php, script, wp = 'latest', timeoutMs = 600_000 }) {
  const [program, ...before] = command();
  const result = spawnSync(
    program,
    [
      ...before,
      'php',
      `--php=${php}`,
      `--wp=${wp}`,
      `--blueprint=${blueprintFile(blueprint({ php, wp }))}`,
      ...mounts(plugin),
      '--',
      `/tests/${script}`,
    ],
    { cwd: root, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
  );
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Starts a WordPress with the plugin on a free port and resolves with its address and a function
 * that stops it. Used for tests through real HTTP, with cookies and nonces.
 */
export async function startSite({
  plugin,
  php = '8.3',
  wp = 'latest',
  port,
  blueprintText,
  timeoutMs = 240_000,
}) {
  const [program, ...before] = command();
  const child = spawn(
    program,
    [
      ...before,
      'server',
      `--php=${php}`,
      `--wp=${wp}`,
      `--port=${port}`,
      `--blueprint=${blueprintFile(blueprintText)}`,
      ...mounts(plugin),
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  let log = '';
  child.stdout.on('data', (chunk) => {
    log += chunk;
  });
  child.stderr.on('data', (chunk) => {
    log += chunk;
  });
  const stop = () => {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  };
  const base = `http://127.0.0.1:${port}`;
  const started = Date.now();
  // The server answers (with a 502, then a page) before the Blueprint has run, so the signal that
  // the site is ready is the line the CLI prints when it is.
  while (!/Ready! WordPress is running/.test(log)) {
    if (child.exitCode !== null) throw new Error(`Playground stopped before it was ready:\n${log}`);
    if (Date.now() - started > timeoutMs) {
      stop();
      throw new Error(`Playground was not ready within ${timeoutMs / 1000} seconds:\n${log}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  // The first request to a new site is answered with a redirect, whatever it is, so make it now.
  await fetch(`${base}/`, { redirect: 'follow' }).then((response) => response.text());
  return { base, stop, log: () => log };
}

/** A port nothing is listening on. */
export async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
