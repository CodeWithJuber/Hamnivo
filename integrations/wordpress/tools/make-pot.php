<?php
/**
 * Makes languages/hamnivo-chat.pot, the template translators start from, out of the plugin's PHP.
 *
 *   php integrations/wordpress/tools/make-pot.php            # write the template
 *   php integrations/wordpress/tools/make-pot.php --check    # fail when it is out of date
 *
 * It also checks the rules that keep a plugin translation-ready. A translation call must use the
 * text domain "hamnivo-chat", and its text must be one plain string, never a variable or a joined
 * string, because translators cannot translate what is built at run time. It exits with 1 and says
 * what to fix when a call breaks a rule.
 */

declare(strict_types=1);

const DOMAIN = 'hamnivo-chat';

$plugin = dirname(__DIR__) . '/hamnivo-chat';
$target = $plugin . '/languages/hamnivo-chat.pot';
$check  = in_array('--check', $argv, true);

/** Function => positions (0-based) of text, plural text, context and domain among its arguments. */
const FUNCTIONS = [
    '__' => ['text' => 0, 'domain' => 1],
    '_e' => ['text' => 0, 'domain' => 1],
    'esc_html__' => ['text' => 0, 'domain' => 1],
    'esc_html_e' => ['text' => 0, 'domain' => 1],
    'esc_attr__' => ['text' => 0, 'domain' => 1],
    'esc_attr_e' => ['text' => 0, 'domain' => 1],
    '_x' => ['text' => 0, 'context' => 1, 'domain' => 2],
    'esc_html_x' => ['text' => 0, 'context' => 1, 'domain' => 2],
    'esc_attr_x' => ['text' => 0, 'context' => 1, 'domain' => 2],
    '_n' => ['text' => 0, 'plural' => 1, 'domain' => 3],
];

$files = [];
$iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($plugin, FilesystemIterator::SKIP_DOTS));
foreach ($iterator as $file) {
    $path = str_replace('\\', '/', $file->getPathname());
    if ($file->getExtension() === 'php' && !str_contains($path, '/lib/')) {
        $files[] = $path;
    }
}
sort($files);

$entries = [];
$problems = [];

foreach ($files as $path) {
    $relative = substr($path, strlen($plugin) + 1);
    $tokens = token_get_all((string) file_get_contents($path));
    $count = count($tokens);
    $comment = '';
    for ($i = 0; $i < $count; $i++) {
        $token = $tokens[$i];
        if (!is_array($token)) {
            continue;
        }
        if ($token[0] === T_COMMENT || $token[0] === T_DOC_COMMENT) {
            if (preg_match('/translators:\s*(.+?)\s*(?:\*\/)?$/s', $token[1], $found)) {
                $comment = trim(preg_replace('/\s*\n\s*\*?\s*/', ' ', $found[1]) ?? '');
            }
            continue;
        }
        if ($token[0] !== T_STRING || !isset(FUNCTIONS[$token[1]])) {
            continue;
        }
        $previous = previousSignificant($tokens, $i);
        if ($previous !== null && ($previous[0] === T_OBJECT_OPERATOR || $previous[0] === T_DOUBLE_COLON || $previous[0] === T_FUNCTION)) {
            continue;
        }
        $open = nextSignificant($tokens, $i);
        if ($open !== '(') {
            continue;
        }
        $arguments = arguments($tokens, $i + 1);
        $name = $token[1];
        $line = $token[2];
        $at = "{$relative}:{$line} {$name}()";
        $positions = FUNCTIONS[$name];

        $text = literal($arguments[$positions['text']] ?? []);
        if ($text === null) {
            $problems[] = "{$at}: the text must be one plain string, not a variable or a joined string.";
            continue;
        }
        $domain = literal($arguments[$positions['domain']] ?? []);
        if ($domain !== DOMAIN) {
            $problems[] = "{$at}: the text domain must be '" . DOMAIN . "'.";
        }
        $plural = isset($positions['plural']) ? literal($arguments[$positions['plural']] ?? []) : null;
        if (isset($positions['plural']) && $plural === null) {
            $problems[] = "{$at}: the plural text must be one plain string.";
            continue;
        }
        $context = isset($positions['context']) ? literal($arguments[$positions['context']] ?? []) : null;
        if (preg_match('/%[0-9$]*[sdfF]/', $text . ($plural ?? '')) === 1 && $comment === '') {
            $problems[] = "{$at}: a text with a placeholder needs a /* translators: … */ comment before it.";
        }

        $key = ($context ?? '') . "\x04" . $text;
        $entries[$key] ??= ['text' => $text, 'plural' => $plural, 'context' => $context, 'comments' => [], 'places' => []];
        if ($comment !== '' && !in_array($comment, $entries[$key]['comments'], true)) {
            $entries[$key]['comments'][] = $comment;
        }
        $entries[$key]['places'][] = "{$relative}:{$line}";
        $comment = '';
    }
}

// The header of the main file is translated too (WordPress reads Plugin Name and Description).
$header = (string) file_get_contents($plugin . '/hamnivo-chat.php');
foreach (['Plugin Name', 'Description'] as $field) {
    if (preg_match('/^ \* ' . preg_quote($field, '/') . ':\s*(.+)$/m', $header, $found) === 1) {
        $text = trim($found[1]);
        $context = "{$field} of the plugin";
        $entries[$context . "\x04" . $text] = ['text' => $text, 'plural' => null, 'context' => $context, 'comments' => [], 'places' => ['hamnivo-chat.php']];
    }
}

if ($problems !== []) {
    fwrite(STDERR, "Translation problems:\n- " . implode("\n- ", $problems) . "\n");
    exit(1);
}

$version = preg_match('/^ \* Version:\s*(\S+)/m', $header, $found) === 1 ? $found[1] : '0';
$lines = [
    '# Copyright (C) 2026 Juber Shaikh',
    '# This file is distributed under the MIT license.',
    'msgid ""',
    'msgstr ""',
    '"Project-Id-Version: Hamnivo Chat ' . $version . '\n"',
    '"Report-Msgid-Bugs-To: https://github.com/CodeWithJuber/Hamnivo/issues\n"',
    '"MIME-Version: 1.0\n"',
    '"Content-Type: text/plain; charset=UTF-8\n"',
    '"Content-Transfer-Encoding: 8bit\n"',
    '"Language-Team: LANGUAGE <LL@li.org>\n"',
    '"X-Generator: integrations/wordpress/tools/make-pot.php\n"',
    '"X-Domain: ' . DOMAIN . '\n"',
    '',
];
foreach ($entries as $entry) {
    foreach ($entry['comments'] as $comment) {
        $lines[] = '#. translators: ' . $comment;
    }
    foreach (array_unique($entry['places']) as $place) {
        $lines[] = '#: ' . $place;
    }
    if (preg_match('/%[0-9$]*[sdfF]/', $entry['text'] . ($entry['plural'] ?? '')) === 1) {
        $lines[] = '#, php-format';
    }
    if ($entry['context'] !== null) {
        $lines[] = 'msgctxt ' . quote($entry['context']);
    }
    $lines[] = 'msgid ' . quote($entry['text']);
    if ($entry['plural'] !== null) {
        $lines[] = 'msgid_plural ' . quote($entry['plural']);
        $lines[] = 'msgstr[0] ""';
        $lines[] = 'msgstr[1] ""';
    } else {
        $lines[] = 'msgstr ""';
    }
    $lines[] = '';
}
$pot = implode("\n", $lines);

if ($check) {
    if (!is_file($target) || file_get_contents($target) !== $pot) {
        fwrite(STDERR, "languages/hamnivo-chat.pot is out of date. Run: php integrations/wordpress/tools/make-pot.php\n");
        exit(1);
    }
    echo count($entries) . " strings, and languages/hamnivo-chat.pot is up to date.\n";
    exit(0);
}
file_put_contents($target, $pot);
echo 'Wrote ' . count($entries) . " strings to languages/hamnivo-chat.pot.\n";

/** The text of a PO string: quoted, with the characters PO escapes. */
function quote(string $text): string
{
    return '"' . strtr($text, ['\\' => '\\\\', '"' => '\\"', "\n" => '\\n', "\t" => '\\t']) . '"';
}

/** The next token that is not white space or a comment. */
function nextSignificant(array $tokens, int $from)
{
    for ($i = $from + 1, $n = count($tokens); $i < $n; $i++) {
        $token = $tokens[$i];
        if (is_array($token) && in_array($token[0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true)) {
            continue;
        }
        return is_array($token) ? $token[1] : $token;
    }
    return null;
}

/** The token before this one that is not white space or a comment, as [id, text, line] or a character. */
function previousSignificant(array $tokens, int $from)
{
    for ($i = $from - 1; $i >= 0; $i--) {
        $token = $tokens[$i];
        if (is_array($token) && in_array($token[0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true)) {
            continue;
        }
        return is_array($token) ? $token : [-1, $token, 0];
    }
    return null;
}

/**
 * The tokens of each argument of the call whose "(" is at $open, without the comments and white
 * space.
 *
 * @return list<list<array|string>>
 */
function arguments(array $tokens, int $open): array
{
    $depth = 0;
    $all = [];
    $current = [];
    for ($i = $open, $n = count($tokens); $i < $n; $i++) {
        $token = $tokens[$i];
        $char = is_array($token) ? null : $token;
        if ($char === '(' || $char === '[') {
            $depth++;
            if ($depth === 1) {
                continue;
            }
        } elseif ($char === ')' || $char === ']') {
            $depth--;
            if ($depth === 0) {
                $all[] = $current;
                return $all;
            }
        } elseif ($char === ',' && $depth === 1) {
            $all[] = $current;
            $current = [];
            continue;
        }
        if (is_array($token) && in_array($token[0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true)) {
            continue;
        }
        $current[] = $token;
    }
    return $all;
}

/** The value of an argument that is exactly one string literal; null for anything else. */
function literal(array $argument): ?string
{
    if (count($argument) !== 1 || !is_array($argument[0]) || $argument[0][0] !== T_CONSTANT_ENCAPSED_STRING) {
        return null;
    }
    $raw = $argument[0][1];
    $body = substr($raw, 1, -1);
    if ($raw[0] === "'") {
        return strtr($body, ['\\\\' => '\\', "\\'" => "'"]);
    }
    return preg_match('/[$]/', $body) === 1 ? null : stripcslashes($body);
}
