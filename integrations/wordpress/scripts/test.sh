#!/usr/bin/env bash
# Tests the WordPress plugin.
#
#   integrations/wordpress/scripts/test.sh            # everything below
#   integrations/wordpress/scripts/test.sh --quick    # only 1 and 2: no network
#   HAMNIVO_PHP_VERSIONS=7.4,8.1,8.3,8.5 integrations/wordpress/scripts/test.sh   # more PHP versions
#
# 1. The plugin's files and browser scripts: headers, readme.txt, escaping and nonce rules, the
#    translation template, identity.js and admin.js in jsdom. Fast, no network.
# 2. The translation template is up to date (needs php).
# 3. The plugin inside WordPress, on PHP 8.3 and 7.4 (the tests in tests/php, 60 of them), in
#    WordPress Playground: WordPress and PHP in WebAssembly, run with `pnpm dlx` at a pinned
#    version. The first run downloads WordPress from wordpress.org.
# 4. The plugin through real HTTP: signing in, the REST nonce, saving the settings, AJAX.
#
# Needs pnpm install at the repository root, and node 22 or later.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../../.."

echo "== 1. The plugin's files and browser scripts"
pnpm --filter @hamnivo/example-wordpress test

if command -v php >/dev/null 2>&1; then
  echo "== 2. The translation template"
  php integrations/wordpress/tools/make-pot.php --check
else
  echo "== 2. Skipped: php is not installed, so the translation template was not checked."
fi

if [ "${1:-}" = "--quick" ]; then
  exit 0
fi

echo "== 3. The plugin in WordPress, on several PHP versions"
node --test integrations/wordpress/tests/plugin.test.mjs

echo "== 4. The plugin through HTTP"
node --test integrations/wordpress/tests/http.test.mjs
