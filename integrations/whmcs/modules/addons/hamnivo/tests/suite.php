<?php
/**
 * The Hamnivo Chat addon for WHMCS, tested without WHMCS. WHMCS is a commercial product that cannot
 * be installed here, so the suite stands in for the few things the addon takes from it (add_hook,
 * generate_token, the database store, the session) and checks everything the addon does with them.
 *
 *   php integrations/whmcs/modules/addons/hamnivo/tests/suite.php
 *
 * It runs on any PHP from 7.4. Before 8.1 it checks that the chat works and that clients stay
 * anonymous. tests/playground.test.mjs runs it on several PHP versions.
 */

require __DIR__ . '/harness.php';

$addon = defined('HAMNIVO_ADDON_DIR') ? HAMNIVO_ADDON_DIR : dirname(__DIR__);
const WIDGET = 'wid_01j9zk7w3xq8r4t2v6m5n1p0ce';
const SECRET = 'q3Zp0xv9L2m8Yk1T5bN7cR4dWf6HjA0sEuG-iO_hXzo';

// ---------------------------------------------------------------- what WHMCS gives the addon

define('WHMCS', true);
$GLOBALS['whmcs_hooks'] = [];

function add_hook($name, $priority, $function)
{
    $GLOBALS['whmcs_hooks'][$name][] = ['priority' => $priority, 'function' => $function];
}

function generate_token($format)
{
    return '<input type="hidden" name="token" value="test-token-' . $format . '" />';
}

// The SDK is bundled in the built zip. In the repository it is next to the addon, so load it from there.
$bundled = $addon . '/lib/hamnivo-php/autoload.php';
if (PHP_VERSION_ID >= 80100 && !is_readable($bundled)) {
    foreach ([defined('HAMNIVO_SDK_AUTOLOAD') ? HAMNIVO_SDK_AUTOLOAD : '', dirname($addon, 4) . '/php-sdk/src/autoload.php'] as $candidate) {
        if ($candidate !== '' && is_readable($candidate)) {
            require_once $candidate;
            break;
        }
    }
}
$php81 = PHP_VERSION_ID >= 80100;

require $addon . '/lib/bootstrap.php';

use Hamnivo\Whmcs\Admin;
use Hamnivo\Whmcs\ConnectionTest;
use Hamnivo\Whmcs\CurrentClient;
use Hamnivo\Whmcs\Endpoint;
use Hamnivo\Whmcs\Identity;
use Hamnivo\Whmcs\Output;
use Hamnivo\Whmcs\Services;
use Hamnivo\Whmcs\Settings;
use Hamnivo\Whmcs\Store;

/** A store in memory, with the data the addon reads. */
class ArrayStore implements Store
{
    /** @var array<string,string> */
    public $settings = [];
    /** @var string */
    public $systemUrl = 'https://billing.example.com/';
    /** @var array<int,array<string,mixed>> */
    public $clients = [];
    /** @var array<int,list<string>> */
    public $products = [];

    public function settings(): array
    {
        return $this->settings;
    }

    public function systemUrl(): string
    {
        return $this->systemUrl;
    }

    public function client(int $id): ?array
    {
        return $this->clients[$id] ?? null;
    }

    public function activeProductNames(int $clientId, int $limit): array
    {
        return array_slice($this->products[$clientId] ?? [], 0, $limit);
    }
}

function ready(array $more = []): array
{
    return array_merge([
        'widget_id' => WIDGET,
        'chat_url' => 'https://chat.example.com',
        'api_url' => 'https://api.example.com',
        'identity_enabled' => 'on',
        'identity_kid' => 'shop-2026',
        'identity_secret' => SECRET,
    ], $more);
}

function store(array $settings = [], array $products = []): ArrayStore
{
    $store = new ArrayStore();
    $store->settings = $settings;
    $store->clients = [
        42 => ['id' => 42, 'firstname' => 'Ayesha', 'lastname' => 'Khan', 'companyname' => 'Khan Traders', 'email' => 'ayesha@example.com', 'status' => 'Active'],
        43 => ['id' => 43, 'firstname' => '', 'lastname' => '', 'companyname' => 'Only A Company', 'email' => 'company@example.com', 'status' => 'Active'],
        44 => ['id' => 44, 'firstname' => 'Closed', 'lastname' => 'Client', 'companyname' => '', 'email' => 'closed@example.com', 'status' => 'Closed'],
    ];
    $store->products = [42 => $products];

    return $store;
}

const XHR = ['x-requested-with' => 'XMLHttpRequest'];

// ---------------------------------------------------------------- settings

test('reads the widget ID and the addresses, and keeps each address to what the loader needs', function () {
    $s = new Settings([
        'widget_id' => ' ' . WIDGET . ' ',
        'chat_url' => 'https://Chat.Example.com:8443/loader.js?x=1#top',
        'api_url' => 'https://example.com/hamnivo/api/',
    ]);
    same(WIDGET, $s->widgetId());
    same('https://chat.example.com:8443', $s->chatUrl(), 'the origin only');
    same('https://example.com/hamnivo/api', $s->apiUrl(), 'the path, without a trailing slash');
    same(true, $s->isConfigured());
    same([], $s->problems());
});

test('reads an address without a scheme as https, and one with a port', function () {
    same('https://chat.example.com', (new Settings(['chat_url' => 'chat.example.com']))->chatUrl());
    same('https://localhost:4000', (new Settings(['chat_url' => 'localhost:4000']))->chatUrl());
    same('http://localhost:4000', (new Settings(['chat_url' => 'http://localhost:4000']))->chatUrl());
    same('https://[::1]:8443', (new Settings(['chat_url' => 'https://[::1]:8443']))->chatUrl());
});

test('treats a widget ID or an address that does not fit as empty, and says what to fix', function () {
    $s = new Settings([
        'widget_id' => 'brd_01j9zk7w3xq8r4t2v6m5n1p0ce',
        'chat_url' => 'javascript:alert(1)',
        'api_url' => 'ftp://api.example.com',
        'identity_kid' => 'a key with spaces',
    ]);
    same('', $s->widgetId());
    same('', $s->chatUrl());
    same('', $s->apiUrl());
    same(false, $s->isConfigured());
    same(4, count($s->problems()));
    foreach (['not a url', 'https://', 'https://bad host/', 'mailto:a@example.com', 'data:text/html,x', '//example.com', 'https://exa mple.com'] as $bad) {
        same('', (new Settings(['chat_url' => $bad]))->chatUrl(), $bad);
    }
});

test('reads yes and no the way WHMCS keeps them', function () {
    $s = new Settings(['identity_enabled' => 'on', 'trust_emails' => '', 'share_products' => 'off']);
    same(true, $s->identityWanted());
    same(false, $s->trustEmails());
    same(false, $s->shareProducts(), '"off" is not on');
    same(true, (new Settings(['share_products' => 'on']))->shareProducts());
});

test('ignores settings it does not know and settings that are not text', function () {
    $s = new Settings(['widget_id' => ['x'], 'unknown' => 'x', 'chat_url' => new stdClass()]);
    same('', $s->widgetId());
    same('', $s->chatUrl());
});

test('loads the saved settings from the store', function () {
    $s = Settings::load(store(ready()));
    same(WIDGET, $s->widgetId());
    same('shop-2026', $s->keyId());
    same(SECRET, $s->secret());
    same(true, $s->hasSecret());
});

// ---------------------------------------------------------------- the head of the client area

test('adds nothing to the head until the widget ID and the chat address are set', function () {
    same('', Output::head(new Settings([]), 'https://billing.example.com/', null));
    same('', Output::head(new Settings(['widget_id' => WIDGET]), 'https://billing.example.com/', null));
    same('', Output::head(new Settings(['chat_url' => 'https://chat.example.com']), 'https://billing.example.com/', null));
});

test('adds the loader, escaped, with the widget ID and the API address', function () {
    $html = Output::head(new Settings(ready(['identity_enabled' => ''])), 'https://billing.example.com/', null);
    same('<script async src="https://chat.example.com/loader.js" data-widget-id="' . WIDGET . '" data-api="https://api.example.com"></script>' . "\n", $html);
    lacks('data-api', Output::head(new Settings(ready(['api_url' => '', 'identity_enabled' => ''])), 'https://billing.example.com/', null));
});

test('cannot be made to break out of its tags by what is saved', function () {
    $s = new Settings(ready([
        'widget_id' => WIDGET,
        'chat_url' => 'https://chat.example.com/"><script>alert(1)</script>',
        'api_url' => 'https://api.example.com/"><img src=x onerror=alert(2)>',
    ]));
    $html = Output::head($s, 'https://billing.example.com/"></script><script>alert(3)</script>', 7);
    lacks('<script>alert', $html);
    lacks('<img src=x', $html);
    lacks('onerror="alert', $html);
});

test('adds the identity script when verified clients are on and this PHP can sign', function () use ($php81) {
    $html = Output::head(new Settings(ready()), 'https://billing.example.com/', 42);
    if (!$php81) {
        lacks('HamnivoWhmcs', $html);
        lacks('identity.js', $html);

        return;
    }
    contains('window.HamnivoWhmcs = {"loggedIn":true,"endpoint":"https://billing.example.com/index.php?m=hamnivo&a=identity"};', str_replace(chr(92) . 'u0026', '&', $html));
    contains('<script src="https://billing.example.com/modules/addons/hamnivo/assets/identity.js?v=' . Output::VERSION . '" defer></script>', $html);
    contains('"loggedIn":false', Output::head(new Settings(ready()), 'https://billing.example.com/', null), 'signed out');
});

test('keeps the loader but not the identity script when verified clients are off or half set up', function () {
    foreach ([['identity_enabled' => ''], ['identity_kid' => ''], ['identity_secret' => '']] as $change) {
        $html = Output::head(new Settings(ready($change)), 'https://billing.example.com/', 42);
        contains('loader.js', $html);
        lacks('identity.js', $html);
    }
    lacks('identity.js', Output::head(new Settings(ready()), '', 42), 'without a WHMCS address');
});

// ---------------------------------------------------------------- the hook

test('registers one ClientAreaHeadOutput hook, which gives the head HTML', function () use ($addon) {
    Services::useStore(store(ready(['identity_enabled' => ''])));
    require $addon . '/hooks.php';
    $hooks = $GLOBALS['whmcs_hooks']['ClientAreaHeadOutput'] ?? [];
    same(1, count($hooks));
    $html = $hooks[0]['function'](['systemurl' => 'https://billing.example.com/']);
    contains('src="https://chat.example.com/loader.js"', $html);
    contains('data-widget-id="' . WIDGET . '"', $html);
});

test('falls back to the WHMCS address in the store when the hook gets none', function () use ($php81) {
    Services::useStore(store(ready()));
    $hook = $GLOBALS['whmcs_hooks']['ClientAreaHeadOutput'][0]['function'];
    $html = $hook([]);
    if ($php81) {
        contains('billing.example.com/modules/addons/hamnivo/assets/identity.js', $html);
    }
    contains('loader.js', $html);
});

test('never breaks the client area: a failing store gives an empty head', function () {
    $broken = new class extends ArrayStore {
        public function settings(): array
        {
            throw new RuntimeException('the database is down');
        }
    };
    Services::useStore($broken);
    $hook = $GLOBALS['whmcs_hooks']['ClientAreaHeadOutput'][0]['function'];
    same('', $hook(['systemurl' => 'https://billing.example.com/']));
    Services::useStore(null);
});

// ---------------------------------------------------------------- who is signed in

test('knows the client from the session, and nobody when signed out', function () {
    same(null, CurrentClient::id([]));
    same(42, CurrentClient::id(['uid' => '42']));
    same(null, CurrentClient::id(['uid' => '0']));
    same(null, CurrentClient::id(['uid' => 'abc']));
});

test('does not verify a staff member who is looking at the client area as the client', function () {
    same(null, CurrentClient::id(['uid' => 42, 'adminid' => 1]));
});

test('asks WHMCS 8 who the client is when it can, and takes no more than that', function () {
    require __DIR__ . '/whmcs-stubs.php';
    \WHMCS\Authentication\CurrentUser::$client = (object) ['id' => '77'];
    same(77, CurrentClient::id(['uid' => 42]), 'the client the user chose, not the old session value');
    \WHMCS\Authentication\CurrentUser::$client = null;
    same(null, CurrentClient::id(['uid' => 42]), 'a signed-in user who has chosen no client');
    \WHMCS\Authentication\CurrentUser::$client = (object) ['id' => 77];
    same(null, CurrentClient::id(['adminid' => 3]), 'staff acting as a client');
    \WHMCS\Authentication\CurrentUser::$client = null;
});

// ---------------------------------------------------------------- the customer

test('builds the customer from the client record: id, name, and no email unless WHMCS confirms emails', function () {
    $client = store()->client(42);
    same(['id' => '42', 'name' => 'Ayesha Khan'], Identity::customerFor($client, new Settings([])));
    same(['id' => '42', 'name' => 'Ayesha Khan', 'email' => 'ayesha@example.com', 'emailVerified' => true], Identity::customerFor($client, new Settings(['trust_emails' => 'on'])));
});

test('names a client with no name by the company, and cuts a long name at 120 UTF-16 units', function () {
    same('Only A Company', Identity::customerFor(store()->client(43), new Settings([]))['name']);
    $client = ['id' => 5, 'firstname' => str_repeat('🙂', 100), 'lastname' => '', 'companyname' => '', 'email' => ''];
    $name = Identity::customerFor($client, new Settings([]))['name'];
    same(60, preg_match_all('/./u', $name));
    $client = ['id' => 6, 'firstname' => '', 'lastname' => '', 'companyname' => '', 'email' => ''];
    same(['id' => '6'], Identity::customerFor($client, new Settings([])));
});

test('shortens text without splitting a character, and cleans bad UTF-8', function () {
    same('abc', Identity::shorten('abcdef', 3));
    same('🙂🙂', Identity::shorten('🙂🙂🙂', 4));
    same('é', Identity::shorten('é', 1));
    same(1, preg_match('//u', Identity::shorten("bad \xC3\x28 text", 20)));
});

// ---------------------------------------------------------------- signing

test('knows whether this PHP can sign identities', function () use ($php81) {
    same($php81, Identity::sdkAvailable());
    if ($php81) {
        same(null, Identity::unavailableReason());
        same(true, Identity::isReady(new Settings(ready())));
    } else {
        contains('PHP 8.1', (string) Identity::unavailableReason());
        contains(PHP_VERSION, (string) Identity::unavailableReason());
        same(false, Identity::isReady(new Settings(ready())));
        truthy(!function_exists('Hamnivo\\createIdentityAssertion'), 'the SDK is not loaded on old PHP');
    }
});

test('says it is not ready until verified clients are on and the key is complete', function () {
    same(false, Identity::isReady(new Settings(ready(['identity_enabled' => '']))));
    same(false, Identity::isReady(new Settings(ready(['identity_kid' => '']))));
    same(false, Identity::isReady(new Settings(ready(['identity_secret' => '']))));
});

test('signs an HS256 assertion for the client that verifies with the secret', function () use ($php81) {
    if (!$php81) {
        skip('needs PHP 8.1');
    }
    $settings = new Settings(ready(['trust_emails' => 'on']));
    $assertion = Identity::assertionFor(store()->client(42), $settings);
    truthy(is_string($assertion), 'an assertion');
    $parts = jwt($assertion);
    same(['alg' => 'HS256', 'kid' => 'shop-2026', 'typ' => 'JWT'], $parts['header']);
    same(hash_hmac('sha256', $parts['input'], SECRET, true), $parts['raw'], 'the signature');
    $claims = $parts['payload'];
    same('42', $claims['sub']);
    same(WIDGET, $claims['aud']);
    same('Ayesha Khan', $claims['name']);
    same('ayesha@example.com', $claims['email']);
    same(true, $claims['email_verified']);
    same(120, $claims['exp'] - $claims['iat']);
    same(['sub', 'aud', 'iat', 'exp', 'jti', 'name', 'email', 'email_verified'], array_keys($claims));
});

test('does not sign when it is not ready, and signs without an email Hamnivo refuses', function () use ($php81) {
    same(null, Identity::assertionFor(store()->client(42), new Settings(ready(['identity_enabled' => '']))));
    if (!$php81) {
        return;
    }
    $client = store()->client(42);
    $client['email'] = 'not-an-email';
    $claims = jwt((string) Identity::assertionFor($client, new Settings(ready(['trust_emails' => 'on']))))['payload'];
    truthy(!isset($claims['email']) && !isset($claims['email_verified']), 'the email was dropped');
    same('42', $claims['sub']);
    same(null, Identity::assertionFor(store()->client(42), new Settings(ready(['identity_secret' => 'has a space']))), 'a key the SDK refuses');
});

test('recognises the algorithm of a private key in JSON, and refuses what Hamnivo does not take', function () {
    same('HS256', Identity::key('k', SECRET)['alg']);
    same('ES256', Identity::key('k', '{"kty":"EC","crv":"P-256","d":"x","x":"y","y":"z"}')['alg']);
    same('EdDSA', Identity::key('k', '{"kty":"OKP","crv":"Ed25519","d":"x","x":"y"}')['alg']);
    same('RS256', Identity::key('k', '{"kty":"RSA","n":"x","e":"AQAB","d":"y"}')['alg']);
    same(null, Identity::key('k', '{"kty":"oct","k":"abc"}'));
    same(null, Identity::key('k', '{"kty":"EC","crv":"P-384","d":"x"}'));
    same(null, Identity::key('k', '{not json'));
});

test('refuses a key that cannot sign, with a reason that never repeats the key', function () use ($php81) {
    if (!$php81) {
        skip('needs PHP 8.1');
    }
    $problem = (string) Identity::keyProblem('shop-2026', 'secret with spaces inside');
    contains('spaces or line breaks', $problem);
    lacks('secret with spaces inside', $problem);
    contains('private key that Hamnivo accepts', (string) Identity::keyProblem('shop-2026', '{"kty":"oct"}'));
    same(null, Identity::keyProblem('shop-2026', SECRET));
});

// ---------------------------------------------------------------- the context

test('shares nothing about products unless the admin turned it on', function () {
    same(null, Identity::context(store([], ['Business Hosting']), 42, new Settings([])));
    same(null, Identity::context(store([], []), 42, new Settings(['share_products' => 'on'])), 'no products, no context');
});

test('shares the names of the active products, as read-only page context', function () {
    $context = Identity::context(store([], ['Business Hosting', 'Domain Registration']), 42, new Settings(['share_products' => 'on']));
    same(['pageType' => 'client-area', 'references' => ['product1' => 'Business Hosting', 'product2' => 'Domain Registration']], $context);
});

test('shares at most ten names, each at most 200 units, under keys the chat accepts', function () {
    $names = [];
    for ($i = 1; $i <= 14; $i++) {
        $names[] = "Plan {$i}";
    }
    $names[0] = str_repeat('x', 300);
    $context = Identity::context(store([], $names), 42, new Settings(['share_products' => 'on']));
    same(10, count($context['references']));
    same(200, strlen($context['references']['product1']));
    foreach (array_keys($context['references']) as $key) {
        truthy(preg_match('/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/', $key) === 1, "the key {$key}");
    }
});

// ---------------------------------------------------------------- the endpoint

function respond(string $method = 'GET', array $headers = XHR, ?int $client = 42, array $settings = [], array $products = []): array
{
    return Endpoint::respond($method, $headers, $client, new Settings(ready($settings)), store(ready($settings), $products));
}

test('answers a signed-in client with a fresh assertion, and never lets a cache keep it', function () use ($php81) {
    $answer = respond();
    if (!$php81) {
        same(503, $answer['status']);

        return;
    }
    same(200, $answer['status']);
    same('no-store, private', $answer['headers']['Cache-Control']);
    same('application/json; charset=utf-8', $answer['headers']['Content-Type']);
    same('nosniff', $answer['headers']['X-Content-Type-Options']);
    $body = json_decode($answer['body'], true);
    same(['assertion'], array_keys($body));
    same('42', jwt($body['assertion'])['payload']['sub']);
    truthy(respond()['body'] !== $answer['body'], 'a new assertion every time');
});

test('refuses a visitor who is signed out, without saying more', function () {
    $answer = respond('GET', XHR, null);
    same(401, $answer['status']);
    same('{"error":"signed_out"}', $answer['body']);
});

test('refuses a request that does not come from the page\'s own script or from the same site', function () {
    same(400, respond('GET', [])['status'], 'no X-Requested-With header');
    same(400, respond('GET', ['x-requested-with' => 'other'])['status']);
    same(403, respond('GET', XHR + ['sec-fetch-site' => 'cross-site'])['status'], 'a request from another website');
    same(403, respond('GET', XHR + ['sec-fetch-site' => 'same-site'])['status']);
    same(405, respond('POST')['status'], 'POST');
    same('GET', respond('POST')['headers']['Allow']);
    truthy(respond('GET', XHR + ['sec-fetch-site' => 'same-origin'])['status'] !== 403, 'the same origin is fine');
});

test('says nothing but "unavailable" when it cannot sign, and never repeats the key', function () {
    foreach ([['identity_enabled' => ''], ['identity_secret' => ''], ['widget_id' => '']] as $change) {
        $answer = respond('GET', XHR, 42, $change);
        same(503, $answer['status']);
        same('{"error":"unavailable"}', $answer['body']);
        lacks(SECRET, $answer['body']);
    }
});

test('refuses a client that does not exist or is closed', function () use ($php81) {
    if (!$php81) {
        skip('needs PHP 8.1: before it the answer is "unavailable" for every client');
    }
    same(403, respond('GET', XHR, 99)['status'], 'unknown');
    same(403, respond('GET', XHR, 44)['status'], 'closed');
});

test('takes the client from the session, never from the request', function () use ($php81) {
    if (!$php81) {
        skip('needs PHP 8.1');
    }
    $_GET = ['a' => 'identity', 'client' => '43', 'id' => '43', 'userid' => '43'];
    $_POST = ['id' => '43'];
    $claims = jwt(json_decode(respond('GET', XHR, 42)['body'], true)['assertion'])['payload'];
    $_GET = [];
    $_POST = [];
    same('42', $claims['sub']);
});

test('adds the product names to the answer only when the admin turned that on', function () use ($php81) {
    if (!$php81) {
        skip('needs PHP 8.1');
    }
    $without = json_decode(respond('GET', XHR, 42, [], ['Business Hosting'])['body'], true);
    truthy(!isset($without['context']), 'off by default');
    $with = json_decode(respond('GET', XHR, 42, ['share_products' => 'on'], ['Business Hosting'])['body'], true);
    same(['pageType' => 'client-area', 'references' => ['product1' => 'Business Hosting']], $with['context']);
    lacks(SECRET, json_encode($with));
});

// ---------------------------------------------------------------- Test connection

function web(array $routes): callable
{
    return function (string $url, array $headers) use ($routes): array {
        foreach ($routes as $needle => $answer) {
            if (strpos($url, $needle) !== false) {
                if ($answer instanceof Throwable) {
                    throw $answer;
                }

                return ['status' => $answer[0], 'body' => $answer[1]] + ['url' => $url, 'headers' => $headers];
            }
        }
        throw new RuntimeException('The test has no answer for ' . $url);
    };
}

test('passes when the loader is served and the API knows the widget and allows this WHMCS', function () {
    $seen = [];
    $http = function (string $url, array $headers) use (&$seen): array {
        $seen[] = [$url, $headers];

        return strpos($url, 'loader.js') !== false
            ? ['status' => 200, 'body' => 'console.error("Hamnivo: add data-widget-id")']
            : ['status' => 200, 'body' => json_encode(['widgetId' => WIDGET])];
    };
    $result = ConnectionTest::run(new Settings(ready(['identity_enabled' => ''])), 'https://billing.example.com/', $http);
    same(true, $result['ok'], json_encode($result));
    same(3, count($result['checks']));
    same('https://chat.example.com/loader.js', $seen[0][0]);
    same('https://api.example.com/v1/widget/launcher?widgetId=' . WIDGET, $seen[1][0]);
    same('https://billing.example.com', $seen[1][1]['Origin'], 'it sends this WHMCS\'s origin, as a browser does');
    contains('https://billing.example.com', $result['checks'][2]['detail']);
});

test('says to add this WHMCS to the allowed websites when the API refuses its origin', function () {
    $result = ConnectionTest::run(new Settings(ready(['identity_enabled' => ''])), 'https://billing.example.com/', web([
        'loader.js' => [200, 'Hamnivo'],
        'launcher' => [403, '{"code":"ORIGIN_NOT_ALLOWED"}'],
    ]));
    same(false, $result['ok']);
    contains('allowed websites', $result['checks'][2]['detail']);
    contains('https://billing.example.com', $result['checks'][2]['detail']);
});

test('tells an unknown widget ID, a wrong chat address and a broken API apart', function () {
    $run = function (array $routes) {
        return ConnectionTest::run(new Settings(ready(['identity_enabled' => ''])), 'https://billing.example.com/', web($routes));
    };
    contains('does not know this widget ID', $run(['loader.js' => [200, 'Hamnivo'], 'launcher' => [404, '{}']])['checks'][2]['detail']);
    contains('status 404', $run(['loader.js' => [404, ''], 'launcher' => [200, '{"widgetId":"' . WIDGET . '"}']])['checks'][1]['detail']);
    contains('not the Hamnivo loader', $run(['loader.js' => [200, '<html>a web page</html>'], 'launcher' => [200, '{}']])['checks'][1]['detail']);
    contains('status 500', $run(['loader.js' => [200, 'Hamnivo'], 'launcher' => [500, 'oops']])['checks'][2]['detail']);
    same(false, $run(['loader.js' => [200, 'Hamnivo'], 'launcher' => [200, '{"widgetId":"wid_aaaaaaaaaaaaaaaaaaaaaaaaaa"}']])['checks'][2]['ok']);
});

test('says so when an address cannot be reached', function () {
    $result = ConnectionTest::run(new Settings(ready(['identity_enabled' => ''])), 'https://billing.example.com/', web([
        'loader.js' => new RuntimeException('Could not resolve host: chat.example.com'),
        'launcher' => new RuntimeException('Connection timed out'),
    ]));
    contains('could not reach the chat address. Could not resolve host', $result['checks'][1]['detail']);
    contains('could not reach the API address. Connection timed out', $result['checks'][2]['detail']);
});

test('asks for what is missing, and calls nothing then', function () {
    $calls = 0;
    $http = function () use (&$calls): array {
        $calls++;

        return ['status' => 200, 'body' => ''];
    };
    $result = ConnectionTest::run(new Settings([]), 'https://billing.example.com/', $http);
    same(false, $result['ok']);
    same(0, $calls);
    contains('widget ID', $result['checks'][0]['detail']);
    contains('chat address', $result['checks'][1]['detail']);
    same(true, $result['checks'][2]['ok'], 'no API address is fine');
});

test('warns that an http address is blocked when WHMCS uses https', function () {
    $calls = 0;
    $http = function () use (&$calls): array {
        $calls++;

        return ['status' => 200, 'body' => ''];
    };
    $result = ConnectionTest::run(new Settings(ready(['chat_url' => 'http://chat.example.com', 'api_url' => 'http://api.example.com', 'identity_enabled' => ''])), 'https://billing.example.com/', $http);
    contains('Browsers block', $result['checks'][1]['detail']);
    contains('Browsers block', $result['checks'][2]['detail']);
    same(0, $calls);
});

test('checks the identity key too, here, without sending it', function () use ($php81) {
    if (!$php81) {
        skip('needs PHP 8.1');
    }
    $routes = ['loader.js' => [200, 'Hamnivo'], 'launcher' => [200, '{"widgetId":"' . WIDGET . '"}']];
    $result = ConnectionTest::run(new Settings(ready()), 'https://billing.example.com/', web($routes));
    same(4, count($result['checks']));
    same(true, $result['checks'][3]['ok']);
    $result = ConnectionTest::run(new Settings(ready(['identity_secret' => 'has a space'])), 'https://billing.example.com/', web($routes));
    same(false, $result['checks'][3]['ok']);
    lacks('has a space', $result['checks'][3]['detail']);
});

test('works out the origin of this WHMCS from its address', function () {
    same('https://billing.example.com', ConnectionTest::origin('https://billing.example.com/whmcs/'));
    same('http://localhost:8080', ConnectionTest::origin('http://localhost:8080/'));
    same('', ConnectionTest::origin('not a url'));
});

// ---------------------------------------------------------------- the admin page

test('shows what is set, the Test connection form with its token, and the result', function () {
    $settings = new Settings(ready(['trust_emails' => 'on', 'share_products' => 'on']));
    $result = ['ok' => false, 'checks' => [['ok' => true, 'label' => 'Widget ID', 'detail' => 'Fine.'], ['ok' => false, 'label' => 'Chat address', 'detail' => 'Check it.']]];
    $page = Admin::render($settings, 'https://billing.example.com/', 'addonmodules.php?module=hamnivo', generate_token('form'), $result);
    contains('The chat is on.', $page);
    contains(WIDGET, $page);
    contains('https://chat.example.com', $page);
    contains('name="token"', $page);
    contains('name="hamnivo_test"', $page);
    contains('action="addonmodules.php?module=hamnivo"', $page);
    contains('Problem: Chat address.', $page);
    contains('Works: Widget ID.', $page);
    contains('https://billing.example.com', $page, 'this WHMCS\'s address, to add to the allowed websites');
    contains('How to find these', $page);
});

test('says how to register an identity key while verified clients are off, and not once they are on', function () {
    $off = Admin::render(new Settings(ready(['identity_enabled' => ''])), 'https://billing.example.com/', 'addonmodules.php?module=hamnivo', '', null);
    contains('How to register an identity key', $off);
    contains('docs/guides/identity.md', $off);
    contains('Verified clients</td><td>off<', $off);
    $on = Admin::render(new Settings(ready()), 'https://billing.example.com/', 'addonmodules.php?module=hamnivo', '', null);
    lacks('How to register an identity key', $on);
});

test('says the chat is off until it is set up, and lists what to fix', function () {
    $page = Admin::render(new Settings(['widget_id' => 'oops']), 'https://billing.example.com/', 'addonmodules.php?module=hamnivo', '', null);
    contains('The chat is off.', $page);
    contains('wid_ followed by 26', $page);
    lacks('Everything works', $page);
});

test('escapes what it prints, and never prints the saved key', function () {
    $settings = new Settings(ready([
        'widget_id' => '"><img src=x onerror=alert(1)>',
        'chat_url' => 'https://chat.example.com/"><script>alert(2)</script>',
        'identity_kid' => '"><svg onload=alert(3)>',
        'identity_secret' => 'TOP-SECRET-VALUE-123',
    ]));
    $page = Admin::render($settings, 'https://billing.example.com/"><script>alert(4)</script>', 'addonmodules.php?module=hamnivo&x="><b>', '', null);
    lacks('<img src=x', $page);
    lacks('<script>alert', $page);
    lacks('<svg onload', $page);
    lacks('TOP-SECRET-VALUE-123', $page);
    contains('saved (never shown again)', $page);
});

test('explains on the page why verified clients are not possible on old PHP', function () use ($php81) {
    $page = Admin::render(new Settings(ready()), 'https://billing.example.com/', 'addonmodules.php?module=hamnivo', '', null);
    if ($php81) {
        lacks('needs PHP 8.1 or newer', $page);
        contains('Verified clients</td><td>on<', $page);
    } else {
        contains('Verified clients need PHP 8.1 or newer', $page);
        contains(PHP_VERSION, $page);
        contains('on, but not working yet', $page);
    }
});

// ---------------------------------------------------------------- the module's functions

test('gives WHMCS the addon\'s name and one field for each setting the addon reads', function () use ($addon) {
    require $addon . '/hamnivo.php';
    $config = hamnivo_config();
    same('Hamnivo Chat', $config['name']);
    same(Output::VERSION, $config['version']);
    $reflection = new ReflectionClass(Settings::class);
    $fields = $reflection->getReflectionConstant('FIELDS')->getValue();
    sort($fields);
    $named = array_keys($config['fields']);
    sort($named);
    same($fields, $named, 'the config fields and Settings::FIELDS are the same');
    foreach ($config['fields'] as $name => $field) {
        truthy(isset($field['FriendlyName'], $field['Type'], $field['Description']), "{$name} is described");
        truthy(in_array($field['Type'], ['text', 'password', 'yesno'], true), "{$name} has a type WHMCS knows");
    }
    same('password', $config['fields']['identity_secret']['Type'], 'the key is a password field');
    same('hamnivo', Settings::MODULE);
});

test('says yes to activate and deactivate, and keeps the settings', function () {
    same('success', hamnivo_activate()['status']);
    $off = hamnivo_deactivate();
    same('success', $off['status']);
    contains('settings are kept', $off['description']);
    same(null, hamnivo_upgrade([]));
});

test('draws the admin page from the store, with the key never shown', function () {
    Services::useStore(store(ready(['identity_secret' => 'TOP-SECRET-VALUE-123'])));
    $_POST = [];
    $page = capture(function () {
        hamnivo_output(['modulelink' => 'addonmodules.php?module=hamnivo']);
    });
    contains('Hamnivo Chat', $page);
    contains('The chat is on.', $page);
    contains('action="addonmodules.php?module=hamnivo"', $page);
    lacks('TOP-SECRET-VALUE-123', $page);
    Services::useStore(null);
});

test('lets the key come from a constant in configuration.php, and the constant wins', function () {
    $store = store(ready(['identity_secret' => 'the-saved-secret']));
    same('the-saved-secret', Settings::load($store)->secret(), 'before the constant');
    define('HAMNIVO_IDENTITY_SECRET', ' ' . SECRET . ' ');
    same(SECRET, Settings::load($store)->secret());
});

finish();
