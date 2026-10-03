___TERMS_OF_SERVICE___

By creating or modifying this file you agree to Google Tag Manager's Community
Template Gallery Developer Terms of Service available at
https://developers.google.com/tag-manager/gallery-tos (or such other URL as
Google may provide), as modified from time to time.


___INFO___

{
  "type": "TAG",
  "id": "cvt_temp_public_id",
  "version": 1,
  "securityGroups": [],
  "displayName": "Hamnivo Chat",
  "categories": [
    "CHAT"
  ],
  "brand": {
    "id": "brand_dummy",
    "displayName": ""
  },
  "description": "Puts Hamnivo Chat on your website. Enter the widget ID and the chat address that Hamnivo Studio shows in the install code.",
  "containerContexts": [
    "WEB"
  ]
}


___TEMPLATE_PARAMETERS___

[
  {
    "type": "TEXT",
    "name": "widgetId",
    "displayName": "Widget ID",
    "simpleValueType": true,
    "alwaysInSummary": true,
    "help": "Starts with wid_. In Hamnivo Studio, open Settings, then Brands and install. Choose your brand and click \"Copy install code\". The widget ID is the data-widget-id in it.",
    "valueValidators": [
      {
        "type": "NON_EMPTY"
      },
      {
        "type": "REGEX",
        "args": [
          "^\\s*wid_[0-9a-z]{26}\\s*$"
        ],
        "errorMessage": "A widget ID is wid_ followed by 26 lower-case letters and digits."
      }
    ]
  },
  {
    "type": "TEXT",
    "name": "chatUrl",
    "displayName": "Chat address",
    "simpleValueType": true,
    "alwaysInSummary": true,
    "help": "Where Hamnivo Chat runs, for example https://chat.example.com. It is the start of the install code's src, before /loader.js. It must start with https://.",
    "valueValidators": [
      {
        "type": "NON_EMPTY"
      },
      {
        "type": "REGEX",
        "args": [
          "^\\s*https://[^\\s/?#@]+(/\\S*)?\\s*$"
        ],
        "errorMessage": "The chat address starts with https:// and has a host name, for example https://chat.example.com."
      }
    ]
  },
  {
    "type": "TEXT",
    "name": "apiUrl",
    "displayName": "API address (optional)",
    "simpleValueType": true,
    "help": "The Hamnivo API of the same installation, for example https://api.example.com. It is the install code's data-api. Leave it empty to use the chat's own default.",
    "valueValidators": [
      {
        "type": "REGEX",
        "args": [
          "^\\s*(https://[^\\s/?#@]+(/[^\\s?#]*)?)?\\s*$"
        ],
        "errorMessage": "The API address starts with https:// and has a host name, for example https://api.example.com."
      }
    ]
  }
]


___SANDBOXED_JS_FOR_WEB_TEMPLATE___

// Hamnivo Chat. Loads loader.js from the chat address. The loader reads its settings from the
// data-* attributes of its script tag, or, where a tag manager can only pass an address, from the
// query of its own address: loader.js?widgetId=wid_...&api=https://api.example.com

const injectScript = require('injectScript');
const queryPermission = require('queryPermission');
const parseUrl = require('parseUrl');
const encodeUriComponent = require('encodeUriComponent');
const logToConsole = require('logToConsole');
const makeString = require('makeString');

const ID_CHARACTERS = '0123456789abcdefghijklmnopqrstuvwxyz';

// A widget ID is wid_ and 26 lower-case letters and digits. A tag setting can hold a variable,
// which the form does not check, so it is checked again here.
function isWidgetId(id) {
  if (id.length !== 30 || id.indexOf('wid_') !== 0) {
    return false;
  }
  for (let i = 4; i < id.length; i++) {
    if (ID_CHARACTERS.indexOf(id.charAt(i)) === -1) {
      return false;
    }
  }
  return true;
}

// An https address with a host name: its origin, and with keepPath its path without trailing
// slashes. Nothing else counts, so a quote, a space or a login in the address is refused. The
// host must follow https:// at once, because a browser reads https:///x as the host x.
function address(text, keepPath) {
  if (text.indexOf('https://') !== 0 || text.charAt(8) === '/' || text.indexOf(' ') !== -1) {
    return undefined;
  }
  const url = parseUrl(text);
  if (!url || url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    return undefined;
  }
  if (url.search || url.hash) {
    return undefined;
  }
  let path = keepPath ? url.pathname : '';
  while (path.length > 0 && path.charAt(path.length - 1) === '/') {
    path = path.substring(0, path.length - 1);
  }
  return url.origin + path;
}

function fail(why) {
  logToConsole('Hamnivo Chat: ' + why);
  data.gtmOnFailure();
}

const widgetId = data.widgetId ? makeString(data.widgetId).trim() : '';
const chat = data.chatUrl ? address(makeString(data.chatUrl).trim(), false) : undefined;
const apiText = data.apiUrl ? makeString(data.apiUrl).trim() : '';
const api = apiText ? address(apiText, true) : '';

if (!isWidgetId(widgetId)) {
  fail('the widget ID is wid_ and 26 lower-case letters and digits. Copy it again from Hamnivo Studio.');
  return;
}
if (!chat) {
  fail('the chat address must start with https:// and have a host name, for example https://chat.example.com.');
  return;
}
if (api === undefined) {
  fail('the API address must start with https:// and have a host name, for example https://api.example.com. Leave it empty to use the default.');
  return;
}

let url = chat + '/loader.js?widgetId=' + encodeUriComponent(widgetId);
if (api) {
  url += '&api=' + encodeUriComponent(api);
}

if (!queryPermission('inject_script', url)) {
  fail('this template may not load ' + url + '. In the template, open Permissions, Injects scripts, and allow the chat address.');
  return;
}

// The address is the cache token, so a tag that fires on every page view of a single-page site
// loads the script once.
injectScript(url, data.gtmOnSuccess, data.gtmOnFailure, url);


___WEB_PERMISSIONS___

[
  {
    "instance": {
      "key": {
        "publicId": "logging",
        "versionId": "1"
      },
      "param": [
        {
          "key": "environments",
          "value": {
            "type": 1,
            "string": "debug"
          }
        }
      ]
    },
    "isRequired": true
  },
  {
    "instance": {
      "key": {
        "publicId": "inject_script",
        "versionId": "1"
      },
      "param": [
        {
          "key": "urls",
          "value": {
            "type": 2,
            "listItem": [
              {
                "type": 1,
                "string": "https://*/loader.js*"
              }
            ]
          }
        }
      ]
    },
    "clientAnnotations": {
      "isEditedByUser": true
    },
    "isRequired": true
  }
]


___TESTS___

scenarios:
- name: Loads the loader from the chat address, with the widget ID and the API address
  code: |-
    const mockData = {
      widgetId: 'wid_01j9zk7w3xq8r4t2v6m5n1p0ce',
      chatUrl: 'https://chat.example.com',
      apiUrl: 'https://api.example.com'
    };
    let injected;
    mock('queryPermission', function() { return true; });
    mock('injectScript', function(url, onSuccess) {
      injected = url;
      onSuccess();
    });

    runCode(mockData);

    assertThat(injected).isEqualTo('https://chat.example.com/loader.js?widgetId=wid_01j9zk7w3xq8r4t2v6m5n1p0ce&api=https%3A%2F%2Fapi.example.com');
    assertApi('gtmOnSuccess').wasCalled();
    assertApi('gtmOnFailure').wasNotCalled();
- name: Leaves out the API address when there is none
  code: |-
    const mockData = {
      widgetId: 'wid_01j9zk7w3xq8r4t2v6m5n1p0ce',
      chatUrl: 'https://chat.example.com'
    };
    let injected;
    mock('queryPermission', function() { return true; });
    mock('injectScript', function(url, onSuccess) {
      injected = url;
      onSuccess();
    });

    runCode(mockData);

    assertThat(injected).isEqualTo('https://chat.example.com/loader.js?widgetId=wid_01j9zk7w3xq8r4t2v6m5n1p0ce');
    assertApi('gtmOnSuccess').wasCalled();
- name: Keeps only the origin of the chat address, and the path of the API address without its slash
  code: |-
    const mockData = {
      widgetId: 'wid_01j9zk7w3xq8r4t2v6m5n1p0ce',
      chatUrl: 'https://chat.example.com:8443/loader.js',
      apiUrl: 'https://example.com/api/v1/'
    };
    let injected;
    mock('queryPermission', function() { return true; });
    mock('injectScript', function(url, onSuccess) {
      injected = url;
      onSuccess();
    });

    runCode(mockData);

    assertThat(injected).isEqualTo('https://chat.example.com:8443/loader.js?widgetId=wid_01j9zk7w3xq8r4t2v6m5n1p0ce&api=https%3A%2F%2Fexample.com%2Fapi%2Fv1');
- name: Trims the spaces that a copy and paste brings along
  code: |-
    const mockData = {
      widgetId: '  wid_01j9zk7w3xq8r4t2v6m5n1p0ce ',
      chatUrl: ' https://chat.example.com ',
      apiUrl: ' '
    };
    let injected;
    mock('queryPermission', function() { return true; });
    mock('injectScript', function(url, onSuccess) {
      injected = url;
      onSuccess();
    });

    runCode(mockData);

    assertThat(injected).isEqualTo('https://chat.example.com/loader.js?widgetId=wid_01j9zk7w3xq8r4t2v6m5n1p0ce');
- name: Refuses a widget ID that is not wid_ and 26 lower-case letters and digits
  code: |-
    const mockData = {
      widgetId: 'wid_01J9ZK7W3XQ8R4T2V6M5N1P0CE',
      chatUrl: 'https://chat.example.com'
    };
    mock('queryPermission', function() { return true; });
    mock('injectScript', function(url, onSuccess) { onSuccess(); });

    runCode(mockData);

    assertApi('injectScript').wasNotCalled();
    assertApi('gtmOnFailure').wasCalled();
    assertApi('gtmOnSuccess').wasNotCalled();
- name: Refuses a chat address that is not https
  code: |-
    const mockData = {
      widgetId: 'wid_01j9zk7w3xq8r4t2v6m5n1p0ce',
      chatUrl: 'http://chat.example.com'
    };
    mock('queryPermission', function() { return true; });
    mock('injectScript', function(url, onSuccess) { onSuccess(); });

    runCode(mockData);

    assertApi('injectScript').wasNotCalled();
    assertApi('gtmOnFailure').wasCalled();
- name: Refuses an API address that is not a web address
  code: |-
    const mockData = {
      widgetId: 'wid_01j9zk7w3xq8r4t2v6m5n1p0ce',
      chatUrl: 'https://chat.example.com',
      apiUrl: 'javascript:alert(1)'
    };
    mock('queryPermission', function() { return true; });
    mock('injectScript', function(url, onSuccess) { onSuccess(); });

    runCode(mockData);

    assertApi('injectScript').wasNotCalled();
    assertApi('gtmOnFailure').wasCalled();
- name: Refuses a chat address with a login in it
  code: |-
    const mockData = {
      widgetId: 'wid_01j9zk7w3xq8r4t2v6m5n1p0ce',
      chatUrl: 'https://user:pass@chat.example.com'
    };
    mock('queryPermission', function() { return true; });
    mock('injectScript', function(url, onSuccess) { onSuccess(); });

    runCode(mockData);

    assertApi('injectScript').wasNotCalled();
    assertApi('gtmOnFailure').wasCalled();
- name: Fails, and does not load anything, when the template may not load the address
  code: |-
    const mockData = {
      widgetId: 'wid_01j9zk7w3xq8r4t2v6m5n1p0ce',
      chatUrl: 'https://chat.example.com'
    };
    mock('queryPermission', function() { return false; });
    mock('injectScript', function(url, onSuccess) { onSuccess(); });

    runCode(mockData);

    assertApi('injectScript').wasNotCalled();
    assertApi('gtmOnFailure').wasCalled();
- name: Fails when the script cannot be loaded
  code: |-
    const mockData = {
      widgetId: 'wid_01j9zk7w3xq8r4t2v6m5n1p0ce',
      chatUrl: 'https://chat.example.com'
    };
    mock('queryPermission', function() { return true; });
    mock('injectScript', function(url, onSuccess, onFailure) { onFailure(); });

    runCode(mockData);

    assertApi('gtmOnFailure').wasCalled();
    assertApi('gtmOnSuccess').wasNotCalled();


___NOTES___

The settings reach the loader in the query of its address, because a tag manager's injectScript
cannot set data-* attributes. The Hamnivo that serves the chat must have a loader that reads them,
as the loader of the release that added this template does. With an older one, use a Custom HTML
tag with the install code from Hamnivo Studio instead.
