#!/usr/bin/env bash
# Builds the one-click installs into dist/integrations/.
#
#   scripts/build-integrations.sh [wordpress|whmcs|gtm|all]      (default: all; also: pnpm build:integrations)
#
#   hamnivo-chat-wordpress.zip   the WordPress plugin, with the PHP SDK bundled (no Composer for the user)
#   hamnivo-whmcs-addon.zip      the WHMCS addon, with the PHP SDK bundled; unzip it into the WHMCS folder
#   hamnivo-gtm-template.tpl     the Google Tag Manager template, ready to import
#
# The zips are reproducible: the same sources give the same bytes. It needs bash, zip and unzip.
# With php installed it also checks the syntax of every PHP file first.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
out=$root/dist/integrations
stage=$out/.stage
sdk=$root/integrations/php-sdk/src
target=${1:-all}

# One date for every file in every zip, so that a rebuild changes no byte. TZ=UTC because zip
# stores local time.
export TZ=UTC
epoch=${SOURCE_DATE_EPOCH:-$(git -C "$root" log -1 --format=%ct 2>/dev/null || echo 1767225600)}
stamp=$(date -u -d "@$epoch" +%Y%m%d%H%M.%S)

say() { printf '%s\n' "$*"; }
die() { printf 'build-integrations: %s\n' "$*" >&2; exit 1; }

command -v zip >/dev/null 2>&1 || die "zip is not installed."
command -v unzip >/dev/null 2>&1 || die "unzip is not installed."

lint_php() {
  if ! command -v php >/dev/null 2>&1; then
    say "  php is not installed, so the PHP syntax check is skipped."
    return
  fi
  local failed=0 file
  while IFS= read -r file; do
    if ! php -l "$file" >/dev/null 2>&1; then
      php -l "$file" >&2 || true
      failed=1
    fi
  done < <(find "$@" -name '*.php' -type f | LC_ALL=C sort)
  [ "$failed" = 0 ] || die "a PHP file has a syntax error."
}

# The SDK goes into the add-on's own folder, so that its users never run Composer.
bundle_sdk() {
  local into=$1
  mkdir -p "$into"
  cp -R "$sdk"/. "$into"/
  cp "$root/integrations/php-sdk/LICENSE" "$into/LICENSE"
  printf '%s\n' \
    'This is a copy of hamnivo/hamnivo-php (integrations/php-sdk in the Hamnivo repository),' \
    'put here by scripts/build-integrations.sh. Do not edit it: change the SDK and build again.' \
    > "$into/README.txt"
}

# Zips a staged folder with sorted names and one date, then lists what went in.
make_zip() {
  local from=$1 zip=$out/$2
  rm -f "$zip"
  find "$from" -exec touch -h -t "$stamp" {} +
  (cd "$from" && find . -type f -o -type l | sed 's|^\./||' | LC_ALL=C sort | zip -X -q "$zip" -@)
  say "  $(basename "$zip"): $(du -h "$zip" | cut -f1), sha256 $(sha256sum "$zip" | cut -c1-16)…, $(unzip -Z1 "$zip" | wc -l) files"
}

# A zip must hold these files, and none of the things that do not belong in a release. The listing
# is read into a variable first: grep -q stops early, and with pipefail a pipe from unzip would
# then fail by chance.
check_zip() {
  local zip=$out/$1 listing file
  shift
  listing=$(unzip -Z1 "$zip")
  for file in "$@"; do
    grep -qxF -- "$file" <<<"$listing" || die "$(basename "$zip") is missing $file"
  done
  if grep -qE '(^|/)(tests?|node_modules|\.(git|DS_Store|phpunit\.cache)|composer\.lock)(/|$)' <<<"$listing"; then
    die "$(basename "$zip") holds files that do not belong in a release."
  fi
}

version_of() { sed -n "s/^ \* Version: *//p" "$1" | head -n1; }

build_wordpress() {
  say "WordPress plugin"
  local src=$root/integrations/wordpress/hamnivo-chat dest=$stage/wordpress/hamnivo-chat
  [ -f "$src/hamnivo-chat.php" ] || die "the plugin is not at $src."

  local header constant readme
  header=$(version_of "$src/hamnivo-chat.php")
  constant=$(sed -n "s/^define( 'HAMNIVO_CHAT_VERSION', '\\(.*\\)' );/\\1/p" "$src/hamnivo-chat.php")
  readme=$(sed -n 's/^Stable tag: *//p' "$src/readme.txt")
  { [ -n "$header" ] && [ "$header" = "$constant" ] && [ "$header" = "$readme" ]; } \
    || die "the plugin version differs: header '$header', constant '$constant', readme.txt '$readme'."

  lint_php "$src" "$sdk"
  rm -rf "$stage/wordpress"
  mkdir -p "$dest"
  cp -R "$src"/. "$dest"/
  bundle_sdk "$dest/lib/hamnivo-php"
  make_zip "$stage/wordpress" hamnivo-chat-wordpress.zip
  check_zip hamnivo-chat-wordpress.zip \
    hamnivo-chat/hamnivo-chat.php hamnivo-chat/readme.txt hamnivo-chat/uninstall.php \
    hamnivo-chat/includes/class-settings.php hamnivo-chat/assets/identity.js \
    hamnivo-chat/languages/hamnivo-chat.pot hamnivo-chat/lib/hamnivo-php/autoload.php \
    hamnivo-chat/lib/hamnivo-php/Internal/IdentityAssertion.php
}

build_whmcs() {
  say "WHMCS addon"
  local src=$root/integrations/whmcs/modules/addons/hamnivo dest=$stage/whmcs/modules/addons/hamnivo
  [ -f "$src/hamnivo.php" ] || die "the addon is not at $src."
  lint_php "$src" "$sdk"
  rm -rf "$stage/whmcs"
  mkdir -p "$dest"
  cp -R "$src"/. "$dest"/
  rm -rf "$dest/tests"
  bundle_sdk "$dest/lib/hamnivo-php"
  make_zip "$stage/whmcs" hamnivo-whmcs-addon.zip
  check_zip hamnivo-whmcs-addon.zip \
    modules/addons/hamnivo/hamnivo.php modules/addons/hamnivo/hooks.php \
    modules/addons/hamnivo/README.md modules/addons/hamnivo/LICENSE \
    modules/addons/hamnivo/assets/identity.js modules/addons/hamnivo/lib/Settings.php \
    modules/addons/hamnivo/lib/hamnivo-php/autoload.php \
    modules/addons/hamnivo/lib/hamnivo-php/Internal/IdentityAssertion.php
}

build_gtm() {
  say "Google Tag Manager template"
  local src=$root/integrations/gtm/template.tpl
  [ -f "$src" ] || die "the template is not at $src."
  local name
  for name in TERMS_OF_SERVICE INFO TEMPLATE_PARAMETERS SANDBOXED_JS_FOR_WEB_TEMPLATE WEB_PERMISSIONS TESTS NOTES; do
    grep -qx "___${name}___" "$src" || die "the template has no ${name} section: GTM would not import it."
  done
  cp "$src" "$out/hamnivo-gtm-template.tpl"
  say "  hamnivo-gtm-template.tpl: $(du -h "$out/hamnivo-gtm-template.tpl" | cut -f1)"
}

mkdir -p "$out"
case "$target" in
  wordpress) build_wordpress ;;
  whmcs) build_whmcs ;;
  gtm) build_gtm ;;
  all)
    build_wordpress
    build_whmcs
    build_gtm
    ;;
  *) die "unknown target '$target'. Use wordpress, whmcs, gtm or all." ;;
esac
rm -rf "$stage"
say "Done: $out"
